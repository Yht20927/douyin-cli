// lib/commands/replies.js — 获取单条评论的回复列表

const { getFlag, formatComment } = require('./helpers');

/**
 * 获取单条评论的回复列表
 * @param {object} ctx - { bridge, audit, loggedCall }
 * @param {string[]} args - [cid, aweme_id, --cursor N, --count N]
 */
async function cmdReplies(ctx, args) {
  const cid = args[0];
  if (!cid) throw new Error('用法: node cli.js replies <cid> <aweme_id> [--cursor N] [--count N]');
  let cursor = getFlag(args, '--cursor', 0);
  let count = Math.min(getFlag(args, '--count', 20), 20);
  let awemeId = '';
  for (let i = 1; i < args.length; i++) {
    if (!args[i].startsWith('--') && args[i] !== cid && !awemeId) awemeId = args[i];
  }

  ctx.audit.startOperation('replies', { cid, aweme_id: awemeId, cursor, count });
  const expr = `window.__bridge.replies('${cid}', '${awemeId}', ${cursor}, ${count})`;
  const data = await ctx.loggedCall('replies', { cid, aweme_id: awemeId, cursor, count }, expr);
  const items = (data.comments || []).map(formatComment);
  ctx.audit.endOperation('success', { count: items.length }, { comments: items });
  return items;
}

module.exports = cmdReplies;
