// lib/commands/delete-comment.js — 删除评论

const { escapeExpression, throttleOpts } = require('./helpers');
const corpus = require('../memory/corpus');
const riskControl = require('../risk-control');
const policy = require('../policy').getPolicy();
const logger = require('../runtime/logger');

/**
 * 删除评论
 * @param {object} ctx - { bridge, audit, loggedCall }
 * @param {string[]} args - [cid, --no-throttle]
 */
async function cmdDeleteComment(ctx, args) {
  const cid = args[0];
  if (!cid) throw new Error('用法: node cli.js delete-comment <cid>');

  // 策略闸门在前、节奏等待在后（见 post.js 的说明）。
  // 删除是撤销类操作，不该被"该 cid 是否已回复过"拦下，故不传 cid 做去重判定。
  await policy.assertWritable({}, { signal: ctx.signal, onWait: ({ waitMs, reason }) => logger.info(`[delete-comment] ${reason}，等待 ${Math.ceil(waitMs / 1000)}s…`) });

  // 请求节奏守卫（--no-throttle 旁路）
  await riskControl.enforceDelay('write', throttleOpts(ctx, args));

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
