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
    cid: c.cid != null ? String(c.cid) : c.cid,
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

/** 随机选择数组中的一个元素 */
function randomChoice(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 随机整数 [min, max] */
function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** 加权随机选择 */
function weightedRandom(items, weights) {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const w = weights || items.map(() => 1);
  const total = w.reduce((s, x) => s + x, 0);
  let rnd = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    rnd -= w[i];
    if (rnd <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * 统一命令审计样板：startOperation → work → endOperation。
 *
 * 收敛各命令重复的 startOperation / try-catch-end('error') / endOperation('success')
 * 三段式；出错时自动以 'error' 收尾并重新抛出（与旧命令依赖 cli.js 主入口
 * 兜底 endOperation 的行为一致，但不再需要触碰 audit._currentOp 私有字段）。
 *
 * @param {object} ctx - { audit }
 * @param {string} opName - 操作名（events.command / audit operation）
 * @param {object} meta - 操作参数元数据（透传 startOperation 第二参）
 * @param {() => Promise<{summary?: object, result?: any, output?: any}>} work
 *   - summary: 端成功摘要（endOperation 第二参，默认 {}）
 *   - result:  附加结果对象（endOperation 第三参，原样透传——key 结构由调用方决定，
 *              如 { result: items } 或 { comments: items }）
 *   - output:  命令最终返回值（缺省 undefined）
 * @returns {Promise<any>} work().output
 */
async function withAudit(ctx, opName, meta, work) {
  const audit = ctx.audit;
  audit.startOperation(opName, meta);
  let out;
  try {
    out = await work();
  } catch (e) {
    audit.endOperation('error', {}, null, e.message);
    throw e;
  }
  audit.endOperation(out?.status || 'success', out?.summary || {},
    out?.result !== undefined ? out.result : null);
  return out?.output;
}

module.exports = {
  SITE,
  escapeExpression,
  getFlag,
  formatComment,
  randomChoice,
  randomInt,
  weightedRandom,
  withAudit,
};
