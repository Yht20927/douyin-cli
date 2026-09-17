// lib/commands/my.js — 我的作品列表

const { getFlag, withAudit, throttleOpts } = require('./helpers');
const riskControl = require('../risk-control');
const videos = require('../memory/videos');
const logger = require('../runtime/logger');

/**
 * 获取我的作品列表
 * @param {object} ctx - { bridge, audit, loggedCall }
 * @param {string[]} args - [--count N]
 */
async function cmdMy(ctx, args) {
  const count = Math.min(getFlag(args, '--count', 20), 20);

  // 读节奏守卫（CLI 下为 advisory no-op，见 get.js 注释）
  await riskControl.enforceDelay('read', throttleOpts(ctx, args));

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
    // 落库自己的视频。
    // 从**原始 API 对象**取而不是从 items —— items 是为命令输出裁剪过的（desc 截断到
    // 80 字、没有封面），拿它落库会把封面和互动数据丢掉。见 my.js 上方的 map。
    try {
      for (const a of (data.aweme_list || [])) {
        if (!a.aweme_id) continue;
        videos.upsert({
          awemeId: a.aweme_id,
          // title 保持截断（列表页展示用），desc 存全文
          title: (a.desc || '').substring(0, 80) || null,
          desc: a.desc || null,
          coverUrl: a.video?.cover?.url_list?.[0]
            || a.video?.dynamic_cover?.url_list?.[0]
            || a.video?.origin_cover?.url_list?.[0]
            || null,
          isMine: true,
          createTime: a.create_time || null,
          playCount: a.statistics?.play_count,
          diggCount: a.statistics?.digg_count,
          commentCount: a.statistics?.comment_count,
          shareCount: a.statistics?.share_count,
        });
      }
    } catch (e) {
      logger.debug('[my.persist] failed: ' + e.message);
    }

    return { summary: { count: items.length }, result: { result: items }, output: items };
  });
}

module.exports = cmdMy;
