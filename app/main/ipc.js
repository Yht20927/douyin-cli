// app/main/ipc.js — 主进程 ↔ 渲染层的 IPC 契约
//
// 渲染层跑在 contextIsolation 下、没有 Node 权限，一切能力经这里白名单暴露。
// 命名约定：<域>:<动作>。渲染层看到的则是 app/preload 里那层更友好的包装。

const { ipcMain, shell, clipboard, dialog, app } = require('electron');

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
  // 走 safe() 包一层 {ok, data}：全应用的 IPC 只有一种返回形状，
  // 否则渲染层每处都要判断"这个 handle 有没有包"。诊断页与设置页共用它。
  ipcMain.handle('config:describe', (_e) => {
    try {
      return { ok: true, data: configModule.describe() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * 保存设置页改动。
   *
   * 只接受补丁（改了什么就传什么），不接受整份配置回写 —— 界面手里那份是
   * **脱敏**过的，整份回写会把 api_key 变成打码文案。config.set 里还有一道
   * 兜底拒绝，这里是第一道。
   *
   * 另外只放行 DEFAULTS 里已有的叶子路径：渲染层被注入时也塞不进自定义键，
   * 顺带避免用户手滑写出拼错的配置项（那会静默不生效）。
   */
  ipcMain.handle('config:set', (_e, patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: '配置补丁需要是一个对象' };
    }
    try {
      const allowed = new Set(configModule.listLeafPaths());
      const unknown = [];
      const walk = (node, prefix) => {
        for (const k of Object.keys(node)) {
          const p = prefix ? `${prefix}.${k}` : k;
          const v = node[k];
          if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
          else if (!allowed.has(p)) unknown.push(p);
        }
      };
      walk(patch, '');
      if (unknown.length) {
        return { ok: false, error: `不认识的配置项：${unknown.join('、')}` };
      }

      configModule.set(patch);
      // 返回 describe() 而不是 config.set() 的原始结果：后者是未脱敏的完整配置，
      // 会把 api_key 明文回传给渲染层。整个设置页的口径是"界面永远不持有明文密钥"，
      // 这一处不例外。
      return { ok: true, data: configModule.describe() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

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
  // 返回 { items, total, shown, truncated }：total 是**数据库里的真实条数**，
  // 而不是"这次取了多少条"。改造前界面把 list.length 当总数显示，
  // 有 120 个作品时标题写着"共 50 个作品"，而且第 51 个以后既看不到也点不进去
  // （工作台的唯一入口就在这一行）。
  ipcMain.handle('data:videos', safe((opts) => {
    const o = opts && typeof opts === 'object' ? opts : { limit: opts };
    const limit = Math.max(1, Number(o.limit) || 50);
    const items = views.listMyVideos({ limit });
    const total = require('../../core/memory/videos').count({ isMine: true });
    return { items, total, shown: items.length, truncated: total > items.length };
  }));
  ipcMain.handle('data:video', safe((awemeId) => views.videoDetail(String(awemeId))));
  ipcMain.handle('data:videoStats', safe((awemeId) => views.videoStats(String(awemeId))));
  // 排序选项由 core 给出，界面不自己写一份 —— 否则加了新排序方式界面看不到。
  //
  // ⚠️ 必须走 safe()：它包出来的形状是 { ok, data }，而界面是按 `r.ok` 判断的。
  // 直接返回裸数组的话 `r.ok` 恒为 undefined，界面上那个排序下拉框**永远是空的**
  // —— 点开一个选项都没有，排序功能看起来"做了但不生效"。
  ipcMain.handle('data:commentOrders', safe(() => require('../../core/memory/comments').ORDER_INFO));
  // 排序字段走白名单，未知值由 listComments 回退到默认并回报 unknownFilter。
  // 返回的是 { items, total, truncated, order, filter, unknownFilter, scanCapped } ——
  // total 是**截断前的真实条数**，界面用它显示「共 N 条」而不是拿列表长度当总数。
  ipcMain.handle('data:comments', safe((awemeId, o) => views.listComments(String(awemeId), {
    filter: o && o.filter,
    limit: o && o.limit,
    search: o && o.search,
    order: o && o.order,
  })));
  ipcMain.handle('data:comment', safe((cid) => views.commentDetail(String(cid))));
  ipcMain.handle('data:drafts', safe(() => views.listDrafts()));

  // ── 草稿箱的本地写操作（同样是本地库，不走队列）──
  ipcMain.handle('draft:save', safe((spec) => {
    const drafts = require('../../core/memory/drafts');
    const id = drafts.save({
      awemeId: String(spec.awemeId),
      text: spec.text == null ? '' : String(spec.text),
      replyToCid: spec.replyToCid || null,
      personaId: spec.personaId || null,
      // 图片回复的本地路径：不带上它，"存草稿→稍后发布"会静默丢掉附图
      imagePath: spec.imagePath || null,
    });
    if (id == null) throw new Error('草稿内容为空（文字与图片至少要有一个）');
    return { id };
  }));

  // ── 人格：编辑器的数据源 ──
  // effective 由 core 现算（内置 + 覆盖 + 自定义 - 停用），界面不重复这套合并规则 ——
  // 否则"界面上看到的"和"生成时用的"迟早会不一样。
  ipcMain.handle('personas:describe', safe(() => {
    const personas = require('../../core/personas');
    return {
      // 生效列表（生成时真正会用到的那批）
      effective: personas.effectivePersonas(),
      // 含停用、且内置项已叠加覆盖 —— 编辑器显示用。
      // 合并规则只在 core 里实现一次，界面不重复，否则"界面上看到的"
      // 和"生成时用的"迟早会不一致。
      all: personas.effectivePersonas({ includeDisabled: true }),
      // 内置默认值，用于"恢复默认"与判断某条是不是自定义
      builtin: personas.BUILTIN,
      config: configModule.get('personas'),
    };
  }));

  // ── 提示词模板：读写 / 备份 / 恢复默认 ──
  // 读写都走 core/prompts —— 它把"清缓存"和"改前备份"绑在保存动作里，
  // 散在 IPC 里很容易漏掉其中一个，而漏掉的表现都是静默的（改了不生效 / 没有退路）。
  const prompts = require('../../core/prompts');
  ipcMain.handle('prompts:list', safe(() => prompts.list()));
  ipcMain.handle('prompts:read', safe((name) => prompts.read(String(name || ''))));
  ipcMain.handle('prompts:save', safe((name, text) => prompts.save(String(name || ''), text)));
  ipcMain.handle('prompts:reset', safe((name) => prompts.resetToDefault(String(name || ''))));
  ipcMain.handle('prompts:backups', safe((name) => prompts.listBackups(String(name || ''))));
  ipcMain.handle('prompts:restore', safe((name, file) => prompts.restoreBackup(String(name || ''), String(file || ''))));

  // ── 回复来源：设置页与工作台要显示"当前模式下会怎么生成" ──
  ipcMain.handle('reply:describe', safe(() => require('../../core/reply-source').describe()));

  // 循环跑到第几条了 + 重置。重置只清 reply-state.json，不碰任何配置。
  ipcMain.handle('reply:cycle-progress', safe(() => require('../../core/reply-source').cycleProgress()));
  ipcMain.handle('reply:reset-cycle', safe((section) => {
    const state = require('../../core/reply-source').state;
    state.reset(section === 'fixed' || section === 'image' ? section : undefined);
    return { reset: section || 'all' };
  }));

  // 选图：用系统文件选择器，多选。
  //
  // 只返回路径，不做校验 —— 校验交给 reply:check-image，界面拿结果逐条标出
  // 哪张不可用。这样"选的时候"和"用的时候"用的是同一个判定，不会出现
  // 选图时放行、发布时才发现超限的情况。
  ipcMain.handle('dialog:pick-images', async (_e) => {
    const exts = Object.keys(require('../../core/comment-image').FORMAT_BY_EXT)
      .map(e => e.replace('.', ''));
    const r = await dialog.showOpenDialog({
      title: '选择回复图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: exts }],
    });
    if (r.canceled) return { ok: true, paths: [] };
    return { ok: true, paths: r.filePaths };
  });

  // 选图时的即时预检：把"文件不存在 / 格式不支持 / 超过 10MB"提前暴露，
  // 而不是等发布上传到一半才失败（改造计划 §11 开放问题 #6）。
  ipcMain.handle('reply:check-image', safe((p) => {
    const { checkImage } = require('../../core/comment-image');
    const r = checkImage(String(p || ''));
    return { path: String(p || ''), ...r };
  }));

  // 发布成功后把草稿标记为已发布。
  // 不标的话，草稿箱里那条会原样留着，用户以为没发出去 → 再点一次发布
  // → 这次被去重/重复回复策略拦下（报"已回复过此评论"），于是更确信是工具坏了。
  // CLI 侧一直有这条（draft post），渲染层发的却是裸 post 命令，所以这个标记从来没落过。
  ipcMain.handle('draft:mark-posted', safe((id) => {
    const drafts = require('../../core/memory/drafts');
    return { marked: drafts.markPosted(Number(id)) };
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
