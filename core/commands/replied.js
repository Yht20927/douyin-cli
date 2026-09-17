// lib/commands/replied.js — 查询已回复的评论 cid 列表
//
// 用法：
//   node cli.js replied                 每行一个 cid（shell 友好）
//   node cli.js replied --json          JSON 数组
//   node cli.js replied --aweme <id>    按视频过滤
//   node cli.js replied --count         只输出数量

const { getFlag } = require('./helpers');
const logger = require('../runtime/logger');

let mem = null;
function memory() {
  if (mem === null) {
    try {
      mem = { comments: require('../memory/comments') };
    } catch (e) {
      logger.debug('[replied] memory unavailable: ' + e.message);
      mem = false;
    }
  }
  return mem || null;
}

async function cmdReplied(ctx, args) {
  const awemeId = getFlag(args, '--aweme', null);
  const asJson = args.includes('--json');
  const asCount = args.includes('--count');

  const m = memory();
  if (!m) {
    const err = new Error('SQLite 记忆层不可用');
    if (asJson || asCount) return { error: err.message };
    logger.error('[replied]' + ' ' + err.message);
    return;
  }

  const rows = m.comments.listReplied(awemeId ? { awemeId } : {});

  if (asCount) {
    const n = rows.length;
    if (asJson) return { count: n };
    logger.output(n);
    return;
  }

  if (asJson) return rows;

  // 默认：每行一个 cid（shell 可直接 > /tmp/replied_cids.txt）
  for (const r of rows) logger.output(r.cid);
}

module.exports = cmdReplied;
