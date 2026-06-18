// lib/commands/helpers.js — 命令共享的辅助函数和上下文

const SITE = 'douyin.com';

/**
 * 转义字符串用于 JS 表达式拼接
 */
function escapeExpression(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * 从参数列表中提取 --flag value 形式的选项
 */
function getFlag(args, flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx === -1) return defaultValue;
  const val = args[idx + 1];
  if (val === undefined || typeof val !== 'string' || val.startsWith('--')) return defaultValue;
  const n = Number(val);
  // 19 位抖音 ID 超过 JS 安全整数范围，必须保持字符串
  if (isNaN(n)) return val;
  if (n > Number.MAX_SAFE_INTEGER || n < Number.MIN_SAFE_INTEGER) return val;
  return n;
}

/**
 * 格式化评论数据（清洗字段、截断文本）
 */
function formatComment(c) {
  const out = {
    cid: c.cid,
    text: (c.text || '').substring(0, 120),
    likes: c.digg_count || c.likes || 0,
    replies: c.reply_comment_total || c.replies || 0,
    time: c.create_time || c.time || 0,
    user: c.user ? {
      nickname: c.user.nickname,
      uid: c.user.uid || c.user.uid_str,
      avatar: c.user.avatar_thumb?.url_list?.[0] || c.user.avatar_medium?.url_list?.[0] || '',
    } : null,
  };
  if (c.children) out.children = c.children;
  return out;
}

module.exports = {
  SITE,
  escapeExpression,
  getFlag,
  formatComment,
};
