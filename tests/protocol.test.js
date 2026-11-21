// tests/protocol.test.js — 协议校验函数单元测试
//
// 原先这里的 validateHello / validateResult 随 WebSocket 通道一起删除，
// 通道只剩 HTTP 长轮询：/api/connect 注册、/api/poll 取命令、/api/result 回填。

const {
  validateCallRequest, normalizeAccount,
  channelOf, parseChannel, accountUidOf, connectionAccountUid, buildEvalMessage,
} = require('../core/shared/protocol');

describe('validateCallRequest', () => {
  it('有效请求', () => {
    const r = validateCallRequest({ site: 'douyin.com', expression: 'window.test()' });
    expect(r.valid).toBe(true);
    expect(r.data.awaitPromise).toBe(true);
    expect(r.data.account).toBeNull();
    expect(r.data.opType).toBe('read');
  });

  it('account 支持 uid 字符串与账号对象，opType=write 原样保留', () => {
    expect(validateCallRequest({ site: 's', expression: 'x', account: 'u1' }).data.account).toBe('u1');
    expect(validateCallRequest({ site: 's', expression: 'x', account: { uid: 'u2' } }).data.account).toBe('u2');
    expect(validateCallRequest({ site: 's', expression: 'x', opType: 'write' }).data.opType).toBe('write');
    expect(validateCallRequest({ site: 's', expression: 'x', opType: 'delete' }).data.opType).toBe('read');
  });

  it('自定义参数', () => {
    const r = validateCallRequest({ site: 'test', expression: '1+1', awaitPromise: false, timeout: 5000 });
    expect(r.valid).toBe(true);
    expect(r.data.awaitPromise).toBe(false);
    expect(r.data.timeout).toBe(5000);
  });

  it('缺少 site', () => {
    expect(validateCallRequest({ expression: '1+1' }).valid).toBe(false);
  });

  it('缺少 expression', () => {
    expect(validateCallRequest({ site: 'test' }).valid).toBe(false);
  });

  it('null 输入', () => {
    expect(validateCallRequest(null).valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// normalizeAccount —— 油猴脚本注册时上报的登录账号信息
// 属于外部输入：只留白名单字段，昵称缺失视为"没认出账号"
// ═══════════════════════════════════════════════════════════
describe('normalizeAccount', () => {
  it('正常字段全部保留', () => {
    expect(normalizeAccount({ nickname: '小杨', avatar: 'https://x/a.jpg', secUid: 's1', uid: '7' }))
      .toEqual({
        nickname: '小杨', avatar: 'https://x/a.jpg', secUid: 's1', uid: '7',
        followerCount: null, followingCount: null, likesReceived: null,
      });
  });

  it('粉丝/关注/获赞：数字与纯数字字符串都接受，小数向下取整', () => {
    expect(normalizeAccount({ nickname: 'x', followerCount: 97, followingCount: '105', likesReceived: '126.9' }))
      .toEqual({
        nickname: 'x', avatar: '', secUid: '', uid: '',
        followerCount: 97, followingCount: 105, likesReceived: 126,
      });
  });

  it('粉丝/关注/获赞：负数、非数字、垃圾输入一律丢弃为 null', () => {
    const r = normalizeAccount({ nickname: 'x', followerCount: -1, followingCount: 'abc', likesReceived: {} });
    expect(r.followerCount).toBeNull();
    expect(r.followingCount).toBeNull();
    expect(r.likesReceived).toBeNull();
  });

  it('非对象输入返回 null', () => {
    expect(normalizeAccount(null)).toBeNull();
    expect(normalizeAccount('小杨')).toBeNull();
    expect(normalizeAccount(['小杨'])).toBeNull();
  });

  it('只认 https 头像地址（脚本可能带 http:// 或恶意串）', () => {
    expect(normalizeAccount({ nickname: 'x', avatar: 'http://x/a.jpg' }).avatar).toBe('');
    expect(normalizeAccount({ nickname: 'x', avatar: 'javascript:alert(1)' }).avatar).toBe('');
  });

  it('昵称缺失或为空 → null（界面按"未识别账号"处理）', () => {
    expect(normalizeAccount({ avatar: 'https://x/a.jpg' })).toBeNull();
    expect(normalizeAccount({ nickname: '   ' })).toBeNull();
  });

  it('过长字段截断', () => {
    const r = normalizeAccount({ nickname: '啊'.repeat(200) });
    expect(r.nickname.length).toBe(60);
  });
});


// ═══════════════════════════════════════════════════════════
// 多账号寻址：channel = site#uid
//
// 一个浏览器连接 = 一个「站点 + 登录账号」组合。channel 是服务端
// 分桶（轮询队列/等待者/pending）的唯一键，因此这三个函数的语义
// 必须固定，否则账号隔离会在某个下游悄悄退化成 site 级。
// ═══════════════════════════════════════════════════════════
describe('channel 寻址', () => {
  it('有 uid 时是 site#uid，无 uid 时退化为 site（兼容旧脚本/未登录）', () => {
    expect(channelOf('douyin.com', 'u1')).toBe('douyin.com#u1');
    expect(channelOf('douyin.com', '')).toBe('douyin.com');
    expect(channelOf('douyin.com')).toBe('douyin.com');
    expect(channelOf('douyin.com', null)).toBe('douyin.com');
  });

  it('parseChannel 与 channelOf 往返一致，且能处理无 # 的旧键', () => {
    expect(parseChannel(channelOf('douyin.com', 'u1'))).toEqual({ site: 'douyin.com', account: 'u1' });
    expect(parseChannel('douyin.com')).toEqual({ site: 'douyin.com', account: '' });
    // uid 里理论上不会出现 #，但真的出现时只按第一个 # 切，保留其余部分
    expect(parseChannel('s#a#b')).toEqual({ site: 's', account: 'a#b' });
  });

  it('accountUidOf 接受字符串/对象，只取 uid 并截断', () => {
    expect(accountUidOf(' u1 ')).toBe('u1');
    expect(accountUidOf({ uid: 'u2' })).toBe('u2');
    expect(accountUidOf({ nickname: '没有 uid' })).toBe('');
    expect(accountUidOf(null)).toBe('');
    expect(accountUidOf('x'.repeat(100))).toHaveLength(64);
  });

  it('connectionAccountUid 兼容 account 对象 / uid / 平铺 accountUid', () => {
    expect(connectionAccountUid({ account: { uid: 'u1' } })).toBe('u1');
    expect(connectionAccountUid({ account: 'u2' })).toBe('u2');
    expect(connectionAccountUid({ uid: 'u3' })).toBe('u3');
    expect(connectionAccountUid({ accountUid: 'u4', uid: 'u5' })).toBe('u4');
    expect(connectionAccountUid(null)).toBe('');
  });

  it('buildEvalMessage 只在写操作时带 expectAccount', () => {
    expect(buildEvalMessage('id1', '1+1')).toEqual({
      type: 'eval', id: 'id1', expression: '1+1', awaitPromise: true,
    });
    expect(buildEvalMessage('id2', 'x', false, 'u1')).toEqual({
      type: 'eval', id: 'id2', expression: 'x', awaitPromise: false, expectAccount: 'u1',
    });
  });
});
