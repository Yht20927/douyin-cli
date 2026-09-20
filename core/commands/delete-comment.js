// lib/commands/delete-comment.js — 删除评论（含本地账目回退）
//
// 这个命令此前只能从命令行用。接进界面之后它多了一层责任：**删除之后本地
// 必须跟着回退** —— 否则界面上那条评论继续显示「已回复」、待回复数不涨回来，
// 而它在抖音上已经不存在了。用户看到的是一份与事实不符的统计。
//
// 两类删除共用同一条路径（都按 cid 定位，不需要调用方区分）：
//   - 删掉**我们发出的回复**：本地要移除那行回复，并把被回复的父评论放回未回复
//   - 删掉**我们自己发的一条顶级评论**：本地移除那行即可（没人指着它）

const { escapeExpression, throttleOpts } = require('./helpers');
const corpus = require('../memory/corpus');
const comments = require('../memory/comments');
const accounts = require('../memory/accounts');
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

  // ── 归属校验：只能删自己发的 ──
  //
  // 抖音那边也会拒（没有权限），但让它拒的话错误是"网络请求失败"级别的，
  // 用户看不出是账号不对还是评论没了。本地有这行记录时先判一次，报得清楚。
  // 本地没有记录（命令行历史上删过、或从没拉过这条）时跳过，交给抖音判。
  const me = (await accounts.resolveExecutor(ctx)).uid || null;
  let local = null;
  try { local = comments.get(String(cid)); } catch (e) { /* 查不到就跳过校验 */ }
  if (local && local.uid && me && String(local.uid) !== String(me)) {
    const who = (uid) => accounts.nicknameOf(uid) || uid;
    throw new Error(
      `这条评论不是当前账号发的，不能删：评论来自「${who(local.uid)}」，`
      + `而浏览器当前登录的是「${who(me)}」。`
    );
  }

  // 策略闸门在前、节奏等待在后（见 post.js 的说明）。
  // 删除是撤销类操作，不该被"该 cid 是否已回复过"拦下，故不传 cid 做去重判定。
  await policy.assertWritable({}, { signal: ctx.signal, onWait: ({ waitMs, reason }) => logger.info(`[delete-comment] ${reason}，等待 ${Math.ceil(waitMs / 1000)}s…`) });

  // 请求节奏守卫（--no-throttle 旁路）
  await riskControl.enforceDelay('write', throttleOpts(ctx, args));

  ctx.audit.startOperation('delete_comment', { cid });

  const expr = `window.__bridge.deleteComment('${escapeExpression(cid)}')`;
  const data = await ctx.loggedCall('delete_comment', { cid }, expr);

  if (data.status_code !== undefined && data.status_code !== 0) {
    // 把服务端原话一起抛出来：2055 这类码的含义我们是猜的，
    // 猜的解释可以给，但**不能替代**原始信息（见 开发进度.md §3.1）
    const raw = data.status_msg || data.message || data.extra?.log_pb?.impr_id || '';
    const err = new Error(
      `status_code=${data.status_code} — 删除评论失败（可能无权限或已被删除）`
      + (raw ? `｜服务端原话：${raw}` : '')
    );
    ctx.audit.endOperation('error', { status_code: data.status_code }, null, err.message);
    throw err;
  }

  // ── 本地账目回退（抖音那边已经删掉了，这里失败只影响本地显示）──
  let removed = 0;
  let unmarked = 0;
  try {
    // 先记语料库的 outcome，再删行 —— 反过来的话 findByReplyCid 就查不到东西了
    const row = corpus.findByReplyCid(String(cid));
    if (row) corpus.setOutcome(row.id, 'deleted');

    removed = comments.remove(String(cid));
    unmarked = comments.unmarkReplied(String(cid));
    if (removed || unmarked) {
      logger.info(`[delete-comment] 本地同步：移除 ${removed} 行，${unmarked} 条父评论回到未回复`);
    }
  } catch (e) {
    // 不抛：评论在抖音上已经删了，这里报错只会让用户以为没删掉而再删一次
    logger.warn(`[delete-comment] 本地账目回退失败（抖音侧已删除）: ${e.message}`);
  }

  const result = {
    cid,
    status: 'deleted',
    status_code: data.status_code ?? 0,
    // 界面据此说明"本地也清理了什么"，而不是只说一句"已删除"
    localRemoved: removed,
    localUnmarked: unmarked,
  };
  ctx.audit.endOperation('success', { cid }, { result });
  return result;
}

module.exports = cmdDeleteComment;
