// core/commands/enrich.js — 补全视频信息（标题 / 封面 / 互动数据）
//
// 为什么需要
// ----------
// `get`（拉评论）与 `post`（发回复）只能给 videos 表 upsert 一行
// 只有 aweme_id + 时间戳的记录 —— 抖音的**评论接口不返回视频信息**
// （见 logs/results/get-*.json 的顶层键：只有 command/args/started/comments）。
// 于是「运营对象」列表里那几百个视频的标题、封面全是空的，只能靠 ID 尾号认；
// 数据页的互动数据也永远只覆盖跑过 `my` 的那几个自己的作品。
//
// 用的端点是 /aweme/v1/web/aweme/detail/ —— 油猴脚本里**早就有了**
// （scripts/douyin.user.js 的 getDetail），core/reply-engine/video-context.js
// 生成 AI 回复时正在用它取视频上下文，只是一直没把结果落库。
// 所以这不是新开一个抓取面，是把已经在跑的那条路上的数据留下来。
//
// 风险面
// ------
// 每个视频一次读请求，所以有**两层**节奏，各管一件事：
//   - 批次之间：命令入口那次 `riskControl.enforceDelay('read')`。
//     它读的是 events 表里上一条读操作的时间，`enrich` 已登记进 READ_COMMANDS。
//   - 批内逐条：`pace(intervals.commentPage)`，与全量拉取的翻页等待同一段代码。
//
// 原来只有第一层，而它对批内**完全无效**：events 那一行是 endOperation 时才写的，
// 一次跑 200 条的补全从头到尾不会多出任何一行 —— 于是循环里每次算出来的
// "距上次读"都是同一个旧值（通常是"查无记录 → 0 秒"），200 个请求实际是连发的。
// 这也正是 开发进度.md 里那条"命令与命令之间有人管、命令内部没人管"的通用陷阱。

const { escapeExpression, getFlag, pace, throttleOpts } = require('./helpers');
const riskControl = require('../risk-control');
const config = require('../config');
const videos = require('../memory/videos');
const accounts = require('../memory/accounts');
const failures = require('../memory/failures');
const logger = require('../runtime/logger');

/**
 * 一次最多补多少条。
 *
 * 与批量生成同一个理由：一条一条串行跑，中间还隔着读间隔，
 * 200 条已经要跑很久。界面会**先**拦住，而不是让用户填了 1000 条然后干等。
 */
const MAX_BATCH = 200;

/** 从 aweme_detail 里取界面要用的那几个字段（字段缺失一律留 null，不编 0） */
function pickVideoFields(detail) {
  const stats = detail.statistics || {};
  const num = (v) => (v == null ? null : Number(v));
  return {
    // title 用 desc —— 与 my.js / user.js 的既有约定一致
    title: detail.desc != null ? String(detail.desc) : null,
    desc: detail.desc != null ? String(detail.desc) : null,
    coverUrl: detail.video?.origin_cover?.url_list?.[0]
      || detail.video?.cover?.url_list?.[0] || null,
    authorUid: detail.author?.uid != null ? String(detail.author.uid) : null,
    createTime: num(detail.create_time),
    playCount: num(stats.play_count),
    diggCount: num(stats.digg_count),
    commentCount: num(stats.comment_count),
    shareCount: num(stats.share_count),
  };
}

/**
 * 补全视频信息。
 *
 * @param {object} ctx - { bridge, audit, loggedCall, signal }
 * @param {string[]} args
 *   - `<awemeId>` 只补这一条
 *   - `--missing` 补所有没有标题的（不给 awemeId 时的默认行为）
 *   - `--all` 连已有标题的也重抓（用于刷新互动数据）
 *   - `--limit N` 本次最多补几条（默认 50，上限 MAX_BATCH）
 */
async function cmdEnrich(ctx, args) {
  const one = args[0] && !String(args[0]).startsWith('--') ? String(args[0]) : null;
  const limit = Math.max(1, Math.min(
    Number(getFlag(args, '--limit', 50)) || 50,
    MAX_BATCH
  ));

  // 这次以哪个号的身份在补。补全是**读操作**，但它会把互动数据写进库并
  // 决定这个视频归谁运营 —— 所以归属要跟着真正执行的那个号走
  const accountUid = (await accounts.resolveExecutor(ctx)).uid || null;

  let targets;
  if (one) {
    const v = videos.get(one);
    // 库里没有这一行也照补 —— 补完 videos.upsert 会把它建出来
    targets = [{ awemeId: one, title: v ? v.title : null }];
  } else {
    // 只补这个账号自己的作品与它运营过的视频：不隔离的话，B 号点一次
    // 会去补 A 号运营的视频 —— 拿 B 的登录状态去做 A 的活
    targets = videos.listMissingInfo({ limit, all: args.includes('--all'), accountUid });
  }

  if (targets.length === 0) {
    ctx.audit.startOperation('enrich', { count: 0 });
    // 形状必须与正常路径**逐字段一致**（尤其是 updatedCount/failedCount）：
    // 少一个字段时，读 result.updatedCount 的调用方拿到的是 undefined，
    // 而它会显示成"0 条"或 NaN，两处结果对不上又查不出原因。
    const result = { requested: 0, updated: [], failed: [], updatedCount: 0, failedCount: 0, skipped: 0 };
    ctx.audit.endOperation('success', { count: 0 }, { result });
    logger.info('[enrich] 没有需要补全的视频');
    return result;
  }

  ctx.audit.startOperation('enrich', { count: targets.length, all: args.includes('--all') });

  // 批次之间：距上一条读操作还不够间隔就先等一次。
  // 放在"有没有要补的"判断之后 —— 没活干不该让人白等 30 秒。
  await riskControl.enforceDelay('read', throttleOpts(ctx, args));

  // 批内逐条。`--no-throttle` 时连这一层也跳过（与全量拉取的翻页同一套口径）。
  const itemRange = args.includes('--no-throttle')
    ? [0, 0]
    : (config.get('intervals.commentPage') || [0, 0]);

  const updated = [];
  const failed = [];
  let skipped = 0;

  for (let i = 0; i < targets.length; i++) {
    const { awemeId } = targets[i];
    const at = `第 ${i + 1}/${targets.length} 条`;
    logger.progress({
      text: `${at}：正在取视频信息`,
      current: i + 1,
      total: targets.length,
    });

    // 逐条之间的等待（第一条不等，上面那次 enforceDelay 已经覆盖"开始干之前"）。
    // 放在进度之后：等待期间界面上停着的是"第 N 条 · 正在取视频信息"，
    // 而不是上一条的残留。ctx.signal 一 abort 就抛 AbortError，任务能立刻取消。
    if (i > 0) await pace(itemRange, { signal: ctx.signal, onWait: ctx.onWait });

    let detail;
    try {
      const expr = `window.__bridge.getDetail('${escapeExpression(awemeId)}')`;
      const data = await ctx.loggedCall('enrich', { aweme_id: awemeId }, expr);
      detail = data && data.aweme_detail;
    } catch (e) {
      failed.push({ awemeId, error: e.message });
      logger.warn(`[enrich] ${at} 失败：${e.message}`);
      // 失败模式要记 —— "2055 又出现了"这类判断靠的就是这张表。
      // 错误原文由 record 自己截取成 example_text（传 opts 只会覆盖它）
      failures.record(e);
      continue;
    }

    if (!detail) {
      const msg = '接口没有返回 aweme_detail（视频可能已删除或不可见）';
      failed.push({ awemeId, error: msg });
      logger.warn(`[enrich] ${at} 失败：${msg}`);
      continue;
    }

    const fields = pickVideoFields(detail);
    // isMine 不传：upsert 里 `is_mine = CASE WHEN excluded.is_mine=1 THEN 1 ELSE is_mine END`，
    // 传 false 不会把已有的 1 抹掉。补全**绝不能**改动归属判断。
    const ok = videos.upsert({ awemeId, ...fields, opsUid: accountUid });
    if (!ok) {
      failed.push({ awemeId, error: '写入本地库失败' });
      skipped++;
      continue;
    }
    updated.push({
      awemeId,
      title: fields.title || '',
      plays: fields.playCount,
      likes: fields.diggCount,
    });
  }

  const result = {
    requested: targets.length,
    updated,
    failed,
    updatedCount: updated.length,
    failedCount: failed.length,
    skipped,
  };
  // 全失败按 error 收尾：这样队列页会把它标成"未完成"，
  // 而不是显示"已完成 · 0 条"让人以为补过了
  const status = (updated.length === 0 && failed.length > 0) ? 'error' : 'success';
  ctx.audit.endOperation(
    status,
    { count: updated.length, failed: failed.length },
    status === 'success' ? { result } : null,
    status === 'error' ? (failed[0] && failed[0].error) : null
  );
  logger.info(`[enrich] 补全 ${updated.length}/${targets.length} 条${failed.length ? `，失败 ${failed.length} 条` : ''}`);
  return result;
}

module.exports = cmdEnrich;
