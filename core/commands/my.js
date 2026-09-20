// lib/commands/my.js — 我的作品列表

const { getFlag, withAudit, throttleOpts } = require('./helpers');
const riskControl = require('../risk-control');
const videos = require('../memory/videos');
const accounts = require('../memory/accounts');
const logger = require('../runtime/logger');

/**
 * 获取我的作品列表
 * @param {object} ctx - { bridge, audit, loggedCall }
 * @param {string[]} args - [--count N]
 */
async function cmdMy(ctx, args) {
  // 上限从 20 放宽到 50：界面一次想拉 50 个，而 20 的旧上限让新用户
  // 第一天只能进 20 个作品（工作台入口在作品列表行）。50 只是"请求里要
  // 多少"——抖音侧对单页有自己的截断，实际返回多少存多少。
  const count = Math.min(getFlag(args, '--count', 20), 50);

  // 读节奏守卫（CLI 下为 advisory no-op，见 get.js 注释）
  await riskControl.enforceDelay('read', throttleOpts(ctx, args));

  // 这里**故意不拦**账号不一致。`myPosts` 返回的永远是"浏览器当前登录那个号"
  // 的作品，数据本身没错；按 author.uid 归属（见下面的 opsUid）就自洽了。
  // 拦下来只会让"我换了个号想看它的作品"这件事做不成 —— 而那正是主用例。
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
          // author_uid 是**识别"我自己的评论"的唯一依据**：
          // 视频是我的 → 该视频的作者就是我 → 评论区里 uid 等于它的都是我自己发的。
          // 改造前这个字段从没被写入过，于是无法把自己的评论（含自己发出的回复）
          // 从待回复列表里摘出去。
          authorUid: a.author?.uid ? String(a.author.uid) : null,
          // 这个视频是**哪个账号的操作**带进来的。myPosts 返回的是"当前登录
          // 那个号的作品"，所以 author.uid 就是执行者 —— 用它而不是界面选的
          // 那个 uid：数据归属永远以实际执行者为准
          opsUid: a.author?.uid ? String(a.author.uid) : null,
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

    // 把"这次实际拉到的是哪个号"报上去：界面显示的是 A 而浏览器登录的是 B 时，
    // 用户至少能从这句里看出不对劲，而不是对着一个空列表猜
    const fetchedUid = (data.aweme_list || [])
      .map(a => (a.author && a.author.uid ? String(a.author.uid) : null))
      .find(Boolean) || null;
    return {
      summary: { count: items.length, accountUid: fetchedUid },
      result: { result: items, accountUid: fetchedUid },
      output: items,
    };
  });
}

module.exports = cmdMy;
