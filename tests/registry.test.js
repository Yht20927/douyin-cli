// tests/registry.test.js — ConnectionRegistry 单元测试

const { ConnectionRegistry } = require('../lib/server/registry');

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
    const got = registry.getAccount('douyin.com', '');
    expect(got.id).toBe(conn.id);
  });

  it('获取不存在的站点返回 null', () => {
    expect(registry.getAccount('unknown.com', '')).toBeNull();
  });

  it('多站点隔离', () => {
    registry.register('douyin.com', null);
    registry.register('bilibili.com', null);
    expect(registry.totalConnections).toBe(2);
    expect(registry.getAccount('douyin.com', '')).toBeTruthy();
    expect(registry.getAccount('bilibili.com', '')).toBeTruthy();
  });

  it('移除连接 (unregister)', () => {
    const conn = registry.register('douyin.com', null);
    registry.unregister(conn.id);
    expect(registry.totalConnections).toBe(0);
    expect(registry.getAccount('douyin.com', '')).toBeNull();
  });

  it('list 返回按站点分组的对象', () => {
    registry.register('douyin.com', null, { url: 'https://douyin.com' });
    registry.register('douyin.com', null, { url: 'https://douyin.com/other' });
    const list = registry.list();
    expect(list['douyin.com']).toHaveLength(2);
    expect(list['douyin.com'][0].url).toBe('https://douyin.com');
  });
});

describe('ConnectionRegistry 多账号', () => {
  let registry;

  beforeEach(() => {
    registry = new ConnectionRegistry();
  });

  it('不同账号落在不同通道，互不覆盖', () => {
    registry.register('douyin.com', null, { account: 'A' });
    registry.register('douyin.com', null, { account: 'B' });
    expect(registry.getAccount('douyin.com', 'A').account).toBe('A');
    expect(registry.getAccount('douyin.com', 'B').account).toBe('B');
    expect(registry.totalConnections).toBe(2);
  });

  it('removeStalePolling 只清自己的通道（多账号的核心回归点）', () => {
    registry.register('douyin.com', null, { account: 'A' });
    registry.register('douyin.com', null, { account: 'B' });
    registry.removeStalePolling('douyin.com', 'B');
    // A 必须还在：按 site 清理会把 A 一起删掉，那正是多账号失效的根因
    expect(registry.getAccount('douyin.com', 'A')).toBeTruthy();
    expect(registry.getAccount('douyin.com', 'B')).toBeNull();
  });

  it('指定账号未连接 → null，绝不回退到别的账号', () => {
    registry.register('douyin.com', null, { account: 'A' });
    expect(registry.getAccount('douyin.com', 'C')).toBeNull();
  });

  it('accountsOf 列出在线账号并去重同账号多标签页', () => {
    registry.register('douyin.com', null, { account: 'A' });
    registry.register('douyin.com', null, { account: 'A' }); // 同容器第二标签
    registry.register('douyin.com', null, { account: 'B' });
    expect(registry.accountsOf('douyin.com').map(a => a.account).sort()).toEqual(['A', 'B']);
  });

  it('空账号的连接不计入账号列表（握手已强制 account 非空，这里兜底）', () => {
    registry.register('douyin.com', null, { account: '' });
    expect(registry.accountsOf('douyin.com')).toHaveLength(0);
  });

  it('pickForRead 轮换：选最久没被服务过的账号', () => {
    const a = registry.register('douyin.com', null, { account: 'A' });
    const b = registry.register('douyin.com', null, { account: 'B' });
    a.lastServedAt = Date.now() - 60000;
    b.lastServedAt = Date.now() - 1000;
    expect(registry.pickForRead('douyin.com', 15000).account).toBe('A');
  });

  it('pickForRead 跳过未识别账号的连接', () => {
    registry.register('douyin.com', null, { account: '' });
    expect(registry.pickForRead('douyin.com', 15000)).toBeNull();
  });

  it('updateAccount 换号后连接迁移到新通道且保留 connId', () => {
    const conn = registry.register('douyin.com', null, { account: '' });
    const moved = registry.updateAccount(conn.id, 'A');
    expect(moved.account).toBe('A');
    expect(moved.id).toBe(conn.id);
    expect(registry.getAccount('douyin.com', '')).toBeNull();
    expect(registry.getAccount('douyin.com', 'A').id).toBe(conn.id);
  });

  it('昵称随连接保存并透出（accountsOf / list / updateMeta）', () => {
    const conn = registry.register('douyin.com', null, { account: 'A', nickname: '小九' });
    expect(conn.nickname).toBe('小九');
    expect(registry.accountsOf('douyin.com')[0].nickname).toBe('小九');
    expect(registry.list()['douyin.com'][0].nickname).toBe('小九');

    registry.updateMeta(conn.id, { nickname: '改名了' });
    expect(registry.accountsOf('douyin.com')[0].nickname).toBe('改名了');
  });

  it('拿不到昵称时为空串，不影响连接本身', () => {
    registry.register('douyin.com', null, { account: 'A' });
    expect(registry.accountsOf('douyin.com')[0].nickname).toBe('');
  });

  it('换号迁移通道时昵称跟着走', () => {
    const conn = registry.register('douyin.com', null, { account: 'A', nickname: '小九' });
    registry.updateAccount(conn.id, 'B');
    expect(registry.getAccount('douyin.com', 'B').nickname).toBe('小九');
  });
});
