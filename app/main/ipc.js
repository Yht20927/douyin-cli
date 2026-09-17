// app/main/ipc.js — 主进程 ↔ 渲染层的 IPC 契约
//
// 渲染层跑在 contextIsolation 下、没有 Node 权限，一切能力经这里白名单暴露。
// 命名约定：<域>:<动作>。渲染层看到的则是 app/preload 里那层更友好的包装。

const { ipcMain, shell, clipboard, app } = require('electron');

const configModule = require('../../core/config');
const paths = require('../../core/paths');
const { sourceExists, sourcePath } = require('../../core/userscript');

/**
 * 注册全部 IPC 处理器。
 *
 * @param {object} opts
 * @param {object} opts.bridge         - createBridgeManager() 的返回值
 * @param {object} opts.dataDirInfo    - { dir, source, fellBack }
 * @param {Array}  [opts.configWarnings] - 启动时的配置校验告警，界面要显示
 */
function registerIpc(opts) {
  const { bridge, dataDirInfo, configWarnings = [] } = opts;

  // ── 应用信息（诊断页与关于页）──
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    dataDir: dataDirInfo.dir,
    dataDirSource: dataDirInfo.source,
    dataDirFellBack: dataDirInfo.fellBack,
    appRoot: paths.appRoot(),
    configFile: paths.configFile(),
    sourceFile: sourcePath(),
    sourceExists: sourceExists(),
    // 配置里有非法值时不能让用户蒙在鼓里：界面会明确提示已回退成什么
    configWarnings,
  }));

  ipcMain.handle('app:open-external', async (_e, url) => {
    // 只放行 http(s)，避免渲染层被注入后拿 file:// 之类做文章
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      return { ok: false, error: '只允许打开 http(s) 链接' };
    }
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('app:quit', () => {
    app.quit();
    return { ok: true };
  });

  // ── 桥接状态 ──
  ipcMain.handle('bridge:status', () => bridge.getStatus());
  ipcMain.handle('bridge:refresh', async () => {
    await bridge.refresh();
    return bridge.getStatus();
  });

  // ── 一键安装油猴脚本 ──
  // 用系统浏览器打开 /install.user.js：Tampermonkey 识别到 .user.js 会弹出安装页。
  // 这是唯一"点一下就能装好"的路径 —— 脚本里的 token 由服务端现场注入，
  // 用户不需要手工复制粘贴任何凭证。
  ipcMain.handle('bridge:open-userscript', async () => {
    const url = bridge.getUserscriptUrl();
    if (!url) return { ok: false, error: '桥接服务尚未启动' };
    await shell.openExternal(url);
    return { ok: true, url };
  });

  ipcMain.handle('bridge:copy-userscript-url', () => {
    const url = bridge.getUserscriptUrl();
    if (!url) return { ok: false, error: '桥接服务尚未启动' };
    clipboard.writeText(url);
    return { ok: true, url };
  });

  // ── 配置（脱敏）──
  ipcMain.handle('config:describe', () => configModule.describe());
}

/**
 * 把桥接状态变化推给渲染层。
 *
 * @param {import('electron').BrowserWindow} win
 * @param {object} bridge
 * @returns {() => void} 取消订阅
 */
function forwardStatusToWindow(win, bridge) {
  return bridge.subscribe((status) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('bridge:status-changed', status);
  });
}

module.exports = { registerIpc, forwardStatusToWindow };
