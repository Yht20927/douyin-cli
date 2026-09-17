// app/main/ipc.js — 主进程 ↔ 渲染层的 IPC 契约
//
// 渲染层跑在 contextIsolation 下、没有 Node 权限，一切能力经这里白名单暴露。
// 命名约定：<域>:<动作>。渲染层看到的则是 app/preload 里那层更友好的包装。

const { ipcMain, shell, clipboard, app } = require('electron');

const configModule = require('../../core/config');
const paths = require('../../core/paths');
const { sourceExists, sourcePath } = require('../../core/userscript');
const { getPolicy } = require('../../core/policy');
const views = require('../../core/data/views');

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

  // ── 策略与队列 ──
  // 策略统计每次现算：它读 events 表，数据随时在变，缓存只会带来"界面显示的是旧的"。
  ipcMain.handle('policy:stats', () => getPolicy().stats());

  // 发布前预检：界面在确认弹窗里展示"能不能发、为什么不能、还要等多久"。
  // 只报告不等待 —— 与队列执行时的判定是同一个 beforeWrite，口径一致。
  ipcMain.handle('policy:check', (_e, meta) => {
    try {
      const r = getPolicy().beforeWrite(meta && typeof meta === 'object' ? meta : {});
      return { ok: true, check: r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('queue:state', () => ({
    tasks: opts.queue.list(),
    stats: opts.queue.stats(),
    policy: getPolicy().stats(),
  }));

  ipcMain.handle('queue:enqueue', (_e, spec) => {
    // 只接受普通对象，避免渲染层被注入后塞进奇怪的东西
    if (!spec || typeof spec !== 'object') return { ok: false, error: '参数不合法' };
    try {
      const id = opts.queue.enqueue({
        command: String(spec.command || ''),
        argv: Array.isArray(spec.argv) ? spec.argv.map(String) : [],
        label: spec.label ? String(spec.label) : undefined,
        meta: spec.meta && typeof spec.meta === 'object' ? spec.meta : {},
      });
      return { ok: true, id };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('queue:cancel', (_e, id) => ({ ok: opts.queue.cancel(String(id)) }));

  ipcMain.handle('queue:cancel-pending', () => ({ ok: true, count: opts.queue.cancelPending() }));

  // 按需取完整结果：生成回复的产出就是一段文本，摘要对它没有意义。
  // 不放进常规推送里，避免每次队列变化都把结果全量过一遍 IPC。
  ipcMain.handle('queue:result', (_e, id) => ({ ok: true, result: opts.queue.getResult(String(id)) }));

  // ── 本地数据（读 SQLite，不走队列：无风控风险，也不该占串行队列）──
  // 每个 handle 都包一层 try：数据层出错应该是界面显示一条错误，而不是整个调用炸掉
  const safe = (fn) => (_e, ...args) => {
    try {
      return { ok: true, data: fn(...args) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  ipcMain.handle('data:overview', safe(() => views.overview()));
  ipcMain.handle('data:videos', safe((limit) => views.listMyVideos({ limit: Number(limit) || 50 })));
  ipcMain.handle('data:video', safe((awemeId) => views.videoDetail(String(awemeId))));
  ipcMain.handle('data:videoStats', safe((awemeId) => views.videoStats(String(awemeId))));
  ipcMain.handle('data:comments', safe((awemeId, o) => views.listComments(String(awemeId), {
    filter: o && o.filter,
    limit: o && o.limit,
    search: o && o.search,
  })));
  ipcMain.handle('data:comment', safe((cid) => views.commentDetail(String(cid))));
  ipcMain.handle('data:drafts', safe(() => views.listDrafts()));

  // ── 草稿箱的本地写操作（同样是本地库，不走队列）──
  ipcMain.handle('draft:save', safe((spec) => {
    const drafts = require('../../core/memory/drafts');
    const id = drafts.save({
      awemeId: String(spec.awemeId),
      text: String(spec.text),
      replyToCid: spec.replyToCid || null,
      personaId: spec.personaId || null,
    });
    return { id };
  }));

  ipcMain.handle('draft:delete', safe((id) => {
    const drafts = require('../../core/memory/drafts');
    return { deleted: drafts.remove(Number(id)) };
  }));
}

/**
 * 把桥接状态与队列变化推给渲染层。
 *
 * @param {import('electron').BrowserWindow} win
 * @param {object} bridge
 * @param {object} queue
 * @returns {() => void} 取消订阅（两个订阅一起撤）
 */
function forwardStatusToWindow(win, bridge, queue) {
  const un1 = bridge.subscribe((status) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('bridge:status-changed', status);
  });
  const un2 = queue.subscribe((payload) => {
    if (!win || win.isDestroyed()) return;
    // 队列变化时把策略一并推过去 —— 配额会随任务完成而变化，
    // 分两条消息推容易让界面短暂显示不一致的组合
    win.webContents.send('queue:changed', { ...payload, policy: getPolicy().stats() });
  });
  return () => { un1(); un2(); };
}

module.exports = { registerIpc, forwardStatusToWindow };
