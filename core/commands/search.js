// lib/commands/search.js — 搜索视频

const { SITE, escapeExpression, getFlag, withAudit, throttleOpts } = require('./helpers');
const riskControl = require('../risk-control');

/**
 * 搜索视频
 * @param {object} ctx - { bridge, audit, loggedCall }
 * @param {string[]} args - [keyword, --offset N, --count N]
 */
async function cmdSearch(ctx, args) {
  const kw = args[0];
  if (!kw) throw new Error('用法: node cli.js search <keyword> [--offset N] [--count N]');
  const offset = getFlag(args, '--offset', 0);
  const count = Math.min(getFlag(args, '--count', 10), 20);

  // 读节奏守卫（CLI 下为 advisory no-op，见 get.js 注释）
  await riskControl.enforceDelay('read', throttleOpts(ctx, args));

  return withAudit(ctx, 'search', { keyword: kw, offset, count }, async () => {
    const expr = `window.__bridge.search('${escapeExpression(kw)}', ${offset}, ${count})`;
    const data = await ctx.loggedCall('search', { keyword: kw, offset, count }, expr);
    // 字段只增不减：CLI 的 JSON 契约不变，界面（找视频页）多拿封面与互动数 ——
    // 没有封面的搜索结果是一列光秃秃的文字，认不出是哪个视频
    const items = (data.data || []).filter(d => d.aweme_info).map(d => {
      const a = d.aweme_info;
      return {
        aweme_id: a.aweme_id,
        desc: (a.desc || '').substring(0, 80),
        author: a.author?.nickname || '',
        uid: a.author?.uid || '',
        time: a.create_time || 0,
        plays: a.statistics?.play_count || 0,
        likes: a.statistics?.digg_count || 0,
        comments: a.statistics?.comment_count || 0,
        cover: a.video?.cover?.url_list?.[0] || a.video?.origin_cover?.url_list?.[0] || '',
      };
    });
    return { summary: { count: items.length }, result: { result: items }, output: items };
  });
}

module.exports = cmdSearch;
