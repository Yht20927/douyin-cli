// core/commands/videos.js — 记忆层视频列表（含多账号归属）
//
// 纯本地：只读 SQLite `videos` 表，不碰 bridge。
//   node cli.js videos                    最近记录（默认 50）
//   node cli.js videos --mine             只看自己的作品（is_mine=1）
//   node cli.js videos --account 主号      只看归属该账号的作品
//   node cli.js videos --limit 200
//   node cli.js videos --json             原始 JSON（便于管道）
//
// `--account` 是**过滤条件**（账号不必在线，可查历史）—— cli.js 把 videos
// 归入本地查询，做宽松解析。
//
// 归属列的选择：桌面端用 ops_uid 表达"本机以哪个号拉取/运营过这个视频"，
// main 分支对应的是 videos.account。两列语义相同，这里只读 ops_uid，
// 不再新增重复列（见 db.js v15 迁移的说明）。

const { getFlag } = require('./helpers');
const videos = require('../memory/videos');

async function cmdVideos(ctx, args) {
  const limit = getFlag(args, '--limit', 50);
  const mineOnly = args.includes('--mine');
  const asJson = args.includes('--json');
  const account = ctx.accountUid || null;

  const rows = videos.list({
    limit: Math.min(Math.max(Number(limit) || 50, 1), 10000),
    // 两种归属语义分开：
    //   --mine --account A → A 作为作者的作品（author_uid=A 且 is_mine=1）
    //   --account A        → A 操作过的视频（ops_uid=A，含 A 拉过评论的他人作品）
    // 桌面端的 ops_uid 是"谁把这一行带进来的"，比 main 的 videos.account
    // 覆盖面更广；--mine 把范围收回到作者归属，正好对应 main 原来的语义。
    accountUid: mineOnly && account ? account : undefined,
    opsUid: !mineOnly && account ? account : undefined,
    isMine: mineOnly ? true : undefined,
    // 作品列表按发布时间排，而不是"最近拉取过"——用户翻自己的作品时
    // 期待的是最新发的在最前面。
    order: 'publish',
  });

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return rows;
  }

  if (rows.length === 0) {
    console.log('No matching videos.');
    return rows;
  }

  for (const v of rows) {
    const tag = v.isMine ? '我的' : '他人';
    // 与 main 的 `videos` 输出对齐：acct 显示这一行的归属账号（迁移后是 ops_uid）。
    // 他人作品如果没有归属（main 旧数据），就不打这一栏，而不是冒充作者 uid。
    const acct = v.opsUid ? ` acct=${v.opsUid}` : '';
    const seen = v.totalCommentsSeen ? ` seen=${v.totalCommentsSeen}` : '';
    console.log(`[${tag}] ${v.awemeId}${acct}${seen} — ${(v.title || '').substring(0, 60)}`);
  }
  return rows;
}

module.exports = cmdVideos;
