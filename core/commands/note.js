// lib/commands/note.js — 用户分级 / 标签 / 备注（v3 P2）
//
// 用法：
//   node cli.js note <uid> --tier vip|normal|blacklist|spam
//   node cli.js note <uid> --tag <tag>          # 累加（去重）
//   node cli.js note <uid> --untag <tag>
//   node cli.js note <uid> --notes "<text>"     # 覆盖式
//   node cli.js note <uid> --clear              # tier=null tags=[] notes=null（不删用户行）
//   node cli.js note <uid>                       # 仅打印当前画像
//
// 多操作可同时传：node cli.js note u123 --tier vip --tag 技术粉 --notes "种子用户"
//
// 行为不抛：找不到用户时仍创建占位行（upsert），保证操作幂等。

const users = require('../memory/users');
const { getFlag } = require('./helpers');

const VALID_TIERS = new Set(['vip', 'normal', 'blacklist', 'spam']);

/**
 * @param {object} ctx
 * @param {string[]} args
 */
async function cmdNote(ctx, args) {
  const uid = args[0];
  if (!uid) throw new Error('用法: node cli.js note <uid> [--tier <T>] [--tag <T>] [--untag <T>] [--notes "<text>"] [--clear]');

  const tier = getFlag(args, '--tier', null);
  const tag = getFlag(args, '--tag', null);
  const untag = getFlag(args, '--untag', null);
  const notes = getFlag(args, '--notes', null);
  const clear = args.includes('--clear');

  ctx.audit.startOperation('note', { uid, tier, tag, untag, notes: notes ? '...' : null, clear });

  // 确保 user 行存在
  users.upsert({ uid });

  const ops = [];
  if (clear) {
    users.setTier(uid, null);
    users.setNotes(uid, null);
    // tags 全清：通过反复 removeTag 实现
    const u = users.get(uid);
    for (const t of (u && u.tags) || []) users.removeTag(uid, t);
    ops.push('clear');
  }
  if (tier !== null) {
    if (!VALID_TIERS.has(String(tier))) {
      const err = new Error(`--tier 必须是 vip/normal/blacklist/spam 之一，收到: ${tier}`);
      ctx.audit.endOperation('error', {}, null, err.message);
      throw err;
    }
    users.setTier(uid, String(tier));
    ops.push(`tier=${tier}`);
  }
  if (tag !== null) {
    users.addTag(uid, String(tag));
    ops.push(`+tag:${tag}`);
  }
  if (untag !== null) {
    users.removeTag(uid, String(untag));
    ops.push(`-tag:${untag}`);
  }
  if (notes !== null) {
    users.setNotes(uid, String(notes));
    ops.push('notes');
  }

  const u = users.get(uid);
  const out = {
    uid,
    ops,
    profile: u ? {
      nickname: u.nickname,
      tier: u.tier,
      tags: u.tags || [],
      notes: u.notes,
      comment_count: u.commentCount,
      reply_count: u.replyCount,
    } : null,
  };

  ctx.audit.endOperation('success', { ops: ops.length }, null);
  return out;
}

module.exports = cmdNote;
