// lib/shared/sanitize.js — 内容清洗与转义工具
//
// 供 LLM prompt 构建（prompt 注入防护）、回复后处理（引号剥离）、
// 自包含 HTML 拼接（仪表盘注入防护）共用。纯函数，无 I/O。

/**
 * 清洗用户评论内容，防止 prompt 注入
 * - 截断过长文本
 * - 移除可能的指令注入模式
 */
function sanitizeComment(text, maxLen = 200) {
  if (!text) return '';
  let s = String(text).slice(0, maxLen);
  // 移除疑似 prompt 注入的模式（如 "ignore previous", "system:" 等）
  s = s.replace(/\b(ignore|forget|disregard)\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)\b/gi, '[filtered]');
  s = s.replace(/\b(system|assistant|user)\s*:/gi, '[filtered]:');
  s = s.replace(/(忽略|忘记|无视)\s*(以上|之前|上述|前面)\s*(所有)?\s*(指令|规则|提示)/g, '[filtered]');
  return s;
}

/**
 * 剥离首尾的引号（中英文/弯直）。LLM 输出的单条文本常带多余包裹引号。
 */
function stripQuotes(s = '') {
  return String(s || '')
    .replace(/^["「'']+|["」'']+$/g, '')
    .trim();
}

/**
 * HTML 转义 — 用户可控文本（视频标题、活动名等）拼进自包含 HTML 前必须调用。
 */
function escapeHtml(s = '') {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { sanitizeComment, stripQuotes, escapeHtml };
