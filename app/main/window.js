// app/main/window.js — 主窗口

const path = require('path');
const { BrowserWindow, shell } = require('electron');

/**
 * 创建主窗口。
 *
 * 安全基线：contextIsolation 开、nodeIntegration 关 —— 渲染层拿不到 Node，
 * 所有能力经 app/preload 的 contextBridge 白名单暴露。
 *
 * @param {object} opts
 * @param {boolean} [opts.show=true]
 * @returns {BrowserWindow}
 */
function createMainWindow(opts = {}) {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    title: '抖音评论运营助手',
    backgroundColor: '#0f172a',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 准备好再显示，避免白屏闪烁
  win.once('ready-to-show', () => {
    if (opts.show !== false) win.show();
  });

  // 站外链接一律交给系统浏览器 —— 应用窗口不该被导航去 douyin.com
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env.DOUYIN_DEV_SERVER || '';
    if (devUrl && url.startsWith(devUrl)) return;
    if (!/^https?:/.test(url)) return;
    e.preventDefault();
    shell.openExternal(url);
  });

  return win;
}

/**
 * 载入界面。
 * - 开发模式（DOUYIN_DEV_SERVER 有值）：载 Vite 开发服务器，支持热更新
 * - 其余情况：载打包好的静态文件
 *
 * @param {BrowserWindow} win
 * @param {object} app - electron app
 */
function loadRenderer(win, app) {
  const devUrl = process.env.DOUYIN_DEV_SERVER;
  if (devUrl && !app.isPackaged) {
    win.loadURL(devUrl);
    return;
  }
  win.loadFile(path.join(__dirname, '..', 'renderer', 'dist', 'index.html'));
}

module.exports = { createMainWindow, loadRenderer };
