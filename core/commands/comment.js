// lib/commands/comment.js — 查询单条评论实体
//
// 用法：
//   node cli.js comment <cid>          查询单条评论（含 replied/sentiment/parent）

const comments = require('../memory/comments');
const users = require('../memory/users');

async function cmdComment(ctx, args) {
  const cid = args[0];
  if (!cid) throw new Error('用法: node cli.js comment <cid>');

  const c = comments.get(cid);
  if (!c) throw new Error(`评论 ${cid} 不在缓存中。请先拉取评论: node cli.js get <aweme_id>`);

  // 补充用户信息
  let user = null;
  if (c.uid) {
    try { user = users.get(c.uid); } catch (_) {}
  }

  // 补充父评论
  let parent = null;
  if (c.parentCid) {
    try { parent = comments.get(c.parentCid); } catch (_) {}
  }

  return {
    cid: c.cid,
    awemeId: c.awemeId,
    uid: c.uid,
    text: c.text,
    digg: c.digg,
    createdAt: c.createdAt,
    isSticker: c.isSticker,
    sentiment: c.sentiment,
    priority: c.priority,
    replied: c.replied,
    replyCid: c.replyCid,
    parentCid: c.parentCid,
    parentText: parent?.text || null,
    user: user ? { nickname: user.nickname, tier: user.tier, tags: user.tags, commentCount: user.commentCount } : null,
    firstSeen: c.firstSeen,
    lastSeen: c.lastSeen,
  };
}

module.exports = cmdComment;
