// lib/llm.js — OpenAI-compatible LLM 调用封装
// 支持批量分析评论、生成回复建议。内置重试与 JSON 提取容错。
//
// Prompt 模板单一真源在 prompts/*.md（经 lib/reply-engine/prompt-builder.js 组装）；
// 本文件只负责 provider 路由、重试、图片注入与用量追踪，不再内联策略文本。
//
// API Key 优先级：环境变量 OPENAI_API_KEY > config.json llm.api_key
// 建议使用环境变量存储密钥，避免提交到版本控制。

let config = {};
try { config = require('../config.json').llm || {}; } catch {}

const { sanitizeComment, stripQuotes } = require('./shared/sanitize');

// 分批大小：防止评论过多导致 token 超限
const BATCH_SIZE = 50;

// 视觉模型 pattern 列表（用于 _supportsVision 检测）
const VISION_MODEL_PATTERNS = [
  'gpt-4o', 'gpt-4-turbo', 'gpt-4-vision', 'gpt-4.1',
  'o1', 'o3', 'o4-mini',
  'claude-3', 'claude-4', 'claude-opus', 'claude-sonnet', 'claude-haiku',
  'gemini-1.5', 'gemini-2', 'gemini-pro',
  'qwen-vl', 'qwen2-vl', 'qwen2.5-vl', 'qvq',
  'pixtral', 'llava', 'cogvlm',
  'llama-3.2', 'llama-4',
  'deepseek-vl', 'glm-4v',
  'mimo-v2.5', 'mimo-v2-omni',
  'deepseek-v4',
];

/** 按 BATCH_SIZE 切分数组 */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

class LLMClient {
  constructor(opts = {}) {
    // 环境变量优先，config.json 兜底
    this.apiKey = opts.apiKey || process.env.OPENAI_API_KEY || config.api_key || '';
    this.baseUrl = opts.baseUrl || process.env.OPENAI_BASE_URL || config.base_url || 'https://api.openai.com/v1';
    this.model = opts.model || process.env.OPENAI_MODEL || config.model || 'gpt-4o-mini';
    this.maxRetries = opts.maxRetries || config.max_retries || 3;
    this.timeoutMs = opts.timeoutMs || config.timeout_ms || 60000;
    this.maxTokens = opts.maxTokens || config.max_tokens || 4096;
  }

  /** 检测模型是否支持视觉输入 */
  _supportsVision() {
    if (process.env.DOUYIN_DISABLE_VISION === '1') return false;
    const m = this.model.toLowerCase();
    return VISION_MODEL_PATTERNS.some(p => m.includes(p));
  }

  /** 检测是否为 Mimo 提供商（使用 api-key 头而非 Bearer） */
  _isMimoProvider() {
    return this.baseUrl.includes('xiaomimimo.com');
  }

  /** 检测是否为 OpenAI 官方提供商 */
  _isOpenAIProvider() {
    return this.baseUrl.includes('api.openai.com');
  }

  /** 检测是否为 Anthropic 原生提供商 */
  _isAnthropicProvider() {
    return this.baseUrl.includes('anthropic.com');
  }

  // ═══════════════════════════════════════════════════════════
  // complete / extractJSON — 公开调用入口（外部模块一律走这两个）
  // ═══════════════════════════════════════════════════════════

  /**
   * 发起一次 LLM 对话调用（公开入口）。按 provider 自动路由，
   * opts.images 注入多模态内容。
   * @param {Array<{role,content}>} messages
   * @param {number} [temperature]
   * @param {object} [opts] - { images?: string[] }
   * @returns {Promise<string>} assistant 文本
   */
  async complete(messages, temperature = 0.3, opts = {}) {
    if (!messages || !messages.length) {
      throw new Error('[llm] messages 数组为空，无法调用 LLM');
    }
    if (this._isAnthropicProvider()) {
      return this._callAnthropic(messages, temperature, opts);
    }
    return this._callOpenAI(messages, temperature, opts);
  }

  /**
   * 从 LLM 响应文本中提取 JSON（三级容错，公开版）。
   */
  extractJSON(text) {
    try { return JSON.parse(text); } catch {}

    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) { try { return JSON.parse(m[1]); } catch {} }

    const ai = text.indexOf('[');
    const oi = text.indexOf('{');
    if (ai >= 0 && (oi < 0 || ai < oi)) {
      const li = text.lastIndexOf(']');
      if (li > ai) { try { return JSON.parse(text.substring(ai, li + 1)); } catch {} }
    }
    if (oi >= 0) {
      const ci = text.lastIndexOf('}');
      if (ci > oi) { try { return JSON.parse(text.substring(oi, ci + 1)); } catch {} }
    }

    throw new Error(`无法从 LLM 响应中提取 JSON: ${text.substring(0, 200)}`);
  }

  // ── 已弃用别名（v4 内部历史上经由反射/私有约定调用；保留转发避免破坏） ──

  /** @deprecated 请改用 complete() */
  async _call(messages, temperature, opts) {
    return this.complete(messages, temperature, opts);
  }

  /** @deprecated 请改用 extractJSON() */
  _extractJSON(text) {
    return this.extractJSON(text);
  }

  // ═══════════════════════════════════════════════════════════
  // OpenAI 兼容格式
  // ═══════════════════════════════════════════════════════════

  async _callOpenAI(messages, temperature, opts) {
    let finalMessages = messages;
    const images = opts.images || [];
    if (images.length > 0 && this._supportsVision()) {
      finalMessages = this._injectImagesOpenAI(messages, images);
    } else if (images.length > 0 && !this._supportsVision()) {
      console.error(`[llm] 当前模型 ${this.model} 不支持视觉，跳过 ${images.length} 张截图`);
    }

    const headers = { 'Content-Type': 'application/json' };
    if (this._isMimoProvider()) {
      headers['api-key'] = this.apiKey;
    } else {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const tokenParam = this._isMimoProvider()
      ? { max_completion_tokens: this.maxTokens }
      : { max_tokens: this.maxTokens };

    const body = {
      model: this.model,
      messages: finalMessages,
      temperature,
      ...tokenParam,
    };

    return this._fetchWithRetry(`${this.baseUrl}/chat/completions`, headers, body,
      (data) => data.choices?.[0]?.message?.content || '');
  }

  // ═══════════════════════════════════════════════════════════
  // Anthropic 原生格式 (Messages API)
  // ═══════════════════════════════════════════════════════════

  async _callAnthropic(messages, temperature, opts) {
    // 提取 system 消息（Anthropic 要求 system 放在顶层）
    const systemMsgs = messages.filter(m => m.role === 'system');
    const systemPrompt = systemMsgs.map(m => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) return m.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      return '';
    }).join('\n\n') || undefined;

    const conversationMsgs = messages.filter(m => m.role !== 'system');

    let finalMessages = conversationMsgs;
    const images = opts.images || [];
    if (images.length > 0 && this._supportsVision()) {
      finalMessages = this._injectImagesAnthropic(conversationMsgs, images);
    }

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };

    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: finalMessages,
      temperature,
    };
    if (systemPrompt) body.system = systemPrompt;

    return this._fetchWithRetry(`${this.baseUrl}/messages`, headers, body,
      (data) => {
        const content = data.content || [];
        return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      });
  }

  _injectImagesAnthropic(messages, images) {
    return messages.map(m => {
      if (m.role !== 'user' || Array.isArray(m.content)) return m;
      const content = [{ type: 'text', text: m.content }];
      for (const img of images.slice(0, 3)) {
        content.push({
          type: 'image',
          source: { type: 'url', url: img.url || img },
        });
      }
      return { ...m, content };
    });
  }

  /** 将图片注入到 user 消息中（OpenAI 格式）。支持 base64 data URI 和 URL */
  _injectImagesOpenAI(messages, images) {
    const isOpenAI = this._isOpenAIProvider();
    return messages.map(m => {
      if (m.role !== 'user' || Array.isArray(m.content)) return m;
      const content = [{ type: 'text', text: m.content }];
      for (const img of images.slice(0, 6)) {
        let url;
        if (typeof img === 'string') {
          url = (img.startsWith('data:') || img.startsWith('http')) ? img : `data:image/jpeg;base64,${img}`;
        } else if (img && img.url) {
          url = img.url;
        } else {
          continue;
        }
        const imageBlock = { url };
        // Mimo API 不支持 detail 参数（会报 400）
        if (isOpenAI) imageBlock.detail = 'high';
        content.push({ type: 'image_url', image_url: imageBlock });
      }
      return { ...m, content };
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 通用 HTTP 请求 + 重试 + Token 追踪
  // ═══════════════════════════════════════════════════════════

  async _fetchWithRetry(url, headers, body, extractContent) {
    const startTime = Date.now();
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!resp.ok) {
          const err = await resp.text();
          throw new Error(`LLM API 请求失败 (HTTP ${resp.status}) — ${err.substring(0, 100)}`);
        }

        const data = await resp.json();
        if (data && data.error) {
          const errMsg = data.error.message || data.error.type || JSON.stringify(data.error);
          throw new Error(`LLM API error: ${errMsg}`);
        }

        const content = extractContent(data);

        // Token 用量追踪（异步写入，不阻塞主流程）
        this._trackUsage(data, body, Date.now() - startTime);

        return content;
      } catch (e) {
        lastError = e;
        const isTransient = lastError.message?.includes('fetch failed')
          || lastError.message?.includes('abort')
          || lastError.message?.includes('timeout')
          || /HTTP 5\d\d/.test(lastError.message);
        if (attempt < this.maxRetries && isTransient) {
          const delay = Math.min(1000 * Math.pow(2, attempt) * (0.5 + Math.random()), 30000);
          console.error(`[llm] 重试 ${attempt}/${this.maxRetries} (${Math.round(delay)}ms): ${e.message}`);
          await new Promise(r => setTimeout(r, delay));
        } else if (attempt < this.maxRetries && !isTransient) {
          break;
        }
      }
    }
    throw lastError;
  }

  /** Token 用量追踪（兼容 OpenAI 和 Anthropic 格式） */
  _trackUsage(data, requestBody, durationMs) {
    try {
      const usage = data?.usage || {};
      const promptTokens = usage.prompt_tokens || usage.input_tokens || 0;
      const completionTokens = usage.completion_tokens || usage.output_tokens || 0;
      const totalTokens = usage.total_tokens || (promptTokens + completionTokens) || 0;
      if (!promptTokens && !completionTokens) return;

      let llmUsage;
      try { llmUsage = require('./memory/llm-usage'); } catch (_) { return; }
      llmUsage.log({
        ts: Date.now(),
        model: this.model,
        awemeId: this._currentAwemeId || null,
        purpose: this._currentPurpose || null,
        promptTokens,
        completionTokens,
        totalTokens,
        durationMs,
      });
    } catch (_) {}
  }

  /**
   * 设置当前调用上下文（awemeId/purpose），用于用量追踪。
   */
  setCallContext(awemeId, purpose) {
    this._currentAwemeId = awemeId;
    this._currentPurpose = purpose;
  }

  /**
   * 分批分析评论（每批最多 BATCH_SIZE 条）
   * 设计意图：防止单次 prompt 过长导致 token 超限或质量下降。
   * Prompt 由 prompts/analyze.md 模板组装（经 prompt-builder），本方法只做分批与解析。
   *
   * @param {Array} comments - 评论列表 [{ cid, text }]
   * @param {object} strategy - 策略配置 { style }
   * @returns {Promise<Array>} 分析结果 [{ cid, sentiment, category, priority, summary }]
   */
  async analyzeComments(comments, strategy = {}) {
    const batches = chunk(comments, BATCH_SIZE);

    if (batches.length > 1) {
      console.error(`[llm] 评论 ${comments.length} 条，分 ${batches.length} 批处理`);
    }

    const { buildAnalyzePrompt } = require('./reply-engine/prompt-builder');

    const allResults = [];
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      if (batches.length > 1) {
        console.error(`[llm] 处理第 ${i + 1}/${batches.length} 批 (${batch.length} 条)...`);
      }

      const sanitized = batch.map(c => ({ cid: c.cid, text: sanitizeComment(c.text) }));
      const { systemPrompt, userPrompt } = buildAnalyzePrompt({
        vctx: null,
        mode: 'text-only',
        comments: sanitized,
        strategy,
      });

      const response = await this.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]);

      const batchResults = this.extractJSON(response);
      if (Array.isArray(batchResults)) allResults.push(...batchResults);
    }

    return allResults;
  }

  /**
   * 分批生成回复建议
   * Prompt 由 prompts/suggest.md + prompts/partial-reply-strategy.md 组装
   * （经 prompt-builder.buildSuggestPrompt），与 getReply 多模态路径共用同一真源。
   *
   * @param {Array} comments - 需回复的评论 [{ cid, text, userTags? }]
   * @param {string|object} strategy - 策略文本或对象
   * @param {string} videoDesc - 视频描述（text-only 模式下作为视频标题注入）
   * @param {object} [context] - v3 P3 注入的历史上下文
   * @param {Array<{srcText, replyText}>} [context.corpus] - 最近成功语料 few-shot
   * @param {Array<{signature, hitCount, exampleText, mitigation}>} [context.failures] - 避雷清单
   * @param {Array<string>} [context.avoid] - 不得复用的回复文本（reply_hash 命中过的）
   * @param {object} [context.repoFacts] - 推广仓库真实事实（由 repo-info 命令缓存）；注入后 LLM 必须基于此生成，禁止编造
   * @returns {Promise<Array>} 回复建议 [{ cid, reply }]
   */
  async suggestReplies(comments, strategy, videoDesc = '', context = {}, persona = null) {
    const strategyText = typeof strategy === 'string' ? strategy : (strategy?.style || '自然亲切');

    const batches = chunk(comments, BATCH_SIZE);
    if (batches.length > 1) {
      console.error(`[llm] 评论 ${comments.length} 条，分 ${batches.length} 批生成回复`);
    }

    const { buildSuggestPrompt } = require('./reply-engine/prompt-builder');
    const { getTemperature } = require('./personas');
    const temperature = persona ? getTemperature(persona) : 0.7;

    // videoDesc 在无视频上下文时作为标题注入 VIDEO_BLOCK
    const vctxShim = videoDesc
      ? { title: String(videoDesc), briefing: '', mode: 'text-only' }
      : null;

    const allResults = [];
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      if (batches.length > 1) {
        console.error(`[llm] 处理第 ${i + 1}/${batches.length} 批 (${batch.length} 条)...`);
      }

      const { systemPrompt, userPrompt } = buildSuggestPrompt({
        vctx: vctxShim,
        mode: 'text-only',
        comments: batch,
        persona,
        llmContext: context,
        strategyText,
      });

      const response = await this.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], temperature);

      const batchResults = this.extractJSON(response);
      if (Array.isArray(batchResults)) allResults.push(...batchResults);
    }

    return allResults;
  }

  /**
   * 分批分析评论（多模态版）— 支持 prompt-builder 预构建的 prompt + 截图注入
   *
   * 调用方式 1（推荐，prompt-builder 预构建）：
   *   client.analyzeCommentsMultiModal({ systemPrompt, userPrompt, images })
   *
   * 调用方式 2（向后兼容，自动构建 prompt）：
   *   client.analyzeCommentsMultiModal({ comments, images, strategy })
   *
   * @param {object} opts
   * @param {string} [opts.systemPrompt]
   * @param {string} [opts.userPrompt]   - 预构建的 user prompt（含评论列表）
   * @param {Array}  [opts.comments]     - 原始评论列表（当 userPrompt 未提供时使用）
   * @param {string[]} [opts.images]
   * @param {string|object} [opts.strategy]
   * @returns {Promise<Array>}
   */
  async analyzeCommentsMultiModal(opts = {}) {
    const { systemPrompt = '', userPrompt = '', comments = [], images = [], strategy = '' } = opts;
    const strategyText = typeof strategy === 'string' ? strategy : (strategy?.style || '自然亲切');

    // 方式 1：预构建的 userPrompt → 直接调用（不分批）
    if (userPrompt) {
      const response = await this.complete([
        { role: 'system', content: systemPrompt || `你是一个专业的抖音评论分析师，只输出 JSON。策略风格：${strategyText}` },
        { role: 'user', content: userPrompt },
      ], 0.3, { images });
      const results = this.extractJSON(response);
      return Array.isArray(results) ? results : [];
    }

    // 方式 2：用 comments 参数自动构建 prompt（分批，复用 analyze.md 模板）
    if (!comments || comments.length === 0) return [];

    const batches = chunk(comments, BATCH_SIZE);
    if (batches.length > 1) {
      console.error(`[llm] 评论 ${comments.length} 条，分 ${batches.length} 批处理（多模态）`);
    }

    const { buildAnalyzePrompt } = require('./reply-engine/prompt-builder');

    const allResults = [];
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const promptData = buildAnalyzePrompt({
        vctx: null,
        mode: 'text-only',
        comments: batch.map(c => ({ cid: c.cid, text: sanitizeComment(c.text) })),
        strategy: strategyText,
      });
      // 构建路径下的模板自带 SYSTEM；显式传入的 systemPrompt 保持优先
      const sys = systemPrompt || promptData.systemPrompt;

      const response = await this.complete([
        { role: 'system', content: sys },
        { role: 'user', content: promptData.userPrompt },
      ], 0.3, { images });

      const batchResults = this.extractJSON(response);
      if (Array.isArray(batchResults)) allResults.push(...batchResults);
    }

    return allResults;
  }

  /**
   * 分批生成回复建议（多模态版）— 支持 prompt-builder 预构建的 prompt + 截图注入
   *
   * @param {object} promptData - { systemPrompt, userPrompt, images, temperature }
   * @returns {Promise<Array>} [{ cid, reply }]
   */
  async suggestRepliesMultiModal(promptData) {
    if (!promptData || !promptData.userPrompt) {
      throw new Error('[llm] suggestRepliesMultiModal 需要 promptData: { systemPrompt, userPrompt, images }');
    }

    const { systemPrompt, userPrompt, images } = promptData;
    const temperature = promptData.temperature || 0.7;

    const response = await this.complete([
      { role: 'system', content: systemPrompt || '你是一个抖音运营助手，只输出 JSON 回复建议。' },
      { role: 'user', content: userPrompt },
    ], temperature, { images });

    const results = this.extractJSON(response);
    return Array.isArray(results) ? results : [];
  }

  /**
   * 单条回复重写（用于 dedup 命中后再生成一次，强制切换人格）。
   */
  async rewriteReply(srcText, originalReply, strategy, videoDesc, excludePersona = null) {
    const strategyText = typeof strategy === 'string' ? strategy : (strategy?.style || '自然亲切');

    // 强制切换人格，确保重写后的回复风格完全不同
    const { pickPersona, buildSystemPrompt, getTemperature } = require('./personas');
    const persona = pickPersona({ excludeId: excludePersona?.id });
    const systemPrompt = buildSystemPrompt(persona, strategyText);
    const temperature = getTemperature(persona);

    const prompt = `你之前给评论「${sanitizeComment(srcText || '', 80)}」生成的回复是「${sanitizeComment(originalReply || '', 80)}」，但这句话我们已经发过了。请用完全不同的角度/措辞重写一遍。

策略风格：${strategyText}
视频描述：${videoDesc || '暂无'}

仅返回新的回复文本，不要任何前缀、引号或解释。`;
    const response = await this.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ], temperature);
    return stripQuotes(response);
  }
}

module.exports = { LLMClient, sanitizeComment };
