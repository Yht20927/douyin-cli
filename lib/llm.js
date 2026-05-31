// lib/llm.js — OpenAI-compatible LLM 调用封装
// 支持批量分析评论、生成回复建议。内置重试与 JSON 提取容错。

let config = {};
try { config = require('../config.json').llm || {}; } catch {}

class LLMClient {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || config.api_key || process.env.OPENAI_API_KEY || '';
    this.baseUrl = opts.baseUrl || config.base_url || 'https://api.openai.com/v1';
    this.model = opts.model || config.model || 'gpt-4o-mini';
    this.maxRetries = opts.maxRetries || config.max_retries || 3;
  }

  async _call(messages, temperature = 0.3) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeout_ms || 60000);

        const resp = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature,
            max_tokens: config.max_tokens || 4096,
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!resp.ok) {
          const err = await resp.text();
          throw new Error(`LLM HTTP ${resp.status}: ${err.substring(0, 200)}`);
        }

        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content || '';
        return content;
      } catch(e) {
        lastError = e;
        if (attempt < this.maxRetries) {
          console.error(`[llm] Retry ${attempt}/${this.maxRetries}: ${e.message}`);
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }
    throw lastError;
  }

  _extractJSON(text) {
    // 尝试多种 JSON 提取策略
    // 1. 直接解析
    try { return JSON.parse(text); } catch {}

    // 2. 提取 ```json ... ``` 块
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) { try { return JSON.parse(m[1]); } catch {} }

    // 3. 提取第一个 [...] 或 {...} 范围
    const ai = text.indexOf('[');
    const oi = text.indexOf('{');
    if (ai >= 0 && (oi < 0 || ai < oi)) {
      // 从第一个 [ 到最后一个 ]
      const li = text.lastIndexOf(']');
      if (li > ai) { try { return JSON.parse(text.substring(ai, li + 1)); } catch {} }
    }
    if (oi >= 0) {
      const ci = text.lastIndexOf('}');
      if (ci > oi) { try { return JSON.parse(text.substring(oi, ci + 1)); } catch {} }
    }

    throw new Error(`Cannot extract JSON from LLM response: ${text.substring(0, 200)}`);
  }

  // 批量分析评论
  async analyzeComments(comments, strategy) {
    const prompt = `你是抖音评论分析师。根据策略风格分析每条评论。

策略风格：${strategy.style || '自然亲切'}

返回 JSON 数组。对每条评论：
- cid: 评论ID（原样）
- sentiment: "positive"|"negative"|"neutral"
- category: "question"|"praise"|"complaint"|"spam"|"other"
- priority: 1-5（5=必须回复）
- summary: 一句话中文摘要

评论列表：${JSON.stringify(comments.map(c => ({ cid: c.cid, text: c.text })))}

严格返回 JSON 数组，不要其他文字。`;

    const response = await this._call([
      { role: 'system', content: '你是一个专业的抖音评论分析师，只输出 JSON。' },
      { role: 'user', content: prompt },
    ]);

    return this._extractJSON(response);
  }

  // 生成回复建议
  async suggestReplies(comments, strategy, videoDesc) {
    const prompt = `你是抖音账号运营助手，为以下评论生成回复建议。

策略风格：${strategy.style || '自然亲切，15-50 字'}
视频描述：${videoDesc || '暂无'}

返回 JSON 数组：
- cid: 评论ID
- reply: 建议回复（符合策略风格，不需要回复的评论不要包含）

需回复的评论：${JSON.stringify(comments.map(c => ({ cid: c.cid, text: c.text })))}

严格返回 JSON 数组。`;

    const response = await this._call([
      { role: 'system', content: '你是抖音运营助手，只输出 JSON 回复建议。' },
      { role: 'user', content: prompt },
    ]);

    return this._extractJSON(response);
  }
}

module.exports = { LLMClient };
