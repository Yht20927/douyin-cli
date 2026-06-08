// lib/commands/get.js — 获取视频评论（支持嵌套回复、增量拉取）

const { escapeExpression, getFlag, formatComment } = require('./helpers');

// 回复拉取并发数上限
const REPLY_CONCURRENCY = 3;

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
 * 获取评论回复（内部辅助函数）
 */
async function fetchAllReplies(ctx, cid, awemeId, limit = 50) {
  const all = [];
  let cursor = 0;
  const pageSize = Math.min(20, limit);
  while (all.length < limit) {
    const expr = `window.__bridge.replies('${cid}', '${awemeId}', ${cursor}, ${pageSize})`;
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
  const perPage = getFlag(args, '--count', 20);
  const replyLimit = getFlag(args, '--reply-limit', 50);
  const pages = getFlag(args, '--pages', all ? Infinity : 1);
  const isNew = args.includes('--new');
  const since = getFlag(args, '--since', null);

  let cutoff = null;
  if (isNew) {
    cutoff = ctx.audit.findLastFetchTime(awemeId);
    if (!cutoff) console.error('[info] 无历史记录，执行全量拉取');
  } else if (since) {
    cutoff = Number(since);
  }

  const startOpArgs = { aweme_id: awemeId, all, depth, pages };
  if (cutoff) startOpArgs.since = cutoff;
  ctx.audit.startOperation('get', startOpArgs);

  const allComments = [];
  let cursor = 0;
  let pageCount = 0;

  while (pageCount < pages) {
    const expr = `window.__bridge.getComments('${awemeId}', ${cursor}, ${perPage})`;
    const data = await ctx.loggedCall('get', { aweme_id: awemeId, cursor, count: perPage }, expr);
    const comments = data.comments || [];
    pageCount++;

    let filtered = comments;
    if (cutoff) {
      filtered = comments.filter(c => (c.create_time || 0) > cutoff);
      if (filtered.length < comments.length) {
        allComments.push(...filtered);
        break;
      }
    }

    // 展开嵌套回复（并发拉取，限制并发数）
    if (depth >= 1) {
      const replyTasks = filtered
        .map((c, i) => ({ comment: c, index: i }))
        .filter(({ comment }) => (comment.reply_comment_total || 0) > 0)
        .map(({ comment }) => async () => {
          const children = await fetchAllReplies(ctx, comment.cid, awemeId, replyLimit);
          return { comment, children };
        });

      if (replyTasks.length > 0) {
        const replyResults = await promiseAllLimit(replyTasks, REPLY_CONCURRENCY);
        for (const { comment, children } of replyResults) {
          comment.children = children.map(formatComment);
        }
      }
    }

    allComments.push(...filtered);

    if (!data.has_more) break;
    cursor = data.cursor || cursor + perPage;
  }

  const result = allComments.map(formatComment);
  ctx.audit.endOperation('success', { comments: result.length, pages: pageCount }, { comments: result });
  return result;
}

module.exports = cmdGet;
module.exports.fetchAllReplies = fetchAllReplies;
