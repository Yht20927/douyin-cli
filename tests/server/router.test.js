// tests/server/router.test.js — HTTP 路由：认证 / 长轮询两路分发 / 单次派发 / 413

const fs = require('fs');
const os = require('os');
const path = require('path');

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

const CALL_BODY = { site: 'douyin.com', expression: '1 + 1' };

/**
 * 把数据目录指到临时目录（用完即弃）。
 *
 * 必须做这件事的原因很具体：/api/connect 会把上报的账号写进 accounts 名册，
 * 而测试跑在仓库根目录下 —— 不重定向就是**每次跑测试都往用户真实的
 * storage/douyin.db 里写一条假账号**，还顺手把它的 last_seen 刷成刚刚，
 * 让它看起来像一个真的连过一次、只是没上报昵称的号。
 */
function useTempDataDir() {
  let tmp = null;
  let orig = null;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-router-'));
    orig = process.env.DOUYIN_DATA_DIR;
    process.env.DOUYIN_DATA_DIR = tmp;
  });

  afterEach(() => {
    try { require('../../core/memory/db').closeDb(); } catch (_) { /* 没打开过，没什么要关 */ }
    if (orig == null) delete process.env.DOUYIN_DATA_DIR;
    else process.env.DOUYIN_DATA_DIR = orig;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  return () => tmp;
}

describe('Router 认证', () => {
  let registry;

  beforeEach(() => {
    registry = new ConnectionRegistry();
  });

  it('未配置 token 时跳过认证，受保护端点可达（无连接时走队列超时 503 而非 401）', async () => {
    const router = new Router({ registry, token: '', requestTimeout: 60 });
    const res = makeRes();
    await router.handle(makeReq({ method: 'POST', url: '/api/call', body: CALL_BODY }), res);
    expect(res.statusCode).toBe(503);
  });

  it('受保护端点缺少 Bearer 头返回 401（公开端点 /api/status 不受影响）', async () => {
    const router = new Router({ registry, token: 'secret' });
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
    const router = new Router({ registry, token: 'secret' });
    const res = makeRes();
    await router.handle(
      makeReq({ method: 'POST', url: '/api/call', headers: { authorization: 'Bearer wrong' }, body: CALL_BODY }),
      res,
    );
    expect(res.statusCode).toBe(401);
  });

  it('正确的 Bearer token 通过', async () => {
    const router = new Router({ registry, token: 'secret' });
    const res = makeRes();
    await router.handle(makeReq({ method: 'GET', url: '/api/status', headers: { authorization: 'Bearer secret' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('查询串 ?token= 通过认证（兼容轮询客户端）', async () => {
    const router = new Router({ registry, token: 'secret' });
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
    router = new Router({ registry, token: '' });
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
    registry.register('douyin.com', { url: 'https://www.douyin.com/x' });
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

  it('WebSocket 升级请求被明确拒绝（426），不再静默挂起', async () => {
    const res = makeRes();
    await router.handle(
      makeReq({ method: 'GET', url: '/ws', headers: { upgrade: 'WebSocket' } }),
      res,
    );
    expect(res.statusCode).toBe(426);
    expect(res.body.error).toMatch(/长轮询/);
  });

  it('畸形的请求目标（GET //）返回错误响应，不把异常抛给调用方', async () => {
    // new URL('//', base) 会抛 TypeError —— 曾经直接冒到 create-server 的
    // router.handle(req, res)（没有 .catch），结果是整个进程崩掉
    const res = makeRes();
    await router.handle(makeReq({ method: 'GET', url: '//' }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
  });

  it('/api/call 缺少 site 字段返回 400', async () => {
    const res = makeRes();
    await router.handle(makeReq({ method: 'POST', url: '/api/call', body: { expression: 'x' } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('请求体超限返回 413', async () => {
    const tiny = new Router({
      registry, token: '',
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

describe('Router _call 两路分发（长轮询）', () => {
  let registry, router;

  beforeEach(() => {
    registry = new ConnectionRegistry();
    router = new Router({ registry, token: '', requestTimeout: 80 });
  });

  /** 等某个条件成立（这些断言依赖 async 链路里的微任务顺序，不能同步检查） */
  async function waitFor(fn, rounds = 40) {
    for (let i = 0; i < rounds && !fn(); i++) await new Promise(r => setTimeout(r, 5));
    return fn();
  }

  it('方式1：已有挂起的 poll → 命令塞进它的响应 → 回填 → 200 polling', async () => {
    const pollRes = makeRes();
    await router.handle(makeReq({ method: 'GET', url: '/api/poll?site=douyin.com' }), pollRes);
    expect(pollRes.headersSent).toBe(false); // 正处于长轮询等待态

    const callRes = makeRes();
    const callPromise = router.handle(
      makeReq({ method: 'POST', url: '/api/call', body: CALL_BODY }),
      callRes,
    );
    expect(await waitFor(() => pollRes._ended)).toBe(true);
    expect(pollRes.body.type).toBe('eval');
    expect(pollRes.body.expression).toBe('1 + 1');

    await router.handle(
      makeReq({ method: 'POST', url: '/api/result', body: { id: pollRes.body.id, value: 'v1' } }),
      makeRes(),
    );
    await callPromise;
    expect(callRes.statusCode).toBe(200);
    expect(callRes.body.value).toBe('v1');
    expect(callRes.body.connection).toBe('polling');
    pollRes.emit('close');
  });

  it('方式2：无挂起 poll → 入队 → /api/poll 取走 → /api/result 回填 → 200 polling-queued', async () => {
    const callRes = makeRes();
    const callPromise = router.handle(
      makeReq({ method: 'POST', url: '/api/call', body: CALL_BODY }),
      callRes,
    );
    // 等队列落位
    expect(await waitFor(() => [...router._pollQueue.values()].flat().length > 0)).toBe(true);

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

  it('方式2 超时：无人取队列 → 503 no polling client connected', async () => {
    const res = makeRes();
    await router.handle(makeReq({ method: 'POST', url: '/api/call', body: CALL_BODY }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/Request timeout.*no polling client connected/s);
  });

  // ─────────────────────────────────────────────────────────
  // 一次调用只允许派发一份命令
  //
  // 这条对"发布"类命令是硬要求：表达式被执行两次 = 同一条评论发两遍，
  // 而抖音对重复发布是判重失败的，运营只会看到"莫名发出去两条/一条没发出去"。
  //
  // 出过问题的写法是 WS 超时后 fallthrough 到轮询、复用同一个 msgId 重发一遍 ——
  // 第一个执行者其实还活着，于是两份都发出去了。删掉 WS 分支顺带修掉了它，
  // 这里把"只派发一次"钉成契约，防止以后加通道时又写回同款逻辑。
  // ─────────────────────────────────────────────────────────
  it('一次 /api/call 只派发一份命令（两个等待者也只喂一个，队列不留副本）', async () => {
    const p1 = makeRes();
    const p2 = makeRes();
    await router.handle(makeReq({ method: 'GET', url: '/api/poll?site=douyin.com' }), p1);
    await router.handle(makeReq({ method: 'GET', url: '/api/poll?site=douyin.com' }), p2);
    expect(router._pollWaiters.get('douyin.com')).toHaveLength(2);

    const callRes = makeRes();
    const callPromise = router.handle(
      makeReq({ method: 'POST', url: '/api/call', body: CALL_BODY }),
      callRes,
    );
    expect(await waitFor(() => p1._ended)).toBe(true);

    const delivered = [p1, p2].filter(r => r.body && r.body.type === 'eval');
    expect(delivered).toHaveLength(1);
    // 第二份命令没有留在队列里等着被下一个 poll 取走
    expect(router._pollQueue.get('douyin.com') || []).toHaveLength(0);

    await router.handle(
      makeReq({ method: 'POST', url: '/api/result', body: { id: delivered[0].body.id, value: 1 } }),
      makeRes(),
    );
    await callPromise;
    expect(callRes.statusCode).toBe(200);
    expect(router._pending.size).toBe(0);

    p1.emit('close');
    p2.emit('close');
  });

  it('派发超时后结果迟到，不会再触发第二次派发（pending 已清）', async () => {
    const pollRes = makeRes();
    await router.handle(makeReq({ method: 'GET', url: '/api/poll?site=douyin.com' }), pollRes);

    const callRes = makeRes();
    await router.handle(
      makeReq({ method: 'POST', url: '/api/call', body: CALL_BODY }),
      callRes,
    );
    // 不回填结果，等 requestTimeout(80ms) 到点
    expect(await waitFor(() => callRes._ended)).toBe(true);
    expect(callRes.statusCode).toBe(503);
    expect(router._pending.size).toBe(0);
    expect(router._pollQueue.get('douyin.com') || []).toHaveLength(0);

    // 迟到的结果：认不出 id，只会被丢弃，不会把命令再排一次队
    await router.handle(
      makeReq({ method: 'POST', url: '/api/result', body: { id: pollRes.body.id, value: 'late' } }),
      makeRes(),
    );
    expect([...router._pollQueue.values()].flat()).toHaveLength(0);
    pollRes.emit('close');
  });

  it('/api/result 对未知 id 不抛错仍返回 ok', async () => {
    const res = makeRes();
    await router.handle(makeReq({ method: 'POST', url: '/api/result', body: { id: 'gone', value: 1 } }), res);
    expect(res.body.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// /api/connect 上报账号 → /api/status 带出账号
// 连接页显示"连的是哪个号"的数据链路
// ═══════════════════════════════════════════════════════════
describe('Router 连接账号上报', () => {
  let router, registry;

  useTempDataDir();

  beforeEach(() => {
    registry = new ConnectionRegistry();
    router = new Router({ registry, token: '' });
  });

  it('注册时带 account → /api/status 能看到', async () => {
    const res = makeRes();
    await router.handle(
      makeReq({
        method: 'POST', url: '/api/connect',
        body: { site: 'douyin.com', url: 'https://www.douyin.com/', account: { nickname: '小杨', uid: '42', followerCount: 97, likesReceived: 126 }, clientVersion: 2 },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);

    const status = makeRes();
    await router.handle(makeReq({ url: '/api/status' }), status);
    const conn = status.body.connections['douyin.com'][0];
    expect(conn.account).toEqual({
      nickname: '小杨', avatar: '', secUid: '', uid: '42',
      followerCount: 97, followingCount: null, likesReceived: 126,
    });
    expect(conn.clientVersion).toBe(2);
  });

  it('名册落库用的是同一份消毒结果（界面看到什么，库里就是什么）', async () => {
    const res = makeRes();
    await router.handle(
      makeReq({
        method: 'POST', url: '/api/connect',
        body: {
          site: 'douyin.com',
          account: {
            uid: '900002', nickname: '杨'.repeat(200),
            avatar: 'javascript:alert(1)', secUid: 'MS4wLjABAAAA-test',
          },
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);

    const accounts = require('../../core/memory/accounts');
    const row = accounts.get('900002');
    expect(row).toBeTruthy();                        // 没落库 → 界面把 uid 翻译不出昵称
    expect(row.nickname).toHaveLength(60);           // 与注册表那份同一条截断规则
    expect(row.secUid).toBe('MS4wLjABAAAA-test');
    expect(row.avatar).toBeNull();                   // 非 https 的头像既不进注册表也不进库
  });

  it('注册时不带 account（旧版脚本）→ account 为 null，注册照常成功', async () => {
    const res = makeRes();
    await router.handle(
      makeReq({ method: 'POST', url: '/api/connect', body: { site: 'douyin.com', url: 'https://www.douyin.com/' } }),
      res,
    );
    expect(res.statusCode).toBe(200);

    const status = makeRes();
    await router.handle(makeReq({ url: '/api/status' }), status);
    const legacy = status.body.connections['douyin.com'][0];
    expect(legacy.account).toBeNull();
    expect(legacy.clientVersion).toBeNull();
  });
});
