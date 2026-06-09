// tests/parseResponse.test.js — 抖音 API 响应解析单元测试

const { parseResponseText } = require('../lib/shared/parseResponse');

describe('parseResponseText', () => {
  describe('成功路径', () => {
    it('合法 JSON 返回 ok=true', () => {
      const r = parseResponseText('search', 200, 'application/json', '{"status_code":0,"data":[]}');
      expect(r.ok).toBe(true);
      expect(r.value.status_code).toBe(0);
    });

    it('content-type 为空但响应是 JSON 也接受', () => {
      const r = parseResponseText('search', 200, '', '{"x":1}');
      expect(r.ok).toBe(true);
      expect(r.value.x).toBe(1);
    });

    it('解析嵌套数组/对象', () => {
      const r = parseResponseText('get', 200, 'application/json; charset=utf-8',
        '{"comments":[{"cid":"123","text":"ok"}],"has_more":1}');
      expect(r.ok).toBe(true);
      expect(r.value.comments[0].cid).toBe('123');
    });
  });

  describe('HTTP 错误', () => {
    it('500 错误标记 retryable=false', () => {
      const r = parseResponseText('search', 500, 'text/plain', 'Internal Server Error');
      expect(r.ok).toBe(false);
      expect(r.retryable).toBe(false);
      expect(r.error).toContain('HTTP 500');
      expect(r.error).toContain('search');
      expect(r.error).toContain('Internal Server Error');
    });

    it('404 错误包含 content-type', () => {
      const r = parseResponseText('publish', 404, 'text/html', '<html>not found</html>');
      expect(r.ok).toBe(false);
      expect(r.error).toContain('HTTP 404');
      expect(r.error).toContain('text/html');
    });

    it('502 网关错误', () => {
      const r = parseResponseText('search', 502, '', '');
      expect(r.ok).toBe(false);
      expect(r.error).toContain('HTTP 502');
    });

    it('响应文本长截断到 200 字', () => {
      const long = 'x'.repeat(500);
      const r = parseResponseText('search', 503, '', long);
      expect(r.error.length).toBeLessThan(300);
      expect(r.error).toContain('...');
    });
  });

  describe('空响应', () => {
    it('完全空字符串 retryable=true', () => {
      const r = parseResponseText('search', 200, 'application/json', '');
      expect(r.ok).toBe(false);
      expect(r.retryable).toBe(true);
      expect(r.error).toContain('空响应');
      expect(r.error).toContain('限流');
    });

    it('仅空白字符也算空', () => {
      const r = parseResponseText('search', 200, 'application/json', '   \n\t  ');
      expect(r.ok).toBe(false);
      expect(r.retryable).toBe(true);
      expect(r.error).toContain('空响应');
    });

    it('包含 label 标识', () => {
      const r = parseResponseText('publish', 200, '', '');
      expect(r.error).toContain('[publish]');
    });
  });

  describe('非 JSON 响应', () => {
    it('HTML 页面（以 < 开头）识别为登录态失效提示', () => {
      const r = parseResponseText('search', 200, 'text/html; charset=utf-8',
        '<!DOCTYPE html><html><head><title>验证</title></head></html>');
      expect(r.ok).toBe(false);
      expect(r.retryable).toBe(true);
      expect(r.error).toContain('HTML');
      expect(r.error).toContain('登录态');
    });

    it('content-type 为 text/html 但内容不以 < 开头也识别为 HTML', () => {
      const r = parseResponseText('publish', 200, 'text/html', 'redirect to login...');
      expect(r.error).toContain('HTML');
    });

    it('普通非 JSON 字符串', () => {
      const r = parseResponseText('search', 200, 'text/plain', 'not json content');
      expect(r.ok).toBe(false);
      expect(r.retryable).toBe(true);
      expect(r.error).toContain('合法 JSON');
      expect(r.error).toContain('text/plain');
    });

    it('截断超长非 JSON 响应', () => {
      const html = '<html>' + 'x'.repeat(500) + '</html>';
      const r = parseResponseText('search', 200, 'text/html', html);
      expect(r.error).toContain('...');
    });
  });

  describe('边界情况', () => {
    it('数字字面量也是合法 JSON', () => {
      const r = parseResponseText('x', 200, 'application/json', '42');
      expect(r.ok).toBe(true);
      expect(r.value).toBe(42);
    });

    it('null 是合法 JSON', () => {
      const r = parseResponseText('x', 200, 'application/json', 'null');
      expect(r.ok).toBe(true);
      expect(r.value).toBe(null);
    });

    it('截断的 JSON 应识别为非 JSON', () => {
      const r = parseResponseText('x', 200, 'application/json', '{"a":1,"b":');
      expect(r.ok).toBe(false);
      expect(r.error).toContain('合法 JSON');
    });

    it('label 出现在所有错误消息中', () => {
      const cases = [
        parseResponseText('myLabel', 500, '', 'err'),
        parseResponseText('myLabel', 200, '', ''),
        parseResponseText('myLabel', 200, '', '<html>'),
      ];
      for (const c of cases) {
        expect(c.error).toContain('myLabel');
      }
    });
  });
});
