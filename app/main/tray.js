// app/main/tray.js — 系统托盘
//
// 托盘在本应用里不是装饰：定时拉取要求应用常驻，用户关窗口后进程还在后台跑，
// 托盘是"应用还活着、现在什么状态、怎么退出"的唯一可见入口。

const path = require('path');
const { Tray, Menu, nativeImage, app } = require('electron');

const ASSETS = path.join(__dirname, '..', 'assets');

/**
 * @param {object} opts
 * @param {() => object} opts.getStatus  - 取当前桥接状态
 * @param {() => void}   opts.onOpen     - 打开主窗口
 * @param {() => void}   opts.onRefresh  - 立即重新检测连接
 * @param {() => void}   opts.onQuit     - 退出应用
 * @returns {{ tray: Tray, update: () => void, destroy: () => void }}
 */
function createTray(opts) {
  const icon = (name) => nativeImage.createFromPath(path.join(ASSETS, name));

  const tray = new Tray(icon('tray-offline.png'));
  tray.setToolTip('抖音评论运营助手');

  function statusLine(s) {
    if (!s.listening) return '服务未启动';
    if (s.online) return `已连接（${s.totalConnections} 个页面）`;
    if (s.alert) return '已离线 —— 请检查抖音页面';
    if (s.offlineForMs > 0) return `连接中断 ${Math.round(s.offlineForMs / 1000)}s`;
    return '等待油猴脚本连接';
  }

  function update() {
    const s = opts.getStatus();
    const online = !!(s.listening && s.online);

    tray.setImage(icon(online ? 'tray-online.png' : 'tray-offline.png'));
    tray.setToolTip(`抖音评论运营助手 — ${statusLine(s)}`);

    tray.setContextMenu(Menu.buildFromTemplate([
      { label: statusLine(s), enabled: false },
      { type: 'separator' },
      { label: '打开主窗口', click: () => opts.onOpen() },
      { label: '重新检测连接', click: () => opts.onRefresh() },
      { type: 'separator' },
      { label: '退出', click: () => opts.onQuit() },
    ]));
  }

  // 左键点击托盘：显示/聚焦窗口（Windows 上习惯如此）
  tray.on('click', () => opts.onOpen());

  update();

  return {
    tray,
    update,
    destroy() {
      try { tray.destroy(); } catch (e) { /* 退出时可能已被销毁 */ }
    },
  };
}

module.exports = { createTray };
