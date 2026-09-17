// lib/reply-engine/prompt-builder.js — 多模态 Prompt 组装器
//
// 参考 xiaohongshu-cli 的 prompt-builder.js 设计，适配抖音视频场景。
// 职责：
// 1. 从 prompts/*.md 加载模板（partial-*.md 为被引用的策略片段，不单独成模板）
// 2. 替换 {{PLACEHOLDER}} 为视频上下文、评论数据等
// 3. 管理图片/截图注入信息（实际图片由 LLM complete() 的 opts.images 传递）
// 4. 构建视频文本块、历史上下文块

const fs = require('fs');
const path = require('path');

const { sanitizeComment } = require('../shared/sanitize');
const { formatVideoBlock } = require('./video-context');

// 模板目录
const PROMPTS_DIR = path.join(__dirname, '..', '..', 'prompts');

// ── 模板缓存 ──

let _templateCache = {};
let _partialCache = {};

/**
 * 加载模板文件，解析为 { system, user } 两部分。
 * 文件格式：=== SYSTEM === ... === USER === ...
 */
function loadTemplate(name) {
  if (_templateCache[name]) return _templateCache[name];
  try {
    const raw = fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf8');
    const sysMatch = raw.match(/=== SYSTEM ===\n([\s\S]*?)(?=\n=== USER ===|$)/);
    const userMatch = raw.match(/=== USER ===\n([\s\S]*)$/);
    const tpl = {
      system: sysMatch ? sysMatch[1].trim() : '',
      user: userMatch ? userMatch[1].trim() : raw.trim(),
    };
    _templateCache[name] = tpl;
    return tpl;
  } catch (_) { return null; }
}

/**
 * 加载 partial 片段（prompts/partial-*.md，无 SYSTEM/USER 分隔符的原始文本）。
 * partial 是跨模板共享的策略块，作为内容单一真源被 render() 后嵌入各模板。
 */
function loadPartial(name) {
  if (_partialCache[name]) return _partialCache[name];
  try {
    const raw = fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf8').trim();
    _partialCache[name] = raw;
    return raw;
  } catch (_) { return null; }
}

/** 清空模板缓存 */
function clearTemplateCache() {
  _templateCache = {};
  _partialCache = {};
}

// ── 渲染器 ──

/**
 * 替换模板中的 {{PLACEHOLDER}}。
 * 未提供的占位符保留原样（便于调试对照模板）。
 */
function render(template, vars = {}) {
  if (!template) return null;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return key in vars ? String(vars[key] ?? '') : `{{${key}}}`;
  });
}

// ── 图片提示行 ──

/**
 * 构建图片提示行 — 告知 LLM 已收到图片。
 * @param {object} vctx
 * @param {string} mode - 'screenshots' | 'video' | 'text-only'
 * @returns {string}
 */
function buildImageHint(vctx, mode) {
  if (mode === 'screenshots' && vctx?.screenshotB64?.length > 0) {
    return `\n⚠️ 你已收到视频截图（${vctx.screenshotB64.length} 帧）。请观察截图中的画面内容（场景、人物、产品、动作、文字等），在回复中体现你"看过视频"。`;
  }
  if (mode === 'video' && vctx?.videoUrl) {
    return `\n⚠️ 你已收到视频内容。请基于视频画面和音频内容生成贴合实际的回复。`;
  }
  return '';
}

// ── 历史上下文块 ──

/**
 * 构建历史上下文块（语料 few-shot + 失败模式 + 规避清单）。
 * @param {object} llmContext - { corpus, failures, avoid, repoFacts }
 * @returns {string}
 */
function buildScopedBlock(llmContext) {
  if (!llmContext) return '';

  // 上限与 lib/commands/suggest.js 注入量对齐（corpus 20 / failures 10 / avoid 30）
  const parts = [];
  const corpus = Array.isArray(llmContext.corpus) ? llmContext.corpus.slice(0, 20) : [];
  const failures = Array.isArray(llmContext.failures) ? llmContext.failures.slice(0, 10) : [];
  const avoidList = Array.isArray(llmContext.avoid) ? llmContext.avoid.slice(0, 30) : [];

  if (corpus.length > 0) {
    const lines = corpus.map((c, i) => {
      const src = sanitizeComment(c.srcText || '', 80);
      const rep = sanitizeComment(c.replyText || '', 80);
      return `${i + 1}. ${src ? `用户：「${src}」 → ` : ''}我们回：「${rep}」`;
    });
    parts.push(`## 历史成功回复（few-shot，参考语气和切入角度，不要原句复制）\n${lines.join('\n')}`);
  }

  if (failures.length > 0) {
    const lines = failures.map((f, i) => {
      const ex = sanitizeComment(f.exampleText || '', 60);
      const mit = f.mitigation ? `（缓解：${f.mitigation}）` : '';
      return `${i + 1}. ${f.signature} × ${f.hitCount}${mit}${ex ? ` 例: 「${ex}」` : ''}`;
    });
    parts.push(`## 历史失败模式（避免触发，hit_count=触发次数）\n${lines.join('\n')}`);
  }

  if (avoidList.length > 0) {
    parts.push(`## 严禁复用（这些原文已发过，必须重新组织措辞）\n${
      avoidList.map((t, i) => `${i + 1}. ${sanitizeComment(t, 80)}`).join('\n')
    }`);
  }

  const repoFacts = llmContext.repoFacts;
  if (repoFacts) {
    parts.push(
      `## 推广仓库真实事实（仅当评论与该仓库相关时使用；禁止编造未列出的 star 数/功能名/版本号）\n` +
      `- 仓库：${repoFacts.full_name}\n` +
      `- 描述：${repoFacts.description || '无'}\n` +
      `- star 数：${repoFacts.stars}\n` +
      `- 主语言：${repoFacts.primary_language || '未知'}\n` +
      `- 最近 push：${repoFacts.pushed_at || '未知'}` +
      (repoFacts.latest_release ? `\n- 最近 release：${repoFacts.latest_release.tag}（${repoFacts.latest_release.published_at}）` : '') +
      `\n若提及具体数字/功能，必须来自上方；无相关事实则不写具体数字。`
    );
  }

  return parts.join('\n\n');
}

// ── 共享策略块（prompts/partial-reply-strategy.md 单一真源）──

/**
 * 加载并渲染跨模板共享的 A-F 回复策略块。
 * @param {number} batchCount - 本批次评论数（用于风格多样化指令）
 * @returns {string}
 */
function buildStrategyBlock(batchCount) {
  const raw = loadPartial('partial-reply-strategy.md');
  if (!raw) return '';
  return render(raw, { BATCH_COUNT: String(batchCount), COUNT: String(batchCount) });
}

// ── 生成 Suggest 回复 Prompt ──

/**
 * 构建 suggest 命令的完整 prompt（可带视频上下文）。
 *
 * @param {object} opts
 * @param {object} opts.vctx         - VideoContext（来自 video-context.js）
 * @param {string} opts.mode         - 'text-only' | 'screenshots' | 'video'
 * @param {Array}  opts.comments     - [{ cid, text, userTags? }]
 * @param {object} opts.persona      - 人格对象
 * @param {object} opts.llmContext   - { corpus, failures, avoid, repoFacts }
 * @param {string} opts.strategyText - 策略文本
 * @returns {{ systemPrompt: string, userPrompt: string, images: string[] }}
 */
function buildSuggestPrompt(opts) {
  const {
    vctx = null, mode = 'text-only',
    comments = [], persona = null,
    llmContext = {}, strategyText = '',
  } = opts;

  const { buildSystemPrompt, buildUserPrefix } = require('../personas');
  const personaPrompt = persona
    ? buildSystemPrompt(persona, strategyText)
    : `你是抖音视频作者。策略：${strategyText || '自然口语化，有观点，不套话'}`;
  const personaExamples = persona ? buildUserPrefix(persona) : '';
  const personaHint = persona ? `\n风格：${persona.name}` : '';

  const videoBlock = formatVideoBlock(vctx);
  const imageHint = buildImageHint(vctx, mode);
  const scopedBlock = buildScopedBlock(llmContext);

  // 格式化评论列表
  const commentList = comments.map(c => ({
    cid: c.cid,
    user_text: sanitizeComment(c.text || '', 300),
    ...(Array.isArray(c.userTags) && c.userTags.length ? { user_tags: c.userTags.slice(0, 5) } : {}),
  }));

  // 加载模板
  const tpl = loadTemplate('suggest.md');
  const strategyBlock = buildStrategyBlock(commentList.length);

  const vars = {
    PERSONA_PROMPT: personaPrompt,
    VIDEO_BLOCK: videoBlock,
    IMAGE_HINT: imageHint,
    SCOPED_BLOCK: scopedBlock,
    STRATEGY_BLOCK: buildStrategyBlock(commentList.length),
    COMMENT_LIST_JSON: JSON.stringify(commentList),
    PERSONA_EXAMPLES: personaExamples,
    PERSONA_HINT: personaHint,
    BATCH_COUNT: String(commentList.length),
    STRATEGY: strategyText || '自然口语化',
  };

  if (tpl) {
    return {
      systemPrompt: render(tpl.system, vars),
      userPrompt: render(tpl.user, vars),
      images: (mode === 'screenshots' && vctx?.screenshotB64) ? vctx.screenshotB64 : [],
    };
  }

  // fallback：无模板时的内建默认
  return {
    systemPrompt: personaPrompt,
    userPrompt: `为以下抖音评论生成回复建议。

## 视频信息
${videoBlock}${imageHint}

策略风格：${strategyText || '自然亲切'}

${scopedBlock}

${strategyBlock}

## 回复要求
- 每条回复必须针对对应评论的 user_text 原文作答
- 基于视频内容回答（视频没提到的信息不要编）
- 口语化，像博主在回复粉丝
- 不要原句复制历史成功回复；不要触发失败模式

${personaExamples}
## 需回复的评论
${JSON.stringify(commentList)}

严格返回 JSON 数组：[{"cid":"...","reply":"..."}]，不要其他文字。`,
    images: (mode === 'screenshots' && vctx?.screenshotB64) ? vctx.screenshotB64 : [],
  };
}

// ── 生成 Analyze 分析 Prompt ──

/**
 * 构建 analyze 命令的分析 prompt（可带视频上下文）。
 *
 * @param {object} opts
 * @param {object} opts.vctx      - VideoContext
 * @param {string} opts.mode      - 'text-only' | 'screenshots' | 'video'
 * @param {Array}  opts.comments  - [{ cid, text }]
 * @param {string} opts.strategy  - 策略风格
 * @returns {{ systemPrompt: string, userPrompt: string, images: string[] }}
 */
function buildAnalyzePrompt(opts) {
  const { vctx = null, mode = 'text-only', comments = [], strategy = '' } = opts;
  const strategyText = typeof strategy === 'string' ? strategy : (strategy?.style || '自然亲切');

  const videoBlock = formatVideoBlock(vctx);
  const imageHint = buildImageHint(vctx, mode);

  const sanitized = comments.map(c => ({
    cid: c.cid,
    text: sanitizeComment(c.text || '', 200),
  }));

  const tpl = loadTemplate('analyze.md');

  const vars = {
    PERSONA_PROMPT: `你是一个专业的抖音评论分析师，只输出 JSON。策略风格：${strategyText}`,
    VIDEO_BLOCK: videoBlock,
    IMAGE_HINT: imageHint,
    COMMENT_LIST_JSON: JSON.stringify(sanitized),
    STRATEGY: strategyText,
  };

  if (tpl) {
    return {
      systemPrompt: render(tpl.system, vars),
      userPrompt: render(tpl.user, vars),
      images: (mode === 'screenshots' && vctx?.screenshotB64) ? vctx.screenshotB64 : [],
    };
  }

  // fallback
  const prompt = `你是抖音评论分析师。根据视频上下文分析每条评论。

策略风格：${strategyText}

视频信息：
${videoBlock}${imageHint}

返回 JSON 数组。对每条评论：
- cid: 评论ID（原样）
- sentiment: "positive"|"negative"|"neutral"
- category: "question"|"praise"|"complaint"|"spam"|"other"
- priority: 1-5（5=必须回复）
- summary: 一句话中文摘要（结合视频内容）

评论列表：${JSON.stringify(sanitized)}

严格返回 JSON 数组，不要其他文字。`;

  return {
    systemPrompt: '你是一个专业的抖音评论分析师，只输出 JSON。',
    userPrompt: prompt,
    images: (mode === 'screenshots' && vctx?.screenshotB64) ? vctx.screenshotB64 : [],
  };
}

// ── 生成顶级评论 Prompt（以普通用户身份）──

/**
 * 构建 generateComment 的 prompt（以普通用户身份对视频发表评论）。
 *
 * @param {object} opts
 * @param {object} opts.vctx         - VideoContext
 * @param {string} opts.mode         - 'text-only' | 'screenshots' | 'video'
 * @param {object} opts.persona      - 人格对象
 * @param {number} opts.count        - 生成几条候选
 * @param {string} opts.strategyText - 策略文本
 * @returns {{ systemPrompt: string, userPrompt: string, images: string[] }}
 */
function buildGenerateCommentPrompt(opts) {
  const {
    vctx = null, mode = 'text-only',
    persona = null, count = 1, strategyText = '',
  } = opts;

  const { buildSystemPrompt, buildUserPrefix } = require('../personas');
  const personaPrompt = persona
    ? buildSystemPrompt(persona, strategyText)
    : `你是一个刷抖音的普通用户。策略：${strategyText || '自然口语化，有观点，不套话'}`;
  const personaExamples = persona ? buildUserPrefix(persona) : '';

  const videoBlock = formatVideoBlock(vctx);
  const imageHint = buildImageHint(vctx, mode);
  const countHint = count > 1
    ? `请生成 ${count} 条不同的评论，每条风格/角度不同，长度 5-50 字。返回 JSON 字符串数组：["评论1", "评论2", ...]`
    : '生成 1 条评论，长度 5-50 字。返回 JSON 字符串数组：["评论内容"]。不要换行、不要分段、不要长篇。';

  const tpl = loadTemplate('comment.md');

  const vars = {
    PERSONA_PROMPT: personaPrompt,
    VIDEO_BLOCK: videoBlock,
    IMAGE_HINT: imageHint,
    PERSONA_EXAMPLES: personaExamples,
    COUNT_HINT: countHint,
    COUNT: String(count),
    STRATEGY: strategyText || '自然口语化',
  };

  if (tpl) {
    return {
      systemPrompt: render(tpl.system, vars),
      userPrompt: render(tpl.user, vars),
      images: (mode === 'screenshots' && vctx?.screenshotB64) ? vctx.screenshotB64 : [],
    };
  }

  // fallback
  return {
    systemPrompt: personaPrompt,
    userPrompt: `你正在浏览一个抖音视频。请以普通用户的身份发表评论。

## 视频内容
${videoBlock}
${imageHint}

## 评论要求
- 像真实用户随手评论（不是"回复"，是"评论"）
- 可以表达观点、提问题、分享经验、玩梗、简短感叹
- 口语化，允许不完整句子，允许碎片化表达
- 长度 5-50 字为主，偶尔可以 3-5 字的极简评论
- 避免 AI 特征词

${personaExamples}
${countHint}`,
    images: (mode === 'screenshots' && vctx?.screenshotB64) ? vctx.screenshotB64 : [],
  };
}

// ── 生成单条回复 Prompt（以博主身份）──

/**
 * 构建 generateReply 的 prompt（以博主身份回复单条评论）。
 *
 * @param {object} opts
 * @param {object} opts.vctx          - VideoContext
 * @param {string} opts.mode          - 'text-only' | 'screenshots' | 'video'
 * @param {object} opts.comment       - { cid, text, userTags?, parentComment?, uid? }
 * @param {object} opts.persona       - 人格对象
 * @param {object} opts.scopedCtx     - { corpus, avoid, failures, userProfile }
 * @param {string} opts.strategyText  - 策略文本
 * @returns {{ systemPrompt: string, userPrompt: string, images: string[] }}
 */
function buildGenerateReplyPrompt(opts) {
  const {
    vctx = null, mode = 'text-only',
    comment = {}, persona = null,
    scopedCtx = {}, strategyText = '',
  } = opts;

  const { buildSystemPrompt, buildUserPrefix } = require('../personas');
  const personaPrompt = persona
    ? buildSystemPrompt(persona, strategyText)
    : `你是抖音视频作者。策略：${strategyText || '自然口语化，有观点，不套话'}`;
  const personaExamples = persona ? buildUserPrefix(persona) : '';
  const personaHint = persona ? `\n风格：${persona.name}` : '';

  const videoBlock = formatVideoBlock(vctx);
  const imageHint = buildImageHint(vctx, mode);
  const scopedBlock = buildScopedBlock(scopedCtx);

  const tagLine = comment.userTags && comment.userTags.length
    ? `\n用户标签：${comment.userTags.join('、')}`
    : '';

  // 用户画像（回头客识别）
  const up = scopedCtx?.userProfile;
  const userProfileLine = up && (up.commentCount > 1 || up.tier)
    ? `\n用户画像：${up.nickname ? `昵称"${up.nickname}"，` : ''}历史评论${up.commentCount}次${up.tier ? `，等级${up.tier}` : ''}${up.tags?.length ? `，标签${up.tags.join('、')}` : ''}`
    : '';

  // 线程上下文（嵌套回复）
  const threadCtx = comment.parentComment
    ? `\n## 对话上下文\n被回复的评论：「${sanitizeComment(comment.parentComment, 150)}」`
    : '';

  const tpl = loadTemplate('reply.md');

  const vars = {
    PERSONA_PROMPT: personaPrompt,
    VIDEO_BLOCK: videoBlock,
    IMAGE_HINT: imageHint,
    SCOPED_BLOCK: scopedBlock,
    COMMENT_TEXT: sanitizeComment(comment.text || '', 300),
    COMMENT_TAGS: tagLine,
    USER_PROFILE: userProfileLine,
    THREAD_CONTEXT: threadCtx,
    PERSONA_HINT: personaHint,
    PERSONA_EXAMPLES: personaExamples,
    PERSONA_NAME: persona?.name || '',
    STRATEGY: strategyText || '自然口语化',
  };

  if (tpl) {
    return {
      systemPrompt: render(tpl.system, vars),
      userPrompt: render(tpl.user, vars),
      images: (mode === 'screenshots' && vctx?.screenshotB64) ? vctx.screenshotB64 : [],
    };
  }

  // fallback
  return {
    systemPrompt: personaPrompt,
    userPrompt: `你是抖音视频作者，需要回复你视频下的一条评论。

## 你的视频
${videoBlock}
${imageHint}

${scopedBlock}

## 用户评论（必须基于原文回复）
「${sanitizeComment(comment.text || '', 300)}」${tagLine}${userProfileLine}${threadCtx}

## 回复要求
- 针对评论原文的具体问题/细节/措辞作答
- 基于视频内容回答（视频没提到的信息不要编）
- 若评论提问，必须正面回答；不得顾左右而言他
- 口语化，像博主在回复粉丝，不是客服
- 宁可简短且针对，不要长而空洞${personaHint}

${personaExamples}
只返回回复文本，不要引号、不要前缀（如"回复："）、不要任何解释。`,
    images: (mode === 'screenshots' && vctx?.screenshotB64) ? vctx.screenshotB64 : [],
  };
}

// ── 批量生成回复 Prompt ──

/**
 * 构建 generateReplies 的 prompt（批量回复多条评论）。
 *
 * @param {object} opts
 * @param {object} opts.vctx         - VideoContext
 * @param {string} opts.mode         - 'text-only' | 'screenshots' | 'video'
 * @param {Array}  opts.comments     - [{ cid, text, userTags?, parentComment? }]
 * @param {object} opts.persona      - 人格对象
 * @param {object} opts.scopedCtx    - { corpus, avoid, failures }
 * @param {string} opts.strategyText - 策略文本
 * @returns {{ systemPrompt: string, userPrompt: string, images: string[] }}
 */
function buildGenerateRepliesPrompt(opts) {
  const {
    vctx = null, mode = 'text-only',
    comments = [], persona = null,
    scopedCtx = {}, strategyText = '',
  } = opts;

  const { buildSystemPrompt, buildUserPrefix } = require('../personas');
  const personaPrompt = persona
    ? buildSystemPrompt(persona, strategyText)
    : `你是抖音视频作者。策略：${strategyText || '自然口语化，有观点，不套话'}`;
  const personaExamples = persona ? buildUserPrefix(persona) : '';

  const videoBlock = formatVideoBlock(vctx);
  const imageHint = buildImageHint(vctx, mode);
  const scopedBlock = buildScopedBlock(scopedCtx);

  // 格式化评论列表
  const commentList = comments.map(c => ({
    cid: c.cid,
    user_text: sanitizeComment(c.text || '', 300),
    ...(Array.isArray(c.userTags) && c.userTags.length ? { user_tags: c.userTags.slice(0, 5) } : {}),
    ...(c.parentComment ? { parent_comment: sanitizeComment(c.parentComment, 100) } : {}),
  }));

  // 共享策略块（prompts/partial-reply-strategy.md 单一真源）
  const strategyBlock = buildStrategyBlock(commentList.length);

  // 尝试加载模板
  const tpl = loadTemplate('replies-batch.md');

  const vars = {
    PERSONA_PROMPT: personaPrompt,
    VIDEO_BLOCK: videoBlock,
    IMAGE_HINT: imageHint,
    SCOPED_BLOCK: scopedBlock,
    STRATEGY_BLOCK: strategyBlock,
    COMMENT_LIST_JSON: JSON.stringify(commentList),
    PERSONA_EXAMPLES: personaExamples,
    STRATEGY: strategyText || '自然口语化',
    COUNT: String(commentList.length),
    BATCH_COUNT: String(commentList.length),
  };

  if (tpl) {
    return {
      systemPrompt: render(tpl.system, vars),
      userPrompt: render(tpl.user, vars),
      images: (mode === 'screenshots' && vctx?.screenshotB64) ? vctx.screenshotB64 : [],
    };
  }

  // fallback
  return {
    systemPrompt: personaPrompt,
    userPrompt: `你是抖音视频作者，需要回复你视频下的多条评论。

## 你的视频
${videoBlock}
${imageHint}

${scopedBlock}

${strategyBlock}

${personaExamples}
## 需回复的评论
${JSON.stringify(commentList)}

严格返回 JSON 数组：[{"cid": "...", "reply": "..."}]，不要其他文字。`,
    images: (mode === 'screenshots' && vctx?.screenshotB64) ? vctx.screenshotB64 : [],
  };
}

module.exports = {
  loadTemplate, loadPartial, render, clearTemplateCache,
  buildImageHint, buildScopedBlock, buildStrategyBlock,
  buildSuggestPrompt, buildAnalyzePrompt,
  buildGenerateCommentPrompt, buildGenerateReplyPrompt, buildGenerateRepliesPrompt,
};
