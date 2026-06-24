// lib/commands/search.js — 搜索视频

const { SITE, escapeExpression, getFlag } = require('./helpers');

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

  const expr = `window.__bridge.search('${escapeExpression(kw)}', ${offset}, ${count})`;
  ctx.audit.startOperation('search', { keyword: kw, offset, count });

  const data = await ctx.loggedCall('search', { keyword: kw, offset, count }, expr);
  const items = (data.data || []).filter(d => d.aweme_info).map(d => ({
    aweme_id: d.aweme_info.aweme_id,
    desc: (d.aweme_info.desc || '').substring(0, 80),
    author: d.aweme_info.author?.nickname || '',
    uid: d.aweme_info.author?.uid || '',
    time: d.aweme_info.create_time || 0,
    plays: d.aweme_info.statistics?.play_count || 0,
  }));
  ctx.audit.endOperation('success', { count: items.length }, { result: items });
  return items;
}

module.exports = cmdSearch;
