// tests/registry.test.js — ConnectionRegistry 单元测试

const { ConnectionRegistry } = require('../core/server/registry');

describe('ConnectionRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new ConnectionRegistry();
  });

  it('初始状态无连接', () => {
    expect(registry.totalConnections).toBe(0);
    expect(registry.list()).toEqual({});
  });

  it('注册连接', () => {
    const conn = registry.register('douyin.com', null, { url: 'https://douyin.com' });
    expect(conn.id).toBeTruthy();
    expect(conn.site).toBe('douyin.com');
    expect(registry.totalConnections).toBe(1);
  });

  it('获取连接', () => {
    const conn = registry.register('douyin.com', null);
    const got = registry.get('douyin.com', 0);
    expect(got.id).toBe(conn.id);
  });

  it('获取不存在的站点返回 null', () => {
    expect(registry.get('unknown.com', 0)).toBeNull();
  });

  it('多站点隔离', () => {
    registry.register('douyin.com', null);
    registry.register('bilibili.com', null);
    expect(registry.totalConnections).toBe(2);
    expect(registry.get('douyin.com', 0)).toBeTruthy();
    expect(registry.get('bilibili.com', 0)).toBeTruthy();
  });

  it('移除连接 (unregister)', () => {
    const conn = registry.register('douyin.com', null);
    registry.unregister(conn.id);
    expect(registry.totalConnections).toBe(0);
    expect(registry.get('douyin.com', 0)).toBeNull();
  });

  it('list 返回按站点分组的对象', () => {
    registry.register('douyin.com', null, { url: 'https://douyin.com' });
    registry.register('douyin.com', null, { url: 'https://douyin.com/other' });
    const list = registry.list();
    expect(list['douyin.com']).toHaveLength(2);
    expect(list['douyin.com'][0].url).toBe('https://douyin.com');
  });
});

// ═══════════════════════════════════════════════════════════
// 长轮询连接的存活判定
//
// 回归背景：改造前 `alive: c.ws ? c.ws.readyState === 1 : true` ——
// HTTP 长轮询连接（ws === null，也就是生产实际走的通道）一律判为活着。
// 后果是关掉抖音页面后注册表永远说"还活着"，桌面应用的离线告警完全失效。
//
// 长轮询没有 close 事件，只能靠最后活跃时间推断：油猴脚本在长轮询返回后
// 会立刻再发起下一次（router 侧 25 秒超时），所以健康客户端至少每 25 秒被
// touch 一次；超过阈值没动静即判定死亡。
// ═══════════════════════════════════════════════════════════

describe('ConnectionRegistry: 长轮询存活判定', () => {
  it('刚注册的长轮询连接是活的', () => {
    const registry = new ConnectionRegistry();
    registry.register('douyin.com', null, {});
    expect(registry.list()['douyin.com'][0].alive).toBe(true);
  });

  it('超过失活阈值未活跃 → 判定为死', () => {
    const registry = new ConnectionRegistry({ staleAfterMs: 1000 });
    const conn = registry.register('douyin.com', null, {});
    // 把最后活跃时间拨回到 2 秒前
    conn.lastActivity = new Date(Date.now() - 2000).toISOString();
    expect(registry.list()['douyin.com'][0].alive).toBe(false);
    expect(registry.isAlive(conn)).toBe(false);
  });

  it('touch() 能把濒死连接救活', () => {
    const registry = new ConnectionRegistry({ staleAfterMs: 1000 });
    const conn = registry.register('douyin.com', null, {});
    conn.lastActivity = new Date(Date.now() - 5000).toISOString();
    expect(registry.isAlive(conn)).toBe(false);

    registry.touch(conn.id);
    expect(registry.isAlive(conn)).toBe(true);
  });

  it('边界：恰好在阈值内算活', () => {
    const registry = new ConnectionRegistry({ staleAfterMs: 10000 });
    const conn = registry.register('douyin.com', null, {});
    conn.lastActivity = new Date(Date.now() - 5000).toISOString();
    expect(registry.isAlive(conn)).toBe(true);
  });

  it('get() 优先返回活着的连接', () => {
    const registry = new ConnectionRegistry({ staleAfterMs: 1000 });
    const dead = registry.register('douyin.com', null, { url: 'old' });
    dead.lastActivity = new Date(Date.now() - 9000).toISOString();
    const live = registry.register('douyin.com', null, { url: 'new' });

    expect(registry.get('douyin.com').id).toBe(live.id);
  });

  it('全都不活时仍返回一个（调用方应拿到超时，而不是"找不到站点"）', () => {
    const registry = new ConnectionRegistry({ staleAfterMs: 1000 });
    const dead = registry.register('douyin.com', null, {});
    dead.lastActivity = new Date(Date.now() - 9000).toISOString();

    const got = registry.get('douyin.com');
    expect(got).toBeTruthy();
    expect(got.id).toBe(dead.id);
  });

  it('WebSocket 连接仍按 readyState 判定，不受活跃时间影响', () => {
    const registry = new ConnectionRegistry({ staleAfterMs: 1000 });
    const ws = { readyState: 1 };
    const conn = registry.register('douyin.com', ws, {});
    conn.lastActivity = new Date(Date.now() - 60000).toISOString();

    expect(registry.isAlive(conn)).toBe(true);
    ws.readyState = 3; // CLOSED
    expect(registry.isAlive(conn)).toBe(false);
  });

  it('多站点各自独立判定', () => {
    const registry = new ConnectionRegistry({ staleAfterMs: 1000 });
    const a = registry.register('douyin.com', null, {});
    const b = registry.register('other.com', null, {});
    a.lastActivity = new Date(Date.now() - 9000).toISOString();

    const list = registry.list();
    expect(list['douyin.com'][0].alive).toBe(false);
    expect(list['other.com'][0].alive).toBe(true);
    expect(b.id).toBeTruthy();
  });
});
