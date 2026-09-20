// tests/protocol.test.js — 协议校验函数单元测试
//
// 原先这里的 validateHello / validateResult 随 WebSocket 通道一起删除，
// 通道只剩 HTTP 长轮询：/api/connect 注册、/api/poll 取命令、/api/result 回填。

const { validateCallRequest, normalizeAccount } = require('../core/shared/protocol');

describe('validateCallRequest', () => {
  it('有效请求', () => {
    const r = validateCallRequest({ site: 'douyin.com', expression: 'window.test()' });
    expect(r.valid).toBe(true);
    expect(r.data.awaitPromise).toBe(true);
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
