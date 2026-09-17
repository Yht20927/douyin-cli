// core/policy/filters.js — 评论筛选决策树与回复文本校验
//
// 来源
// ----
// 改造前这套判定逻辑只存在于 评论区运营.md 的散文里（L32-55），代码零实现：
//
//   读入 (text, cid, uid):
//     1. cid 已回复过                        → 跳过
//     2. 纯表情 / 贴纸 / 单字符              → 表情回复路线（只回表情，不写字）
//     3. 长度 < 4 且无明确语义               → 跳过「无意义水评」
//     4. 命中优先信号（提问 / 高质量反馈 / 负面情绪）→ 文字回复路线
//     5. 其余                                → 跳过「不匹配优先回复条件」
//
// 本模块把它变成可测的纯函数。词表与阈值全部来自 config.filters，
// 这样界面上的表单和这里的判定用的是同一份数据，不会漂移。

const config = require('../config');

// ═══════════════════════════════════════════════════════════
// 文本工具
// ═══════════════════════════════════════════════════════════

/**
 * 表情与符号的匹配模式。
 *
 * 覆盖几类：
 *   - Unicode 表情区（颜文字/象形/交通/补充符号等）
 *   - 杂项符号与装饰符号（❤ ☀ ✨ 等）
 *   - 变体选择符与零宽连接符（组合表情用）
 *   - 区域指示符（国旗）
 *   - **抖音的 [微笑] [赞] 这类方括号表情** —— 它们不是 Unicode 字符，
 *     在接口里就是方括号文本，只看 Unicode 会把它们当成普通文字
 */
const EMOJI_RE = new RegExp(
  '[' +
  '\\u{1F300}-\\u{1FAFF}' +   // 象形/颜文字/补充符号
  '\\u{1F000}-\\u{1F2FF}' +   // 麻将/扑克/附注符号
  '\\u{2600}-\\u{27BF}' +     // 杂项符号 + 装饰符号
  '\\u{2B00}-\\u{2BFF}' +     // 杂项符号与箭头
  '\\u{1F1E6}-\\u{1F1FF}' +   // 区域指示符（国旗）
  '\\u{FE0F}\\u{200D}\\u{20E3}' +
  ']',
  'gu'
);

/** 抖音方括号表情：[微笑] [赞] [比心] … */
const BRACKET_EMOJI_RE = /\[[^\[\]\s]{1,6}\]/g;

const EMOJI_GLOBAL = new RegExp(EMOJI_RE.source, 'gu');

/**
 * 去掉表情、方括号表情与所有空白/标点后还剩什么。
 * 剩空字符串 → 这条评论除了表情什么都没有。
 */
function stripEmojiAndPunctuation(text) {
  return String(text || '')
    .replace(BRACKET_EMOJI_RE, '')
    .replace(EMOJI_GLOBAL, '')
    .replace(/[\s　]/g, '')
    // 中英文标点与常见符号
    .replace(/[.,!?;:'"`~^*_\-+=<>/\\|()[\]{}@#$%&，。！？；：、""''《》【】（）…—～·]/g, '');
}

/** 评论是否「只有表情」（可含空格与标点） */
function isEmojiOnly(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  // 必须真的含有表情，否则空字符串 / 纯标点会被误判
  const hasEmoji = BRACKET_EMOJI_RE.test(raw) || EMOJI_RE.test(raw);
  BRACKET_EMOJI_RE.lastIndex = 0;
  EMOJI_RE.lastIndex = 0;
  if (!hasEmoji) return false;
  return stripEmojiAndPunctuation(raw).length === 0;
}

/** 数一条文本里有多少个表情 */
function countEmoji(text) {
  const s = String(text || '');
  const brackets = (s.match(BRACKET_EMOJI_RE) || []).length;
  BRACKET_EMOJI_RE.lastIndex = 0;
  const plain = (s.replace(BRACKET_EMOJI_RE, '').match(EMOJI_GLOBAL) || []).length;
  EMOJI_GLOBAL.lastIndex = 0;
  return brackets + plain;
}

/** 可见字数（不含空白；中文按字、英文按词义上的字符计） */
function textLength(text) {
  return String(text || '').replace(/\s/g, '').length;
}

/** 文本里是否出现任一关键词 */
function containsAny(text, words) {
  const s = String(text || '');
  return (words || []).filter(w => w && s.includes(w));
}

// ═══════════════════════════════════════════════════════════
// 表情回复
// ═══════════════════════════════════════════════════════════

/**
 * 为纯表情评论挑回复表情（评论区运营.md 的映射表）。
 * 判断不出类型时用兜底池。
 *
 * @param {string} text
 * @param {object} [filters]
 * @returns {string[]} 候选表情（调用方随机取一个）
 */
function pickEmojiReply(text, filters) {
  const f = filters || config.get('filters');
  const eo = f.emojiOnly || {};
  const src = String(text || '');

  for (const rule of (eo.map || [])) {
    if ((rule.match || []).some(m => src.includes(m))) {
      return rule.reply && rule.reply.length ? rule.reply : (eo.pool || []);
    }
  }
  return eo.pool || [];
}

// ═══════════════════════════════════════════════════════════
// 决策树
// ═══════════════════════════════════════════════════════════

/**
 * 判定一条评论该怎么处理。
 *
 * @param {object} comment - { cid, text, uid, is_sticker? }
 * @param {object} [opts]
 * @param {object}   [opts.filters]    - 覆盖 config.filters（测试用）
 * @param {Function} [opts.isReplied]  - (cid) => boolean，缺省不做已回复判定
 * @param {Function} [opts.userTier]   - (uid) => 'vip'|'normal'|'blacklist'|'spam'|null
 * @param {string}   [opts.myUid]      - 我自己的 uid（用于排掉自己发的评论）
 * @returns {{action:'reply'|'emoji_reply'|'skip', reason:string, signals:string[], emojiCandidates?:string[]}}
 */
function classify(comment, opts = {}) {
  const f = opts.filters || config.get('filters');
  const isReplied = opts.isReplied || (() => false);
  const userTier = opts.userTier || (() => null);

  const cid = comment && comment.cid;
  const text = (comment && comment.text) || '';
  const uid = comment && comment.uid;

  // ── 0. 自己发的评论（优先级最高）──
  // 我以作者身份发出的回复也会作为评论被拉回来；不排掉就会出现
  // "自己的回复被当成交互对象"这种明显的错误。
  if (f.skipOwnComments && opts.myUid && uid && String(uid) === String(opts.myUid)) {
    return { action: 'skip', reason: '这是我自己发的评论', signals: [] };
  }

  // ── 1. 已回复过（一生一次，跨日跨轮）──
  if (f.skipReplied && isReplied(cid)) {
    return { action: 'skip', reason: '已回复过此评论', signals: [] };
  }

  // ── 用户分级：黑名单/垃圾用户直接跳过 ──
  const tier = uid ? userTier(uid) : null;
  if (tier === 'blacklist' || tier === 'spam') {
    return { action: 'skip', reason: `用户被标记为 ${tier}`, signals: [] };
  }

  // ── 2. 贴纸评论：平台标记最可靠，优先于文本判断 ──
  if (f.skipSticker && comment && comment.is_sticker) {
    return { action: 'skip', reason: '贴纸评论', signals: [] };
  }

  // ── 3. 纯表情 → 表情回复路线（只回表情，不写字）──
  if (isEmojiOnly(text)) {
    if (!f.emojiOnly || f.emojiOnly.enabled === false) {
      return { action: 'skip', reason: '纯表情评论，且未启用表情回复', signals: [] };
    }
    return {
      action: 'emoji_reply',
      reason: '纯表情评论 → 用表情回应',
      signals: ['emoji_only'],
      emojiCandidates: pickEmojiReply(text, f),
    };
  }

  const len = textLength(text);

  // ── 4. 水评：短且无语义 ──
  if (f.skipWater && len <= f.waterCommentMaxLen) {
    const hit = containsAny(text, f.waterWords);
    // 短但有明确语义（例如提问）不算水评，交给下一步判定
    const hasSignal = collectSignals(text, len, f).length > 0;
    if (hit.length || !hasSignal) {
      return {
        action: 'skip',
        reason: hit.length ? `无意义水评（命中「${hit[0]}」）` : '过短且无明确语义',
        signals: [],
      };
    }
  }

  // ── 5. 优先回复信号 ──
  const signals = collectSignals(text, len, f);
  if (signals.length > 0) {
    return { action: 'reply', reason: `命中优先信号：${signals.join('、')}`, signals };
  }

  // ── 6. 其余：不匹配 ──
  return { action: 'skip', reason: '不匹配优先回复条件', signals: [] };
}

/**
 * 收集一条评论命中的优先回复信号。
 * @returns {string[]}
 */
function collectSignals(text, len, f) {
  const signals = [];
  const ps = f.prioritySignals || {};

  if (containsAny(text, ps.askForHelp).length) signals.push('提问求助');
  if (len > f.qualityFeedbackMinLen) signals.push('高质量反馈');
  if (containsAny(text, ps.negativeEmotion).length) signals.push('负面情绪');

  return signals;
}

// ═══════════════════════════════════════════════════════════
// 回复文本校验（发布前硬门槛）
// ═══════════════════════════════════════════════════════════

/**
 * 校验一条待发布的回复。这是 PolicyEngine 的发布前护栏，
 * 与 prompt 里的策略文本是两回事：prompt 是"请这样写"，这里是"这样写的不许发"。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {object} [opts.filters]
 * @returns {{ok:boolean, violations:Array<{rule:string, hint:string}>}}
 */
function validateReply(text, opts = {}) {
  const f = opts.filters || config.get('filters');
  const s = String(text || '');
  const violations = [];

  if (!s.trim()) {
    return { ok: false, violations: [{ rule: '空内容', hint: '回复不能为空' }] };
  }

  const len = textLength(s);
  const rl = f.replyLength || {};

  if (Number.isInteger(rl.hardMin) && len < rl.hardMin) {
    violations.push({ rule: '过短', hint: `至少 ${rl.hardMin} 个字，当前 ${len}` });
  }
  if (Number.isInteger(rl.hardMax) && len > rl.hardMax) {
    violations.push({ rule: '过长', hint: `最多 ${rl.hardMax} 个字，当前 ${len}（建议拆成两条）` });
  }

  const emoji = countEmoji(s);
  if (Number.isInteger(f.maxEmojiPerReply) && emoji > f.maxEmojiPerReply) {
    violations.push({ rule: '表情过多', hint: `最多 ${f.maxEmojiPerReply} 个 emoji，当前 ${emoji}` });
  }

  const lines = s.split('\n').filter(l => l.trim()).length;
  if (Number.isInteger(f.maxLines) && lines > f.maxLines) {
    violations.push({ rule: '分段过多', hint: `最多 ${f.maxLines} 行，当前 ${lines}` });
  }

  const hitPhrases = containsAny(s, f.forbiddenPhrases);
  if (hitPhrases.length) {
    // 命中的全部列出来：让用户一次看全，而不是改掉一个再试一次
    violations.push({
      rule: '禁用措辞',
      hint: `出现 ${hitPhrases.map(p => `「${p}」`).join('、')}`,
    });
  }

  for (const p of (f.forbiddenPatterns || [])) {
    try {
      if (new RegExp(p.pattern).test(s)) {
        violations.push({ rule: p.name, hint: p.hint });
      }
    } catch (e) {
      // 用户填了非法正则：跳过该条而不是让整条校验崩掉
    }
  }

  return { ok: violations.length === 0, violations };
}

module.exports = {
  classify,
  validateReply,
  // 文本工具（测试与界面也用得上）
  isEmojiOnly,
  countEmoji,
  textLength,
  containsAny,
  pickEmojiReply,
  collectSignals,
};
