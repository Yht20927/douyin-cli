// scripts/_probe.js — 渲染验证探针（开发用，不是产品代码）
//
// 为什么需要它
// ------------
// 这个项目里最贵的一类 bug 是"静态检查看不出来、只在真实渲染时炸"的：
//   - 函数删了但 JSX 还在引用        → 整页白屏
//   - IPC 返回裸数组、界面按 r.ok 读 → 下拉框永远是空的
//   - 字段名差一个字母               → 承诺过的提示永远不出现
// 这些都只有在**真的跑一遍渲染 + 喂真实数据**时才会暴露。
//
// 它做的事：起一个本地 HTTP 服务，把真实的 core 模块挂成 app/main/ipc.js 里
// 那些 channel 的同名端点；再往渲染层产物里塞一个 __stub.js 把 window.dy
// 接到这个服务上。然后用浏览器打开 __probe.html 看界面。
//
// 用法：
//   node scripts/_probe.js            # 起服务，打印探针地址
//   node scripts/_probe.js --port 8791
//
// ⚠️ 只读：所有端点都只调 views / describe 这类读函数，不产生任何写操作。
//
// 两条纪律（都是踩出来的）：
//
//   1. **读端点的响应形状必须与 app/main/ipc.js 一模一样**，包括"有没有被
//      safe() 包成 {ok,data}"。桩统一包一层是不行的。
//   2. **写端点一律如实拒绝**，不能返回一个假的 {ok:true}。旧版本把
//      queue:enqueue / draft:save / config:set 全写成 `noop = () => ({ok:true})`，
//      于是界面会弹出「已加入队列」「草稿已保存」「设置已保存」而什么都没发生 ——
//      探针在替界面确认一个不存在的成功，比没有探针更糟。而且 enqueue 的返回值
//      里没有 id，App.jsx 拿到 undefined 去 trackTask，那条联动静默失效。
//      写操作的正确验证方式是真跑一次应用。
//
// 端点清单**派生自 app/main/ipc.js 的 ipcMain.handle 注册语句**，不在这里手抄第二份。
// 上一版抄了一份清单，于是主进程加了 data:analytics 而探针没有，
// 结果数据页在探针里永久停在"正在统计…" —— 整个图表层是在没有验证手段的情况下改的。
// 写通道名单（WRITE_CHANNELS）没法从代码里推出来，仍然手维护，但它漏项的后果
// 只是"探针多渲染了一个只读端点"，不是"页面空白"，方向上安全。

const http = require('http');
const fs = require('fs');
const path = require('path');

const paths = require('../core/paths');

const ROOT = paths.appRoot();
const DIST = path.join(ROOT, 'app', 'renderer', 'dist');
const MAIN_IPC = path.join(ROOT, 'app', 'main', 'ipc.js');

/**
 * 探针**不**实现的写通道 —— 命中这些时返回一条如实的失败，形状与各 handle 的失败分支一致。
 * 新增只读通道不需要动这里；新增写通道才需要。
 *
 * 有一条**故意不在这里**：`draft:update-many` 是写通道，但它的 `dryRun` 那次调用
 * 是一次真正的读（core 只算不写），探针给它写了一个只实现 dryRun 的端点，
 * 其余情况仍返回 refused()。列进这张表的话，那个端点就没意义了 ——
 * 而确认框里"会改动 N 条、每条改成什么"恰恰是只有真渲染才看得出的那一处。
 */
const WRITE_CHANNELS = new Set([
  'app:open-external',
  'app:quit',
  'app:open-data-dir',
  'data:backup',
  'bridge:open-userscript',
  'bridge:copy-userscript-url',
  'config:set',
  'queue:enqueue',
  'queue:cancel',
  'queue:cancel-pending',
  'reply:reset-cycle',
  'prompts:save',
  'prompts:reset',
  'prompts:restore',
  'draft:save',
  'draft:delete',
  'draft:delete-many',
  'draft:mark-posted',
]);

/** 从 ipc.js 抽出所有注册过的通道名 —— 探针的端点清单以此为权威来源 */
function readIpcChannels() {
  const src = fs.readFileSync(MAIN_IPC, 'utf8');
  const out = new Set();
  const re = /ipcMain\.handle\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

/**
 * 与 app/main/ipc.js 同一个解析规则：界面上每份数据都属于某个账号。
 * 探针里固定用 account:state 返回的那个号 —— 两者必须是同一个值，
 * 否则界面显示"当前账号是 X"而数据是按 Y 取的，验证就成了自欺。
 * 放在模块顶层是因为 FIXTURE 那条分支也要按同一个账号取数（见 fixtureDrafts）。
 */
const PROBE_ACCOUNT_UID = '1179139456380456';

/**
 * 可选的假数据（--fixture）。
 *
 * 存在的理由：草稿箱和队列这两页**在真实数据下常常是空的** ——
 * 于是这两页的渲染（比如草稿上"回复的是哪条评论"那一行）没有任何办法验证，
 * 只能靠读代码。这里给一份形状正确的假数据让页面真的渲染出来。
 *
 * ⚠️ 它只是让**页面**渲染出来，不能用来验证数据层：字段类型是照着
 * core/data/views.js 的返回手写的，改错了探针也不会告诉你。数据层由测试保证。
 */
const FIXTURE = process.argv.includes('--fixture') ? {
  drafts: [
    {
      id: 9001, awemeId: 'v-fixture', videoTitle: '（探针假数据）示例作品',
      replyToCid: 'c-fixture', replyToText: '请问这个工具支持多账号吗？', replyToUid: 'u-fixture',
      text: '支持，配置文件里可以并存多套账号。', personaId: 'casual_friend',
      imagePath: '/tmp/不存在的图.png', createdAt: Date.now() - 3600 * 1000, posted: false,
    },
    {
      id: 9002, awemeId: 'v-fixture', videoTitle: '（探针假数据）示例作品',
      replyToCid: null, replyToText: null, replyToUid: null,
      text: '（这条没有回复对象，用来对比"回复对象"那一行该不该出现）',
      personaId: null, imagePath: null, createdAt: Date.now() - 90 * 1000, posted: false,
    },
    {
      // 必须有一个**不同视频**的条目：只有一组时界面不会加分组壳（那是设计），
      // 于是组头、组内条数、整组勾选、收起这四样在探针里永远渲染不出来
      id: 9003, awemeId: 'v-fixture-2', videoTitle: '（探针假数据）另一个作品',
      replyToCid: 'c-fixture-3', replyToText: '多账号切换后草稿箱会串号吗？', replyToUid: 'u-fixture-3',
      text: '不会，草稿按账号隔离，换号后另一号的草稿整箱消失。',
      personaId: null, imagePath: null, createdAt: Date.now() - 45 * 1000, posted: false,
    },
  ],
  tasks: [
    {
      // 带进度的运行中任务：进度条**只有**在这条上才会渲染，
      // 没有它就没法验证「core 上报 current/total、界面画成条」这条链路
      id: 't0', command: 'getReply', argv: [], label: '批量生成 12 条回复', status: 'running',
      createdAt: Date.now() - 40000, startedAt: Date.now() - 38000, endedAt: null,
      error: null, blockers: [], warnings: ['本日已进行 1 轮，风控概率上升'],
      progress: { text: '第 5/12 条：正在生成', current: 5, total: 12 },
      resultSummary: null, wait: null,
    },
    {
      // 不确定总量的任务：进度条应当走"滚动条纹"而不是 0%
      id: 't5', command: 'get', argv: [], label: '拉取我的作品', status: 'running',
      createdAt: Date.now() - 9000, startedAt: Date.now() - 8000, endedAt: null,
      error: null, blockers: [],
      warnings: [], progress: { text: '正在读取第 2 页' }, resultSummary: null, wait: null,
    },
    {
      id: 't1', command: 'post', argv: [], label: '发布草稿', status: 'waiting',
      createdAt: Date.now() - 5000, startedAt: Date.now() - 3000, endedAt: null, error: null,
      blockers: [], warnings: [], progress: null, resultSummary: null,
      wait: { until: Date.now() + 42000, reason: '距上次写操作不足最小间隔', waitMs: 42000, remainingMs: 42000 },
    },
    {
      id: 't2', command: 'getReply', argv: [], label: '生成回复（示例用户）', status: 'done',
      createdAt: Date.now() - 60000, startedAt: Date.now() - 59000, endedAt: Date.now() - 40000,
      error: null, blockers: [], warnings: [], progress: null,
      resultSummary: { kind: 'object', keys: ['reply', 'source', 'personaId'] }, wait: null,
    },
    {
      id: 't3', command: 'post', argv: [], label: '发布回复', status: 'blocked',
      createdAt: Date.now() - 120000, startedAt: Date.now() - 119000, endedAt: Date.now() - 118000,
      error: '这条评论已经回复过了', blockers: [{ reason: '这条评论已经回复过了', action: 'stop' }],
      warnings: [], progress: null, resultSummary: null, wait: null,
    },
    {
      id: 't4', command: 'get', argv: [], label: '拉取新评论', status: 'pending',
      createdAt: Date.now() - 1000, startedAt: null, endedAt: null, error: null,
      blockers: [], warnings: [], progress: null, resultSummary: null, wait: null,
    },
  ],
} : null;

/** 对应 ipc.js 里 safe() 包出来的形状 */
const ok = (data) => ({ ok: true, data });

/**
 * 写操作的统一响应。
 *
 * 形状与各 handle 的**失败**分支一致（safe() 的 catch、以及 enqueue/config:set
 * 自己返回的 `{ok:false, error}`），所以界面走的是真实的错误渲染路径，
 * 而不是被一个假成功骗过去。
 */
function refused() {
  return { ok: false, error: '探针是只读的，不会执行这个操作 —— 要验证它请真跑一次应用' };
}

/**
 * --fixture 模式下草稿箱的返回，带搜索语义。
 *
 * 过滤必须在"数据层"做而不是让界面自己 filter —— 探针要是把全量原样返回，
 * 「搜索到 N 条」与那个「没有草稿含 X」的空态就永远渲染不出来，
 * 而这两处恰恰是这一轮新加的界面分支。返回形状与 views.listDrafts 逐项对齐。
 */
function fixtureDrafts(q) {
  const key = String(q || '').trim();
  const hit = (d) => !key
    || (d.text || '').includes(key)
    || (d.videoTitle || '').includes(key)
    || (d.replyToText || '').includes(key);
  const items = FIXTURE.drafts.filter(hit);
  return {
    items,
    total: FIXTURE.drafts.length,
    matched: items.length,
    truncated: false,
    q: key,
    accountUid: PROBE_ACCOUNT_UID,
    accountCertain: true,
  };
}

/**
 * channel → 处理函数，返回值就是**最终响应体**（是否包 { ok, data } 一并决定）。
 *
 * 这一点必须照抄 app/main/ipc.js：那里有的端点走 safe()（包成 {ok,data}），
 * 有的直接返回裸对象。桩如果统一包一层，界面按 `r.ok` 读的地方就会全部拿到
 * undefined —— 而"界面按 r.ok 读、主进程返回裸值"恰恰就是本项目里
 * 排序下拉框永远为空的那个 bug。探针要是自己也搞错形状，它就会把真 bug 掩盖成
 * "探针跑通了"，比不做还糟。
 */
function makeRoutes() {
  const views = require('../core/data/views');
  const comments = require('../core/memory/comments');
  const videos = require('../core/memory/videos');
  const prompts = require('../core/prompts');

  return {
    'app:info': () => ({
      version: '0.0.0-probe',
      platform: process.platform,
      // 键必须与 app/main/ipc.js 那个 handler 一一对上：少给一个字段，界面就会
      // 渲染成 "Electron undefined"，而"主进程真漏了字段"是同一个长相 —— 那正好
      // 是探针要抓的 bug，不能被桩自己制造出来。
      electron: process.versions.electron || '—（探针不跑在 Electron 里）',
      node: process.versions.node,
      dataDir: paths.dataDir(),
      dataDirSource: '探针（未经主进程定位，仓库根目录）',
      dataDirFellBack: false,
      appRoot: paths.appRoot(),
      sourceFile: require('../core/userscript').sourcePath(),
      sourceExists: require('../core/userscript').sourceExists(),
      configFile: require('../core/config').describe().file,
      configWarnings: [],
    }),
    // 探针不联网查 release。带 current 是为了与 ipc.js 的失败分支同形状。
    'app:check-update': () => ({ ok: false, current: '0.0.0-probe', error: '探针不联网检查更新' }),
    'account:state': () => {
      // 与 bridge:status 同源（真实 accounts 表）。两处各写一份假账号的话，
      // 侧栏与连接页会报出两个对不上的账号数，而这正是本轮要验的东西。
      const isCur = (a) => String(a.uid) === String(PROBE_ACCOUNT_UID);
      return ok({
        uid: PROBE_ACCOUNT_UID,
        needsChoice: false,
        candidates: [PROBE_ACCOUNT_UID],
        accounts: probeRoster().map(a => ({
          uid: a.uid,
          nickname: a.nickname,
          avatar: a.avatar,
          online: isCur(a),
          current: isCur(a),
        })),
      });
    },
    // 切换账号会改数据库（is_current），探针是只读的 —— 如实拒绝，
    // 不返回假的 {ok:true}（见文件头第 2 条纪律）
    'account:set': refused,
    'app:open-data-dir': refused,
    // 浏览器里没有主进程的剪贴板。如实拒绝而不是假装成功 ——
    // 探针替界面确认一个不存在的成功，比没有探针更糟（见文件头第 2 条纪律）
    'app:copy-text': refused,
    // 与"用户在保存对话框里点了取消"同形状：确实什么都没写出去。
    'data:backup': () => ({ ok: true, canceled: true }),
    // 系统文件选择器在浏览器里没有对应物，空数组等价于"没选"。
    'dialog:pick-images': () => ({ ok: true, paths: [] }),
    'bridge:status': () => fakeStatus(PROBE_ACCOUNT_UID),
    // ipc.js 里 refresh 返回的是裸的 bridge.getStatus()，不是 {ok,data}
    'bridge:refresh': () => fakeStatus(PROBE_ACCOUNT_UID),
    'bridge:open-userscript': refused,
    'bridge:copy-userscript-url': refused,
    'app:open-external': refused,
    // ── 裸返回（ipc.js 里没有 safe() 包）──
    'queue:state': () => ({
      tasks: FIXTURE ? FIXTURE.tasks : [],
      stats: FIXTURE
        ? { counts: { pending: 1, done: 1, blocked: 1, running: 2, waiting: 1 }, total: 6, idle: false, serial: true }
        : { counts: {}, total: 0, idle: true, serial: true },
      policy: policySnapshot(),
    }),
    'policy:stats': () => policySnapshot(),
    'policy:check': (meta) => {
      // 与 ipc.js 同一段逻辑：策略判定之外还要并入"浏览器有没有连上"，
      // 否则发布确认框在探针里少一条硬拦截，界面渲染的就不是真实的分支。
      const r = require('../core/policy').getPolicy().beforeWrite(meta || {});
      const online = !!fakeStatus(PROBE_ACCOUNT_UID).online;
      const check = online ? r : {
        ...r,
        ok: false,
        waitMs: 0,
        hardBlockers: [
          { reason: '浏览器没有连上 —— 到「连接」页确认抖音页面开着且已登录' },
          ...((r && r.hardBlockers) || []),
        ],
      };
      return { ok: true, check };
    },

    // ── safe() 包（{ ok, data }）──
    'data:overview': (o) => ok(views.overview({ scope: o && o.scope, accountUid: PROBE_ACCOUNT_UID })),
    'data:videos': (o) => {
      const limit = Math.max(1, Number((o && o.limit) || 50));
      const items = views.listMyVideos({ limit, accountUid: PROBE_ACCOUNT_UID });
      const total = videos.count({ isMine: true, accountUid: PROBE_ACCOUNT_UID });
      return ok({ items, total, shown: items.length, truncated: total > items.length });
    },
    // 运营对象。参数必须透传：漏掉 order 时排序下拉看起来"选了没反应"，
    // 而那是探针造出来的假象，不是界面 bug
    'data:targets': (o) => ok(views.listTargets({
      order: o && o.order,
      limit: o && o.limit,
      accountUid: PROBE_ACCOUNT_UID,
    })),
    'data:targetStatus': (ids) => ok(views.targetStatus(
      Array.isArray(ids) ? ids : [],
      { accountUid: PROBE_ACCOUNT_UID }
    )),
    'data:video': (id) => ok(views.videoDetail(String(id), { accountUid: PROBE_ACCOUNT_UID })),
    'data:videoStats': (id) => ok(views.videoStats(String(id), { accountUid: PROBE_ACCOUNT_UID })),
    'data:commentOrders': () => ok(comments.ORDER_INFO),
    'data:comments': (id, o) => ok(views.listComments(String(id), {
      filter: o && o.filter, limit: o && o.limit, search: o && o.search, order: o && o.order,
      accountUid: PROBE_ACCOUNT_UID,
    })),
    'data:comment': (cid) => ok(views.commentDetail(String(cid))),
    'data:checkDup': (text) => ok(views.checkDuplicate(text)),
    'data:events': (o) => ok(views.listEvents(o || {})),
    'data:cleanupPreview': (o) => ok(views.cleanupPreview(o || {})),
    'data:userProfile': (uid, o) => ok(views.userProfile(String(uid || ''), { limit: o && o.limit })),
    'data:userEvents': (uid, o) => ok(views.userEvents(String(uid || ''), { limit: o && o.limit })),
    // 探针只读：改用户标签是写操作，如实拒绝
    'user:setNote': refused,
    'data:drafts': (o) => ok(FIXTURE
      ? fixtureDrafts(o && o.q)
      : views.listDrafts({ q: o && o.q, accountUid: PROBE_ACCOUNT_UID })),
    // 数据页的原料。少了这个端点，界面 `window.dy.data.analytics()` 直接抛
    // TypeError → data 永远是 null → 页面永久停在"正在统计…"，
    // 于是整个图表层在没有验证手段的情况下被改动。
    // 参数与 app/main/ipc.js **逐个对齐**（见那边的注释：漏传 dayWindow
    // 的表现是"分段按钮点了数字不动"，两端都不报错）
    'data:analytics': (o) => ok(views.analytics({
      scope: o && o.scope,
      dayWindow: o && o.dayWindow,
      accountUid: PROBE_ACCOUNT_UID,
    })),
    'reply:describe': () => ok(require('../core/reply-source').describe()),
    // 图片预检走**真实**实现，不用假桩。
    // 之前这里是 `checkImage: () => Promise.resolve({ok:true,data:{ok:true}})`,
    // 于是发布确认框对着一张不存在的图照样显示"预检通过" ——
    // 探针在这一点上是在骗人，而"探针骗人"比"没有探针"更糟。
    'reply:check-image': (p) => {
      const { checkImage } = require('../core/comment-image');
      const r = checkImage(String(p || ''));
      return ok({ path: String(p || ''), ...r });
    },
    'reply:cycle-progress': () => ok(require('../core/reply-source').cycleProgress()),
    'reply:reset-cycle': refused,
    'config:describe': () => ok(require('../core/config').describe()),
    'config:set': refused,
    'personas:describe': () => {
      const personas = require('../core/personas');
      return ok({
        effective: personas.effectivePersonas(),
        all: personas.effectivePersonas({ includeDisabled: true }),
        builtin: personas.BUILTIN,
        config: require('../core/config').get('personas'),
      });
    },
    'prompts:list': () => ok(prompts.list()),
    // 读模板与列备份是纯读，走真实实现 —— 否则提示词编辑器这一整块
    // 在探针里永远渲染不出内容。
    'prompts:read': (name) => ok(prompts.read(String(name || ''))),
    'prompts:backups': (name) => ok(prompts.listBackups(String(name || ''))),
    'prompts:save': refused,
    'prompts:validate': (name) => ok(require('../core/prompts').validateAll(name || undefined)),
    'prompts:reset': refused,
    'prompts:restore': refused,

    // ── 队列与草稿的写操作 ──
    'queue:enqueue': refused,
    'queue:cancel': refused,
    'queue:cancel-pending': refused,
    'queue:result': () => ({ ok: true, result: null }),
    'draft:save': refused,
    'draft:delete': refused,
    'draft:delete-many': refused,
    'draft:mark-posted': refused,
    /**
     * 批量改正文：`dryRun` 那一次调用是一次**真正的读**（core 只算不改），
     * 所以探针能验证它 —— 而确认框里"会改动 N 条 + 每一条改成什么"正是
     * 形状最容易错、错了又只有真渲染才看得见的那一处。
     * 账号口径与 ipc.js 一致（PROBE_ACCOUNT_UID 就是 account:state 报的那个号），
     * 否则预览数与列表数对不上，界面看起来像算错了。
     * 真按下去那次（不带 dryRun）照旧如实拒绝。
     */
    'draft:update-many': (ids, patch, opts) => {
      if (!opts || opts.dryRun !== true) return refused();
      // --fixture 的草稿是凭空造的、库里没有这些 id，预览会一律算成"已不在草稿箱"。
      // 那种返回是在骗人，宁可拒绝（见文件头第 2 条纪律）
      if (FIXTURE) {
        return { ok: false, error: '探针的 --fixture 模式里草稿是假数据，批量改正文的预览算不出来 —— 要验这一处请用真库跑探针' };
      }
      const r = require('../core/memory/drafts').updateMany(ids, patch, {
        dryRun: true, accountUid: PROBE_ACCOUNT_UID,
      });
      return ok({
        changed: r.changed.length,
        requested: r.requested,
        skipped: r.skipped,
        preview: r.preview,
      });
    },
  };
}

/** 策略快照。用真实 PolicyEngine，不编造数字 */
function policySnapshot() {
  try {
    const { getPolicy } = require('../core/policy');
    return getPolicy().stats();
  } catch (e) {
    return null;
  }
}

/**
 * 探针用的账号名册（真实 accounts 表）。
 *
 * 读失败必须说出来：静默变空会让连接页显示"一个号都没连上"、侧栏整块账号区消失，
 * 而这两件事看起来都像"数据本来就是这样"。
 */
function probeRoster() {
  try {
    return require('../core/memory/accounts').list();
  } catch (e) {
    console.error(`[probe] 读 accounts 名册失败（连接页会显示成"没有账号"）: ${e.message}`);
    return [];
  }
}

/**
 * 桥接状态。形状照抄 app/main/bridge-manager.js 的 lastStatus：
 * 少一个字段，界面读到 undefined 就会走错分支（`online` 缺失 = 永远"未连接"）。
 *
 * 账号取自**真实的 accounts 表**（本机登录过的号），不编昵称 ——
 * 连接页那张账号卡是排查多账号错乱的第一现场，假数据在这里毫无价值。
 * 只有 --fixture 且一张表都没登记过时，才补一条标明身份的假连接，
 * 目的是让那条渲染路径至少被走过一次。
 */
function fakeStatus(currentUid) {
  const accounts = probeRoster();
  const now = Date.now();

  const connections = accounts.map((a, i) => {
    // 只有一个号真的连着，其余是"页面关掉后还没被回收"的残留连接（alive:false）。
    // 全标成在线等于假装三个浏览器页面同时开着 —— 连接页与侧栏的账号数
    // 就是这么互相打脸的，而 ConnectionView 本来就分「已连接 / 已断开」两组渲染。
    const alive = currentUid == null ? true : String(a.uid) === String(currentUid);
    return {
      site: 'douyin.com',
      id: `probe-${i + 1}`,
      url: 'https://www.douyin.com/',
      title: '抖音',
      account: { nickname: a.nickname, uid: a.uid, avatar: a.avatar, secUid: a.secUid },
      clientVersion: 2,
      alive,
      lastActivity: new Date(alive ? now : now - 26 * 60 * 1000).toISOString(),
    };
  });

  if (FIXTURE && connections.length === 0) {
    connections.push({
      site: 'douyin.com',
      id: 'probe-fixture',
      url: 'https://www.douyin.com/user/self',
      title: '（探针假数据）抖音 · 我的页面',
      account: { nickname: '（假）示例账号', uid: '000000000000', avatar: null },
      clientVersion: 2,
      alive: true,
      lastActivity: new Date().toISOString(),
    });
  }

  const url = `http://127.0.0.1:${port}`;
  return {
    listening: true,
    url,
    userscriptUrl: `${url}/install.user.js`,
    online: connections.some(c => c.alive),
    offlineForMs: 0,
    alert: false,
    connections,
    totalConnections: connections.filter(c => c.alive).length,
    error: null,
  };
}

// ── 探针页面 + window.dy 桩 ──
//
// 桩是**普通脚本**（不是 module），在应用 bundle 之前执行 —— module 是 defer 的，
// 所以顺序有保证。它把 window.dy 的每个方法转成对这个本地服务的 fetch。

function writeProbeFiles(port) {
  // 桩只做转发：**响应体由服务端决定**，与 app/main/ipc.js 一一对应。
  // 在这里再包一层 safe() 是不行的 —— ipc.js 里有的端点包、有的不包，
  // 桩统一处理必然把一半端点的形状弄错，而那种错误恰好会掩盖掉
  // "界面按 r.ok 读、主进程返回裸值"这类真 bug。
  //
  // 这份清单必须与 app/preload/index.js 逐项对齐，由 tests/preload-contract.test.js
  // 钉住。上一版桩里写了一批 `noop = () => ({ok:true})`，于是界面会弹出
  // 「已加入队列」「设置已保存」而什么都没发生 —— 桩替界面确认了一个不存在的成功。
  // 现在写操作也照样转发给服务端，拒绝的话术只在 refused() 一处。
const stub = `
// 由 scripts/_probe.js 生成，勿手改（改 preload 后跑测试会告诉你这里漏了什么）
const BASE = 'http://127.0.0.1:${port}/api/';
const call = (ch, ...args) =>
  fetch(BASE + ch, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  }).then(r => r.json());
// 主进程推送（bridge:status-changed / queue:changed）在浏览器里没有对应物：
// 探针不会自己变，要看新状态就点界面上的「重新检测」或重新加载页面。
const unsub = () => () => {};

window.dy = {
  info: () => call('app:info'),
  openExternal: (url) => call('app:open-external', url),
  quit: () => call('app:quit'),

  account: {
    state: () => call('account:state'),
    set: (uid) => call('account:set', uid),
  },

  app: {
    checkUpdate: () => call('app:check-update'),
    copyText: (text) => call('app:copy-text', text),
    openDataDir: () => call('app:open-data-dir'),
    backupData: () => call('data:backup'),
  },

  bridge: {
    status: () => call('bridge:status'),
    refresh: () => call('bridge:refresh'),
    openUserscript: () => call('bridge:open-userscript'),
    copyUserscriptUrl: () => call('bridge:copy-userscript-url'),
    onStatusChanged: unsub,
  },

  config: {
    describe: () => call('config:describe'),
    set: (patch) => call('config:set', patch),
  },

  queue: {
    state: () => call('queue:state'),
    enqueue: (spec) => call('queue:enqueue', spec),
    cancel: (id) => call('queue:cancel', id),
    cancelPending: () => call('queue:cancel-pending'),
    result: (id) => call('queue:result', id),
    onChanged: unsub,
  },

  policy: {
    stats: () => call('policy:stats'),
    check: (meta) => call('policy:check', meta),
  },

  data: {
    overview: (opts) => call('data:overview', opts),
    videos: (limit) => call('data:videos', limit),
    targets: (opts) => call('data:targets', opts),
    targetStatus: (ids) => call('data:targetStatus', ids),
    video: (awemeId) => call('data:video', awemeId),
    videoStats: (awemeId) => call('data:videoStats', awemeId),
    comments: (awemeId, opts) => call('data:comments', awemeId, opts),
    comment: (cid) => call('data:comment', cid),
    checkDup: (text) => call('data:checkDup', text),
    events: (opts) => call('data:events', opts),
    cleanupPreview: (opts) => call('data:cleanupPreview', opts),
    userProfile: (uid, opts) => call('data:userProfile', uid, opts),
    userEvents: (uid, opts) => call('data:userEvents', uid, opts),
    commentOrders: () => call('data:commentOrders'),
    drafts: (opts) => call('data:drafts', opts),
    analytics: (opts) => call('data:analytics', opts),
  },

  user: {
    setNote: (uid, patch) => call('user:setNote', uid, patch),
  },

  draft: {
    save: (spec) => call('draft:save', spec),
    remove: (id) => call('draft:delete', id),
    removeMany: (ids) => call('draft:delete-many', ids),
    updateMany: (ids, patch, opts) => call('draft:update-many', ids, patch, opts),
    markPosted: (id) => call('draft:mark-posted', id),
  },

  personas: {
    describe: () => call('personas:describe'),
  },

  prompts: {
    list: () => call('prompts:list'),
    read: (name) => call('prompts:read', name),
    save: (name, text) => call('prompts:save', name, text),
    validate: (name) => call('prompts:validate', name),
    reset: (name) => call('prompts:reset', name),
    backups: (name) => call('prompts:backups', name),
    restore: (name, file) => call('prompts:restore', name, file),
  },

  reply: {
    describe: () => call('reply:describe'),
    checkImage: (p) => call('reply:check-image', p),
    cycleProgress: () => call('reply:cycle-progress'),
    resetCycle: (section) => call('reply:reset-cycle', section),
  },

  pickImages: () => call('dialog:pick-images'),
};
console.log('[probe] window.dy 就绪');
`;

  fs.writeFileSync(path.join(DIST, '__stub.js'), stub, 'utf8');

  // 复用构建产物里的 asset 名
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const withStub = html
    .replace('<head>', '<head>\n    <script src="./__stub.js"></script>')
    .replace('<div id="root">', '<div id="root">');
  fs.writeFileSync(path.join(DIST, '__probe.html'), withStub, 'utf8');
}

function selfCheckRoutes(routes) {
  // 位置参数只能猜一个"形状正确但不存在"的样本：真正在跑的库里有视频时用它。
  let sample = null;
  try {
    sample = (require('../core/data/views').listMyVideos({ limit: 1 })[0] || {}).awemeId || null;
  } catch (e) { /* 读不动就当没有样本 */ }
  if (!sample && FIXTURE && FIXTURE.drafts.length) sample = FIXTURE.drafts[0].awemeId;
  if (!sample) sample = 'probe-sample-aweme-id';

  const bad = [];
  const argGuess = [];
  for (const [ch, fn] of Object.entries(routes)) {
    if (WRITE_CHANNELS.has(ch)) continue;   // 写通道一律如实拒绝，不必试
    try {
      fn(sample, {});
    } catch (e) {
      // 换一个参数再试一次。自检猜的位置参数未必合用（prompts:read 要的是模板
      // 文件名而不是 awemeId），**只有换参数也不改变的异常**才说明端点自己坏了。
      let again = null;
      try { fn(undefined, {}); } catch (e2) { again = e2; }
      if (again && again.message === e.message) bad.push(`  ${ch} → ${e.message}`);
      else argGuess.push(ch);
    }
  }
  if (!bad.length) {
    console.log(`[probe] 自检通过：${Object.keys(routes).length} 个端点逐个调用，没有一处抛异常`
      + (argGuess.length ? `（${argGuess.length} 个端点因自检猜的位置参数不对而报错，已跳过：${argGuess.join('、')}）` : ''));
    return;
  }
  // 抛异常与"返回了空数据"是两件事：前者一定是探针或 core 坏了。
  // 不报出来的话，它会以"界面显示读取失败"的样子出现，然后被当成界面的问题去改界面。
  console.warn(`[probe] ⚠️ 自检发现 ${bad.length} 个端点抛异常（界面会显示成"读取失败"）：\n${bad.join('\n')}`);
}

function startServer(port) {
  const routes = makeRoutes();

  // 与主进程的通道清单对账。这一步是 U0 的机制化：上一版探针手抄了一份端点清单，
  // 主进程后来加了 data:analytics 而这里没有，界面就永久停在"正在统计…"，
  // 而探针"跑起来了"看起来一切正常 —— 整个图表层差点就在没有验证手段的情况下被改。
  const ipcChannels = readIpcChannels();
  const missing = [];
  for (const ch of ipcChannels) {
    if (routes[ch]) continue;
    if (WRITE_CHANNELS.has(ch)) { routes[ch] = refused; continue; }
    missing.push(ch);
  }
  const stale = Object.keys(routes).filter(ch => !ipcChannels.has(ch));

  if (missing.length) {
    console.warn(`[probe] ⚠️ 主进程注册了但探针没有端点的通道 ${missing.length} 个：\n  ${missing.join('\n  ')}`);
    console.warn('[probe] 界面调用它们会收到"探针没有实现端点" —— 请补一个只读实现，或加进 WRITE_CHANNELS');
  }
  if (stale.length) {
    console.warn(`[probe] 探针有而主进程没有的端点（ipc 通道已删？）：${stale.join('、')}`);
  }

  selfCheckRoutes(routes);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
    };

    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

    if (url.pathname.startsWith('/api/')) {
      const channel = decodeURIComponent(url.pathname.slice(5));
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        // **先算出响应体，再写一次**。旧版在 try 里 writeHead+end、catch 里又
        // writeHead 一次 —— 头已经发出去了，第二次直接抛 ERR_HTTP_HEADERS_SENT，
        // 于是"端点抛错"时客户端收到的是**空响应体**，而不是 ipc.js 的 safe()
        // 那个 {ok:false,error}。界面于是走 JSON 解析失败的分支而不是错误渲染分支：
        // 探针在最能证明自己的那一刻恰恰是错的。
        let payload;
        try {
          const args = body ? JSON.parse(body) : [];
          const fn = routes[channel];
          payload = fn ? fn(...args) : { ok: false, error: `探针没有实现端点 ${channel}` };
          // 处理器返回 undefined 时 JSON.stringify 会产出 undefined，
          // res.end(undefined) 就是空响应体 —— 同样是"界面读到 undefined"那一类
          if (payload === undefined) {
            payload = { ok: false, error: `端点 ${channel} 返回了 undefined` };
          }
        } catch (e) {
          payload = { ok: false, error: e.message };
        }

        let text;
        try {
          text = JSON.stringify(payload);
        } catch (e) {
          text = JSON.stringify({ ok: false, error: `响应无法序列化：${e.message}` });
        }
        res.writeHead(200, { ...cors, 'content-type': 'application/json; charset=utf-8' });
        res.end(text);
      });
      return;
    }

    // 静态文件
    const rel = url.pathname === '/' ? '/__probe.html' : url.pathname;
    const file = path.join(DIST, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    const type = file.endsWith('.js') ? 'text/javascript'
      : file.endsWith('.css') ? 'text/css' : 'text/html';
    res.writeHead(200, { ...cors, 'content-type': `${type}; charset=utf-8` });
    res.end(fs.readFileSync(file));
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[probe] 探针地址 http://127.0.0.1:${port}/__probe.html`);
    // 报**解析后的**路径而不是写死"仓库根目录"：DOUYIN_STORAGE_DIR 能把它指到别处，
    // 而这行是验证时唯一一处说明"数据是从哪个库读的"的地方 —— 它说错，
    // 就会让人对着自己的真库以为在读一份临时副本。
    console.log(`[probe] 数据来自真实 core（${paths.dbFile()}），只读`);
  });
  return server;
}

const portArg = process.argv.indexOf('--port');
const port = portArg > -1 ? Number(process.argv[portArg + 1]) : 8791;

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('[probe] 渲染层还没构建 —— 先跑 npm run app:renderer');
  process.exit(1);
}

writeProbeFiles(port);
startServer(port);
