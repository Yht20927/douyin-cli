// tests/reply-engine/context-scope.test.js

describe('context-scope', () => {
  const { buildScopedContext, dedupeByText, resetMemory } = require('../../core/reply-engine/context-scope');

  afterEach(() => {
    resetMemory();
  });

  describe('dedupeByText', () => {
    it('should remove duplicate replies', () => {
      const items = [
        { replyText: '你好' },
        { replyText: '你好' },
        { replyText: '再见' },
      ];
      const result = dedupeByText(items);
      expect(result).toHaveLength(2);
    });

    it('should be case-insensitive and trim-insensitive', () => {
      const items = [
        { replyText: '  HELLO  ' },
        { replyText: 'hello' },
      ];
      const result = dedupeByText(items);
      expect(result).toHaveLength(1);
    });

    it('should handle empty array', () => {
      expect(dedupeByText([])).toEqual([]);
    });

    it('should handle non-array', () => {
      expect(dedupeByText(null)).toEqual([]);
    });
  });

  describe('buildScopedContext', () => {
    it('should return empty context when no DB available', () => {
      // 无测试 DB 的情况下返回空对象
      process.env.DOUYIN_STORAGE_DIR = '/tmp/nonexistent_douyin_test';
      const result = buildScopedContext('test_aweme_001');
      expect(result).toBeDefined();
      expect(Array.isArray(result.corpus)).toBe(true);
      expect(Array.isArray(result.avoid)).toBe(true);
      expect(Array.isArray(result.failures)).toBe(true);
      delete process.env.DOUYIN_STORAGE_DIR;
    });
  });
});
