// lib/commands/my.js — 我的作品列表

const { getFlag } = require('./helpers');

/**
 * 获取我的作品列表
 * @param {object} ctx - { bridge, audit, loggedCall }
 * @param {string[]} args - [--count N]
 */
async function cmdMy(ctx, args) {
  const count = Math.min(getFlag(args, '--count', 20), 20);
  ctx.audit.startOperation('my', { count });

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
  ctx.audit.endOperation('success', { count: items.length }, { result: items });
  return items;
}

module.exports = cmdMy;
