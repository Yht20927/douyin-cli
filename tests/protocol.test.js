// tests/protocol.test.js — 协议校验函数单元测试

const { validateHello, validateResult, validateCallRequest } = require('../lib/shared/protocol');

describe('validateHello', () => {
  it('有效消息', () => {
    const r = validateHello({ type: 'hello', site: 'douyin.com', account: 'ACC_A', url: 'https://douyin.com' });
    expect(r.valid).toBe(true);
    expect(r.data.site).toBe('douyin.com');
    expect(r.data.account).toBe('ACC_A');
  });

  it('nickname 可选：带上就传，缺省归一为空串', () => {
    expect(validateHello({ type: 'hello', site: 'douyin.com', account: 'A', nickname: '小九' }).data.nickname).toBe('小九');
    expect(validateHello({ type: 'hello', site: 'douyin.com', account: 'A' }).data.nickname).toBe('');
    expect(validateHello({ type: 'hello', site: 'douyin.com', account: 'A', nickname: 42 }).data.nickname).toBe('');
  });

  it('缺少 site', () => {
    const r = validateHello({ type: 'hello' });
    expect(r.valid).toBe(false);
    expect(r.error).toContain('site');
  });

  it('缺少 account 被拒（未登录的标签页不应连接）', () => {
    expect(validateHello({ type: 'hello', site: 'douyin.com' }).valid).toBe(false);
    expect(validateHello({ type: 'hello', site: 'douyin.com', account: '' }).valid).toBe(false);
    expect(validateHello({ type: 'hello', site: 'douyin.com', account: 123 }).valid).toBe(false);
    expect(validateHello({ type: 'hello', site: 'douyin.com' }).error).toContain('account');
  });

  it('错误的 type', () => {
    const r = validateHello({ type: 'result', site: 'test' });
    expect(r.valid).toBe(false);
  });

  it('null 输入', () => {
    expect(validateHello(null).valid).toBe(false);
  });

  it('非对象输入', () => {
    expect(validateHello('hello').valid).toBe(false);
  });
});

describe('validateResult', () => {
  it('有效结果（带 value）', () => {
    const r = validateResult({ type: 'result', id: '123', value: 'ok' });
    expect(r.valid).toBe(true);
  });

  it('有效结果（带 error）', () => {
    const r = validateResult({ type: 'result', id: '123', error: 'fail' });
    expect(r.valid).toBe(true);
  });

  it('缺少 id', () => {
    const r = validateResult({ type: 'result', value: 'ok' });
    expect(r.valid).toBe(false);
    expect(r.error).toContain('id');
  });

  it('缺少 value 和 error', () => {
    const r = validateResult({ type: 'result', id: '123' });
    expect(r.valid).toBe(false);
  });

  it('错误的 type', () => {
    expect(validateResult({ type: 'hello', id: '123', value: 'ok' }).valid).toBe(false);
  });
});

describe('validateCallRequest', () => {
  it('有效请求', () => {
    const r = validateCallRequest({ site: 'douyin.com', expression: 'window.test()' });
    expect(r.valid).toBe(true);
    expect(r.data.awaitPromise).toBe(true);
    expect(r.data.connIndex).toBe(0);
  });

  it('自定义参数', () => {
    const r = validateCallRequest({ site: 'test', expression: '1+1', awaitPromise: false, connIndex: 2, timeout: 5000 });
    expect(r.valid).toBe(true);
    expect(r.data.awaitPromise).toBe(false);
    expect(r.data.connIndex).toBe(2);
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
