// lib/commands/videos.js — 记忆层视频列表（含多账号归属）
//
// 纯本地：只读 SQLite `videos` 表，不碰 bridge。
//   node cli.js videos                    最近记录（默认 50）
//   node cli.js videos --mine             只看自己的作品（is_mine=1）
//   node cli.js videos --account 主号      只看归属该账号的作品
//   node cli.js videos --limit 200
//   node cli.js videos --json             原始 JSON（便于管道）
//
// `--account` 是**过滤条件**（账号不必在线，可查历史）——cli.js 把 `videos`
// 归入 LOCAL_QUERY，做宽松解析。

const { getFlag } = require('./helpers');
const videos = require('../memory/videos');

async function cmdVideos(ctx, args) {
  const limit = getFlag(args, '--limit', 50);
  const mineOnly = args.includes('--mine');
  const asJson = args.includes('--json');
  const account = ctx.account || null;

  const rows = videos.list({
    limit: Math.min(Math.max(Number(limit) || 50, 1), 10000),
    isMine: mineOnly ? true : undefined,
    account,
  });

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log('No matching videos.');
    return;
  }

  for (const v of rows) {
    const tag = v.isMine ? '我的' : '他人';
    const acct = v.account ? ` acct=${v.account}` : '';
    const seen = v.totalCommentsSeen ? ` seen=${v.totalCommentsSeen}` : '';
    console.log(`[${tag}] ${v.awemeId}${acct}${seen} — ${(v.title || '').substring(0, 60)}`);
  }
}

module.exports = cmdVideos;
