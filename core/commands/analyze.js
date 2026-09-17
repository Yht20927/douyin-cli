// lib/commands/analyze.js — LLM 评论分析（情感/分类/优先级）

const fs = require('fs');
const path = require('path');
const { getFlag } = require('./helpers');
const commentsRepo = require('../memory/comments');

/**
 * LLM 分析评论
 * @param {object} ctx - { bridge, audit, config, cmdGet }
 * @param {string[]} args - [aweme_id]
 */
async function cmdAnalyze(ctx, args) {
  const awemeId = args[0];
  if (!awemeId) throw new Error('用法: node cli.js analyze <aweme_id> [--force] [--mode text-only|screenshots|video] [--screenshots N]');
  const force = args.includes('--force');
  const mode = getFlag(args, '--mode', 'text-only');
  const screenshotCount = parseInt(getFlag(args, '--screenshots', '4'), 10);
  const multimodal = ctx.config.multimodal || {};
  const effectiveMode = args.includes('--mode') ? mode : (multimodal.mode || 'text-only');

  const llm = require('../llm');
  ctx.audit.startOperation('analyze', { aweme_id: awemeId, force });

  // 先获取评论
  console.error('正在获取评论...');
  let commentsData = await ctx.cmdGet([awemeId, '--all', '--depth', '0']);

  // cid 一生一次：默认跳过已回复评论（--force 覆盖），避免重复分析浪费 token
  if (!force) {
    const before = commentsData.length;
    commentsData = commentsData.filter(c => !commentsRepo.get(String(c.cid))?.replied);
    if (process.env.DOUYIN_DEBUG) console.error(`[analyze] 过滤已回复: ${before} → ${commentsData.length}`);
  }

  if (!commentsData || commentsData.length === 0) {
    ctx.audit.endOperation('success', { analyzed: 0 }, { result: [] });
    return [];
  }

  console.error(`正在分析 ${commentsData.length} 条评论...`);
  const client = new llm.LLMClient(ctx.config.llm || {});

  let results;
  if (effectiveMode !== 'text-only') {
    console.error(`[analyze] 多模态模式: ${effectiveMode}`);
    const { loadVideoContext } = require('../reply-engine/video-context');
    const { buildAnalyzePrompt } = require('../reply-engine/prompt-builder');

    let vctx;
    try {
      vctx = await loadVideoContext(ctx.bridgeCall, awemeId, {
        mode: effectiveMode, screenshotCount, forceRefresh: force,
      });
      console.error(`[analyze] 视频上下文已加载`);
    } catch (e) {
      console.error(`[analyze] 视频上下文加载失败，降级到 text-only: ${e.message}`);
    }

    const promptData = buildAnalyzePrompt({
      vctx: vctx || null,
      mode: vctx?.mode || 'text-only',
      comments: commentsData,
      strategy: '自然亲切',
    });
    results = await client.analyzeCommentsMultiModal(promptData);
  } else {
    results = await client.analyzeComments(commentsData);
  }

  if (!results || results.length === 0) {
    console.error('警告: LLM 未返回分析结果');
  }

  // 把原始评论 text 合并到分析结果中（供 suggest 使用）
  const textByCid = new Map(commentsData.map(c => [String(c.cid), c.text]));
  for (const r of results) {
    if (r && r.cid) r.text = textByCid.get(String(r.cid)) || r.summary || '';
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const fp = path.join(process.cwd(), 'logs', 'results', `analyze-${awemeId}-${ts}.json`);
  fs.writeFileSync(fp, JSON.stringify(results, null, 2));

  // ── 实体表落库：把 sentiment / priority 写回 comments 表（旁路写）──
  try {
    let written = 0;
    for (const r of results) {
      if (r && r.cid) {
        if (commentsRepo.setAnalysis(r.cid, { sentiment: r.sentiment, priority: r.priority })) {
          written++;
        }
      }
    }
    if (process.env.DOUYIN_DEBUG) console.error(`[analyze] persisted ${written}/${results.length} analyses`);
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[cmdAnalyze.persist] failed:', e.message);
  }

  ctx.audit.endOperation('success', { analyzed: results.length }, {
    result: results,
    resultFile: 'logs/results/' + path.basename(fp),
  });
  return results;
}

module.exports = cmdAnalyze;
