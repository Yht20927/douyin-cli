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
 * @param {() => object} [opts.getQueue] - 取队列表述（最小化后要看得到在忙什么）
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

  /**
   * 队列里最值得看一眼的那一条。
   * 应用常驻托盘，用户最小化时唯一能看到"正在等 30 秒"的地方就是这里。
   */
  function queueLine() {
    if (!opts.getQueue) return null;
    const q = opts.getQueue();
    const cur = (q.tasks || []).find(t => t.status === 'running' || t.status === 'waiting');
    if (cur) {
      if (cur.status === 'waiting' && cur.wait) {
        return `${cur.label}：等 ${Math.ceil(cur.wait.remainingMs / 1000)}s`;
      }
      return `${cur.label}：执行中`;
    }
    const pending = (q.stats && q.stats.counts && q.stats.counts.pending) || 0;
    return pending > 0 ? `队列中还有 ${pending} 个任务` : null;
  }

  function update() {
    const s = opts.getStatus();
    const online = !!(s.listening && s.online);
    const q = queueLine();

    tray.setImage(icon(online ? 'tray-online.png' : 'tray-offline.png'));
    tray.setToolTip(`抖音评论运营助手 — ${statusLine(s)}${q ? `\n${q}` : ''}`);

    const items = [
      { label: statusLine(s), enabled: false },
    ];
    if (q) items.push({ label: q, enabled: false });
    items.push(
      { type: 'separator' },
      { label: '打开主窗口', click: () => opts.onOpen() },
      { label: '重新检测连接', click: () => opts.onRefresh() },
      { type: 'separator' },
      { label: '退出', click: () => opts.onQuit() }
    );

    tray.setContextMenu(Menu.buildFromTemplate(items));
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
