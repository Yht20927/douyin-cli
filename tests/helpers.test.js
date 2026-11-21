// tests/helpers.test.js — 命令辅助函数单元测试

const {
  escapeExpression, getFlag, formatComment, extractAccountArg, CLIENT_PROTOCOL_VERSION,
} = require('../core/commands/helpers');

describe('escapeExpression', () => {
  it('转义反斜杠', () => {
    expect(escapeExpression('a\\b')).toBe('a\\\\b');
  });

  it('转义单引号', () => {
    expect(escapeExpression("it's")).toBe("it\\'s");
  });

  it('同时转义反斜杠和单引号', () => {
    expect(escapeExpression("it\\'s")).toBe("it\\\\\\'s");
  });

  it('非字符串转为字符串', () => {
    expect(escapeExpression(123)).toBe('123');
    expect(escapeExpression(null)).toBe('null');
  });

  it('空字符串', () => {
    expect(escapeExpression('')).toBe('');
  });
});

describe('getFlag', () => {
  it('提取数值参数', () => {
    expect(getFlag(['--count', '10'], '--count', 5)).toBe(10);
  });

  it('提取数值参数（数字字符串转为 Number）', () => {
    expect(getFlag(['--video', '123'], '--video', null)).toBe(123);
  });

  it('返回默认值（flag 不存在）', () => {
    expect(getFlag(['--other', '10'], '--count', 5)).toBe(5);
  });

  it('返回默认值（flag 后无值）', () => {
    expect(getFlag(['--count'], '--count', 5)).toBe(5);
  });

  it('返回默认值（flag 后是另一个 flag）', () => {
    expect(getFlag(['--count', '--other'], '--count', 5)).toBe(5);
  });

  it('大数字保持字符串（抖音 ID）', () => {
    expect(getFlag(['--id', '1234567890123456789'], '--id', null)).toBe('1234567890123456789');
  });

  it('安全整数范围内的数字转为 Number', () => {
    expect(getFlag(['--count', '100'], '--count', 0)).toBe(100);
  });
});

describe('formatComment', () => {
  it('基本字段格式化', () => {
    const c = { cid: '123', text: 'hello', digg_count: 5, reply_comment_total: 2, create_time: 1000 };
    const result = formatComment(c);
    expect(result.cid).toBe('123');
    expect(result.text).toBe('hello');
    expect(result.likes).toBe(5);
    expect(result.replies).toBe(2);
    expect(result.time).toBe(1000);
  });

  it('截断长文本到 120 字', () => {
    const c = { text: 'x'.repeat(200) };
    expect(formatComment(c).text.length).toBe(120);
  });

  it('用户信息提取', () => {
    const c = { user: { nickname: 'test', uid: '456', avatar_thumb: { url_list: ['http://img'] } } };
    const result = formatComment(c);
    expect(result.user.nickname).toBe('test');
    expect(result.user.uid).toBe('456');
    expect(result.user.avatar).toBe('http://img');
  });

  it('保留 children 字段', () => {
    const c = { children: [{ cid: 'child1' }] };
    expect(formatComment(c).children).toEqual([{ cid: 'child1' }]);
  });

  it('空评论不报错', () => {
    const result = formatComment({});
    expect(result.cid).toBeUndefined();
    expect(result.text).toBe('');
    expect(result.likes).toBe(0);
  });
});


// ═══════════════════════════════════════════════════════════
// 多账号命令行解析
// ═══════════════════════════════════════════════════════════
describe('extractAccountArg', () => {
  it('摘掉 --account 与它的值，其余参数顺序不变', () => {
    const r = extractAccountArg(['videos', '--account', '主号', '--mine', '--limit', '5']);
    expect(r.raw).toBe('主号');
    expect(r.args).toEqual(['videos', '--mine', '--limit', '5']);
  });

  it('没有 --account 时原样返回', () => {
    const args = ['get', '123'];
    expect(extractAccountArg(args)).toEqual({ args, raw: null });
  });

  it('缺少值或值看起来像另一个选项 → 报错（不把 --mine 当账号）', () => {
    expect(() => extractAccountArg(['like', '123', '--account'])).toThrow(/需要一个值/);
    expect(() => extractAccountArg(['like', '123', '--account', '--mine'])).toThrow(/需要一个值/);
  });

  it('注册契约版本为 3（脚本端 CLIENT_VERSION 必须同步）', () => {
    expect(CLIENT_PROTOCOL_VERSION).toBe(3);
  });
});
