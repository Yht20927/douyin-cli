// app/main/index.js — Electron 主进程入口
//
// 启动顺序（顺序有讲究）：
//   1. 单实例锁        —— 两个实例会抢同一个桥接端口，先挡住
//   2. 数据目录        —— 必须在任何 core 模块落盘之前定下来
//   3. 日志 sink       —— 之后的启动过程才有留痕
//   4. 内嵌桥接服务    —— 失败要能体面地告诉用户，而不是白屏
//   5. 窗口 + 托盘
//
// 退出走一条明确的路：quitApp() → 停桥接 → 毁托盘 → app.quit()。
// 不依赖 before-quit 里做异步清理（那里只能 preventDefault + 手动退出，
// 很容易写成递归或半退出状态）。

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

  // ── 数据目录 ──
  const dataDirInfo = applyDataDir(app);

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
  let win = null;
  let tray = null;
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
    try { await bridge.stop(); } catch (e) { log.warn(`[app] 停止桥接服务时出错: ${e.message}`); }
    if (tray) tray.destroy();
    app.quit();
  }

  function createUi() {
    win = createMainWindow();
    loadRenderer(win, app);

    forwardStatusToWindow(win, bridge);
    bridge.subscribe((status) => { if (tray) tray.update(status); });

    // 关窗口 → 最小化到托盘（默认）；置 false 则真关。
    // 定时拉取要求进程常驻，所以默认不是退出。
    win.on('close', (e) => {
      if (quitting) return;                       // 退出流程中放行
      if (!configModule.get('app.minimizeToTray')) return;  // 用户要求真关
      e.preventDefault();
      win.hide();
      if (tray) tray.update(bridge.getStatus());
    });

    win.on('closed', () => { win = null; });

    tray = createTray({
      getStatus: () => bridge.getStatus(),
      onOpen: showMainWindow,
      onRefresh: () => bridge.refresh(),
      onQuit: quitApp,
    });

    registerIpc({ bridge, dataDirInfo, configWarnings });
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
    createUi();
  });

  // 第二个实例被启动 → 把已有窗口叫到前面
  app.on('second-instance', showMainWindow);

  // 窗口被真正关掉时（minimizeToTray=false 的情况）才退出；
  // 托盘常驻模式下窗口只是 hide，不会触发这里。
  app.on('window-all-closed', () => {
    if (!configModule.get('app.minimizeToTray')) quitApp();
  });

  // 让窗口的 close 处理器放行（真正的清理在 quitApp 里做）
  app.on('before-quit', () => { quitting = true; });
}
