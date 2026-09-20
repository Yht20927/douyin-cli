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
    const conn = registry.register('douyin.com', { url: 'https://douyin.com' });
    expect(conn.id).toBeTruthy();
    expect(conn.site).toBe('douyin.com');
    expect(registry.totalConnections).toBe(1);
  });

  it('获取连接', () => {
    const conn = registry.register('douyin.com');
    const got = registry.get('douyin.com', 0);
    expect(got.id).toBe(conn.id);
  });

  it('获取不存在的站点返回 null', () => {
    expect(registry.get('unknown.com', 0)).toBeNull();
  });

  it('多站点隔离', () => {
    registry.register('douyin.com');
    registry.register('bilibili.com');
    expect(registry.totalConnections).toBe(2);
    expect(registry.get('douyin.com', 0)).toBeTruthy();
    expect(registry.get('bilibili.com', 0)).toBeTruthy();
  });

  it('移除连接 (unregister)', () => {
    const conn = registry.register('douyin.com');
    registry.unregister(conn.id);
    expect(registry.totalConnections).toBe(0);
    expect(registry.get('douyin.com', 0)).toBeNull();
  });

  it('list 返回按站点分组的对象', () => {
    registry.register('douyin.com', { url: 'https://douyin.com' });
    registry.register('douyin.com', { url: 'https://douyin.com/other' });
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
    registry.register('douyin.com', {});
    expect(registry.list()['douyin.com'][0].alive).toBe(true);
  });

  it('超过失活阈值未活跃 → 判定为死', () => {
    const registry = new ConnectionRegistry({ staleAfterMs: 1000 });
    const conn = registry.register('douyin.com', {});
    // 把最后活跃时间拨回到 2 秒前
    conn.lastActivity = new Date(Date.now() - 2000).toISOString();
    expect(registry.list()['douyin.com'][0].alive).toBe(false);
    expect(registry.isAlive(conn)).toBe(false);
  });

  it('touch() 能把濒死连接救活', () => {
    const registry = new ConnectionRegistry({ staleAfterMs: 1000 });
    const conn = registry.register('douyin.com', {});
    conn.lastActivity = new Date(Date.now() - 5000).toISOString();
    expect(registry.isAlive(conn)).toBe(false);

    registry.touch(conn.id);
    expect(registry.isAlive(conn)).toBe(true);
  });

  it('边界：恰好在阈值内算活', () => {
    const registry = new ConnectionRegistry({ staleAfterMs: 10000 });
    const conn = registry.register('douyin.com', {});
    conn.lastActivity = new Date(Date.now() - 5000).toISOString();
    expect(registry.isAlive(conn)).toBe(true);
  });

  it('get() 优先返回活着的连接', () => {
    const registry = new ConnectionRegistry({ staleAfterMs: 1000 });
    const dead = registry.register('douyin.com', { url: 'old' });
    dead.lastActivity = new Date(Date.now() - 9000).toISOString();
    const live = registry.register('douyin.com', { url: 'new' });

    expect(registry.get('douyin.com').id).toBe(live.id);
  });

  it('全都不活时仍返回一个（调用方应拿到超时，而不是"找不到站点"）', () => {
    const registry = new ConnectionRegistry({ staleAfterMs: 1000 });
    const dead = registry.register('douyin.com', {});
    dead.lastActivity = new Date(Date.now() - 9000).toISOString();

    const got = registry.get('douyin.com');
    expect(got).toBeTruthy();
    expect(got.id).toBe(dead.id);
  });

  it('多站点各自独立判定', () => {
    const registry = new ConnectionRegistry({ staleAfterMs: 1000 });
    const a = registry.register('douyin.com', {});
    const b = registry.register('other.com', {});
    a.lastActivity = new Date(Date.now() - 9000).toISOString();

    const list = registry.list();
    expect(list['douyin.com'][0].alive).toBe(false);
    expect(list['other.com'][0].alive).toBe(true);
    expect(b.id).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════
// 登录账号信息（连接页显示"连的是哪个号"）
//
// 回归背景：连接页此前只能显示页面 URL 和标题 —— 用户关心的是账号，
// 不是网址。账号由油猴脚本注册时上报（外部输入），registry 是归一化的收口。
// ═══════════════════════════════════════════════════════════
describe('ConnectionRegistry: 账号信息', () => {
  it('注册时存入并经 list() 带出账号', () => {
    const registry = new ConnectionRegistry();
    registry.register('douyin.com', {
      account: {
        nickname: '小杨', avatar: 'https://p.douyinpic.com/a.jpg', secUid: 'sec-1', uid: '42',
        followerCount: 97, followingCount: 105, likesReceived: 126,
      },
      clientVersion: 2,
    });
    const row = registry.list()['douyin.com'][0];
    expect(row.account).toEqual({
      nickname: '小杨', avatar: 'https://p.douyinpic.com/a.jpg', secUid: 'sec-1', uid: '42',
      followerCount: 97, followingCount: 105, likesReceived: 126,
    });
    expect(row.clientVersion).toBe(2);
  });

  it('没有账号时 account 为 null（旧版脚本 / 未登录），不影响连接本身', () => {
    const registry = new ConnectionRegistry();
    registry.register('douyin.com', {});
    const row = registry.list()['douyin.com'][0];
    expect(row.account).toBeNull();
    expect(row.clientVersion).toBeNull();
  });

  it('恶意/多余字段被剔除，nickname 缺失时整个 account 归 null', () => {
    const registry = new ConnectionRegistry();
    registry.register('douyin.com', {
      account: { nickname: 'x', evil: { a: 1 }, url: 'javascript:alert(1)', avatar: 'http://not-https' },
    });
    const row = registry.list()['douyin.com'][0];
    expect(row.account).toEqual({
      nickname: 'x', avatar: '', secUid: '', uid: '',
      followerCount: null, followingCount: null, likesReceived: null,
    });
  });

  it('重新注册（换号 / 刷新页面）会顶掉旧连接，账号取新上报的那一份', () => {
    const registry = new ConnectionRegistry();
    registry.register('douyin.com', { account: { nickname: '旧名字', uid: '1' } });
    registry.register('douyin.com', { account: { nickname: '旧名字第二页', uid: '1' } });

    // 长轮询没有 close 事件：脚本重新 /api/connect 时先清掉同 site 的旧条目，
    // 否则每刷新一次页面就多一条连接，registry.get 挑到的可能是早就关掉的页面
    expect(registry.totalConnections).toBe(2);
    registry.removeStalePolling('douyin.com');
    registry.register('douyin.com', { account: { nickname: '新名字', uid: '2' } });

    const rows = registry.list()['douyin.com'];
    expect(rows).toHaveLength(1);
    expect(rows[0].account.nickname).toBe('新名字');
    expect(registry.get('douyin.com').account.uid).toBe('2');
    expect(registry.totalConnections).toBe(1);
  });

  it('removeStalePolling 只清同一个 site，别的站点的连接不受牵连', () => {
    const registry = new ConnectionRegistry();
    registry.register('douyin.com', { account: { nickname: 'a', uid: '1' } });
    const other = registry.register('bilibili.com', { account: { nickname: 'b', uid: '2' } });
    expect(registry.removeStalePolling('douyin.com')).toBe(1);
    expect(registry.get('bilibili.com').id).toBe(other.id);
    expect(registry.removeStalePolling('douyin.com')).toBe(0); // 已经没有条目了，不抛错
  });
});
