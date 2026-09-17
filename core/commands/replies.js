// lib/commands/replies.js — 获取单条评论的回复列表

const { getFlag, formatComment, escapeExpression, withAudit } = require('./helpers');
const comments = require('../memory/comments');

/**
 * 获取单条评论的回复列表
 * @param {object} ctx - { bridge, audit, loggedCall }
 * @param {string[]} args - [cid, aweme_id, --cursor N, --count N]
 */
async function cmdReplies(ctx, args) {
  if (!args[0]) throw new Error('用法: node cli.js replies <cid> <aweme_id> [--cursor N] [--count N]');
  const cid = String(args[0]);
  let cursor = getFlag(args, '--cursor', 0);
  let count = Math.min(getFlag(args, '--count', 20), 20);
  let awemeId = '';
  for (let i = 1; i < args.length; i++) {
    if (!args[i].startsWith('--') && args[i] !== args[0] && !awemeId) awemeId = String(args[i]);
  }

  return withAudit(ctx, 'replies', { cid, aweme_id: awemeId, cursor, count }, async () => {
    const expr = `window.__bridge.replies('${escapeExpression(cid)}', '${escapeExpression(awemeId)}', ${cursor}, ${count})`;
    const data = await ctx.loggedCall('replies', { cid, aweme_id: awemeId, cursor, count }, expr);
    const raw = data.comments || [];
    const items = raw.map(formatComment);

    // 落库子回复（旁路，失败不影响主流程；parent_cid 标为被回复的评论）
    try {
      const entries = raw
        .filter(c => c && c.cid)
        .map(c => ({
          cid: String(c.cid),
          awemeId: String(awemeId),
          uid: c.user ? (String(c.user.uid || c.user.uid_str || '') || null) : null,
          text: c.text != null ? String(c.text) : null,
          digg: c.digg_count != null ? Number(c.digg_count) : null,
          createdAt: c.create_time != null ? Number(c.create_time) : null,
          parentCid: cid,
        }));
      if (entries.length) comments.upsertMany(entries);
    } catch (e) {
      if (process.env.DOUYIN_DEBUG) console.warn('[replies.persist] failed:', e.message);
    }

    return { summary: { count: items.length }, result: { comments: items }, output: items };
  });
}

module.exports = cmdReplies;
