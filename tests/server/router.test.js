// tests/server/router.test.js — HTTP 路由：认证 / WS 分发 / 长轮询三路分发 / 413

const { Router } = require('../../core/server/router');
const { ConnectionRegistry } = require('../../core/server/registry');

// ── 测试用 fake http.IncomingMessage / ServerResponse ──

function makeReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const { EventEmitter } = require('events');
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.resume = () => {};
  if (body !== null) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  }
  return req;
}

function makeRes() {
  const { EventEmitter } = require('events');
  const ev = new EventEmitter();
  ev.headersSent = false;
  ev.statusCode = null;
  ev._headers = {};
  ev._chunks = [];
  ev.setHeader = (k, v) => { ev._headers[k] = v; };
  ev.writeHead = (code, hdrs) => {
    if (ev.headersSent) throw new Error('headers already sent');
    ev.statusCode = code;
    Object.assign(ev._headers, hdrs || {});
    ev.headersSent = true;
  };
  ev.end = (data) => {
    if (data) ev._chunks.push(String(data));
    ev._ended = true;
  };
  // 注意：不能用 Object.assign 复制 getter（会被立即求值），必须 defineProperty
  Object.defineProperty(ev, 'body', {
    get() { return ev._chunks.length ? JSON.parse(ev._chunks.join('')) : null; },
  });
  return ev;
}

function makeHubStub() {
  const handlers = {};
  return {
    lastSend: null,
    on(evName, fn) { (handlers[evName] ||= new Set()).add(fn); },
    emit(evName, msg) { (handlers[evName] || new Set()).forEach(fn => fn(msg)); },
    sendEval(conn, msgId, expression, awaitPromise) {
      // 默认不回填 —— 由各测试通过 emit('result') 控制
      this.lastSend = { conn, msgId, expression, awaitPromise };
    },
  };
}

const CALL_BODY = { site: 'douyin.com', expression: '1 + 1' };

describe('Router 认证', () => {
  let registry;

  beforeEach(() => {
    registry = new ConnectionRegistry();
  });

  it('未配置 token 时跳过认证，受保护端点可达（无连接时走队列超时 503 而非 401）', async () => {
    const router = new Router({ registry, wsHub: makeHubStub(), token: '', requestTimeout: 60 });
    const res = makeRes();
    await router.handle(makeReq({ method: 'POST', url: '/api/call', body: CALL_BODY }), res);
    expect(res.statusCode).toBe(503);
  });

  it('受保护端点缺少 Bearer 头返回 401（公开端点 /api/status 不受影响）', async () => {
    const router = new Router({ registry, wsHub: makeHubStub(), token: 'secret' });
    // 公开端点应正常放行
    const pubRes = makeRes();
    await router.handle(makeReq({ method: 'GET', url: '/api/status' }), pubRes);
    expect(pubRes.statusCode).toBe(200);
    // 受保护端点无认证头 → 401
    const res = makeRes();
    await router.handle(makeReq({ method: 'POST', url: '/api/call', body: CALL_BODY }), res);
    expect(res.statusCode).toBe(401);
  });

  it('错误的 Bearer token 返回 401', async () => {
    const router = new Router({ registry, wsHub: makeHubStub(), token: 'secret' });
    const res = makeRes();
    await router.handle(
      makeReq({ method: 'POST', url: '/api/call', headers: { authorization: 'Bearer wrong' }, body: CALL_BODY }),
      res,
    );
    expect(res.statusCode).toBe(401);
  });

  it('正确的 Bearer token 通过', async () => {
    const router = new Router({ registry, wsHub: makeHubStub(), token: 'secret' });
    const res = makeRes();
    await router.handle(makeReq({ method: 'GET', url: '/api/status', headers: { authorization: 'Bearer secret' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('查询串 ?token= 通过认证（兼容轮询客户端）', async () => {
    const router = new Router({ registry, wsHub: makeHubStub(), token: 'secret' });
    const res = makeRes();
    await router.handle(makeReq({ method: 'GET', url: '/api/poll?site=douyin.com&token=secret' }), res);
    expect(res.statusCode).toBeNull();          // 未写错误响应
    expect(res.headersSent).toBe(false);        // 进入长轮询等待态
    res.emit('close');                          // 断开，避免 25s 挂起 timer 泄漏
  });
});

describe('Router 公开端点与基础路由', () => {
  let router, registry;

  beforeEach(() => {
    registry = new ConnectionRegistry();
    router = new Router({ registry, wsHub: makeHubStub(), token: '' });
  });

  it('/api/health 返回 uptime 与连接数', async () => {
    const res = makeRes();
    await router.handle(makeReq({ url: '/api/health' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.connections).toBe(0);
  });

  it('/api/status 列出注册的连接', async () => {
    registry.register('douyin.com', null, { url: 'https://www.douyin.com/x' });
    const res = makeRes();
    await router.handle(makeReq({ url: '/api/status' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.totalConnections).toBe(1);
    expect(Object.keys(res.body.connections)).toContain('douyin.com');
  });

  it('未知路径返回 404', async () => {
    const res = makeRes();
    await router.handle(makeReq({ url: '/api/nope' }), res);
    expect(res.statusCode).toBe(404);
  });

  it('WebSocket 升级请求交由 ws-hub 处理（router 直接返回 undefined）', async () => {
    const res = makeRes();
    const r = await router.handle(
      makeReq({ method: 'GET', url: '/ws', headers: { upgrade: 'WebSocket' } }),
      res,
    );
    expect(r).toBeUndefined();
    expect(res.headersSent).toBe(false);
  });

  it('/api/call 缺少 site 字段返回 400', async () => {
    const res = makeRes();
    await router.handle(makeReq({ method: 'POST', url: '/api/call', body: { expression: 'x' } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('请求体超限返回 413', async () => {
    const tiny = new Router({
      registry, wsHub: makeHubStub(), token: '',
      maxBodySize: 8,
    });
    const res = makeRes();
    await tiny.handle(
      makeReq({ method: 'POST', url: '/api/connect', body: { site: 'douyin.com'.repeat(50) } }),
      res,
    );
    expect(res.statusCode).toBe(413);
    expect(res.body.error).toContain('Request body too large');
  });
});

describe('Router _call 三路分发', () => {
  let registry, hub, router;

  beforeEach(() => {
    registry = new ConnectionRegistry();
    hub = makeHubStub();
    router = new Router({ registry, wsHub: hub, token: '', requestTimeout: 80 });
  });

  it('方式1：WS 连接在线 → sendEval + result 回填 → pending 正常消费', async () => {
    registry.register('douyin.com', { readyState: 1 });
    const callPromise = router.handle(
      makeReq({ method: 'POST', url: '/api/call', body: CALL_BODY }),
      makeRes(),
    );
    // 等待 sendEval 发生
    for (let i = 0; i < 20 && !hub.lastSend; i++) await new Promise(r => setTimeout(r, 5));
    expect(hub.lastSend).toBeTruthy();
    expect(hub.lastSend.expression).toBe('1 + 1');
    expect(hub.lastSend.awaitPromise).toBe(true);

    // 结果回填 → 调用方收到 200（无未处理 rejection 即链路通畅）
    hub.emit('result', { id: hub.lastSend.msgId, value: 42 });
    await callPromise;
  });

  it('方式2/3：无 WS → 入 poll 队列 → /api/poll 取走 → /api/result 回填 → 200 polling-queued', async () => {
    const callRes = makeRes();
    const callPromise = router.handle(
      makeReq({ method: 'POST', url: '/api/call', body: CALL_BODY }),
      callRes,
    );
    // 等队列落位
    for (let i = 0; i < 30 && ![...router._pollQueue.values()].flat().length; i++) {
      await new Promise(r => setTimeout(r, 5));
    }

    // poll 客户端取走命令
    const pollRes = makeRes();
    await router.handle(makeReq({ method: 'GET', url: '/api/poll?site=douyin.com&id=c1' }), pollRes);
    expect(pollRes.body.type).toBe('eval');
    expect(pollRes.body.expression).toBe('1 + 1');
    const msgId = pollRes.body.id;

    // 结果回填
    const resultRes = makeRes();
    await router.handle(
      makeReq({ method: 'POST', url: '/api/result', body: { id: msgId, value: 'ok-value' } }),
      resultRes,
    );
    expect(resultRes.body.ok).toBe(true);

    await callPromise;
    expect(callRes.statusCode).toBe(200);
    expect(callRes.body.value).toBe('ok-value');
    expect(callRes.body.connection).toBe('polling-queued');
  });

  it('方式3 超时：无人取队列 → 503 no polling client connected', async () => {
    const res = makeRes();
    await router.handle(makeReq({ method: 'POST', url: '/api/call', body: CALL_BODY }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/Request timeout.*no polling client connected/s);
  });

  it('WS 在线但一直无结果 → 超时后 fallthrough，最终 503（不再误挂起）', async () => {
    registry.register('douyin.com', { readyState: 1 });
    const res = makeRes();
    await router.handle(makeReq({ method: 'POST', url: '/api/call', body: CALL_BODY }), res);
    expect(res.statusCode).toBe(503);
  });

  it('/api/result 对未知 id 不抛错仍返回 ok', async () => {
    const res = makeRes();
    await router.handle(makeReq({ method: 'POST', url: '/api/result', body: { id: 'gone', value: 1 } }), res);
    expect(res.body.ok).toBe(true);
  });
});
