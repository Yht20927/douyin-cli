// lib/memory/llm-usage.js — LLM Token 用量追踪
//
// 从 xiaohongshu-cli 移植，适配抖音项目。
const { getDb } = require('./db');

// 模型单价估算（$/1M tokens），用于成本估算
// 顺序重要：长 pattern 在前，避免短 pattern 误匹配
const MODEL_PRICES = [
  ['gpt-4o-mini', { input: 0.15, output: 0.60 }],
  ['gpt-4.1',     { input: 2.00, output: 8.00 }],
  ['gpt-4o',      { input: 2.50, output: 10.00 }],
  ['gpt-4-turbo', { input: 10.00, output: 30.00 }],
  ['claude-4',    { input: 3.00, output: 15.00 }],
  ['claude-3.5',  { input: 3.00, output: 15.00 }],
  ['claude-sonnet', { input: 3.00, output: 15.00 }],
  ['claude-haiku', { input: 0.80, output: 4.00 }],
  ['claude-3',    { input: 3.00, output: 15.00 }],
  ['mimo-v2.5',   { input: 0.15, output: 0.30 }],
  ['mimo-v2-omni', { input: 0.40, output: 2.00 }],
  ['deepseek',     { input: 0.27, output: 1.10 }],
  ['qwen',         { input: 0.50, output: 2.00 }],
];

function estimateCost(model, promptTokens, completionTokens) {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const [key, price] of MODEL_PRICES) {
    if (m.includes(key)) {
      return (promptTokens / 1e6) * price.input + (completionTokens / 1e6) * price.output;
    }
  }
  return null;
}

function log(fields) {
  try {
    const db = getDb();
    const cost = estimateCost(fields.model, fields.promptTokens, fields.completionTokens);
    db.prepare(`
      INSERT INTO llm_usage (ts, model, purpose, aweme_id, prompt_tokens, completion_tokens, total_tokens, cost_estimate, duration_ms)
      VALUES (@ts, @model, @purpose, @awemeId, @promptTokens, @completionTokens, @totalTokens, @cost, @durationMs)
    `).run({
      ts: fields.ts || Date.now(),
      model: fields.model || '',
      purpose: fields.purpose || null,
      awemeId: fields.awemeId || null,
      promptTokens: fields.promptTokens || 0,
      completionTokens: fields.completionTokens || 0,
      totalTokens: fields.totalTokens || 0,
      cost: cost != null ? Math.round(cost * 1e6) / 1e6 : null,
      durationMs: fields.durationMs || null,
    });
  } catch (_) {}
}

function stats(opts = {}) {
  try {
    const db = getDb();
    const since = opts.since || Date.now() - 7 * 86400000;
    const rows = db.prepare(`
      SELECT model, purpose,
        SUM(total_tokens) AS total_tokens,
        SUM(prompt_tokens) AS prompt_tokens,
        SUM(completion_tokens) AS completion_tokens,
        SUM(cost_estimate) AS total_cost,
        COUNT(*) AS calls,
        AVG(duration_ms) AS avg_duration_ms
      FROM llm_usage
      WHERE ts >= ?
      GROUP BY model, purpose
      ORDER BY total_cost DESC
    `).all(since);
    return rows;
  } catch (e) { return []; }
}

function recent(limit = 20) {
  try {
    return getDb().prepare(`
      SELECT * FROM llm_usage ORDER BY ts DESC LIMIT ?
    `).all(Math.min(limit, 100));
  } catch (e) { return []; }
}

module.exports = { log, stats, recent, estimateCost };
