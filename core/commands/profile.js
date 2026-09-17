// lib/commands/profile.js — 用户交互历史
//
// v2 局限：post 操作的事件中并未携带"被回复者 uid"（reply_to 是 cid，不是 uid），
//         因此 v2 的 profile 实际上对所有 uid 返回相同的全量回复列表。
// v3 P1：查询路径切到 SQLite events 表，输出 schema 与 v2 兼容；
//        当 events.uid 列已记录数据（如 P2 实体表落库后）时，自动按 uid 精确过滤。
//        events 路径不可用或无数据时回退到 audit.json 全表扫，确保兼容。

const events = require('../memory/events');

/**
 * 查看用户交互历史
 * @param {object} ctx - { audit }
 * @param {string[]} args - [uid]
 */
async function cmdProfile(ctx, args) {
  const uid = args[0];
  if (!uid) throw new Error('用法: node cli.js profile <uid>');

  const interactions = readEvents(uid) || readAuditJson(ctx, uid);

  // 升序：早 → 晚
  interactions.sort((a, b) => a.ts - b.ts);

  return {
    uid,
    first_seen: interactions[0]
      ? new Date(interactions[0].ts).toISOString()
      : 'unknown',
    last_seen: interactions.length
      ? new Date(interactions[interactions.length - 1].ts).toISOString()
      : 'unknown',
    total_interactions: interactions.length,
    interactions: interactions.map(it => ({
      time: new Date(it.ts).toISOString(),
      type: it.type,
      command: it.command,
      aweme_id: it.awemeId || null,
      cid: it.cid || null,
    })),
  };
}

/**
 * 从 SQLite events 读取交互历史。
 * 当前匹配策略：events.uid = uid（精确）。
 * 在 P2 完成 reply_to → 评论作者 uid 关联前，post 事件不会自动绑 uid。
 * 这里不报错，返回空数组让 caller 回退到 audit.json。
 */
function readEvents(uid) {
  try {
    const rows = events.query({ uid }, { limit: 1000, order: 'asc' });
    if (!rows || rows.length === 0) return null;
    return rows.map(r => ({
      ts: r.ts,
      command: r.command,
      type: classify(r.command),
      awemeId: r.awemeId,
      cid: r.cid,
    }));
  } catch (e) {
    return null;
  }
}

/**
 * 兼容 v2：从 audit.json 全表扫，仅记录 post --reply-to 行为。
 * v2 实现的副本，保留作为最低保底（uid 实际未参与过滤）。
 */
function readAuditJson(ctx, uid) {
  const a = ctx.audit.load();
  const interactions = [];
  for (const s of (a.sessions || [])) {
    for (const op of (s.operations || [])) {
      if (op.command === 'post' && op.args?.reply_to) {
        interactions.push({
          ts: op.ended ? new Date(op.ended).getTime() : (op.started ? new Date(op.started).getTime() : 0),
          command: 'post',
          type: 'replied',
          awemeId: op.args.aweme_id || null,
          cid: op.args.reply_to || null,
        });
      }
    }
  }
  return interactions;
}

function classify(command) {
  switch (command) {
    case 'post': return 'replied';
    case 'like': return 'liked';
    case 'delete-comment': return 'deleted_comment';
    case 'get': return 'observed';
    default: return command;
  }
}

module.exports = cmdProfile;
