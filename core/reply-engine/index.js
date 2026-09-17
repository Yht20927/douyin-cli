// lib/reply-engine/index.js — ReplyEngine 独立评论生成模块
//
// 设计原则：
// - 零 CLI 依赖：不依赖 bridge、audit、ctx
// - 单一入口：generateComment / generateReply / generateReplies 三个公开方法
// - 上下文隔离：自动加载视频上下文 + 人格绑定 + scoped context
// - 多模态：视觉模型自动注入视频截图
//
// 用法：
//   const engine = new ReplyEngine({ llm: { api_key, model, ... } });
//   const result = await engine.generateReply({ awemeId, comment: { cid, text } });
//
// 从 xiaohongshu-cli 移植，适配抖音视频场景。

const { LLMClient } = require('../llm');
const { PersonaBinder } = require('./persona-binder');
const {
  buildGenerateCommentPrompt,
  buildGenerateReplyPrompt,
  buildGenerateRepliesPrompt,
} = require('./prompt-builder');
const { buildScopedContext } = require('./context-scope');
const { loadVideoContext } = require('./video-context');
const { stripQuotes } = require('../shared/sanitize');

class ReplyEngine {
  /**
   * @param {object} [config]
   * @param {object} [config.llm] — LLM 配置，透传给 LLMClient
   * @param {Function} [config.bridgeCall] — Bridge 调用函数（用于获取视频详情/截图）
   */
  constructor(config = {}) {
    this.llm = new LLMClient(config.llm || {});
    this._binder = new PersonaBinder();
    this._bridgeCall = config.bridgeCall || null;
  }

  // ═══════════════════════════════════════════════════════════
  // 公开方法
  // ═══════════════════════════════════════════════════════════

  /**
   * 生成视频的顶级评论（以普通用户身份对视频发表看法）。
   *
   * @param {object} options
   * @param {string} options.awemeId — 视频 ID
   * @param {object} [options.vctx] — 预加载的 VideoContext（跳过内部加载）
   * @param {string|object} [options.persona='auto'] — 'auto' | 'casual_friend' | {...}
   * @param {number} [options.count=1] — 生成几条候选评论
   * @param {string} [options.strategy=''] — 回复策略文本
   * @param {string} [options.mode='text-only'] — 视觉模式
   * @returns {Promise<{comments: Array<{text, persona}>, context: object}>}
   */
  async generateComment(options = {}) {
    const { awemeId, vctx: inputVctx, persona: personaArg = 'auto', count = 1, strategy = '', mode = 'text-only' } = options;
    this.llm.setCallContext?.(awemeId, 'getReply_comment');

    // 加载视频上下文（可能通过 bridgeCall）
    const vctx = inputVctx || await this._loadVideoContext(awemeId, mode);
    const persona = this._resolvePersona(personaArg, awemeId);

    const { systemPrompt, userPrompt, images } = buildGenerateCommentPrompt({
      vctx, mode,
      persona, count, strategyText: strategy,
    });

    const response = await this.llm.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], persona?.temperature || 0.7, { images });

    const comments = this._parseCommentResponse(response, count);
    return {
      comments: comments.map(text => ({
        text,
        persona: persona ? { id: persona.id, name: persona.name } : null,
      })),
      context: { awemeId, vctx, persona },
    };
  }

  /**
   * 生成对特定评论的回复（以博主身份回复评论者）。
   *
   * @param {object} options
   * @param {string} options.awemeId — 视频 ID
   * @param {object} [options.vctx] — 预加载的 VideoContext
   * @param {object} options.comment — { cid, text, userTags?, parentComment?, uid? }
   * @param {string|object} [options.persona='auto']
   * @param {string} [options.strategy='']
   * @param {string} [options.mode='text-only']
   * @returns {Promise<{reply: {cid, text, persona}, context: object}>}
   */
  async generateReply(options = {}) {
    const { awemeId, vctx: inputVctx, comment, persona: personaArg = 'auto', strategy = '', mode = 'text-only' } = options;
    this.llm.setCallContext?.(awemeId, 'getReply_reply');

    if (!comment || !comment.cid || !comment.text) {
      throw new Error('comment.cid 和 comment.text 为必填字段');
    }

    const vctx = inputVctx || await this._loadVideoContext(awemeId, mode);
    const persona = this._resolvePersona(personaArg, awemeId);
    const scopedCtx = await buildScopedContext(awemeId, { commentUid: comment.uid });

    const { systemPrompt, userPrompt, images } = buildGenerateReplyPrompt({
      vctx, mode,
      comment, persona, scopedCtx, strategyText: strategy,
    });

    const response = await this.llm.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], persona?.temperature || 0.7, { images });

    const text = this._parseSingleReply(response);
    return {
      reply: {
        cid: comment.cid,
        text,
        persona: persona ? { id: persona.id, name: persona.name } : null,
      },
      context: { awemeId, vctx, comment, persona, scopedContext: scopedCtx },
    };
  }

  /**
   * 批量生成对多条评论的回复。
   *
   * @param {object} options
   * @param {string} options.awemeId
   * @param {object} [options.vctx] — 预加载的 VideoContext
   * @param {Array<{cid, text, userTags?, parentComment?, uid?}>} options.comments
   * @param {string|object} [options.persona='auto']
   * @param {string} [options.strategy='']
   * @param {string} [options.mode='text-only']
   * @returns {Promise<{replies: Array<{cid, text, persona}>, context: object}>}
   */
  async generateReplies(options = {}) {
    const { awemeId, vctx: inputVctx, comments, persona: personaArg = 'auto', strategy = '', mode = 'text-only' } = options;
    this.llm.setCallContext?.(awemeId, 'getReply_batch');

    if (!comments || !comments.length) {
      throw new Error('comments 为必填数组');
    }

    const vctx = inputVctx || await this._loadVideoContext(awemeId, mode);
    const persona = this._resolvePersona(personaArg, awemeId);
    const scopedCtx = await buildScopedContext(awemeId);

    const { systemPrompt, userPrompt, images } = buildGenerateRepliesPrompt({
      vctx, mode,
      comments, persona, scopedCtx, strategyText: strategy,
    });

    const response = await this.llm.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], persona?.temperature || 0.7, { images });

    const replies = this._parseReplies(response, comments);
    return {
      replies: replies.map(r => ({
        cid: r.cid,
        text: r.reply || r.text || '',
        persona: persona ? { id: persona.id, name: persona.name } : null,
      })),
      context: { awemeId, vctx, persona, scopedContext: scopedCtx },
    };
  }

  // ═══════════════════════════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════════════════════════

  _resolvePersona(personaArg, bindKey) {
    // 手动指定人格 id
    if (typeof personaArg === 'string' && personaArg !== 'auto') {
      return this._binder.bind(bindKey, { forcePersona: personaArg });
    }
    // 手动传入人格对象
    if (typeof personaArg === 'object' && personaArg !== null) {
      return personaArg;
    }
    // 'auto' — 自动绑定
    return this._binder.bind(bindKey);
  }

  /** 加载视频上下文（无 bridgeCall 时返回最小 fallback） */
  async _loadVideoContext(awemeId, mode) {
    if (this._bridgeCall) {
      try {
        return await loadVideoContext(this._bridgeCall, awemeId, { mode });
      } catch (e) {
        console.warn(`[ReplyEngine] 视频上下文加载失败（${awemeId}），使用 text-only fallback: ${e.message}`);
      }
    }
    // fallback: 尝试从 videos 表读取
    try {
      const videos = require('../memory/videos');
      const v = videos.get(awemeId);
      if (v) {
        return {
          awemeId: v.awemeId || awemeId,
          title: v.title || '',
          desc: v.title || '',
          author: { nickname: '', uid: '', sec_uid: '' },
          coverUrl: null,
          stats: { diggCount: 0, commentCount: 0, shareCount: 0, playCount: 0 },
          duration: null,
          briefing: v.briefing || '',
          screenshotB64: [],
          videoUrl: null,
          mode: 'text-only',
        };
      }
    } catch (_) {}

    // 最小 fallback
    return {
      awemeId,
      title: '',
      desc: '',
      author: { nickname: '', uid: '', sec_uid: '' },
      coverUrl: null,
      stats: { diggCount: 0, commentCount: 0, shareCount: 0, playCount: 0 },
      duration: null,
      briefing: '',
      screenshotB64: [],
      videoUrl: null,
      mode: 'text-only',
    };
  }

  /** 解析 generateComment 的响应（JSON 数组 或 单条文本） */
  _parseCommentResponse(response, expectedCount) {
    const text = String(response || '').trim();
    // 尝试 JSON 数组解析
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) return arr.map(String);
    } catch (_) {}
    // fallback: 纯文本 — 按空行拆分，取第一段
    const paragraphs = text.split(/\n\n+/).filter(Boolean);
    if (paragraphs.length > 1 && expectedCount === 1) {
      // 多段文本但只需要 1 条 → 取第一段（最长不超过 100 字）
      return [stripQuotes(paragraphs[0]).substring(0, 100)];
    }
    // 多段 → 每段作为独立评论
    if (paragraphs.length > 1) {
      return paragraphs.slice(0, expectedCount).map(p => stripQuotes(p).substring(0, 100));
    }
    const cleaned = stripQuotes(text);
    return [cleaned || text];
  }

  /** 解析 generateReply 的单条响应 */
  _parseSingleReply(response) {
    return stripQuotes(String(response || ''))
      .replace(/^(回复|Reply)[：:]\s*/i, '');
  }

  /** 解析 generateReplies 的 JSON 数组响应 */
  _parseReplies(response, comments) {
    try {
      const parsed = this.llm.extractJSON(response);
      if (Array.isArray(parsed)) return parsed;
      // 兼容常见对象包裹格式
      if (parsed && typeof parsed === 'object') {
        const inner = parsed.replies || parsed.data || parsed.comments || parsed.results;
        if (Array.isArray(inner)) return inner;
      }
    } catch (_) {}
    // fallback：JSON 解析失败，返回空回复并告警
    console.warn('[ReplyEngine] 无法从 LLM 响应中提取 JSON，返回空回复');
    return comments.map(c => ({ cid: c.cid, reply: '' }));
  }

  /** 暴露 PersonaBinder 供外部微调 */
  get binder() { return this._binder; }
}

module.exports = { ReplyEngine };
