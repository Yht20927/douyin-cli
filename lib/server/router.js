// lib/server/router.js — HTTP API 路由（/call, /status, /health）
//
// 认证：/api/call, /api/connect, /api/poll, /api/result 需要 token
//       /api/health, /api/status 公开（只读监控）
// CORS：仅允许 localhost 来源

const { randomUUID } = require('crypto');
const { validateCallRequest, buildEvalMessage } = require('../shared/protocol');
const { safeSerialize } = require('../shared/serialize');

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
   * @param {import('./ws-hub').WebSocketHub} options.wsHub
   * @param {number} options.requestTimeout
   * @param {string} options.token - 访问令牌
   * @param {object} [options.accounts] - config.accounts（aliases / rotation）
   */
  constructor(options) {
    this.registry = options.registry;
    this.wsHub = options.wsHub;
    this.requestTimeout = options.requestTimeout || 30000;
    this.token = options.token || '';
    // HTTP 请求体上限（字节）。抖音搜索结果等大响应可能远超 1MB，
    // 默认 64MB，可用 config.json 的 bridge.maxBodySize 调整。
    this.maxBodySize = options.maxBodySize || 64 * 1024 * 1024;

    const accounts = options.accounts || {};
    this.aliases = accounts.aliases || {};
    this.rotation = Object.assign({ enabled: true, cooldownMs: 15000 }, accounts.rotation || {});

    /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this._pending = new Map();

    // HTTP 轮询队列：channel → [{ msgId, expression, awaitPromise, expectAccount }]
    this._pollQueue = new Map();
    // HTTP 轮询等待者：channel → [{ res, timer }]
    this._pollWaiters = new Map();

    // 监听 ws-hub 的 result 事件
    this.wsHub.on('result', (msg) => {
      const pending = this._pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this._pending.delete(msg.id);

        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.value);
        }
      }
    });
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
   *  - 未指定 + 读操作 → 按账号轮换（每号独立冷却）。
   *
   * @returns {{ conn: object } | { status: number, code: string, error: string, available: object[] }}
   */
  _selectConn(site, account, opType) {
    const available = () => this._availableAccounts(site);

    if (account) {
      const conn = this.registry.getAccount(site, account);
      if (conn) return { conn };
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
        if (conn) return { conn };
      }
      return { status: 503, code: 'no_connection', error: this._noConnMsg(site), available: [] };
    }

    // 读操作：轮换。所有连接都带账号（握手强制），所以不需要"未识别"退化路径
    const conn = this.rotation.enabled === false
      ? this.registry.aliveOf(site)[0]
      : this.registry.pickForRead(site, this.rotation.cooldownMs);
    if (conn) return { conn };
    return { status: 503, code: 'no_connection', error: this._noConnMsg(site), available: [] };
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
    // WebSocket 升级请求交给 ws-hub，router 不介入
    if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
      return;
    }

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

    try {
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
      console.error(`[router] Unhandled error: ${e.message}`);
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

  /** 按站点分组的账号快照（合并别名），供 /api/status 与 `accounts` 命令使用 */
  _accountsSummary() {
    const out = {};
    for (const [site, conns] of Object.entries(this.registry.list())) {
      for (const c of conns) {
        if (!out[site]) out[site] = [];
        out[site].push({
          // 连接的身份就是账号名：别名优先，没设别名时退回 uid
          id: this.aliases[c.account] || c.account,
          account: c.account,
          nickname: c.nickname || '',
          clientVersion: c.clientVersion,
          // 区别于 _aliasOf：这里不把 uid 当别名回填，否则
          // `accounts` 输出里"别名"列和 uid 列长得一模一样，看不出谁没设别名
          alias: this.aliases[c.account] || null,
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

    const { site, account, expression, awaitPromise, timeout, opType } = result.data;
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

    const conn = selected.conn;
    const channel = conn.channel;
    // 写操作把期望账号带给油猴端做二次校验；读操作不需要
    const expectAccount = opType === 'write' ? (conn.account || null) : null;

    // 记账：写会先把该账号排到读轮换的队尾
    if (opType === 'write') this.registry.markWrite(conn.id);
    else this.registry.markServed(conn.id);

    // 方式1：WebSocket 路径
    if (conn.ws) {
      const pendingPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pending.delete(msgId);
          reject(new Error(`Request timeout after ${effectiveTimeout}ms`));
        }, effectiveTimeout);
        this._pending.set(msgId, { resolve, reject, timer });
      });

      try {
        this.wsHub.sendEval(conn, msgId, expression, awaitPromise, expectAccount);
      } catch (e) {
        const p = this._pending.get(msgId);
        if (p) { clearTimeout(p.timer); this._pending.delete(msgId); }
      }

      if (this._pending.has(msgId)) {
        try {
          const value = await pendingPromise;
          this._sendJson(res, 200, { ok: true, value, connection: conn.id, account: conn.account, channel });
          return;
        } catch (e) {
          // WS 超时，fallthrough 到 HTTP 轮询
        }
      }
    }

    // 方式2：HTTP 轮询 — 有等待中的 poll 请求
    const waiters = this._pollWaiters.get(channel);
    if (waiters && waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiters.length === 0) this._pollWaiters.delete(channel);
      clearTimeout(waiter.timer);

      const pendingPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pending.delete(msgId);
          reject(new Error(`Request timeout after ${effectiveTimeout}ms`));
        }, effectiveTimeout);
        this._pending.set(msgId, { resolve, reject, timer });
      });

      waiter.res.writeHead(200, { 'Content-Type': 'application/json' });
      waiter.res.end(JSON.stringify(buildEvalMessage(msgId, expression, awaitPromise, expectAccount)));

      try {
        const value = await pendingPromise;
        this._sendJson(res, 200, { ok: true, value, connection: 'polling', account: conn.account, channel });
        return;
      } catch (e) {
        this._sendJson(res, 503, { ok: false, error: e.message });
        return;
      }
    }

    // 方式3：无等待者 → 放入队列，等 poll 来取
    if (!this._pollQueue.has(channel)) this._pollQueue.set(channel, []);
    this._pollQueue.get(channel).push({ msgId, expression, awaitPromise, expectAccount });

    const pendingPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(msgId);
        const queue = this._pollQueue.get(channel);
        if (queue) {
          const idx = queue.findIndex(c => c.msgId === msgId);
          if (idx !== -1) queue.splice(idx, 1);
        }
        reject(new Error(`Request timeout after ${effectiveTimeout}ms — no polling client connected`));
      }, effectiveTimeout);
      this._pending.set(msgId, { resolve, reject, timer });
    });

    try {
      const value = await pendingPromise;
      this._sendJson(res, 200, { ok: true, value, connection: 'polling-queued', account: conn.account, channel });
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
    const account = typeof body.account === 'string' ? body.account : '';
    // 不接受无账号的连接：未登录的标签页不该接入（它既不能承接写操作，
    // 也无法做写护栏校验），否则会出现一条身份不明的连接。
    //
    // 但要把两种情况分开报，否则用户会看到"没登录"而困惑（他其实已登录）：
    //   完全没带 account 字段 = 油猴脚本是旧版（协议已要求 account）→ 让他去更新脚本
    //   account 是空串         = 脚本探测不到登录态        → 让他去登录
    if (!account || typeof body.account !== 'string') {
      const outdated = body.account === undefined || body.account === null;
      const code = outdated ? 'client_outdated' : 'account_required';
      const error = outdated
        ? '客户端未上报 account 字段：油猴脚本版本过旧，请在 Tampermonkey 里重新安装 scripts/douyin.user.js'
        : 'account 为空：该标签页未探测到登录账号，未登录不应连接（请先登录再刷新页面）';
      console.log(`[router] ✗ 拒绝连接 (${site}) → ${code}`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code, error }));
      return;
    }

    // 换号重注册：客户端带上自己上一条的 connId，精确清掉，避免旧通道残留
    // （按 site 清理会误伤同站点的其他账号，所以只能由客户端指明自己是谁）
    if (body.prevId) this.registry.unregister(body.prevId);

    // 清理僵尸连接：HTTP 轮询无 close 事件，页面刷新后旧连接无法自动清理。
    // 作用域是 channel 而不是 site —— 按 site 清理会把同站点的其他账号一起删掉。
    this.registry.removeStalePolling(site, account);

    const meta = {
      account,
      nickname: typeof body.nickname === 'string' ? body.nickname : '',
      clientVersion: typeof body.clientVersion === 'number' ? body.clientVersion : null,
      url: body.url || '',
      title: body.title || '',
      userAgent: body.userAgent || '',
    };
    const conn = this.registry.register(site, null, meta);
    // 把脚本版本打进日志：调账号相关问题时，这行能立刻区分
    // "浏览器里是旧脚本"（clientVersion=null）和"新脚本但探测失败"（nickname 空）
    console.log(`[router] poll client: ${conn.channel} (nickname=${conn.nickname || '空'}, clientVersion=${conn.clientVersion == null ? '未上报' : conn.clientVersion})`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: conn.id, channel: conn.channel }));
  }

  // ── HTTP 轮询：等待命令（长轮询）──
  async _poll(url, res) {
    // channel 优先；兼容旧的 ?site= 调用（等价于未识别账号的通道）
    const channel = url.searchParams.get('channel')
      || (url.searchParams.get('site') ? `${url.searchParams.get('site')}#` : null);
    if (!channel) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'channel required' }));
      return;
    }
    const connId = url.searchParams.get('id') || '';
    // 更新连接活跃时间（用于僵尸检测）
    if (connId) {
      this.registry.touch(connId);
    }

    // 队列中有待处理命令 → 立即返回
    const queue = this._pollQueue.get(channel);
    if (queue && queue.length > 0) {
      const cmd = queue.shift();
      if (queue.length === 0) this._pollQueue.delete(channel);
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
    this._pollWaiters.get(channel).push({ res, timer });

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
      if (error) pending.reject(new Error(error));
      else pending.resolve(value);
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
