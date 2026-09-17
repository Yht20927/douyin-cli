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
    const expr = `window.__bridge.myPosts(0, ${count})`;
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
    try {
      for (const it of items) {
        if (it.aweme_id) videos.upsert({ awemeId: it.aweme_id, title: it.desc, isMine: true });
      }
    } catch (e) {
      if (process.env.DOUYIN_DEBUG) console.warn('[my.persist] failed:', e.message);
    }

    return { summary: { count: items.length }, result: { result: items }, output: items };
  });
}

module.exports = cmdMy;
