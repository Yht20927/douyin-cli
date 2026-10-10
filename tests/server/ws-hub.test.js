// tests/server/ws-hub.test.js — WebSocket Hub：hello 握手 + 心跳僵尸连接剔除
//
// 回归背景：heartbeat failures 曾从不递增（send ping 后无 ++），
// 导致 heartbeatMaxFailures 成为死配置、半开 TCP 永不被剔除 —— 见 2026-08 P1 修复。
// 用真实 ws 客户端走完整链路，避免 mock 失真。

const http = require('http');
const WebSocket = require('ws');
const { WebSocketHub } = require('../../lib/server/ws-hub');
const { ConnectionRegistry } = require('../../lib/server/registry');

const HEARTBEAT_INTERVAL = 30;
const MAX_FAILURES = 2;

let server;
let hub;
let registry;
let port;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function connect(opts = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, opts);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('open timeout')), 3000);
    ws.on('open', () => { clearTimeout(t); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function hello(ws, site = 'douyin.com', account = 'ACC_A') {
  ws.send(JSON.stringify({ type: 'hello', site, account, url: 'https://www.douyin.com/', title: '抖音' }));
}

beforeAll(async () => {
  registry = new ConnectionRegistry();
  hub = new WebSocketHub({
    registry,
    heartbeatInterval: HEARTBEAT_INTERVAL,
    heartbeatTimeout: 5,
    heartbeatMaxFailures: MAX_FAILURES,
  });
  server = http.createServer();
  hub.attach(server);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterAll(async () => {
  await hub.stop().catch(() => {});
  await new Promise(r => server.close(r));
});

describe('WebSocketHub 心跳', () => {
  it('连续 miss pong 达 maxFailures 后服务端主动 close(4004)（回归：failures 必须递增）', async () => {
    const ws = await connect();
    hello(ws);

    // 装死：收到任何消息都不回 pong
    const closedCode = new Promise((resolve) => {
      ws.on('close', (code) => resolve(code));
    });

    // maxFailures=2 → 第 3 个 tick 触发关闭；留裕量
    const code = await Promise.race([
      closedCode,
      sleep(HEARTBEAT_INTERVAL * (MAX_FAILURES + 4)).then(() => 'not-closed'),
    ]);

    expect(code).toBe(4004);
    // 服务端 close() 与客户端挥手异步完成，轮询等待注销
    for (let i = 0; i < 100 && registry.totalConnections > 0; i++) await sleep(10);
    expect(registry.totalConnections).toBe(0);
    ws.terminate();
  }, 10000);

  it('正常应答 pong 的连接长期存活且被 registry 记录', async () => {
    const ws = await connect();
    hello(ws);

    let pings = 0;
    ws.on('message', (d) => {
      try {
        const m = JSON.parse(d.toString());
        if (m.type === 'ping') {
          pings++;
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (_) {}
    });

    // 跑过足够多个心跳周期
    await sleep(HEARTBEAT_INTERVAL * (MAX_FAILURES * 4));
    expect(pings).toBeGreaterThanOrEqual(MAX_FAILURES + 1);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(registry.totalConnections).toBe(1);

    ws.close();
    await sleep(20);
    expect(registry.totalConnections).toBe(0);
  }, 10000);

  it('非 hello 首条消息被拒绝（4002）', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'result', id: 'x', value: 1 }));
    const code = await new Promise((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4002);
  }, 5000);
});
