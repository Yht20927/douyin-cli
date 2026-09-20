// lib/commands/get.js — 获取视频评论（支持嵌套回复、增量拉取）

const { escapeExpression, getFlag, formatComment, pace, throttleOpts } = require('./helpers');
const riskControl = require('../risk-control');
const config = require('../config');
const { throwIfAborted } = require('../runtime/abort');
const users = require('../memory/users');
const comments = require('../memory/comments');
const videos = require('../memory/videos');
const accounts = require('../memory/accounts');
const logger = require('../runtime/logger');

// 回复拉取并发数上限
const REPLY_CONCURRENCY = 3;

/**
 * 单页最多要多少条。**服务端硬顶就是 50**，超过这个值不会多给，但 `cursor` 仍按你请求的
 * count 往前跳 —— 于是被跳过的那批评论**静默丢失**，接口不报错、`has_more` 也照常为 1。
 *
 * 实测（comments/list，2026-09，两个视频）：
 *   要 20 条 → 每页回 18-20 条，翻完 226 条 / 去重 226 条 ✅
 *   要 50 条 → 每页回 48-50 条，翻完 226 条 / 去重 226 条 ✅
 *   要 60 条 → 每页回 48-50 条，只拿到 196 条 ❌（丢了 30 条）
 *   要 100 条 → 每页回 48-50 条，只拿到 146 条 ❌
 * 所以这里是硬上限，不是"建议值"。
 */
const MAX_PAGE_SIZE = 50;

/** 全量拉取的页数保险丝：400 页 × 50 条 = 20000 条。正常作品远到不了。 */
const DEFAULT_MAX_PAGES = 400;

/** 连续多少页一条新评论都没有，就认定服务端在原地打转，停下来（见 fetchAllPages）。 */
const STALE_PAGES = 3;

/** 是否为表情包/贴纸评论（无文字仅图）。 */
function isStickerComment(c) {
  if (!c) return false;
  if (c.sticker_id || c.sticker) return true;
  const hasImage = Array.isArray(c.image_list) && c.image_list.length > 0;
  const noText = !c.text || !String(c.text).trim();
  return hasImage && noText;
}

/**
 * 把一组原始评论 + 它们的回复落库到 users/comments 表。
 * 调用方负责传 awemeId（对原帖评论与回复都用同一个）与 accountUid
 * （当前执行的账号，用于判断"哪些评论是我自己发的"）。
 * 失败不抛 —— 实体表只是辅助索引。
 */
function persistEntities(rawComments, awemeId, accountUid = null) {
  if (!Array.isArray(rawComments) || rawComments.length === 0) {
    return { users: 0, comments: 0 };
  }
  const seenAt = Date.now();
  const userEntries = [];
  const commentEntries = [];
  function walk(list, parentCid) {
    for (const c of list) {
      if (!c || !c.cid) continue;
      const u = c.user || {};
      const uid = u.uid || u.uid_str || null;
      if (uid) {
        userEntries.push({
          uid: String(uid),
          secUid: u.sec_uid || null,
          nickname: u.nickname || null,
          seenAt,
          commentDelta: 1,
        });
      }
      commentEntries.push({
        cid: String(c.cid),
        awemeId: String(awemeId),
        uid: uid ? String(uid) : null,
        text: c.text != null ? String(c.text) : null,
        digg: c.digg_count != null ? Number(c.digg_count) : null,
        createdAt: c.create_time != null ? Number(c.create_time) : null,
        isSticker: isStickerComment(c),
        parentCid: parentCid || null,
        seenAt,
      });
      if (Array.isArray(c.children) && c.children.length > 0) {
        // children 可能已经是 formatComment 后的对象，也可能是原始对象。
        // 这里只接收原始对象（formatComment 之前调用 persistEntities）。
        walk(c.children, c.cid);
      }
    }
  }
  walk(rawComments, null);

  // ── 推断"已经被我回复过" ──
  // 拉取时带上嵌套回复（--depth 1），所以如果某条评论下面出现了**我发的回复**，
  // 那这条评论显然已经被我回过了。这能覆盖"直接在抖音 App 里手工回复、
  // 本地没有记录"的情况 —— 否则界面会一直提示去回复一条早就回过的评论。
  //
  // 判定依据是我的 uid（来自 videos.author_uid，由 `my` 命令写入）。
  // 拿不到 myUid 时整段跳过：宁可少标，也不能误把别人的回复当成我的。
  const inferred = [];
  // 归属判定用**当前账号**（由 cmdGet 解析后传进来 —— 这个函数是同步的，
  // 不能自己 await）。全局 videos.myUid() 是"作品数最多的号"的猜测，
  // 两个号时必有一个是错的。
  const myUid = accountUid || null;
  if (myUid) {
    for (const e of commentEntries) {
      if (e.parentCid && e.uid && String(e.uid) === myUid) {
        inferred.push({ parentCid: e.parentCid, replyCid: e.cid });
      }
    }
  }

  // 单事务包住 users + comments upsert（原子，崩溃不留半成品）
  let uCount = 0, cCount = 0;
  try {
    const { getDb } = require('../memory/db');
    const db = getDb();
    const tx = db.transaction(() => {
      uCount = users.upsertMany(userEntries);
      cCount = comments.upsertMany(commentEntries);
      // 必须放在 upsert 之后：父评论得先存在，markReplied 才是在真实行上置位
      for (const it of inferred) {
        comments.markReplied(it.parentCid, String(awemeId), it.replyCid);
      }
    });
    tx();
    if (inferred.length > 0) {
      logger.info(`[get] 推断出 ${inferred.length} 条评论此前已被我回复过（评论区内有我的回复）`);
    }
  } catch (e) {
    logger.debug('[persistEntities] tx failed: ' + e.message);
    return { users: 0, comments: 0 };
  }
  return { users: uCount, comments: cCount, inferredReplied: inferred.length };
}

/**
 * 并发执行异步任务（带并发数限制）
 * @param {Array<Function>} tasks - 返回 Promise 的函数数组
 * @param {number} limit - 最大并发数
 * @returns {Promise<Array>} 结果数组（顺序与 tasks 一致）
 */
async function promiseAllLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * 把一个视频的评论从头翻到尾（`--all` 的实现主体）。
 *
 * 比"循环到 has_more 为假"复杂的那几件事，全都有实测依据：
 *
 *   - **必须按 cid 去重**。offset 翻页踩在一个会变动的列表上，实测 1180 条的那个作品
 *     顺序翻完拿到 1093 条，去重后只有 903 条 —— 17% 是重复的。不去的后果不只是浪费，
 *     是"拉回来 1093 条"这个数直接是假的。
 *   - **`has_more` 不能当唯一终止条件**。它中途一直是 1，只有真尽头才 0；而且不能保证
 *     服务端不会原地打转（同窗口反复吐同一批）。所以配了 STALE_PAGES 兜底。
 *   - **越界是干净的**：cursor 超过真实条数时服务端返回空数组 + has_more=0，不报错。
 *     下面把它单独标成 'empty'，因为"翻到头了"和"被服务端悄悄截断"对用户是两件事。
 *
 * @param {object} ctx - 需要 ctx.loggedCall 与 ctx.signal
 * @param {string} awemeId
 * @param {object} [opts]
 * @param {number} [opts.perPage=20]      每页条数，超过 MAX_PAGE_SIZE 会被夹住
 * @param {number} [opts.maxPages]        页数保险丝
 * @param {number} [opts.stalePages]      连续多少页无新增就停
 * @param {number[]} [opts.delayRange]    页间等待区间（秒）
 * @param {Function} [opts.filterPage]    每页的额外过滤；返回条数变少即视为"撞到增量边界"，停止
 * @param {Function} [opts.onPage]        每页回调，用于上报进度
 * @param {AbortSignal} [opts.signal]     取消信号（缺省取 ctx.signal）
 * @returns {Promise<{comments:Array, pages:number, unique:number, duplicates:number, stoppedBy:string}>}
 *          stoppedBy: end | empty | stale | maxPages | cutoff
 */
async function fetchAllPages(ctx, awemeId, opts = {}) {
  const perPage = Math.min(Math.max(1, Number(opts.perPage) || 20), MAX_PAGE_SIZE);
  const maxPages = Number.isFinite(opts.maxPages) && opts.maxPages > 0
    ? Math.floor(opts.maxPages) : DEFAULT_MAX_PAGES;
  const stalePages = opts.stalePages || STALE_PAGES;
  const signal = opts.signal || ctx.signal;

  const seen = new Set();
  const out = [];
  let cursor = 0;
  let pages = 0;
  let duplicates = 0;
  let stale = 0;
  let stoppedBy = 'end';

  while (true) {
    if (pages >= maxPages) { stoppedBy = 'maxPages'; break; }
    throwIfAborted(signal);
    if (pages > 0) await pace(opts.delayRange, { signal });

    const expr = `window.__bridge.getComments('${escapeExpression(String(awemeId))}', ${cursor}, ${perPage})`;
    const data = await ctx.loggedCall('get', { aweme_id: awemeId, cursor, count: perPage }, expr);
    const raw = (data && data.comments) || [];
    pages++;

    // 增量过滤（--new / --since）：命中边界就把这一页当作最后一页
    const page = opts.filterPage ? opts.filterPage(raw) : raw;
    const hitCutoff = page.length < raw.length;

    let fresh = 0;
    for (const c of page) {
      if (!c || !c.cid) continue;
      const cid = String(c.cid);
      if (seen.has(cid)) { duplicates++; continue; }
      seen.add(cid);
      out.push(c);
      fresh++;
    }

    if (opts.onPage) {
      opts.onPage({ pages, returned: raw.length, fresh, unique: seen.size, duplicates, cursor });
    }

    if (hitCutoff) { stoppedBy = 'cutoff'; break; }
    if (raw.length === 0) { stoppedBy = 'empty'; break; }
    if (!data.has_more) { stoppedBy = 'end'; break; }

    stale = fresh === 0 ? stale + 1 : 0;
    if (stale >= stalePages) { stoppedBy = 'stale'; break; }

    cursor = data.cursor || cursor + perPage;
  }

  return { comments: out, pages, unique: seen.size, duplicates, stoppedBy };
}

/**
 * 获取评论回复（内部辅助函数）
 */
async function fetchAllReplies(ctx, cid, awemeId, limit = 50) {
  const all = [];
  let cursor = 0;
  const pageSize = Math.min(20, limit);
  while (all.length < limit) {
    const expr = `window.__bridge.replies('${escapeExpression(String(cid))}', '${escapeExpression(String(awemeId))}', ${cursor}, ${pageSize})`;
    const data = await ctx.bridgeCall(expr);
    const comments = data.comments || [];
    all.push(...comments);
    if (!data.has_more || comments.length === 0) break;
    cursor = data.cursor || cursor + pageSize;
  }
  return all.slice(0, limit);
}

/**
 * 获取视频评论
 * @param {object} ctx - { bridge, audit, bridgeCall, loggedCall }
 * @param {string[]} args - [aweme_id, --all, --depth N, --count N, --pages N, --new, --since <ts>, --reply-limit N]
 */
async function cmdGet(ctx, args) {
  const awemeId = args[0];
  if (!awemeId) throw new Error('用法: node cli.js get <aweme_id> [--all] [--depth N] [--new] [--since <ts>]');

  const all = args.includes('--all');
  const depth = getFlag(args, '--depth', 0);
  // 全量拉取默认每页要满 50（要翻的页数是单页拉取的 1/2.5，少一页就少一次风控暴露）；
  // 单页拉取保持原来的 20 —— 那条路径是"点一下看看有没有新评论"，没必要多拿。
  const perPage = Math.min(getFlag(args, '--count', all ? MAX_PAGE_SIZE : 20), MAX_PAGE_SIZE);
  const replyLimit = getFlag(args, '--reply-limit', 50);
  const maxPages = getFlag(args, '--pages', all ? DEFAULT_MAX_PAGES : 1);
  const isNew = args.includes('--new');
  const since = getFlag(args, '--since', null);

  // 本次以哪个号的身份在拉。用**执行者**（浏览器当前登录的那个）而不是界面
  // 选定的那个：ops_uid 记的是"谁真的去拉了这些数据"，归属要跟着它走。
  const accountUid = (await accounts.resolveExecutor(ctx)).uid || null;

  // 读操作节奏守卫。CLI 下 intervals.readEnforce=false → 立即返回（advisory），
  // 行为与改造前一致；GUI 下置 true → 真正阻塞，因为那里没有 agent 自觉遵守间隔。
  await riskControl.enforceDelay('read', throttleOpts(ctx, args));

  let cutoff = null;
  if (isNew) {
    cutoff = ctx.audit.findLastFetchTime(awemeId);
    // 这句此前写的是"执行全量拉取"，但这里并没有翻页 —— 不带 --all 时 maxPages 就是 1。
    // 界面的「拉取新评论」走的正是这条路径，看到这句会以为拉全了。
    if (!cutoff) {
      logger.info(all
        ? '[info] 无历史记录，全量拉取'
        : '[info] 无历史记录，本次只拉第 1 页（要拉全部用 --all）');
    }
  } else if (since) {
    cutoff = Number(since);
  }

  const startOpArgs = { aweme_id: awemeId, all, depth, pages: maxPages };
  if (cutoff) startOpArgs.since = cutoff;
  ctx.audit.startOperation('get', startOpArgs);

  // 翻页之间的节奏。`--no-throttle` 由队列给写操作补，这里也认它 —— 读操作被显式要求跳过时
  // 不该还卡在页间等待上。
  const delayRange = args.includes('--no-throttle')
    ? [0, 0]
    : (config.get('intervals.commentPage') || [0, 0]);

  const {
    comments: allComments, pages: pageCount, unique, duplicates, stoppedBy,
  } = await fetchAllPages(ctx, awemeId, {
    perPage,
    maxPages,
    delayRange,
    signal: ctx.signal,
    // 增量模式：某一页开始出现 <= cutoff 的评论，就认为到底了（列表按时间倒序的前提下）
    filterPage: cutoff ? (raw) => raw.filter(c => (c.create_time || 0) > cutoff) : undefined,
    // 单页拉取不报进度 —— 那条路径的 CLI stdout/stderr 契约维持原样
    //
    // 必须用 `ctx.logger` 而不是模块级的 logger：任务级进度 sink 是当作 extraSinks
    // 挂在 ctx 的 child logger 上的（context.js:59-68），走全局单例的记录到不了那个 sink，
    // task.progress 永远是空的，界面上的进度条会一直冻着。
    onPage: all
      ? ({ pages, unique: u, duplicates: d }) => {
        ctx.logger.progress({
          text: `第 ${pages} 页 · 已拿到 ${u} 条`
            + (d > 0 ? ` · 重复跳过 ${d} 条` : ''),
          pages,
          unique: u,
          duplicates: d,
        });
      }
      : undefined,
  });

  // 提前停下必须是响的：用户以为拉全了、其实没有，是最坏的一种"成功"
  if (stoppedBy === 'stale' || stoppedBy === 'maxPages') {
    ctx.logger.warn(
      `[get] 提前停止（${stoppedBy === 'stale' ? '连续多页没有新评论' : `达到 ${maxPages} 页上限`}）`
      + `：已拿到 ${unique} 条，可能没拉全。`
    );
  }

  // 展开嵌套回复（并发拉取，限制并发数）。
  // 放在翻页**之后**而不是每页之后：页循环保持紧凑，回复阶段独占它的并发窗口，
  // 两件事的时间线和取消语义都更清楚。
  if (depth >= 1 && allComments.length > 0) {
    const replyTasks = allComments
      .filter(c => (c.reply_comment_total || 0) > 0)
      .map(comment => async () => {
        const children = await fetchAllReplies(ctx, String(comment.cid), awemeId, replyLimit);
        return { comment, children };
      });

    if (replyTasks.length > 0) {
      ctx.logger.info(`[get] 展开 ${replyTasks.length} 条评论的嵌套回复…`);
      const replyResults = await promiseAllLimit(replyTasks, REPLY_CONCURRENCY);
      for (const { comment, children } of replyResults) {
        // 保留原始 children 用于 persistEntities，formatted 副本用于输出
        comment._rawChildren = children;
        comment.children = children.map(formatComment);
      }
    }
  }

  // ── 实体表落库（旁路写，失败不影响主流程）──
  try {
    // 把 _rawChildren 暂时挂回 children 以便递归落库，落库后再恢复
    const forPersist = allComments.map(c => {
      const clone = { ...c };
      if (clone._rawChildren) clone.children = clone._rawChildren;
      return clone;
    });
    persistEntities(forPersist, awemeId, accountUid);
    // 记下"这个视频是哪个账号在运营" —— 运营对象的账号隔离全靠它
    videos.markGet(awemeId, { commentsSeenDelta: allComments.length, accountUid });
  } catch (e) {
    // 旁路写：失败不该让整次拉取失败，但不能只用 debug 记 —— 那样"评论没落库、
    // 这个视频在运营对象页里根本不出现"会变成一件无迹可查的事
    logger.warn(`[get] 实体落库失败（评论未写入、归属账号未记上）: ${e.message}`);
  }

  // 清理 _rawChildren，确保 formatComment 输出干净
  for (const c of allComments) delete c._rawChildren;

  const result = allComments.map(formatComment);
  // summary 里带上 unique/duplicates/stoppedBy：界面拿不到大结果对象（队列有 64KB 上限），
  // 但这个小对象会落进 events 表，事后查得到"那次到底拉了多少、为什么停"。
  ctx.audit.endOperation('success', {
    comments: result.length, pages: pageCount, unique, duplicates, stoppedBy,
  }, { comments: result });
  return result;
}

module.exports = cmdGet;
module.exports.fetchAllPages = fetchAllPages;
module.exports.fetchAllReplies = fetchAllReplies;
module.exports.persistEntities = persistEntities;
module.exports.isStickerComment = isStickerComment;
module.exports.MAX_PAGE_SIZE = MAX_PAGE_SIZE;
