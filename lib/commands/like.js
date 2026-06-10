// lib/commands/like.js — 点赞/取消点赞视频

const { escapeExpression } = require('./helpers');

/**
 * 点赞或取消点赞
 * @param {object} ctx - { bridge, audit, loggedCall }
 * @param {string[]} args - [aweme_id, --unlike]
 */
async function cmdLike(ctx, args) {
  const awemeId = args[0];
  if (!awemeId) throw new Error('用法: node cli.js like <aweme_id> [--unlike]');

  const unlike = args.includes('--unlike');
  const type = unlike ? 0 : 1;
  const action = unlike ? 'unlike' : 'like';

  ctx.audit.startOperation(action, { aweme_id: awemeId });

  // type=1 点赞，type=0 取消点赞
  const expr = `window.__bridge.digg('${escapeExpression(awemeId)}', ${type})`;
  const data = await ctx.loggedCall(action, { aweme_id: awemeId }, expr);

  if (data.status_code !== undefined && data.status_code !== 0) {
    const err = new Error(`status_code=${data.status_code} — ${unlike ? '取消点赞' : '点赞'}失败，可能被风控`);
    ctx.audit.endOperation('error', { status_code: data.status_code }, null, err.message);
    throw err;
  }

  const result = {
    aweme_id: awemeId,
    action: unlike ? 'unliked' : 'liked',
    status: 'success',
    status_code: data.status_code ?? 0,
  };
  ctx.audit.endOperation('success', { aweme_id: awemeId, action }, { result });
  return result;
}

module.exports = cmdLike;
