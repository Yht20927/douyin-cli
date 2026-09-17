// lib/commands/suggest.js — LLM 回复建议（可自动发布，含节奏拟人化）
//
// 节奏拟人化（rate-limit pacing + content humanization）：
// - 人格化回复（7 种人格自动轮换）
// - 随机延迟（发布间隔 + 疲劳累加）—— 让请求节奏贴近正常用户使用习惯，避免触发接口频控
// - 断路器改为 events 表窗口统计（避免累计 hit_count 误触发）
//
// 发布间隔的单一事实源 = risk-control.getIntervals().write（config.json:intervals）。
// 本模块不再维护自己的间隔常量。
//
// 语义边界：本模块服务于用户自有账号的代管运营；内容真实性与反刷量由 corpus 去重 +
// 内容禁令保证，节奏工具只管"多快发一次"。

const fs = require('fs');
const path = require('path');
const { getFlag } = require('./helpers');
const corpus = require('../memory/corpus');
const failures = require('../memory/failures');
const users = require('../memory/users');
const commentsRepo = require('../memory/comments');
const { maybeDelay, jitter } = require('../jitter');
const riskControl = require('../risk-control');
const { pickPersona } = require('../personas');
const logger = require('../runtime/logger');

const CORPUS_FEWSHOT_LIMIT = 20;
const FAILURE_TOP_LIMIT = 10;
const AVOID_LIMIT = 30;

/** 自动发布的条数上限 */
const MAX_AUTO_POSTS = 30;

/**
 * 解析 suggest 命令参数
 * @param {string[]} args - [--auto] [--force] [--fast] [--min-priority N] [--interval ms] [--mode ...] [--screenshots N]
 */
function parseSuggestArgs(args) {
  const awemeId = args[0];
  if (!awemeId) {
    throw new Error('用法: node cli.js suggest <aweme_id> [--auto] [--min-priority N] [--mode text-only|screenshots|video] [--screenshots N] [--fast] [--force]');
  }

  // 基础发布间隔：写操作窗口 [min,max] 内均匀采样（单一事实源 risk-control）
  const [writeMinSec, writeMaxSec] = riskControl.getIntervals().write;
  const userInterval = getFlag(args, '--interval', null);
  const basePostIntervalMs = userInterval != null
    ? Number(userInterval)
    : (writeMinSec + Math.random() * (writeMaxSec - writeMinSec)) * 1000;

  return {
    awemeId,
    auto: args.includes('--auto'),
    force: args.includes('--force'),
    fast: args.includes('--fast'),
    minPriority: getFlag(args, '--min-priority', 0),
    basePostIntervalMs,
    mode: getFlag(args, '--mode', 'text-only'),   // text-only | screenshots | video
    screenshotCount: parseInt(getFlag(args, '--screenshots', '4'), 10),
  };
}

/**
 * 生成阶段：分析评论 → 过滤 → 上下文注入 → LLM 生成建议 → dedup 重写。
 * 不含任何发布动作。
 *
 * @returns {Promise<Array>} suggestions [{ cid, reply, rewritten?, _duplicate? }]
 */
async function collectSuggestions(ctx, opts) {
  const { awemeId, force, fast, minPriority } = opts;

  // 先分析
  logger.info('正在分析评论...');
  const analysis = await ctx.cmdAnalyze([awemeId, ...(force ? ['--force'] : [])]);
  if (!analysis || analysis.length === 0) {
    logger.info('没有需要回复的评论。');
    return [];
  }

  // 模拟阅读时间（概率 50%）
  if (!fast) await maybeDelay(0.5, 2000, 6000);

  // 筛选需回复的（cid 一生一次：默认跳过已回复，--force 覆盖）
  const toReply = analysis.filter(a =>
    a.priority >= minPriority
    && a.sentiment !== 'negative'
    && (force || !commentsRepo.get(String(a.cid))?.replied)
  );

  // 给每条评论挂上用户画像标签
  for (const c of toReply) {
    const uid = c.uid || c.user?.uid;
    if (uid) {
      const u = users.get(String(uid));
      if (u && Array.isArray(u.tags) && u.tags.length) c.userTags = u.tags;
    }
  }

  // 读取策略
  let strategy = '';
  try { strategy = fs.readFileSync(path.join(process.cwd(), 'reply-strategy.md'), 'utf8'); } catch (e) { /* */ }

  // ── v3 P3 上下文注入 ──
  const histCorpus = corpus.recent({ limit: CORPUS_FEWSHOT_LIMIT, outcomes: ['published'] });
  const histFailures = failures.top(FAILURE_TOP_LIMIT);
  const avoidTexts = histCorpus.slice(0, AVOID_LIMIT).map(c => c.replyText).filter(Boolean);

  logger.info(`[suggest] 注入历史: corpus=${histCorpus.length} failures=${histFailures.length} avoid=${avoidTexts.length}`);

  const llm = require('../llm');
  const client = new llm.LLMClient(ctx.config.llm || {});
  const llmContext = {
    corpus: histCorpus.map(c => ({ srcText: c.srcText, replyText: c.replyText })),
    failures: histFailures,
    avoid: avoidTexts,
  };

  // 随机选择人格
  const persona = pickPersona();
  if (process.env.DOUYIN_DEBUG) {
    logger.info(`[suggest] 使用人格: ${persona.name} (temp=${persona.temperature.toFixed(2)})`);
  }

  let suggestions;
  if (opts.effectiveMode !== 'text-only') {
    // ── 多模态路径：加载视频上下文 → 构建 prompt → 调用 LLM ──
    logger.info(`[suggest] 多模态模式: ${opts.effectiveMode} (截图数: ${opts.screenshotCount})`);
    const { loadVideoContext } = require('../reply-engine/video-context');
    const { buildSuggestPrompt } = require('../reply-engine/prompt-builder');

    let vctx;
    try {
      vctx = await loadVideoContext(ctx.bridgeCall, awemeId, {
        mode: opts.effectiveMode,
        screenshotCount: opts.screenshotCount,
        forceRefresh: force,
      });
      logger.info(`[suggest] 视频上下文已加载: "${vctx.title?.substring(0, 40) || '未知'}"`);
    } catch (e) {
      logger.error(`[suggest] 视频上下文加载失败，降级到 text-only: ${e.message}`);
    }

    const promptData = buildSuggestPrompt({
      vctx: vctx || null,
      mode: vctx?.mode || 'text-only',
      comments: toReply,
      persona,
      llmContext,
      strategyText: (strategy || '自然亲切').substring(0, 500),
    });

    logger.info(`[suggest] 多模态 prompt: system=${promptData.systemPrompt.length}chars user=${promptData.userPrompt.length}chars images=${promptData.images.length}`);
    suggestions = await client.suggestRepliesMultiModal(promptData);
  } else {
    // ── 传统路径：经 prompt-builder（prompts/suggest.md 单一真源）──
    suggestions = await client.suggestReplies(toReply, strategy, '', llmContext, persona);
  }

  // 模拟思考时间（概率 30%）
  if (!fast && suggestions.length > 0) await maybeDelay(0.3, 3000, 8000);

  await rewriteDuplicates(client, suggestions, toReply, strategy, persona);

  return suggestions;
}

/**
 * 去重护栏：reply_hash 命中过 → 让 LLM 重写一次（强制切换人格）。
 * 就地修改 suggestions 元素（reply/rewritten/_duplicate 字段）。
 */
async function rewriteDuplicates(client, suggestions, toReply, strategy, persona) {
  const dupCids = new Set();
  for (const s of suggestions) {
    if (!s.reply) continue;
    if (corpus.findByText(s.reply)) dupCids.add(s.cid);
  }
  if (dupCids.size === 0) return;

  logger.info(`[suggest] ${dupCids.size} 条命中已发过的回复，调用 LLM 重写...`);
  for (const s of suggestions) {
    if (!dupCids.has(s.cid)) continue;
    try {
      const newReply = await client.rewriteReply(
        (toReply.find(t => t.cid === s.cid) || {}).text || '',
        s.reply,
        strategy,
        '',
        persona,
      );
      if (newReply && !corpus.findByText(newReply)) {
        s.reply = newReply;
        s.rewritten = true;
      } else {
        s._duplicate = true;
      }
    } catch (e) {
      logger.debug('[suggest] rewrite failed: ' + e.message);
      s._duplicate = true;
    }
  }
}

/**
 * 风控断路器：10 分钟内 post 失败 ≥3 次 → 暂停自动发布（用 events 表窗口统计）。
 * @returns {{open: boolean, failCount: number}}
 */
function circuitBreakerStatus() {
  try {
    const { getDb } = require('../memory/db');
    const db = getDb();
    const windowStart = Date.now() - 600000;
    const failCount = db.prepare(`
      SELECT count(*) AS n FROM events
      WHERE platform = 'douyin' AND command = 'post' AND status = 'error' AND ts >= ?
    `).get(windowStart).n;
    return { open: failCount >= 3, failCount };
  } catch (e) {
    logger.debug('[suggest] 断路器查询失败: ' + e.message);
    return { open: false, failCount: 0 };
  }
}

/**
 * 发布阶段：逐条发布 auto 候选（带疲劳累加间隔 + 浏览穿插）。
 * @returns {Promise<Array>} 每条结果（posted/error/skipped 标注）
 */
async function autoPublish(ctx, awemeId, suggestions, opts) {
  const results = [];
  const autoList = suggestions.slice(0, MAX_AUTO_POSTS);
  let postedCount = 0;

  for (let i = 0; i < autoList.length; i++) {
    const s = autoList[i];
    if (!opts.auto || !s.reply || s._duplicate) {
      results.push(s);
      continue;
    }

    // 二次护栏：仍然命中已发过，跳过
    if (corpus.findByText(s.reply)) {
      results.push({ ...s, posted: false, error: '命中已发回复，跳过', skipped: true });
      logger.warn(`✗ 跳过（已发过）: ${s.reply.slice(0, 30)}...`);
      continue;
    }

    // 非首条发布前等待间隔（基础 = 写操作窗口采样；疲劳累加 + 抖动）
    if (postedCount > 0) {
      let nextDelay = opts.basePostIntervalMs;
      if (!opts.fast) {
        const fatigue = 1 + (Math.random() * 0.15 * postedCount);
        nextDelay = jitter(opts.basePostIntervalMs * fatigue, 0.20);
      }
      logger.info(`⏳ 等待 ${Math.round(nextDelay / 1000)}s 后发布下一条... (${postedCount + 1}/${autoList.length})`);
      await new Promise(r => setTimeout(r, nextDelay));
    }

    try {
      const postResult = await ctx.cmdPost([s.aweme_id || awemeId, s.reply, '--reply-to', String(s.cid), '--no-throttle']);
      results.push({ ...s, posted: true, post_cid: postResult.cid });
      postedCount++;
      logger.info(`✓ 已发布 ${postedCount}/${autoList.length}: ${s.reply.slice(0, 30)}...`);
    } catch (e) {
      results.push({ ...s, posted: false, error: e.message });
      logger.warn(`✗ 发布失败: ${e.message}`);
    }
  }

  return results;
}

/**
 * LLM 回复建议入口
 * @param {object} ctx - { bridge, audit, config, cmdAnalyze, cmdPost, cmdSearch, cmdLike }
 * @param {string[]} args - [aweme_id, --auto, --min-priority N, --fast, --force]
 */
async function cmdSuggest(ctx, args) {
  const opts = parseSuggestArgs(args);
  const { awemeId, auto, force, fast, minPriority } = opts;

  const multimodal = ctx.config.multimodal || {};
  opts.effectiveMode = args.includes('--mode') ? opts.mode : (multimodal.mode || 'text-only');

  ctx.audit.startOperation('suggest', {
    aweme_id: awemeId, auto, force, fast, min_priority: minPriority,
    post_interval: Math.round(opts.basePostIntervalMs),
  });

  // ── 生成阶段（失败即整单失败）──
  let suggestions;
  try {
    suggestions = await collectSuggestions(ctx, opts);
  } catch (e) {
    ctx.audit.endOperation('error', {}, null, e.message);
    throw e;
  }
  if (!suggestions || suggestions.length === 0) {
    ctx.audit.endOperation('success', { suggested: 0 });
    return [];
  }

  // ── 自动发布：先查断路器 ──
  if (auto) {
    const cb = circuitBreakerStatus();
    if (cb.open) {
      logger.error(`[suggest] ⚠️ 风控断路器触发：10 分钟内 post 失败 ${cb.failCount} 次，暂停自动发布。请检查后手动重试。`);
      const skipped = suggestions.map(s => ({ ...s, skipped_circuit_breaker: true }));
      ctx.audit.endOperation('success', {
        suggested: suggestions.length, posted: 0, circuit_breaker: `post_fail_${cb.failCount}`,
      }, { result: skipped });
      return skipped;
    }
  }

  // ── 发布阶段 ──
  const results = await autoPublish(ctx, awemeId, suggestions, opts);

  ctx.audit.endOperation('success', {
    suggested: results.length,
    posted: auto ? results.filter(r => r.posted).length : 0,
    rewritten: results.filter(r => r.rewritten).length,
    skipped_dup: results.filter(r => r.skipped).length,
  }, { result: results });
  return results;
}

module.exports = cmdSuggest;
