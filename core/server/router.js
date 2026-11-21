// core/server/router.js — HTTP API 路由（/call, /status, /health）
//
// 通道只有一条：**HTTP 长轮询**。原先还有一条 WebSocket 通道（core/server/ws-hub.js），
// 已连同协议一起删除 —— 油猴脚本从来只用长轮询（它内部的 WebSocket 是连抖音原生 IM 的），
// 而那条 WS 通道既无鉴权（hello 不校验 token）、又无来源校验，任何网页里的 JS
// 都能把自己注册成"douyin.com 的连接"，从而收到发布表达式的原文并回一份假结果。
// 一扇没有正当用户、却向任意来源开着的门，留着就只有风险。
//
// 多账号（从 main 分支移植）
// -------------------------
// 一个浏览器连接 = 一个 channel（`site#uid`）。/api/call 的 `account` 指定要落到哪个号，
// `opType:'write'` 会强制要求显式账号，并把期望账号随 eval 一起下发；油猴端执行前
// 比对当前登录 uid，不一致就拒绝 —— 这是「界面显示 A、实际以 B 发出」的最后一道护栏。
// 未指定账号的读操作按 lastServedAt 轮换，每个号独立冷却。
//
// 认证：/api/call, /api/connect, /api/poll, /api/result 需要 token
//       /api/health, /api/status 公开（只读监控）
// CORS：仅允许 localhost 来源

const { randomUUID } = require('crypto');
const {
  validateCallRequest,
  buildEvalMessage,
  channelOf,
  parseChannel,
  coerceConnAccount,
  accountUidOf,
} = require('../shared/protocol');
const { safeSerialize } = require('../shared/serialize');
const logger = require('../runtime/logger');

// 允许的 CORS 来源
const ALLOWED_ORIGINS = [
  'http://127.0.0.1',
  'http://localhost',
  'https://www.douyin.com',
  'https://douyin.com',
];

class Router {
  /**
   * @param {object} options
   * @param {import('./registry').ConnectionRegistry} options.registry
   * @param {number} options.requestTimeout
   * @param {string} options.token - 访问令牌
   * @param {object} [options.accounts] - config.accounts（aliases / rotation）。桌面端暂无此配置
   */
  constructor(options) {
    this.registry = options.registry;
    this.requestTimeout = options.requestTimeout || 30000;
    this.token = options.token || '';
    // HTTP 请求体上限（字节）。抖音搜索结果等大响应可能远超 1MB，
    // 默认 64MB，可用 config.json 的 bridge.maxBodySize 调整。
    this.maxBodySize = options.maxBodySize || 64 * 1024 * 1024;

    const accounts = options.accounts || {};
    this.aliases = accounts.aliases || {};
    this.rotation = {
      enabled: !(accounts.rotation && accounts.rotation.enabled === false),
      cooldownMs: (accounts.rotation && accounts.rotation.cooldownMs) || 15000,
    };

    /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout, expectAccount: string|null, channel: string }>} */
    this._pending = new Map();

    // HTTP 轮询队列：channel → [{ msgId, expression, awaitPromise, expectAccount }]
    this._pollQueue = new Map();
    // HTTP 轮询等待者：channel → [{ res, timer }]
    this._pollWaiters = new Map();
  }

  /** uid → 别名；未配置别名时回退 uid 本身 */
  _aliasOf(account) {
    if (!account) return '(未识别)';
    return this.aliases[account] || account;
  }

  /** 供错误提示与 /api/status 使用的账号清单 */
  _availableAccounts(site) {
    return this.registry.accountsOf(site).map(a => ({
      account: a.account,
      nickname: a.nickname || '',
      alias: this._aliasOf(a.account),
      channel: a.channel,
      lastServedAt: a.lastServedAt,
      lastWriteAt: a.lastWriteAt,
    }));
  }

  /**
   * 为一次请求选定连接。
   *
   * 规则（多账号的核心约束）：
   *  - 指定了 account → 必须精确命中，否则报错。绝不回退到别的账号。
   *  - 未指定 + 写操作 → 只有一个可用账号时才放行；多个账号则要求显式指定。
   *  - 未指定 + 读操作 → 按账号轮换。
   *  - 没有任何连接时，读操作仍排进 site 通道等长轮询（保持改造前行为：
   *    调用方最终拿到"超时"而不是立刻被拒；期间浏览器连上还能接走）。
   *
   * @returns {{ conn: object, channel: string } | { conn: null, channel: string, deferred: true } | { status: number, code: string, error: string, available: object[] }}
   */
  _selectConn(site, account, opType) {
    const available = () => this._availableAccounts(site);

    if (account) {
      // --account 支持 uid 或昵称：本地名册解析不出的昵称也要能命中在线连接。
      // 先按 uid/channel 精确查，再按昵称唯一匹配；绝不回退到"随便挑一个"。
      let conn = this.registry.getAccount(site, account);
      if (!conn) {
        const hit = this.registry.accountsOf(site).filter(a => a.nickname && a.nickname === account);
        if (hit.length === 1) conn = this.registry.getAccount(site, hit[0].account);
      }
      if (conn) return { conn, channel: conn.channel };
      return {
        status: 404,
        code: 'account_not_connected',
        error: `账号 "${this._aliasOf(account)}" 未连接`,
        available: available(),
      };
    }

    if (opType === 'write') {
      const online = this.registry.accountsOf(site);
      if (online.length > 1) {
        return {
          status: 409,
          code: 'account_required',
          error: `当前有 ${online.length} 个账号在线，写操作必须用 --account 显式指定`,
          available: available(),
        };
      }
      if (online.length === 1) {
        const conn = this.registry.getAccount(site, online[0].account);
        if (conn) return { conn, channel: conn.channel };
      }
      return { status: 503, code: 'no_connection', error: this._noConnMsg(site), available: [] };
    }

    // 读操作：轮换。有账号时只在账号连接里轮换；没有账号时退回未识别连接。
    const conn = this.rotation.enabled
      ? this.registry.pickForRead(site, this.rotation.cooldownMs)
      : (this.registry.aliveOf(site)[0] || null);
    if (conn) return { conn, channel: conn.channel };

    // 零连接：保持既有"排队 → 超时"语义（测试与旧客户端都依赖这条）
    return { conn: null, channel: channelOf(site, ''), deferred: true };
  }

  /** 无连接时的提示：把最可能的原因（未登录）直接写出来，别让人去猜 */
  _noConnMsg(site) {
    return `无客户端连接 (${site}) — 确认浏览器已登录对应账号并打开站点页面（未登录的标签页不会连接）`;
  }

  /**
   * 安全发送 JSON 响应（处理 BigInt 序列化）
   */
  _sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safeSerialize(data)));
  }

  /**
   * 处理 HTTP 请求
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse} res
   */
  async handle(req, res) {
    try {
      // WebSocket 升级请求：明确拒绝，不能静默返回。
      // 改造前这里是 `return`（交给已删除的 ws-hub 处理）—— 现在没有任何东西接管
      // 这个 socket，客户端只会看到连上之后永远没响应。返回 426 让旧客户端
      // 立刻知道该走 HTTP 长轮询。
      if (req.headers.upgrade && String(req.headers.upgrade).toLowerCase() === 'websocket') {
        res.writeHead(426, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: 'WebSocket 通道已移除 —— 请使用 HTTP 长轮询（POST /api/connect + GET /api/poll）',
        }));
        return;
      }

      // URL 解析必须在 try 内：`GET //` 这类畸形请求目标会让 new URL 抛
      // TypeError: Invalid URL，而调用方（create-server）没有 handle() 的
      // .catch() —— 抛出去就是未处理拒绝，整个应用崩掉。
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const path = url.pathname;
      const method = req.method.toUpperCase();

      // CORS：仅允许已知来源（localhost + douyin.com）
      const origin = req.headers.origin || '';
      if (ALLOWED_ORIGINS.some(o => origin.startsWith(o)) || !origin) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }

      if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // 公开端点：无需认证
      if (method === 'GET' && path === '/api/health') {
        return this._health(res);
      }
      if (method === 'GET' && path === '/api/status') {
        return this._status(res);
      }

      // 受保护端点：需要 token 认证
      if (!this._authenticate(req, res)) return;

      if (method === 'POST' && path === '/api/call') {
        return await this._call(req, res);
      }
      if (method === 'POST' && path === '/api/connect') {
        return await this._connect(req, res);
      }
      if (method === 'GET' && path === '/api/poll') {
        return await this._poll(url, res);
      }
      if (method === 'POST' && path === '/api/result') {
        return await this._result(req, res);
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    } catch (e) {
      logger.error(`[router] Unhandled error: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }
  }

  /**
   * Token 认证检查
   * 支持 Authorization: Bearer <token> 或 ?token=<token> 查询参数
   */
  _authenticate(req, res) {
    if (!this.token) return true; // 未配置 token 则跳过认证

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const authHeader = req.headers.authorization || '';
    const queryToken = url.searchParams.get('token') || '';

    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : queryToken;

    if (token !== this.token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized — 无效的 access token' }));
      return false;
    }
    return true;
  }

  _health(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      uptime: Math.floor(process.uptime()),
      version: '1.0.0',
      connections: this.registry.totalConnections,
    }));
  }

  _status(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      connections: this.registry.list(),
      accounts: this._accountsSummary(),
      totalConnections: this.registry.totalConnections,
      uptime: Math.floor(process.uptime()),
    }));
  }

  /** 按站点分组的账号快照（合并别名），供 /api/status 与连接页使用 */
  _accountsSummary() {
    const out = {};
    for (const [site, conns] of Object.entries(this.registry.list())) {
      for (const c of conns) {
        if (!out[site]) out[site] = [];
        out[site].push({
          // 连接的身份就是账号名：别名优先，没设别名时退回 uid
          id: this.aliases[c.uid] || c.uid || c.id,
          account: c.uid || '',
          nickname: c.nickname || '',
          clientVersion: c.clientVersion,
          // 区别于 _aliasOf：这里不把 uid 当别名回填，否则
          // `accounts` 输出里"别名"列和 uid 列长得一模一样，看不出谁没设别名
          alias: this.aliases[c.uid] || null,
          channel: c.channel,
          connId: c.id,
          alive: c.alive,
          lastActivity: c.lastActivity,
          lastServedAt: c.lastServedAt,
          lastWriteAt: c.lastWriteAt,
        });
      }
    }
    return out;
  }

  async _call(req, res) {
    // 解析 body
    const body = await this._parseBody(req, res);
    if (body === null) return;

    const result = validateCallRequest(body);
    if (!result.valid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: result.error }));
      return;
    }

    const { site, account, expression, awaitPromise, opType, timeout } = result.data;
    const msgId = randomUUID();
    const effectiveTimeout = timeout || this.requestTimeout;

    // 选连接：多账号的准入校验都在这里
    const selected = this._selectConn(site, account, opType);
    if (selected.error) {
      this._sendJson(res, selected.status, {
        ok: false,
        error: selected.error,
        code: selected.code,
        available: selected.available,
      });
      return;
    }

    const conn = selected.conn || null;
    const channel = selected.channel;
    // 写操作把期望账号带给油猴端做二次校验；读操作不需要
    const expectAccount = opType === 'write' && conn ? (conn.uid || null) : null;

    // 记账：写会先把该账号排到读轮换的队尾
    if (conn) {
      if (opType === 'write') this.registry.markWrite(conn.id);
      else this.registry.markServed(conn.id);
    }

    // pending 里带一份 state（不只是 Promise）：/api/result 要把油猴回报的
    // 实际执行账号写回来，零连接时排队的读请求才拿得到归属。
    const makePending = () => {
      const state = { resolve: null, reject: null, timer: null, expectAccount, channel, account: null };
      const promise = new Promise((resolve, reject) => {
        state.resolve = resolve;
        state.reject = reject;
        state.timer = setTimeout(() => {
          this._pending.delete(msgId);
          // 超时后把还在队列里的副本摘掉，避免下一个 poll 又把它取走执行
          const queue = this._pollQueue.get(channel);
          if (queue) {
            const idx = queue.findIndex(c => c.msgId === msgId);
            if (idx !== -1) queue.splice(idx, 1);
            if (queue.length === 0) this._pollQueue.delete(channel);
          }
          reject(new Error(`Request timeout after ${effectiveTimeout}ms — no polling client connected`));
        }, effectiveTimeout);
        this._pending.set(msgId, state);
      });
      return { promise, state };
    };

    // 方式1：HTTP 轮询 — 有等待中的 poll 请求 → 立刻把命令塞进它的响应里
    const waiter = this._takeWaiter(channel);
    if (waiter) {

      const { promise: pendingPromise, state } = makePending();
      waiter.res.writeHead(200, { 'Content-Type': 'application/json' });
      waiter.res.end(JSON.stringify(buildEvalMessage(msgId, expression, awaitPromise, expectAccount)));

      try {
        const value = await pendingPromise;
        this._sendJson(res, 200, {
          ok: true, value, connection: 'polling',
          account: state.account || (conn ? conn.uid || null : null), channel,
        });
        return;
      } catch (e) {
        this._sendJson(res, 503, { ok: false, error: e.message });
        return;
      }
    }

    // 方式2：无等待者 → 放入队列，等 poll 来取
    if (!this._pollQueue.has(channel)) this._pollQueue.set(channel, []);
    this._pollQueue.get(channel).push({ msgId, expression, awaitPromise, expectAccount });

    const { promise: pendingPromise, state } = makePending();
    try {
      const value = await pendingPromise;
      this._sendJson(res, 200, {
        ok: true, value, connection: 'polling-queued',
        account: state.account || (conn ? conn.uid || null : null), channel,
      });
    } catch (e) {
      this._sendJson(res, 503, { ok: false, error: e.message });
    }
  }

  // ── HTTP 轮询：注册 ──
  async _connect(req, res) {
    const body = await this._parseBody(req, res);
    if (body === null) return;
    const site = body.site;
    if (!site) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'site required' }));
      return;
    }

    // 账号信息是外部输入，只在这里消毒一次：注册表与 accounts 名册用同一份，
    // 否则界面上看到的昵称与库里存的那份会有出入（长度、头像协议各管一段）。
    // 兼容两种上报：桌面端旧脚本的 account 对象，以及 main 分支的 account uid 字符串。
    const account = coerceConnAccount(body.account, body.nickname);
    const uid = account ? account.uid : '';

    // 换号重注册：客户端带上自己上一条的 connId，精确清掉，避免旧通道残留
    // （按 site 清理会误伤同站点的其他账号，所以只能由客户端指明自己是谁）。
    if (body.prevId) {
      this.registry.unregister(String(body.prevId));
      // 挂在旧连接上的长轮询也必须结束：否则它仍留在 waiters 里，
      // 后续发往旧账号的命令会被塞进这个"页面已经换号"的响应。
      this._dropWaitersForConn(String(body.prevId));
    }

    // 清理僵尸连接：作用域是 channel 而不是 site —— 按 site 清理会把
    // 同站点的其他账号一起删掉（第二个账号一连上就踢掉第一个）。
    this.registry.removeStalePolling(site, uid);
    // 同一 channel 的旧 waiter 如果指向已不存在的连接，也一并结束。
    this._dropDeadWaiters(channelOf(site, uid));

    const meta = {
      // 完整对象用于界面展示；uid 单独存在 conn 上用于路由
      account: account || undefined,
      nickname: typeof body.nickname === 'string' ? body.nickname : (account ? account.nickname : ''),
      clientVersion: body.clientVersion,
      url: body.url || '',
      title: body.title || '',
      userAgent: body.userAgent || '',
    };

    // 账号名册：把"这个 uid 是哪个昵称/头像"落库 —— 作品列表的账号标注、
    // 发布链路的归属比对都靠它。上报里没有 uid（未登录/旧脚本）就跳过。
    if (account && account.uid) {
      try {
        require('../memory/accounts').upsert(account);
      } catch (e) {
        logger.warn(`[router] 登记连接账号失败: ${e.message}`);
      }
    }

    const conn = this.registry.register(site, meta);
    // 把脚本版本与账号打进日志：调账号相关问题时，这行能立刻区分
    // "浏览器里是旧脚本"（clientVersion=null）和"新脚本但探测失败"（uid 空）
    logger.info(`[router] poll client: ${conn.channel} (uid=${uid || '未识别'}, nickname=${conn.nickname || '空'}, clientVersion=${conn.clientVersion == null ? '未上报' : conn.clientVersion})`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: conn.id, channel: conn.channel, account: conn.uid || '' }));
  }

  /**
   * 取一个可用的 poll waiter。
   *
   * 长轮询的等待请求不会因为注册表里删掉连接而自动消失（页面没关、XHR 没断），
   * 所以取之前要确认它对应的 connId 仍然存在。失效的直接结束成 idle 并丢弃 ——
   * 绝不能把命令交给一个已经换号/关页面的 socket。
   *
   * @param {string} channel
   * @returns {{res: object, timer: NodeJS.Timeout, connId: string}|null}
   */
  _takeWaiter(channel) {
    const waiters = this._pollWaiters.get(channel);
    if (!waiters) return null;
    while (waiters.length > 0) {
      const w = waiters.shift();
      if (waiters.length === 0) this._pollWaiters.delete(channel);
      // 同账号可能开着多个标签页：精确 connId 已被同 channel 的新连接顶掉时，
      // 只要这个 channel 还有连接，旧标签页仍可服务（写操作另有 fresh whoami 校验）。
      if (!w.connId || this.registry.getById(w.connId) || this.registry.getByChannel(channel)) return w;
      clearTimeout(w.timer);
      if (!w.res.headersSent) {
        w.res.writeHead(200, { 'Content-Type': 'application/json' });
        w.res.end(JSON.stringify({ ok: true, type: 'idle' }));
      }
    }
    return null;
  }

  /** 结束挂在某个 connId 上的全部 waiter（换号重注册时调用） */
  _dropWaitersForConn(connId) {
    if (!connId) return;
    for (const [channel, waiters] of [...this._pollWaiters.entries()]) {
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].connId !== connId) continue;
        const w = waiters[i];
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        if (!w.res.headersSent) {
          w.res.writeHead(200, { 'Content-Type': 'application/json' });
          w.res.end(JSON.stringify({ ok: true, type: 'idle' }));
        }
      }
      if (waiters.length === 0) this._pollWaiters.delete(channel);
    }
  }

  /** 结束某 channel 上指向已消失连接的 waiter（page 刷新/重连） */
  _dropDeadWaiters(channel) {
    const waiters = this._pollWaiters.get(channel);
    if (!waiters) return;
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (!w.connId || this.registry.getById(w.connId)) continue;
      waiters.splice(i, 1);
      clearTimeout(w.timer);
      if (!w.res.headersSent) {
        w.res.writeHead(200, { 'Content-Type': 'application/json' });
        w.res.end(JSON.stringify({ ok: true, type: 'idle' }));
      }
    }
    if (waiters.length === 0) this._pollWaiters.delete(channel);
  }

  /**
   * 从队列取一条待执行命令。
   *
   * channel 精确匹配优先；没有时回退到 site 桶。site 桶里只会有"零连接时到达
   * 的读请求"和旧脚本（不认识账号）的请求 —— 写入在没有连接时直接拒绝，不会排进来。
   * 因此任意识别出账号的 channel 都可以接走它。
   *
   * @param {string} channel
   * @returns {object|null}
   */
  _shiftQueued(channel) {
    const take = (key) => {
      const q = this._pollQueue.get(key);
      if (!q || q.length === 0) return null;
      const cmd = q.shift();
      if (q.length === 0) this._pollQueue.delete(key);
      return cmd;
    };
    const own = take(channel);
    if (own) return own;
    const { site, account } = parseChannel(channel);
    return account ? take(site) : null;
  }

  /**
   * 解析 /api/poll 的通道。
   *
   * 优先级：显式 channel > connId 反查 > site+account > 单连接站点 > site 本身。
   * 兼容三种客户端：
   *   - 新版脚本：?channel=site%23uid&id=…
   *   - 桌面端旧脚本：?site=…&id=…（id 反查到 channel）
   *   - 测试/最小客户端：?site=…（单连接时自动落到该连接）
   */
  _resolvePollChannel(url) {
    const channelParam = url.searchParams.get('channel');
    if (channelParam) return channelParam;

    const connId = url.searchParams.get('id') || '';
    if (connId) {
      const conn = this.registry.getById(connId);
      if (conn) return conn.channel;
    }

    const site = url.searchParams.get('site') || '';
    const account = url.searchParams.get('account') || '';
    if (site && account) return channelOf(site, account);

    if (site) {
      const conns = this.registry.listBySite(site);
      if (conns.length === 1) return conns[0].channel;
      return channelOf(site, '');
    }
    return null;
  }

  // ── HTTP 轮询：等待命令（长轮询）──
  async _poll(url, res) {
    const channel = this._resolvePollChannel(url);
    if (!channel) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'channel or site required' }));
      return;
    }
    const connId = url.searchParams.get('id') || '';
    // 更新连接活跃时间（用于僵尸检测）
    if (connId) {
      this.registry.touch(connId);
    }

    // 队列中有待处理命令 → 立即返回。
    //
    // _shiftQueued 会额外看一眼 site 桶：零连接时到达的读请求没有账号可归属，
    // 只能排在 site；等某个账号连上后，它的 channel 轮询要能把这条命令接走，
    // 否则就只能干等到超时（改造前所有轮询都按 site 取，才有"连上还能接走"）。
    const cmd = this._shiftQueued(channel);
    if (cmd) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildEvalMessage(cmd.msgId, cmd.expression, cmd.awaitPromise, cmd.expectAccount)));
      return;
    }

    // 无命令 → 长轮询等待（25s 超时）
    const timer = setTimeout(() => {
      const waiters = this._pollWaiters.get(channel);
      if (waiters) {
        const idx = waiters.findIndex(w => w.res === res);
        if (idx !== -1) waiters.splice(idx, 1);
        if (waiters.length === 0) this._pollWaiters.delete(channel);
      }
      if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, type: 'idle' }));
      }
    }, 25000);

    if (!this._pollWaiters.has(channel)) this._pollWaiters.set(channel, []);
    this._pollWaiters.get(channel).push({ res, timer, connId });

    res.on('close', () => {
      clearTimeout(timer);
      const waiters = this._pollWaiters.get(channel);
      if (waiters) {
        const idx = waiters.findIndex(w => w.res === res);
        if (idx !== -1) waiters.splice(idx, 1);
        if (waiters.length === 0) this._pollWaiters.delete(channel);
      }
    });
  }

  // ── HTTP 轮询：提交 eval 结果 ──
  async _result(req, res) {
    const body = await this._parseBody(req, res);
    if (body === null) return;
    const { id, value, error } = body;

    const pending = this._pending.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this._pending.delete(id);

      // 服务端兜底校验：写操作期望账号已知时，回填的 account 必须一致。
      // 油猴端已经先比对过一次；这里是防"旧脚本/伪造结果"的第二道。
      // 回填里没有 account（旧脚本）时不拒绝 —— 否则升级期间写操作全挂。
      const reported = accountUidOf(body.account);
      // 记录实际执行账号：读操作也能因此拿到归属（尤其是零连接时排队的请求，
      // 选择连接发生在 pending 创建之后，_call 手里没有 conn）。
      if (reported) pending.account = reported;
      if (pending.expectAccount && reported && reported !== pending.expectAccount) {
        pending.reject(new Error(
          `账号不一致：请求期望 ${pending.expectAccount}，实际回填 ${reported} —— 已拒绝执行结果`
        ));
      } else if (error) {
        pending.reject(new Error(error));
      } else {
        pending.resolve(value);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  /**
   * 读取并解析请求体。解析失败（超限/非法 JSON）时已写好错误响应，返回 null。
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse} res
   */
  async _parseBody(req, res) {
    try {
      return await this._readBody(req, res);
    } catch (e) {
      if (!res.headersSent) {
        const status = e.message === 'Request body too large' ? 413 : 400;
        this._sendJson(res, status, { ok: false, error: e.message });
      }
      return null;
    }
  }

  _readBody(req, res) {
    return new Promise((resolve, reject) => {
      let data = '';
      let rejected = false;
      req.on('data', chunk => {
        if (rejected) return;
        data += chunk;
        // 限制 body 大小（默认 64MB，可用 config.bridge.maxBodySize 调整）
        if (Buffer.byteLength(data) > this.maxBodySize) {
          rejected = true;
          // 返回 413 让客户端拿到明确错误，而不是直接掐断连接（ECONNRESET）
          if (res && !res.headersSent) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Request body too large' }));
          }
          req.resume(); // 排空剩余数据，保持 socket 可用
          reject(new Error('Request body too large'));
        }
      });
      req.on('end', () => {
        if (rejected) return;
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON in request body'));
        }
      });
      req.on('error', reject);
    });
  }
}

module.exports = { Router };
