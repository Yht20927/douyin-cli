// core/reply-source/index.js — 回复来源分发（AI / 固定 / 混合）
//
// 这一层回答的问题是「这一次到底用不用 LLM」，与 reply-engine 的分工是：
//   reply-engine = 怎么用 LLM 生成一条像样的回复
//   reply-source = 这次要不要走 LLM、失败了怎么办、要不要带图
//
// 接入点在 getReply 命令的 cid 分支内部（而不是界面另开一条 IPC 路径），
// 于是 CLI 与桌面应用共用同一条链路：队列的串行、进度、取消、审计全部复用，
// P5 定时生成草稿也直接调同一条命令，不需要再接一次。
//
// AI 生成本身由调用方以 generateAI 回调传入 —— 本模块不构造 ReplyEngine，
// 于是它可以在没有 bridge、没有网络的情况下被完整测试。

const config = require('../config');
const logger = require('../runtime/logger');
const { nextFixed, describeItems } = require('./fixed');
const { pickImage, usableImages } = require('./image');
const stateStore = require('./state');

// 模式清单来自 config（那边同时用它做 schema 校验），不在这里另立一份，
// 否则「校验认的名字」与「分发认的名字」迟早会不一致。
const MODES = config.REPLY_MODES;

function isValidMode(m) {
  return MODES.includes(m);
}

/**
 * 解析本次实际使用的模式。
 * 优先级：命令行的 --mode > 配置 reply.mode > 'ai'。
 *
 * --mode 拼错时**忽略该参数回到配置值**（而不是强制 ai，也不是报错）：
 * 配置是用户明确设过的真源，一个打错的临时参数不该把行为改到第三个地方去，
 * 更不该让整条命令失败。两种情况下都会留一条 warn。
 */
function resolveMode(explicit) {
  if (explicit && isValidMode(explicit)) return explicit;
  // 注意日志要说实话：这里是**回退到配置值**，不是"按 ai 处理"。
  // 改造前文案写的是后者，而代码 return 的是 cfg —— 用户照着日志排查会得到错误结论。
  if (explicit) {
    const fallback = isValidMode(config.get('reply.mode')) ? config.get('reply.mode') : 'ai';
    logger.warn(`[reply-source] 未知模式 "${explicit}"，已忽略该参数并回退到配置值 "${fallback}"`);
  }
  const cfg = config.get('reply.mode');
  if (isValidMode(cfg)) return cfg;
  if (cfg) logger.warn(`[reply-source] 配置里的 reply.mode "${cfg}" 不认识，已按 ai 处理`);
  return 'ai';
}

/**
 * 从固定内容取一条。
 * @returns {{ok:true, text:string, meta:object}|{ok:false, error:string}}
 */
function takeFixed(fixedCfg) {
  const picked = stateStore.withSection('fixed', (st) =>
    nextFixed({ config: fixedCfg, state: st }));

  if (!picked) {
    const cycle = (fixedCfg && fixedCfg.cycle) || null;
    const d = describeItems(fixedCfg && fixedCfg.items, cycle);
    let detail;
    if (d.total === 0) {
      detail = '固定回复列表是空的';
    } else {
      const reasons = [];
      if (d.disabled) reasons.push(`${d.disabled} 条被禁用`);
      if (d.blank) reasons.push(`${d.blank} 条内容为空`);
      if (d.zeroWeight) reasons.push(`${d.zeroWeight} 条权重为 0`);
      detail = `列表里有 ${d.total} 条，但没有一条可用（${reasons.join('、') || '原因不明'}）`;
    }
    return {
      ok: false,
      error: `${detail}。请到设置页的「回复策略」里调整，或把回复模式改回 AI。`,
    };
  }
  return { ok: true, text: picked.text, meta: { cycle: picked.cycle, itemIndex: picked.itemIndex } };
}

/**
 * 生成一条回复。
 *
 * @param {object} ctx - 运行上下文（本模块只用它的 logger 语义，保留参数是为了
 *                       与计划里定的 `next(ctx, {...})` 签名一致，将来加进度上报不用改调用方）
 * @param {object} opts
 * @param {string} opts.awemeId
 * @param {object} opts.comment - { cid, text, uid?, userTags?, parentComment? }
 * @param {string|object} [opts.persona='auto']
 * @param {string} [opts.mode]  - 显式覆盖配置里的模式（来自 --mode）
 * @param {Function} opts.generateAI - 真正调用 LLM 的函数，签名 () => engine.generateReply(...) 的结果
 * @param {Function} [opts.rng] - 随机源，测试用
 * @returns {Promise<{ok:true, text:string, source:'ai'|'fixed', personaId:string|null,
 *                    imagePath:string|null, imageReason:string|null, degraded:boolean,
 *                    aiError:string|null, meta:object}>}
 *          | {ok:false, error:string}
 */
async function next(ctx, opts) {
  const {
    awemeId,
    comment,
    persona = 'auto',
    mode: explicitMode,
    generateAI,
    rng,
  } = opts || {};

  const mode = resolveMode(explicitMode);
  const replyCfg = config.get('reply') || {};
  const hybridCfg = replyCfg.hybrid || {};

  let text = '';
  let source = 'ai';
  let personaId = null;
  let personaObj = null;
  let degraded = false;
  let aiError = null;
  // AI 成功时保留原始返回，让调用方能原样吐出 ReplyEngine 的结果形状
  // （persona 详情、候选列表等），不用把字段在这一层复刻一遍。
  let aiRaw = null;

  if (mode === 'fixed') {
    const r = takeFixed(replyCfg.fixed);
    if (!r.ok) return { ok: false, error: r.error };
    text = r.text;
    source = 'fixed';
  } else if (mode === 'hybrid') {
    const ratio = Number.isFinite(hybridCfg.aiRatio)
      ? Math.min(1, Math.max(0, hybridCfg.aiRatio))
      : 0;
    const useAI = (rng || Math.random)() < ratio;

    if (useAI) {
      const ai = await tryAI('混合模式按比例命中 AI', generateAI);
      if (ai.ok) {
        text = ai.text; personaObj = ai.persona; source = 'ai'; aiRaw = ai.raw;
      } else {
        aiError = ai.error;
        if (hybridCfg.fallbackToFixed === false) return { ok: false, error: ai.error };
        const r = takeFixed(replyCfg.fixed);
        if (!r.ok) {
          // 降级目标也没有：把 AI 的原始错误报出来，那才是用户要修的东西
          return { ok: false, error: `${ai.error}（本想降级到固定内容，但${r.error}）` };
        }
        text = r.text; source = 'fixed'; degraded = true;
        logger.warn(`[reply-source] AI 生成失败，已降级到固定内容：${ai.error}`);
      }
    } else {
      const r = takeFixed(replyCfg.fixed);
      if (!r.ok) return { ok: false, error: r.error };
      text = r.text; source = 'fixed';
    }
  } else {
    const ai = await tryAI('AI 模式', generateAI);
    if (!ai.ok) return { ok: false, error: ai.error };
    text = ai.text; personaObj = ai.persona; source = 'ai'; aiRaw = ai.raw;
  }

  personaId = (personaObj && personaObj.id) || null;

  // ── 图片附加 ──
  // 不管文字来自 AI 还是固定内容，图片都是在这一步统一决策的。
  const imgCfg = replyCfg.image || {};
  let imagePath = null;
  let imageReason = null;
  if (imgCfg.enabled) {
    const picked = stateStore.withSection('image', (st) =>
      pickImage({ config: imgCfg, comment, state: st, rng }));
    if (picked) {
      imagePath = picked.path || null;
      imageReason = picked.reason;
      if (!imagePath) {
        // 想带图却挑不出来：说明白为什么，但不影响文字照常返回
        logger.warn(`[reply-source] 本条不带图：${picked.reason}`);
      } else if (imgCfg.withText === false) {
        // 「只发图不写字」：文字清空，交给发布链路只提交图片
        text = '';
      }
    }
  }

  return {
    ok: true,
    text,
    source,
    personaId,
    imagePath,
    imageReason,
    degraded,
    aiError,
    raw: aiRaw,
    meta: { mode, persona: personaObj || persona, awemeId, cid: comment && comment.cid },
  };
}

/**
 * 调一次 AI，把异常收敛成结果对象。
 * 不直接 throw：调用方需要区分"AI 失败了但可以降级"与"整体失败"。
 */
async function tryAI(label, generateAI) {
  if (typeof generateAI !== 'function') {
    return { ok: false, error: `${label}需要 AI 生成能力，但调用方没有提供 generateAI` };
  }
  try {
    const result = await generateAI();
    const text = extractText(result);
    if (!text) {
      return { ok: false, error: 'AI 返回了空内容（原始结果请看队列结果或日志）' };
    }
    return { ok: true, text, persona: (result && result.reply && result.reply.persona) || null, raw: result };
  } catch (e) {
    return { ok: false, error: `AI 生成失败：${e.message}` };
  }
}

/** 从 ReplyEngine 的返回里取文本，兼容 generateReply / generateComment 两种形状 */
function extractText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result.trim();
  if (result.reply && typeof result.reply.text === 'string') return result.reply.text.trim();
  if (typeof result.text === 'string') return result.text.trim();
  if (Array.isArray(result.comments) && result.comments[0]) {
    return String(result.comments[0].text || '').trim();
  }
  return '';
}

/**
 * 循环进度的可读快照（设置页的「当前轮到第几条」）。
 * 与上方的 describe() 是两件事：那个说"配置长什么样"，这个说"跑到哪了"。
 */
function cycleProgress() {
  const cfg = config.get('reply') || {};
  const cycle = (cfg.fixed && cfg.fixed.cycle) || null;
  const usable = require('./fixed').usableItems(cfg.fixed && cfg.fixed.items, cycle);
  return stateStore.describe(usable.length);
}

/** 设置页展示用：当前模式 + 固定内容概况 + 图片概况 */
function describe() {
  const cfg = config.get('reply') || {};
  const cycle = (cfg.fixed && cfg.fixed.cycle) || null;
  const fixed = describeItems(cfg.fixed && cfg.fixed.items, cycle);
  const img = usableImages(cfg.image && cfg.image.paths);
  return {
    mode: resolveMode(null),
    modes: MODES,
    // 界面要能说清"这次会不会真的调 AI"，比例得让它看得到
    hybridRatio: Number.isFinite(cfg.hybrid && cfg.hybrid.aiRatio) ? cfg.hybrid.aiRatio : 0,
    fixed: { ...fixed, cycle },
    image: {
      enabled: !!(cfg.image && cfg.image.enabled),
      mode: (cfg.image && cfg.image.mode) || null,
      usable: img.usable.length,
      rejected: img.rejected,
    },
  };
}

module.exports = {
  next,
  resolveMode,
  describe,
  cycleProgress,
  MODES,
  isValidMode,
  // 子模块透出，设置页与测试直接用
  fixed: require('./fixed'),
  image: require('./image'),
  state: stateStore,
  cycles: require('./cycles'),
};
