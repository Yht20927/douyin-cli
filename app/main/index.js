// app/main/index.js — Electron 主进程入口
//
// 启动顺序（顺序有讲究）：
//   1. 单实例锁        —— 两个实例会抢同一个桥接端口，先挡住
//   2. 数据目录        —— 必须在任何 core 模块落盘之前定下来
//   3. 日志 sink       —— 之后的启动过程才有留痕
//   4. 内嵌桥接服务    —— 失败要能体面地告诉用户，而不是白屏
//   5. IPC / 订阅 / 窗口 / 托盘
//
// 生命周期上刻意区分"创建一次"与"可重建"：
//   - IPC 处理器、托盘、bridge 订阅 → 进程级，只建一次
//     （ipcMain.handle 对同一 channel 重复注册会直接抛错；
//      订阅重复注册则是慢性泄漏）
//   - 窗口 → 可重建（macOS 上关掉所有窗口后点 Dock 图标会走 activate）
//
// 退出走一条明确的路：quitApp() → 停桥接 → 毁托盘 → app.quit()。
// 不依赖 before-quit 里做异步清理 —— 那里只能 preventDefault + 手动退出，
// 很容易写成递归或半退出状态。

const { app, dialog } = require('electron');

// ── 单实例锁 ──
// 两个实例会争同一个桥接端口，第二个必然起不来；不如把已有窗口叫到前面。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap() {
  const { applyDataDir } = require('./data-dir');
  const paths = require('../../core/paths');
  const loggerModule = require('../../core/runtime/logger');
  const configModule = require('../../core/config');
  const { createBridgeManager } = require('./bridge-manager');
  const { createMainWindow, loadRenderer } = require('./window');
  const { createTray } = require('./tray');
  const { registerIpc, forwardStatusToWindow } = require('./ipc');
  const { createTaskQueue } = require('../../core/runtime/task-queue');
  const { createContext, bindCommands } = require('../../core/runtime/context');
  const { getPolicy } = require('../../core/policy');

  // ── 数据目录 ──
  const dataDirInfo = applyDataDir(app);

  // ── 桌面形态下的运行时覆盖 ──
  //
  // intervals.readEnforce：改造计划 §5.4 / 风险 R6 定的「CLI 下 false、GUI 下 true」。
  // 命令行下读操作只提示不阻塞（否则每次查询都卡 30 秒，交互没法用）；
  // 桌面应用里没有 agent 自觉遵守间隔，读操作必须真的进队列等 —— 否则
  // 定时拉取 + 手动刷新叠在一起，请求密度会高到触发风控。
  //
  // 用 setRuntimeOverrides 而不是 config.set：后者会写进用户的 config.json，
  // 于是用户在设置页把这一项关掉之后，下次启动又被改回来 —— 配置项就变成假的了。
  configModule.setRuntimeOverrides({ intervals: { readEnforce: true } });

  // ── 日志 ──
  loggerModule.configure({
    sinks: [loggerModule.consoleSink(), loggerModule.fileSink()],
    level: loggerModule.defaultLevel(),
  });
  const log = loggerModule.getLogger();
  log.info(`[app] 数据目录: ${dataDirInfo.dir}（${dataDirInfo.source}）`);
  if (dataDirInfo.fellBack) {
    log.warn('[app] 安装目录不可写，已回退到用户数据目录');
  }

  // 配置告警要在界面上可见，不能只写日志（用户不会去看日志）
  const configWarnings = configModule.getWarnings();
  for (const w of configWarnings) {
    log.warn(`[app] 配置告警 ${w.key}: ${w.message}`);
  }

  const bridge = createBridgeManager({ config: configModule.get() });

  // 所有命令都经这条队列执行，保证串行（运营规则说明.md §1「严禁并发」）。
  // 队列不自己拼 ctx —— 由这里注入，与 CLI 共用同一套组装逻辑。
  const queue = createTaskQueue({
    policy: getPolicy(),
    createContext: (task, o = {}) => {
      const ctx = createContext({
        command: task.command,
        taskId: task.id,
        signal: o.signal,
        extraSinks: o.extraSinks || [],
      });
      bindCommands(ctx);
      return ctx;
    },
  });

  let win = null;
  let tray = null;
  /** 窗口级 bridge 订阅的取消函数（窗口重建时必须先取消，否则累积） */
  let unwatchWindow = null;
  /** 是否已进入退出流程（此后窗口 close 不再拦截） */
  let quitting = false;

  function showMainWindow() {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  /** 唯一退出路径：先停服务，再退应用，不留孤儿监听 */
  async function quitApp() {
    if (quitting) return;
    quitting = true;
    // 先停队列（取消未开始的任务），再停桥接服务，最后退出
    try { queue.stop(); } catch (e) { log.warn(`[app] 停止队列时出错: ${e.message}`); }
    try { await bridge.stop(); } catch (e) { log.warn(`[app] 停止桥接服务时出错: ${e.message}`); }
    if (tray) tray.destroy();
    app.quit();
  }

  /** 托盘是进程级的，只建一次 */
  function ensureTray() {
    if (tray) return tray;
    tray = createTray({
      getStatus: () => bridge.getStatus(),
      getQueue: () => ({ tasks: queue.list(), stats: queue.stats() }),
      onOpen: showMainWindow,
      onRefresh: () => bridge.refresh(),
      onQuit: quitApp,
    });
    return tray;
  }

  function createWindow() {
    if (win && !win.isDestroyed()) { showMainWindow(); return win; }

    win = createMainWindow();
    loadRenderer(win, app);

    // 上一个窗口的订阅要先撤掉，否则每重建一次就多一份推送
    if (unwatchWindow) { unwatchWindow(); unwatchWindow = null; }
    unwatchWindow = forwardStatusToWindow(win, bridge, queue);

    // 关窗口 → 最小化到托盘（默认）；置 false 则真关。
    // 定时拉取要求进程常驻，所以默认不是退出。
    win.on('close', (e) => {
      if (quitting) return;                                 // 退出流程中放行
      if (!configModule.get('app.minimizeToTray')) return;   // 用户要求真关
      e.preventDefault();
      win.hide();
      if (tray) tray.update(bridge.getStatus());
    });

    win.on('closed', () => {
      if (unwatchWindow) { unwatchWindow(); unwatchWindow = null; }
      win = null;
    });

    return win;
  }

  app.whenReady().then(async () => {
    try {
      await bridge.start();
    } catch (e) {
      // 端口被占用是最常见的启动失败，给出可操作的说明而不是白屏
      log.error(`[app] 桥接服务启动失败: ${e.message}`);
      dialog.showErrorBox(
        '桥接服务启动失败',
        `${e.message}\n\n配置文件位置：\n${paths.configFile()}\n\n` +
        '可修改其中的 bridge.port 换一个端口后重试。'
      );
      app.exit(1);
      return;
    }

    // ── 进程级：只注册一次 ──
    registerIpc({ bridge, queue, dataDirInfo, configWarnings });
    bridge.subscribe((status) => { if (tray) tray.update(status); });
    // 队列里在等待/执行时，托盘提示也要跟着变 —— 否则最小化后完全看不出在忙
    queue.subscribe(() => { if (tray) tray.update(bridge.getStatus()); });
    ensureTray();

    createWindow();
  });

  // 第二个实例被启动 → 把已有窗口叫到前面
  app.on('second-instance', showMainWindow);

  // macOS：关掉所有窗口后应用仍活着，点 Dock 图标应重建窗口
  app.on('activate', () => {
    if (app.isReady()) createWindow();
  });

  // 窗口被真正关掉时（minimizeToTray=false 的情况）才退出；
  // 托盘常驻模式下窗口只是 hide，不会触发这里。
  app.on('window-all-closed', () => {
    if (!configModule.get('app.minimizeToTray')) quitApp();
  });

  // 让窗口的 close 处理器放行（真正的清理在 quitApp 里做）
  app.on('before-quit', () => { quitting = true; });
}
