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
 * 简单版本比较：a 是否大于 b（按数字段逐段比，段数不齐补 0）。
 * 只用于 release tag vs app.getVersion()，不需要完整 semver。
 */
function isNewerVersion(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

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

  // ── 应用级：更新检查 / 数据备份 ──
  // 检查 GitHub 最新 release。网络不通（代理/防火墙）时如实报错，
  // 绝不把"检查失败"伪装成"已是最新"。
  ipcMain.handle('app:check-update', async () => {
    const current = app.getVersion();
    try {
      const res = await fetch('https://api.github.com/repos/Yht20927/douyin-cli/releases/latest', {
        headers: { 'User-Agent': 'douyin-comment-app', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { ok: false, current, error: `GitHub 返回 HTTP ${res.status}` };
      const data = await res.json();
      const latest = String(data.tag_name || '').replace(/^v/, '');
      const hasUpdate = !!latest && isNewerVersion(latest, current);
      return { ok: true, current, latest: latest || null, hasUpdate, url: data.html_url || null };
    } catch (e) {
      return { ok: false, current, error: `网络请求失败：${e.message}` };
    }
  });

  // 数据目录是个 SQLite + 配置的整体，让用户在文件管理器里看到它，
  // 比在界面上解释"数据库文件在哪"更直接。
  ipcMain.handle('app:open-data-dir', async () => {
    const r = await shell.openPath(dataDirInfo.dir);
    return r ? { ok: false, error: r } : { ok: true, path: dataDirInfo.dir };
  });

  // 备份本地数据库（作品/评论/草稿都在里面）到用户选的位置。
  // 热备份：SQLite 单文件，直接复制 —— 运行中复制最多损失最后几秒的写入，
  // 对"防误删/迁移"这个用途可以接受；wired-up 的事务级备份属于过度设计。
  ipcMain.handle('data:backup', async () => {
    const fs = require('fs');
    const dbFile = require('../../core/paths').dbFile();
    const r = await dialog.showSaveDialog({
      title: '备份数据库',
      defaultPath: `douyin-data-${new Date().toISOString().slice(0, 10)}.db`,
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }],
    });
    if (r.canceled) return { ok: true, canceled: true };
    try {
      fs.copyFileSync(dbFile, r.filePath);
      return { ok: true, path: r.filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
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

  /**
   * 复制任意文本到剪贴板（诊断页的各类路径用）。
   *
   * 走主进程的 clipboard 而不是渲染层的 navigator.clipboard：后者要求
   * 安全上下文与用户手势同时成立，而这个应用加载的是本地文件 —— 一旦
   * 某天加载方式变了（改成自定义协议），复制会**静默失效**，
   * 表现是"点了没反应"。主进程这条路径没有这些前提。
   */
  // ── 账号 ──
  //
  // 界面靠这两个接口显示"现在在看哪个号"并支持切换。**必须显式显示**：
  // 用户报的问题就是"换了号数据没变"，而只要把当前账号摆在界面上，
  // 这件事立刻可验证；多账号同时在线时也才有办法选定一个。
  ipcMain.handle('account:state', () => {
    try {
      const status = bridge.getStatus();
      const online = accounts.aliveUids(status);
      const stored = accounts.currentUid();
      const uid = currentAccountUid();
      const list = accounts.list().map(a => ({
        uid: a.uid,
        nickname: a.nickname,
        avatar: a.avatar,
        online: online.includes(String(a.uid)),
        current: uid != null && String(a.uid) === String(uid),
      }));
      return {
        ok: true,
        data: {
          uid,
          // 多个号同时在线时才需要人工选；只有一个时是自动跟随的
          needsChoice: online.length > 1,
          candidates: online,
          accounts: list,
        },
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('account:set', (_e, uid) => {
    // 传 null/'' = 清除选择，回到"自动跟随唯一在线账号"
    const ok = accounts.setCurrent(uid == null || uid === '' ? null : String(uid));
    return ok
      ? { ok: true, data: { uid: uid == null || uid === '' ? null : String(uid) } }
      : { ok: false, error: '这个账号不在名册里 —— 先在浏览器里连一次，它才会被登记' };
  });

  ipcMain.handle('app:copy-text', (_e, text) => {
    if (typeof text !== 'string' || !text) return { ok: false, error: '没有可复制的内容' };
    try {
      clipboard.writeText(text);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
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
  //
  // 必须带上执行账号：配额与轮次都是"这个号今天干了多少"。不带账号统计时
  // A 号用掉的轮次会算到刚切过来的 B 号头上（实测今日 5 条写操作分属 3 个账号）。
  ipcMain.handle('policy:stats', () => getPolicy().stats({ accountUid: currentAccountUid() }));

  // 发布前预检：界面在确认弹窗里展示"能不能发、为什么不能、还要等多久"。
  // 只报告不等待 —— 与队列执行时的判定是同一个 beforeWrite，口径一致。
  //
  // 连接状态必须并入这里：弹窗向用户承诺"这里说能发、点下去就一定能发"，
  // 而 beforeWrite 只懂策略不懂桥接 —— 浏览器没连上时它照样放行，
  // 任务进了队列才会超时失败。这里把"没连上"作为硬拦截塞进去，
  // 弹窗在点击之前就会说清楚。
  ipcMain.handle('policy:check', (_e, meta) => {
    try {
      const given = meta && typeof meta === 'object' ? meta : {};
      // 执行账号由主进程定，渲染层传来的同名字段一律覆盖 ——
      // 否则被注入的渲染层可以挑一个"配额还没用完的号"把闸门绕过去。
      const r = getPolicy().beforeWrite({ ...given, accountUid: currentAccountUid() });
      const online = !!(bridge.getStatus() && bridge.getStatus().online);
      const check = online
        ? r
        : {
            ...r,
            ok: false,
            waitMs: 0,
            hardBlockers: [
              { reason: '浏览器没有连上 —— 到「连接」页确认抖音页面开着且已登录' },
              ...((r && r.hardBlockers) || []),
            ],
          };
      return { ok: true, check };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('queue:state', () => ({
    tasks: opts.queue.list(),
    stats: opts.queue.stats(),
    policy: getPolicy().stats({ accountUid: currentAccountUid() }),
  }));

  ipcMain.handle('queue:enqueue', (_e, spec) => {
    // 只接受普通对象，避免渲染层被注入后塞进奇怪的东西
    if (!spec || typeof spec !== 'object') return { ok: false, error: '参数不合法' };
    try {
      const givenMeta = spec.meta && typeof spec.meta === 'object' ? spec.meta : {};
      const id = opts.queue.enqueue({
        command: String(spec.command || ''),
        argv: Array.isArray(spec.argv) ? spec.argv.map(String) : [],
        label: spec.label ? String(spec.label) : undefined,
        // 执行账号由主进程盖：队列执行时 beforeWrite(task.meta) 据此统计配额与轮次，
        // 让渲染层自带的话它可以挑一个"今天还没用过的号"把闸门绕过去。
        meta: { ...givenMeta, accountUid: currentAccountUid() },
        // 插队只对发布类命令开放：批量生成/拉取不允许借它加塞读请求，
        // 发布才需要跳过排在前面的大批量任务
        front: spec.front === true && String(spec.command) === 'post',
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

  // ── 当前账号 ──
  //
  // 界面上的每一份数据都属于某个账号。这里把"当前在看哪个号"解析出来传给
  // 视图层 —— 不传的话视图只能退回全局猜测，两个号的数据就混在一起，
  // 而症状正是用户报的"换了号刷新后列表没变"。
  //
  // `bridge.getStatus()` 是轮询缓存，同步返回；解析规则复用 core 里那一份，
  // 不在主进程另写一套（否则两处的"当前账号"迟早不一致）。
  const accounts = require('../../core/memory/accounts');
  function currentAccountUid() {
    try {
      const online = accounts.aliveUids(bridge.getStatus());
      const stored = accounts.currentUid();
      if (online.length === 1) return online[0];
      if (online.length > 1) return (stored && online.includes(stored)) ? stored : online[0];
      return stored || null;
    } catch (e) {
      return null;
    }
  }

  // scope: 'all'（默认）| 'mine' —— 默认全量的理由见 core/data/views.js 的 overview()
  ipcMain.handle('data:overview', safe((o) => views.overview({
    scope: o && o.scope,
    accountUid: currentAccountUid(),
  })));
  // 返回 { items, total, shown, truncated }：total 是**数据库里的真实条数**，
  // 而不是"这次取了多少条"。改造前界面把 list.length 当总数显示，
  // 有 120 个作品时标题写着"共 50 个作品"，而且第 51 个以后既看不到也点不进去
  // （工作台的唯一入口就在这一行）。
  ipcMain.handle('data:videos', safe((opts) => {
    const o = opts && typeof opts === 'object' ? opts : { limit: opts };
    const limit = Math.max(1, Number(o.limit) || 50);
    const items = views.listMyVideos({ limit, accountUid: currentAccountUid() });
    const total = require('../../core/memory/videos').count({ isMine: true, accountUid: currentAccountUid() });
    return { items, total, shown: items.length, truncated: total > items.length };
  }));
  // 「运营对象」—— 别人的视频里我正在互动的那批评论区。
  //
  // 与 data:videos 是两件事，不能合并：data:videos 是"我发的作品"，
  // 而工作台真正的入口对象是**别人视频下的评论区**（实测 215 个视频里
  // 只有 7 个是自己的、1850 条评论在别人那边）。此前工作台只能从
  // 「我的作品」进，于是 96% 的运营数据在界面上不可达。
  //
  // 返回 { items, total, shown, truncated, scanned, scanLimit, scanCapped,
  //        order, orders, accountUid, accountCertain } —— orders 由 core 提供，
  // 界面不自己写一份排序清单（同 commentOrders 的做法）。
  // accountCertain 现在由「运营对象」页用来声明"这一页到底有没有按账号过滤"。
  ipcMain.handle('data:targets', safe((o) => views.listTargets({
    order: o && o.order,
    limit: o && o.limit,
    accountUid: currentAccountUid(),
  })));
  // 「找视频」页用：一批视频在库里的状态（已收录 / 可加入 / 是不是当前账号在运营）
  ipcMain.handle('data:targetStatus', safe((ids) => views.targetStatus(
    Array.isArray(ids) ? ids : [],
    { accountUid: currentAccountUid() }
  )));
  ipcMain.handle('data:video', safe((awemeId) => views.videoDetail(String(awemeId), {
    accountUid: currentAccountUid(),
  })));
  ipcMain.handle('data:videoStats', safe((awemeId) => views.videoStats(String(awemeId), {
    accountUid: currentAccountUid(),
  })));
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
    accountUid: currentAccountUid(),
  })));
  ipcMain.handle('data:comment', safe((cid) => views.commentDetail(String(cid))));
  // 查重：纯本地读（语料库有唯一索引），**不走队列** —— 写回复时想确认
  // "这句没发过"是即时动作，让用户为它等读间隔是错的
  ipcMain.handle('data:checkDup', safe((text) => views.checkDuplicate(text)));
  // 诊断页：操作历史 + 清理预演（都是纯本地读；真正执行清理仍然走队列里的 cleanup 命令）
  // 逐项转发（不整个 `o` 丢下去）：界面传了什么参数，一眼能从这行看出来 ——
  // 整个对象透传时"界面加了参数但主进程没接"这类问题看不出来
  ipcMain.handle('data:events', safe((o) => views.listEvents({
    limit: o && o.limit,
    command: o && o.command,
    status: o && o.status,
  })));
  // 用户详情（whois 的视图版）+ 交互历史（profile）。纯本地读，不走队列。
  ipcMain.handle('data:userProfile', safe((uid, o) => views.userProfile(String(uid || ''), {
    limit: o && o.limit,
  })));
  ipcMain.handle('data:userEvents', safe((uid, o) => views.userEvents(String(uid || ''), {
    limit: o && o.limit,
  })));
  /**
   * 打标签 / 备注（`note` 命令的写入部分）。
   *
   * 直接写本地库、不走队列：它不碰抖音，没有任何风控风险 —— 与 draft:save
   * 同一种性质。命令本身留着给 CLI 用。
   */
  ipcMain.handle('user:setNote', (_e, uid, patch) => {
    const id = String(uid || '');
    if (!id) return { ok: false, error: '缺少 uid' };
    try {
      const users = require('../../core/memory/users');
      users.upsert({ uid: id });   // 名册里没有先建一行，否则下面的 UPDATE 什么都不改
      const p = patch && typeof patch === 'object' ? patch : {};
      if (p.tier !== undefined) users.setTier(id, p.tier ? String(p.tier) : null);
      if (p.notes !== undefined) users.setNotes(id, p.notes ? String(p.notes) : null);
      if (Array.isArray(p.addTags)) for (const t of p.addTags) users.addTag(id, String(t));
      if (Array.isArray(p.removeTags)) for (const t of p.removeTags) users.removeTag(id, String(t));
      return { ok: true, data: users.get(id) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('data:cleanupPreview', safe((o) => views.cleanupPreview({
    days: o && o.days,
  })));
  // 逐个转发（理由见下面 data:analytics 的注释）：这里原本写的是 `...(o || {})`，
  // 参数能不能过全靠运气 —— 界面上加一个搜索框、preload 里传了 q，而主进程
  // 若改成挑字段就会静默丢掉。显式列出来，护栏（preload-contract）才看得见它。
  ipcMain.handle('data:drafts', safe((o) => views.listDrafts({
    q: o && o.q,
    accountUid: currentAccountUid(),
  })));
  // 数据分析页的全量聚合（纯本地读，不占队列）。
  // 一次算好所有图卡的原料，而不是每个图表各发一个 IPC 各扫一遍库。
  // scope 默认 'all' —— 只统计自己的作品会让这一页分析 3% 的业务。
  //
  // ⚠️ 参数必须**逐个转发**，不能只挑一个。这里曾经只传 scope 而漏了
  // dayWindow，于是界面上「最近 90 天」的分段按钮点了以后标签变了、
  // 数字一个没动 —— 因为 core 拿到的还是默认的 30 天。这类"界面参数没接到
  // 后端"的缺陷在两端都不报错，只能靠把每一个参数都写出来避免。
  ipcMain.handle('data:analytics', safe((o) => views.analytics({
    scope: o && o.scope,
    dayWindow: o && o.dayWindow,
    accountUid: currentAccountUid(),
  })));

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
      // 归属账号。必须与 data:drafts 过滤用的是同一个解析，否则刚存进去的草稿
      // 会因为"没标明账号"被列表整个藏掉
      accountUid: currentAccountUid(),
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
  // 完整格式校验（与 `validate-prompts` 命令同一份实现）。
  // 界面上是一个「校验」按钮 —— 不带参数校验全部，带参数只校验那一个。
  ipcMain.handle('prompts:validate', safe((name) => prompts.validateAll(name ? String(name) : undefined)));
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

  /**
   * 批量删除草稿。纯本地操作，不碰抖音，因此不占串行队列（与 draft:delete 同理）。
   *
   * 限定当前账号：勾选集合可能来自刷新之前（刚换号、或某条已被另一个窗口删掉），
   * 拿 id 直接删会删到用户在界面上根本看不见的草稿。删掉的条数如实返回，
   * 界面说"删了 N 条（另有 M 条已不在当前账号的草稿箱里）"，而不是报个好看的数。
   */
  ipcMain.handle('draft:delete-many', safe((ids) => {
    const drafts = require('../../core/memory/drafts');
    const requested = [...new Set((Array.isArray(ids) ? ids : [])
      .map(Number).filter(n => Number.isInteger(n) && n > 0))];
    if (!requested.length) return { deleted: 0, requested: 0 };
    const deleted = drafts.removeMany(requested, { accountUid: currentAccountUid() });
    if (deleted < 0) throw new Error('批量删除失败（原因已记入日志）');
    return { deleted, requested: requested.length };
  }));

  /**
   * 批量改草稿正文 —— 单条编辑也走这一条（ids 传一个）。纯本地写，不碰抖音，
   * 所以同样不占串行队列。
   *
   * 为什么要一条真 UPDATE：此前只有 save / delete，界面"编辑"是存新的再删旧的，
   * 于是 id 变了、created_at 变成现在（这条在列表里跳到最前），而且两步之间
   * 任何一步失败就留下**两条内容相同的待发草稿** —— 用户接着批量发布，
   * 同一句话就发两遍。
   *
   * 「整批替换」与「查找替换」能不能同时给、find 为空算不算一次替换，
   * 判据只在 core/drafts.updateMany 里写一份：这里再抄一遍的话，
   * 两处迟早对不上，而 preview（dryRun）与执行就会给出不同的条数。
   * dryRun 原样透传，确认框里的"会改动 N 条"因此不是界面猜的。
   */
  ipcMain.handle('draft:update-many', safe((ids, patch, opts) => {
    const drafts = require('../../core/memory/drafts');
    // ids 原样交给 core：去重与"只留正整数"那套净化只有一份（在 updateMany 里），
    // 这里再抄一遍的话，预览报的条数与实际改的条数迟早对不上
    const r = drafts.updateMany(ids, patch, {
      ...opts,
      // 与 list / delete-many 同一个口径：刚换号或别的窗口已经删掉时，
      // 勾选集合里会有界面上根本看不见的 id，那些一条都不能碰
      accountUid: currentAccountUid(),
    });
    // 执行后界面会重新载入列表，正文本来就跟着回来了；
    // 只有预览需要把每一条改成什么带过去
    const preview = opts && opts.dryRun ? r.preview : [];
    return { changed: r.changed.length, requested: r.requested, skipped: r.skipped, preview };
  }));
}

/**
 * 把桥接状态与队列变化推给渲染层。
 *
 * @param {import('electron').BrowserWindow} win
 * @param {object} bridge
 * @param {object} queue
 * @param {() => string|null} [getAccountUid] - 当前执行账号。推给界面的策略快照
 *   必须与 `policy:stats` 用同一个账号口径，否则两处数字不是一套；
 *   不传时退回"全账号合算"（更严的方向）。
 * @returns {() => void} 取消订阅（两个订阅一起撤）
 */
function forwardStatusToWindow(win, bridge, queue, getAccountUid) {
  const un1 = bridge.subscribe((status) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('bridge:status-changed', status);
  });
  const un2 = queue.subscribe((payload) => {
    if (!win || win.isDestroyed()) return;
    // 队列变化时把策略一并推过去 —— 配额会随任务完成而变化，
    // 分两条消息推容易让界面短暂显示不一致的组合
    let accountUid = null;
    try { accountUid = typeof getAccountUid === 'function' ? getAccountUid() : null; } catch (e) { /* 退回全账号合算 */ }
    win.webContents.send('queue:changed', { ...payload, policy: getPolicy().stats({ accountUid }) });
  });
  return () => { un1(); un2(); };
}

module.exports = { registerIpc, forwardStatusToWindow };
