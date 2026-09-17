// tests/bridge-manager.test.js — 内嵌桥接服务的状态监测
//
// 回归背景：用户报告"油猴脚本已连接，界面右上角仍显示未连接"。
// 服务端日志明确有 `[registry] + douyin.com`，/api/status 也返回
// alive:true —— 所以问题出在 manager 的轮询或状态推送上。
// 本文件用真实的 server + 真实的 poll 客户端把这段逻辑钉死。

const http = require('http');

const { createBridgeManager } = require('../app/main/bridge-manager');

/** 让系统分配端口，避免与开发机上跑着的实例打架 */
function testConfig(overrides = {}) {
  return {
    bridge: {
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      requestTimeout: 5000,
      maxBodySize: 1024 * 1024,
      connectionWatch: { pollIntervalSec: 1, offlineAlertSec: 2 },
      ...overrides,
    },
  };
}

function postJson(url, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    // /api/connect 是受保护端点，缺 Authorization 会 401
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers, agent: false,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** 注册一个假的长轮询客户端，模拟油猴脚本连上来的效果 */
async function registerFakePollClient(baseUrl, token, site = 'douyin.com') {
  const r = await postJson(`${baseUrl}/api/connect`, { site, url: 'https://www.douyin.com/', title: '测试页' }, token);
  if (r.status !== 200) throw new Error(`注册轮询客户端失败: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

describe('bridge-manager: 连接状态监测', () => {
  let manager;

  afterEach(async () => {
    if (manager) { await manager.stop(); manager = null; }
  });

  it('无任何客户端时 online=false，且不算离线告警', async () => {
    manager = createBridgeManager({ config: testConfig() });
    await manager.start();

    const s = manager.getStatus();
    expect(s.listening).toBe(true);
    expect(s.online).toBe(false);
    // 从未连上过不该报"离线"—— 那是"还没设置好"，提示语完全不同
    expect(s.alert).toBeFalsy();
    expect(s.offlineForMs).toBe(0);
  });

  it('客户端连上后 refresh() 立刻反映 online=true', async () => {
    manager = createBridgeManager({ config: testConfig() });
    await manager.start();
    expect(manager.getStatus().online).toBe(false);

    await registerFakePollClient(manager.getStatus().url, 'test-token');
    await manager.refresh();

    const s = manager.getStatus();
    expect(s.online).toBe(true);
    expect(s.totalConnections).toBe(1);
    expect(s.connections).toHaveLength(1);
    expect(s.connections[0].site).toBe('douyin.com');
    expect(s.connections[0].alive).toBe(true);
  });

  it('轮询会自动发现新连接（不依赖 refresh）', async () => {
    manager = createBridgeManager({ config: testConfig() });
    await manager.start();
    expect(manager.getStatus().online).toBe(false);

    await registerFakePollClient(manager.getStatus().url, 'test-token');
    await wait(1600); // 轮询间隔 1s

    expect(manager.getStatus().online).toBe(true);
  });

  it('状态变化会推给订阅者（首次连上必须推）', async () => {
    manager = createBridgeManager({ config: testConfig() });
    const seen = [];
    manager.subscribe((s) => seen.push({ online: s.online, n: s.connections.length }));

    await manager.start();
    await registerFakePollClient(manager.getStatus().url, 'test-token');
    await wait(1600);

    const onlineEvent = seen.find(e => e.online === true);
    expect(onlineEvent).toBeTruthy();
    expect(onlineEvent.n).toBe(1);
  });

  it('订阅时机晚于连上时，getStatus() 仍给出正确值（界面首屏靠它）', async () => {
    manager = createBridgeManager({ config: testConfig() });
    await manager.start();
    await registerFakePollClient(manager.getStatus().url, 'test-token');
    await wait(1600);

    // 模拟界面挂载后才订阅 —— 此前的变化已经错过了，但快照必须是新的
    const seen = [];
    manager.subscribe((s) => seen.push(s.online));

    const snapshot = manager.getStatus();
    expect(snapshot.online).toBe(true);

    // 而且不应因此重复推送一次"无变化"的状态
    await wait(1300);
    expect(seen).toHaveLength(0);
  });

  it('stop() 后状态归位，且不残留监听', async () => {
    manager = createBridgeManager({ config: testConfig() });
    await manager.start();
    const url = manager.getStatus().url;
    await manager.stop();

    expect(manager.getStatus().listening).toBe(false);
    expect(manager.getStatus().online).toBe(false);

    // 端口应已释放
    await expect(postJson(`${url}/api/connect`, { site: 'x' })).rejects.toThrow();
    manager = null;
  });
});
