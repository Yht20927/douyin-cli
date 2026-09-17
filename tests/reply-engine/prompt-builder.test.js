// tests/reply-engine/prompt-builder.test.js

const path = require('path');
const fs = require('fs');

// 确保 prompts 目录存在
const PROMPTS_DIR = path.join(__dirname, '..', '..', 'prompts');

describe('prompt-builder', () => {
  const {
    loadTemplate, render, clearTemplateCache,
    buildImageHint, buildScopedBlock,
    buildGenerateCommentPrompt, buildGenerateReplyPrompt, buildGenerateRepliesPrompt,
    buildSuggestPrompt, buildAnalyzePrompt,
  } = require('../../core/reply-engine/prompt-builder');

  beforeAll(() => {
    // 确保模板文件存在
    const suggestPath = path.join(PROMPTS_DIR, 'suggest.md');
    const analyzePath = path.join(PROMPTS_DIR, 'analyze.md');
    const commentPath = path.join(PROMPTS_DIR, 'comment.md');
    const replyPath = path.join(PROMPTS_DIR, 'reply.md');
    if (!fs.existsSync(suggestPath) || !fs.existsSync(analyzePath) ||
        !fs.existsSync(commentPath) || !fs.existsSync(replyPath)) {
      console.warn('部分 prompt 模板不存在，部分测试将使用 fallback');
    }
  });

  afterAll(() => {
    clearTemplateCache();
  });

  describe('loadTemplate', () => {
    it('should load suggest.md template', () => {
      const tpl = loadTemplate('suggest.md');
      expect(tpl).not.toBeNull();
      expect(tpl.system).toBeTruthy();
      expect(tpl.user).toBeTruthy();
    });

    it('should load analyze.md template', () => {
      const tpl = loadTemplate('analyze.md');
      expect(tpl).not.toBeNull();
    });

    it('should load comment.md template', () => {
      const tpl = loadTemplate('comment.md');
      expect(tpl).not.toBeNull();
    });

    it('should load reply.md template', () => {
      const tpl = loadTemplate('reply.md');
      expect(tpl).not.toBeNull();
    });

    it('should return null for missing template', () => {
      const tpl = loadTemplate('nonexistent.md');
      expect(tpl).toBeNull();
    });

    it('should cache templates', () => {
      const tpl1 = loadTemplate('suggest.md');
      const tpl2 = loadTemplate('suggest.md');
      expect(tpl1).toBe(tpl2); // Same reference from cache
    });
  });

  describe('render', () => {
    it('should replace placeholders', () => {
      const result = render('Hello {{NAME}}!', { NAME: 'World' });
      expect(result).toBe('Hello World!');
    });

    it('should preserve unreplaced placeholders', () => {
      const result = render('Hi {{NAME}}, {{UNKNOWN}}', { NAME: 'A' });
      expect(result).toBe('Hi A, {{UNKNOWN}}');
    });

    it('should handle null template', () => {
      expect(render(null, {})).toBeNull();
    });

    it('should handle empty vars', () => {
      const result = render('{{EMPTY}}', { EMPTY: '' });
      expect(result).toBe('');
    });
  });

  describe('buildImageHint', () => {
    it('should return hint for screenshots mode', () => {
      const vctx = { screenshotB64: ['data:...', 'data:...'] };
      const hint = buildImageHint(vctx, 'screenshots');
      expect(hint).toContain('截图');
    });

    it('should return hint for video mode', () => {
      const vctx = { videoUrl: 'https://example.com/video.mp4' };
      const hint = buildImageHint(vctx, 'video');
      expect(hint).toContain('视频内容');
    });

    it('should return empty for text-only mode', () => {
      expect(buildImageHint({}, 'text-only')).toBe('');
    });
  });

  describe('buildScopedBlock', () => {
    it('should return empty for null context', () => {
      expect(buildScopedBlock(null)).toBe('');
    });

    it('should build corpus block', () => {
      const ctx = { corpus: [{ srcText: '你好', replyText: '你好呀' }] };
      const block = buildScopedBlock(ctx);
      expect(block).toContain('历史成功回复');
      expect(block).toContain('你好');
    });
  });

  describe('buildGenerateCommentPrompt', () => {
    it('should return system and user prompts', () => {
      const result = buildGenerateCommentPrompt({
        vctx: { title: '测试视频', briefing: '测试摘要' },
        mode: 'text-only',
        persona: null,
        count: 1,
        strategyText: '自然口语化',
      });
      expect(result.systemPrompt).toBeTruthy();
      expect(result.userPrompt).toBeTruthy();
      expect(result.userPrompt).toContain('测试视频');
      expect(Array.isArray(result.images)).toBe(true);
    });

    it('should include count hint for multiple comments', () => {
      const result = buildGenerateCommentPrompt({
        vctx: null, mode: 'text-only', count: 3, strategyText: '',
      });
      expect(result.userPrompt).toContain('3 条');
    });
  });

  describe('buildGenerateReplyPrompt', () => {
    it('should return system and user prompts', () => {
      const result = buildGenerateReplyPrompt({
        vctx: { title: '测试' },
        mode: 'text-only',
        comment: { cid: '123', text: '这个好用吗？' },
        persona: null,
        scopedCtx: {},
        strategyText: '自然',
      });
      expect(result.systemPrompt).toBeTruthy();
      expect(result.userPrompt).toBeTruthy();
      expect(result.userPrompt).toContain('这个好用吗');
    });

    it('should include user profile when available', () => {
      const result = buildGenerateReplyPrompt({
        vctx: null, mode: 'text-only',
        comment: { cid: '1', text: '测试' },
        scopedCtx: { userProfile: { nickname: '老用户', commentCount: 5 } },
        strategyText: '',
      });
      expect(result.userPrompt).toContain('老用户');
    });
  });

  describe('buildGenerateRepliesPrompt', () => {
    it('should handle batch comments', () => {
      const result = buildGenerateRepliesPrompt({
        vctx: null, mode: 'text-only',
        comments: [
          { cid: '1', text: '评论一' },
          { cid: '2', text: '评论二' },
        ],
        scopedCtx: {},
        strategyText: '自然',
      });
      expect(result.systemPrompt).toBeTruthy();
      expect(result.userPrompt).toContain('评论一');
      expect(result.userPrompt).toContain('评论二');
    });
  });

  describe('buildSuggestPrompt', () => {
    it('should return prompts for suggest', () => {
      const result = buildSuggestPrompt({
        vctx: null, mode: 'text-only',
        comments: [{ cid: '1', text: '测试' }],
        llmContext: {},
        strategyText: '友好',
      });
      expect(result.systemPrompt).toBeTruthy();
      expect(result.userPrompt).toBeTruthy();
    });
  });

  describe('buildAnalyzePrompt', () => {
    it('should return prompts for analyze', () => {
      const result = buildAnalyzePrompt({
        vctx: null, mode: 'text-only',
        comments: [{ cid: '1', text: '测试' }],
        strategy: '自然',
      });
      expect(result.systemPrompt).toBeTruthy();
      expect(result.userPrompt).toBeTruthy();
    });
  });
});
