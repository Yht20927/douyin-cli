// lib/commands/user.js — 查看任意用户的作品信息
//
// 走 /aweme/v1/web/aweme/post/?sec_user_id=... 端点（与 myPosts 同一接口，
// 但显式传入 sec_user_id、from_user_page=1，用于查看他人主页作品）。
// 入参支持纯 sec_user_id 或完整用户主页 URL（https://www.douyin.com/user/<sec_uid>）。

const { escapeExpression, getFlag } = require('./helpers');
const videos = require('../memory/videos');

const SEC_UID_RE = /^MS4wLjAB[A-Za-z0-9_-]+$/;

/**
 * 从入参中解析出 sec_user_id
 * - 完整 URL：https://www.douyin.com/user/MS4wLjAB...
 * - 纯 sec_user_id：MS4wLjAB...
 */
function parseSecUserId(raw) {
  if (!raw) return '';
  // URL 形式：取 /user/ 后面那段
  const m = String(raw).match(/\/user\/(MS4wLjAB[A-Za-z0-9_-]+)/);
  if (m) return m[1];
  // 纯 sec_user_id
  if (SEC_UID_RE.test(raw)) return raw;
  return '';
}

/**
 * 查看用户作品信息
 * @param {object} ctx - { bridge, audit, loggedCall }
 * @param {string[]} args - [sec_user_id | 用户主页URL, --count N, --cursor <ts>]
 */
async function cmdUser(ctx, args) {
  const secUserId = parseSecUserId(args[0]);
  if (!secUserId) {
    throw new Error('用法: node cli.js user <sec_user_id | 用户主页URL> [--count N] [--cursor <ts>]\n例: node cli.js user MS4wLjABAAAAvJhhhv1qrvful_kqsv6Ry2F8v8Z-jCDNha0yyvkVKg2eCZ60_Ni2-23tUZ08NdWX');
  }
  const count = Math.min(getFlag(args, '--count', 18), 35);
  const cursor = getFlag(args, '--cursor', 0);

  ctx.audit.startOperation('user', { sec_user_id: secUserId, count, cursor });

  const expr = `window.__bridge.userPosts('${escapeExpression(secUserId)}', ${cursor}, ${count})`;
  const data = await ctx.loggedCall('user', { sec_user_id: secUserId, count, cursor }, expr);

  const list = data.aweme_list || [];
  // 作者信息取自首个作品的 author 字段（接口在每条作品里都回带）
  const author = list[0]?.author || {};
  const user = {
    uid: author.uid || '',
    sec_uid: author.sec_uid || secUserId,
    nickname: author.nickname || '',
  };

  const items = list.map(a => ({
    aweme_id: a.aweme_id,
    desc: (a.desc || '').substring(0, 80),
    time: a.create_time || 0,
    duration: a.duration || 0, // 毫秒
    is_top: a.is_top === 1,
    stats: {
      plays: a.statistics?.play_count || 0,
      likes: a.statistics?.digg_count || 0,
      comments: a.statistics?.comment_count || 0,
      shares: a.statistics?.share_count || 0,
      collects: a.statistics?.collect_count || 0,
    },
    cover: a.video?.cover?.url_list?.[0] || '',
  }));

  // 落库（他人作品：isMine=false，记录 author_uid 便于后续按作者检索）
  try {
    for (const it of items) {
      if (it.aweme_id) videos.upsert({ awemeId: it.aweme_id, title: it.desc, authorUid: user.uid, isMine: false });
    }
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[user.persist] failed:', e.message);
  }

  const result = {
    user,
    has_more: data.has_more,
    max_cursor: data.max_cursor,
    min_cursor: data.min_cursor,
    count: items.length,
    aweme_list: items,
  };
  ctx.audit.endOperation('success', { count: items.length, has_more: data.has_more }, { result });
  return result;
}

module.exports = cmdUser;
