// lib/commands/my.js — 我的作品列表

const { getFlag, withAudit } = require('./helpers');
const videos = require('../memory/videos');

/**
 * 获取我的作品列表
 * @param {object} ctx - { bridge, audit, loggedCall }
 * @param {string[]} args - [--count N]
 */
async function cmdMy(ctx, args) {
  const count = Math.min(getFlag(args, '--count', 20), 20);

  return withAudit(ctx, 'my', { count }, async () => {
    // 第 3 个参数是「本命令应落到哪个账号」：油猴端据此校验取到的 sec_uid 属于该号，
    // 防止本地残留（登出后 / 别的账号）的 sec_uid 被用来查「我的作品」。
    const expr = `window.__bridge.myPosts(0, ${count}, ${JSON.stringify(ctx.account || '')})`;
    const data = await ctx.loggedCall('my', { count }, expr);
    const items = (data.aweme_list || []).map(a => ({
      aweme_id: a.aweme_id,
      desc: (a.desc || '').substring(0, 80),
      time: a.create_time || 0,
      stats: {
        plays: a.statistics?.play_count || 0,
        likes: a.statistics?.digg_count || 0,
        comments: a.statistics?.comment_count || 0,
        shares: a.statistics?.share_count || 0,
      },
    }));
    // 落库自己的视频（title + is_mine=true，对齐 xhs my.js notes 落库）
    // account 记归属：多账号下 A 号 my 与 B 号 my 拉来的作品不能混作一谈
    try {
      for (const it of items) {
        if (it.aweme_id) videos.upsert({ awemeId: it.aweme_id, title: it.desc, isMine: true, account: ctx.account });
      }
    } catch (e) {
      if (process.env.DOUYIN_DEBUG) console.warn('[my.persist] failed:', e.message);
    }

    return { summary: { count: items.length }, result: { result: items }, output: items };
  });
}

module.exports = cmdMy;
