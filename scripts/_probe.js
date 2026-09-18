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

const http = require('http');
const fs = require('fs');
const path = require('path');

const paths = require('../core/paths');

const ROOT = paths.appRoot();
const DIST = path.join(ROOT, 'app', 'renderer', 'dist');

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

/**
 * channel → 处理函数，返回值就是**最终响应体**（是否包 { ok, data } 一并决定）。
 *
 * 这一点必须照抄 app/main/ipc.js：那里有的端点走 safe()（包成 {ok,data}），
 * 有的直接返回裸对象。桩如果统一包一层，界面按 `r.ok` 读的地方就会全部拿到
 * undefined —— 而"界面按 r.ok 读、主进程返回裸值"恰恰就是本项目里
 * 排序下拉框永远为空的那个 bug。探针要是自己也搞错形状，它就会把真 bug 掩盖成
 * "探针跑通了"，比不做还糟。
 *
 * 顺带一提：用 POST 而不是 GET 是因为参数里有对象（opts），
 * 序列化成 JSON 最省事，也最接近结构化克隆的语义。
 */
function makeRoutes() {
  const views = require('../core/data/views');
  const comments = require('../core/memory/comments');
  const videos = require('../core/memory/videos');

  /** 对应 ipc.js 里 safe() 包出来的形状 */
  const ok = (data) => ({ ok: true, data });

  return {
    'app:info': () => ({
      version: '0.0.0-probe',
      dataDir: paths.dataDir(),
      sourceFile: require('../core/userscript').sourcePath(),
      sourceExists: require('../core/userscript').sourceExists(),
      configFile: require('../core/config').describe().file,
      configWarnings: [],
    }),
    'bridge:status': () => ({
      listening: true, online: true, url: 'http://127.0.0.1:1', totalConnections: 1,
      userscriptUrl: 'http://127.0.0.1:1/install.user.js', connections: [], error: null,
    }),
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
      const r = require('../core/policy').getPolicy().beforeWrite(meta || {});
      return { ok: true, check: r };
    },

    // ── safe() 包（{ ok, data }）──
    'data:overview': () => ok(views.overview()),
    'data:videos': (o) => {
      const limit = Math.max(1, Number((o && o.limit) || 50));
      const items = views.listMyVideos({ limit });
      const total = videos.count({ isMine: true });
      return ok({ items, total, shown: items.length, truncated: total > items.length });
    },
    'data:video': (id) => ok(views.videoDetail(String(id))),
    'data:videoStats': (id) => ok(views.videoStats(String(id))),
    'data:commentOrders': () => ok(comments.ORDER_INFO),
    'data:comments': (id, o) => ok(views.listComments(String(id), {
      filter: o && o.filter, limit: o && o.limit, search: o && o.search, order: o && o.order,
    })),
    'data:comment': (cid) => ok(views.commentDetail(String(cid))),
    'data:drafts': () => ok(FIXTURE ? FIXTURE.drafts : views.listDrafts()),
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
    'config:describe': () => ok(require('../core/config').describe()),
    'personas:describe': () => {
      const personas = require('../core/personas');
      return ok({
        effective: personas.effectivePersonas(),
        all: personas.effectivePersonas({ includeDisabled: true }),
        builtin: personas.BUILTIN,
        config: require('../core/config').get('personas'),
      });
    },
    'prompts:list': () => ok(require('../core/prompts').list()),
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

// ── 探针页面 + window.dy 桩 ──
//
// 桩是**普通脚本**（不是 module），在应用 bundle 之前执行 —— module 是 defer 的，
// 所以顺序有保证。它把 window.dy 的每个方法转成对这个本地服务的 fetch。

function writeProbeFiles(port) {
  // 桩只做转发：**响应体由服务端决定**，与 app/main/ipc.js 一一对应。
// 在这里再包一层 safe() 是不行的 —— ipc.js 里有的端点包、有的不包，
// 桩统一处理必然把一半端点的形状弄错，而那种错误恰好会掩盖掉
// "界面按 r.ok 读、主进程返回裸值"这类真 bug。
const stub = `
// 由 scripts/_probe.js 生成，勿手改
const BASE = 'http://127.0.0.1:${port}/api/';
const call = (ch, ...args) =>
  fetch(BASE + ch, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  }).then(r => r.json());
const noop = () => Promise.resolve({ ok: true });
const unsub = () => () => {};

window.dy = {
  info: () => call('app:info'),
  openExternal: noop,
  quit: noop,
  bridge: {
    status: () => call('bridge:status'),
    refresh: noop,
    onStatusChanged: unsub,
    copyUserscriptUrl: noop,
    openUserscript: noop,
  },
  queue: {
    state: () => call('queue:state'),
    onChanged: unsub,
    enqueue: noop,
    cancel: noop,
    cancelPending: noop,
    result: () => Promise.resolve({ ok: true, result: null }),
  },
  policy: { stats: () => call('policy:stats'), check: (m) => call('policy:check', m) },
  data: {
    overview: () => call('data:overview'),
    videos: (l) => call('data:videos', l),
    video: (id) => call('data:video', id),
    videoStats: (id) => call('data:videoStats', id),
    commentOrders: () => call('data:commentOrders'),
    comments: (id, o) => call('data:comments', id, o),
    comment: (cid) => call('data:comment', cid),
    drafts: () => call('data:drafts'),
  },
  draft: { save: noop, markPosted: noop, remove: noop },
  reply: {
    describe: () => call('reply:describe'),
    cycleProgress: () => call('reply:cycle-progress'),
    checkImage: (p) => call('reply:check-image', p),
  },
  config: { describe: () => call('config:describe'), set: noop },
  personas: { describe: () => call('personas:describe') },
  prompts: { list: () => call('prompts:list') },
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

function startServer(port) {
  const routes = makeRoutes();

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
        const args = body ? JSON.parse(body) : [];
        const fn = routes[channel];
        if (!fn) {
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `探针没有实现端点 ${channel}` }));
          return;
        }
        try {
          // 处理函数返回的就是最终响应体，这里不再包一层
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify(fn(...args)));
        } catch (e) {
          // 抛错时兜底成 safe() 的形状：只读端点抛错本来就该是这个形状
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
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
    console.log('[probe] 数据来自真实 core（仓库根目录的 storage/douyin.db），只读');
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
