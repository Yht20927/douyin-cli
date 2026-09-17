// lib/commands/delete-comment.js — 删除评论

const { escapeExpression } = require('./helpers');
const corpus = require('../memory/corpus');
const riskControl = require('../risk-control');

/**
 * 删除评论
 * @param {object} ctx - { bridge, audit, loggedCall }
 * @param {string[]} args - [cid, --no-throttle]
 */
async function cmdDeleteComment(ctx, args) {
  const cid = args[0];
  if (!cid) throw new Error('用法: node cli.js delete-comment <cid>');

  // 请求节奏守卫（--no-throttle 旁路）
  await riskControl.enforceDelay('write', { force: args.includes('--no-throttle') });

  ctx.audit.startOperation('delete_comment', { cid });

  const expr = `window.__bridge.deleteComment('${escapeExpression(cid)}')`;
  const data = await ctx.loggedCall('delete_comment', { cid }, expr);

  if (data.status_code !== undefined && data.status_code !== 0) {
    const err = new Error(`status_code=${data.status_code} — 删除评论失败（可能无权限或已被删除）`);
    ctx.audit.endOperation('error', { status_code: data.status_code }, null, err.message);
    throw err;
  }

  // 旁路：如果该 cid 是 corpus 中我们曾经发布的回复（reply_cid 命中），标记 outcome=deleted
  try {
    const row = corpus.findByReplyCid(cid);
    if (row) corpus.setOutcome(row.id, 'deleted');
  } catch (_) {}

  const result = {
    cid,
    status: 'deleted',
    status_code: data.status_code ?? 0,
  };
  ctx.audit.endOperation('success', { cid }, { result });
  return result;
}

module.exports = cmdDeleteComment;
