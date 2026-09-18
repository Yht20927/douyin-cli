// core/personas.js — 评论人格模板池（抖音版）
// 为 LLM 生成回复提供多样化的风格模板，避免所有评论都是同一种"自然亲切"的 AI 味。
//
// ── 关于「内置」与「生效」的区分（D18 / 改造计划 §5.7）──
//
// 下面这份 BUILTIN 是**默认值**，不是最终结果。改造前它同时扮演两个角色，
// 于是 examples 里写着美妆/购物语料却改不动（硬编码在 JS 里）。
// 现在实际使用的是 effectivePersonas()：内置 → 叠加 config 的 overrides
// → 追加 custom → 去掉 disabled。
//
// 消费者（pickPersona / findPersona / listPersonas）的签名一个都没变，
// 因此 reply-engine / llm.js / 各命令不需要跟着改。
//
// 配置形状（见 core/config 的 DEFAULTS.personas）：
//   personas.disabled   = ['enthusiastic_fan']            停用哪些内置人格
//   personas.overrides  = [{ id:'casual_friend', temperature: 0.9 }]   只写要覆盖的字段
//   personas.custom     = [{ id, name, promptPrefix, ... }]            完整定义
//
// overrides 与 custom 用**数组**而不是以 id 为键的对象，是为了配合
// "配置补丁只允许已知路径"的守卫（app/main/ipc.js）：以 id 为键意味着
// 路径数量取决于用户数据，守卫没法预先列出，只能整个放开。

const config = require('./config');

const BUILTIN = [
  {
    id: 'casual_friend',
    name: 'casual 朋友',
    weight: 20,
    temperature: 0.75,
    lengthRange: [10, 40],
    emojiChance: 0.6,
    promptPrefix: `你是一位刷抖音的普通用户，说话像跟朋友聊天一样自然随意。
风格要求：
- 用口语化短句，不追求语法完整
- 偶尔用 emoji（1-2 个），但不要每句都有
- 可以用"哈哈哈"、"真的假的"、"我也是"这类 casual 表达
- 避免书面语和过度礼貌`,
    forbiddenWords: ['值得注意的是','综上所述','首先','其次','最后','因此','总而言之','从某种程度上说','不得不说','客观来说'],
    examples: [
      '哈哈哈这也太真实了😂',
      '我也是！！之前试过真的有用',
      '这也太会了吧，学到了学到了',
    ],
  },
  {
    id: 'curious_asker',
    name: '好奇提问型',
    weight: 15,
    temperature: 0.65,
    lengthRange: [15, 45],
    emojiChance: 0.3,
    promptPrefix: `你是一位对内容 genuinely 好奇的抖音用户，喜欢追问细节。
风格要求：
- 以问句为主，或者带疑问语气的陈述句
- 问题要具体，不要泛泛而谈
- 语气真诚，像真的想知道答案
- 可以带一点自己的猜测再提问`,
    forbiddenWords: ['值得注意的是','综上所述','首先','其次','最后','因此','总而言之','从某种程度上说','客观来说','笔者认为'],
    examples: [
      '这个是在哪里买的呀？看起来质感好好',
      '想问下用了多久看到效果的？有点心动但怕坚持不下来😂',
      '这个和 xx 那个比怎么样？纠结好久了',
    ],
  },
  {
    id: 'experienced_sharer',
    name: '经验分享型',
    weight: 18,
    temperature: 0.60,
    lengthRange: [20, 55],
    emojiChance: 0.25,
    promptPrefix: `你是一位喜欢分享自己经验的抖音用户，看过/试过类似的东西。
风格要求：
- 用"我之前也..."、"我试过..."、"我们家..."等第一人称经验句式
- 分享要简短具体，不要写成教程
- 可以补充一个小 tip 或踩坑提醒
- 语气平和，不要居高临下`,
    forbiddenWords: ['值得注意的是','综上所述','首先','其次','最后','因此','总而言之','从某种程度上说','客观来说','笔者认为','建议'],
    examples: [
      '我之前也买过类似的，用了两个月感觉确实不错，就是刚开始有点不习惯',
      '这个我也在做！不过我是早上做，感觉效果更好一点～',
      '提醒一下姐妹，这个要坚持至少一个月才有效果，我第一周差点放弃😂',
    ],
  },
  {
    id: 'enthusiastic_fan',
    name: '热情追捧型',
    weight: 12,
    temperature: 0.80,
    lengthRange: [8, 35],
    emojiChance: 0.8,
    promptPrefix: `你是一位容易被种草、情绪外露的抖音用户，看到喜欢的内容会很激动。
风格要求：
- 多用感叹号，语气热情
- emoji 可以稍微多一点（2-3 个）
- 用"啊啊啊"、"绝了"、"救命"等情绪化表达
- 短句为主，像即时反应`,
    forbiddenWords: ['值得注意的是','综上所述','首先','其次','最后','因此','总而言之','从某种程度上说','客观来说','笔者认为','分析'],
    examples: [
      '啊啊啊这个绝了！！！🤩🤩',
      '救命这也太好看了吧！！马住！！',
      '姐妹你太会了！！这就是我要找的！！',
    ],
  },
  {
    id: 'thoughtful_critic',
    name: '温和探讨型',
    weight: 15,
    temperature: 0.50,
    lengthRange: [18, 50],
    emojiChance: 0.15,
    promptPrefix: `你是一位喜欢理性讨论但语气温和的抖音用户，会提出不同角度但不抬杠。
风格要求：
- 用"我觉得..."、"不过..."、"也有可能..."等委婉表达
- 提出补充观点而不是否定
- 语气友好，结尾可以带鼓励
- 少用 emoji，最多 1 个`,
    forbiddenWords: ['值得注意的是','综上所述','首先','其次','最后','因此','总而言之','从某种程度上说','客观来说','笔者认为','但是'],
    examples: [
      '我觉得还可以试试另一种方法，我之前是那样做的效果也挺好的',
      '说得挺有道理的，不过也要看个人体质吧，我是属于容易...的那种',
      '这个角度好棒！我补充一个小点，其实...',
    ],
  },
  {
    id: 'humor_maker',
    name: '轻松幽默型',
    weight: 12,
    temperature: 0.85,
    lengthRange: [10, 40],
    emojiChance: 0.7,
    promptPrefix: `你是一位喜欢玩梗、说话幽默的抖音用户，会用轻松的方式互动。
风格要求：
- 可以适当玩抖音/网络梗，但不要过时或太生硬
- 用自嘲、夸张等幽默手法
- 语气轻松，像在群里聊天
- emoji 可以配合梗使用`,
    forbiddenWords: ['值得注意的是','综上所述','首先','其次','最后','因此','总而言之','从某种程度上说','客观来说','笔者认为'],
    examples: [
      '我的手：我会了 我的脑：不你不会😂',
      '看完：这么简单？ 上手：我是谁我在哪',
      '这不就是世另我吗！监控拆一下谢谢',
    ],
  },
  {
    id: 'brief_reactor',
    name: '简短反应型',
    weight: 8,
    temperature: 0.70,
    lengthRange: [4, 20],
    emojiChance: 0.5,
    promptPrefix: `你是一位不爱打太多字的抖音用户，喜欢用极简短句表达态度。
风格要求：
- 极度简短，5-15 字为主
- 像随手评论，不深思熟虑
- 可以用"+1"、"真实"、"马住"等极简表达
- 偶尔只发 emoji`,
    forbiddenWords: ['值得注意的是','综上所述','首先','其次','最后','因此','总而言之','从某种程度上说','客观来说','笔者认为','分析','建议'],
    examples: [
      '真实👍',
      '马住了',
      '学到了！',
    ],
  },
];

// ═══════════════════════════════════════════════════════════
// 生效人格 = 内置 + 覆盖 + 自定义 - 停用
// ═══════════════════════════════════════════════════════════

/** 允许被 overrides 覆盖的字段。其余字段（尤其是 id）不允许改，否则找不到原始定义 */
const OVERRIDABLE = ['name', 'weight', 'temperature', 'lengthRange', 'emojiChance', 'promptPrefix', 'forbiddenWords', 'examples', 'enabled'];

/** 覆盖一个内置人格。数组整体替换（与 config 的深合并语义一致） */
function applyOverride(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = { ...base };
  for (const k of OVERRIDABLE) {
    if (override[k] !== undefined) out[k] = override[k];
  }
  return out;
}

/**
 * 把一条自定义人格规范化成与内置完全同构的形状。
 *
 * 缺字段的一律补默认值而不是丢弃 —— 用户只填了 id 和 promptPrefix 也应该能用，
 * 而不是生成时才炸。真正的合法性（id 非空、promptPrefix 非空）由 config 校验负责，
 * 到这里说明已经过了一遍校验，这里只是补齐可选项。
 */
function normalizeCustom(raw) {
  return {
    id: String(raw.id),
    name: raw.name || String(raw.id),
    weight: Number.isFinite(raw.weight) ? raw.weight : 10,
    temperature: Number.isFinite(raw.temperature) ? raw.temperature : 0.7,
    lengthRange: Array.isArray(raw.lengthRange) && raw.lengthRange.length === 2 ? raw.lengthRange : [10, 45],
    emojiChance: Number.isFinite(raw.emojiChance) ? raw.emojiChance : 0.3,
    promptPrefix: raw.promptPrefix || '',
    forbiddenWords: Array.isArray(raw.forbiddenWords) ? raw.forbiddenWords : [],
    examples: Array.isArray(raw.examples) ? raw.examples : [],
    custom: true,
  };
}

/**
 * 当前真正生效的人格列表。
 *
 * 每次调用都重新读配置（config.get 本身有缓存，成本很低）——
 * 不做模块级缓存，否则设置页改完不重启不生效，正是 C4 那个老问题。
 */
function effectivePersonas(opts = {}) {
  const includeDisabled = opts.includeDisabled === true;
  const cfg = config.get('personas') || {};
  const disabled = new Set(Array.isArray(cfg.disabled) ? cfg.disabled : []);
  const overrides = Array.isArray(cfg.overrides) ? cfg.overrides : [];
  const custom = Array.isArray(cfg.custom) ? cfg.custom : [];

  const byId = new Map();
  for (const o of overrides) if (o && o.id) byId.set(o.id, o);

  // 内置：叠加覆盖。includeDisabled 时不看停用状态 ——
  // 设置页要显示"停用的那些现在被改成什么样了"，否则用户展开一个停用的人格
  // 看到的是内置原值，一编辑就会把之前的改动覆盖掉。
  const builtin = BUILTIN
    .map(p => applyOverride(p, byId.get(p.id)))
    .filter(p => includeDisabled || (!disabled.has(p.id) && p.enabled !== false));

  const builtinIds = new Set(BUILTIN.map(p => p.id));
  const myCustom = custom
    .filter(c => c && c.id)
    // 自定义人格的 id 撞上内置 id 时忽略自定义的那条：内置是更明确的意图
    .filter(c => !builtinIds.has(c.id))
    .map(normalizeCustom)
    .filter(c => includeDisabled || (!disabled.has(c.id) && c.enabled !== false));

  return [...builtin, ...myCustom];
}

/** 全部停用时回退到内置全部 —— 总比"生成时没有可用人格"要好 */
function safePersonas() {
  const list = effectivePersonas();
  return list.length ? list : BUILTIN;
}

let lastPersonaId = null;

/**
 * 随机挑一个人格（按 weight 加权）。
 *
 * 排除项支持两种写法：
 *   opts.excludeId  单个 id
 *   opts.excludeIds  id 数组
 * 复数形式以前就被调用方使用（persona-binder.js 的 bulkAdvance），但这里从来没读过它，
 * 于是"这批别再用这几个"实际只有 lastPersonaId 生效。两种写法都支持后，
 * 调用方不必再关心哪个才对。
 */
function pickPersona(opts = {}) {
  const list = safePersonas();
  const excluded = new Set([
    opts.excludeId,
    lastPersonaId,
    ...(Array.isArray(opts.excludeIds) ? opts.excludeIds : []),
  ].filter(Boolean));

  const candidates = list.filter(p => !excluded.has(p.id));
  if (candidates.length === 0) return list[0];

  const totalWeight = candidates.reduce((sum, p) => sum + (p.weight > 0 ? p.weight : 0), 0);
  // 权重全为 0（或负数）时退回等概率，否则会一直返回最后一个人格
  if (totalWeight <= 0) {
    const p = candidates[Math.floor(Math.random() * candidates.length)];
    lastPersonaId = p.id;
    return p;
  }

  let rnd = Math.random() * totalWeight;
  for (const p of candidates) {
    rnd -= (p.weight > 0 ? p.weight : 0);
    if (rnd <= 0) { lastPersonaId = p.id; return p; }
  }
  lastPersonaId = candidates[candidates.length - 1].id;
  return candidates[candidates.length - 1];
}

function buildSystemPrompt(persona, baseStrategy) {
  const parts = [persona.promptPrefix];

  // 账号人设背景（改造计划 §5.10 的 account.roleProfile）。
  // 从改造前的账号文档抢救来的（那份文档已随 P4.4 删除）—— 这里是**唯一的消费点**，
  // 去掉它这个配置项就变成"能配不生效"了。
  // 留空则整段不加，所以默认（空串）下与改造前行为完全一致。
  const roleProfile = config.get('account.roleProfile');
  if (typeof roleProfile === 'string' && roleProfile.trim()) {
    parts.push(`\n账号背景（只影响你看问题的视角，不要直接复述）：\n${roleProfile.trim()}`);
  }

  parts.push(`\n通用约束：\n- 回复长度控制在 ${persona.lengthRange[0]}-${persona.lengthRange[1]} 字之间\n- 绝对禁止出现以下 AI 特征词：${persona.forbiddenWords.join('、')}\n- 不要写完整段落，用短句或换行\n- 不要过度礼貌或正式\n- 必须为每条传入的评论都生成一条回复（不要跳过任何一条）`);
  // 注：改造前这里对策略文本做 .slice(0, 300) 截断，会从句子中间切断策略内容
  // （实测截到"### B. 赞美型 / 好看/厉害/喜欢/绝了"），导致后半部分策略从未生效。
  // 现在策略统一由单一真源经 {{STRATEGY_BLOCK}} 注入，此处仅作可选的调用方补充，
  // 不再截断 —— 若确实需要控制长度，应由调用方决定传什么。
  if (baseStrategy && baseStrategy.trim()) {
    parts.push(`\n用户补充策略：\n${baseStrategy.trim()}`);
  }
  return parts.join('\n');
}

function buildUserPrefix(persona) {
  const examples = persona.examples;
  if (!examples || examples.length === 0) return '';
  return `\n参考语气（不要原句复制，只学语气）：\n${examples.map((ex, i) => `${i + 1}. 「${ex}」`).join('\n')}\n`;
}

function getTemperature(persona) {
  const jitter = (Math.random() * 0.10) - 0.05;
  return Math.max(0.1, Math.min(1.0, (persona.temperature || 0.7) + jitter));
}

/**
 * 精简列表（只 id/name/weight），供日志与概览用。
 * 刻意不带 promptPrefix / examples —— 那些内容很长，混进日志会淹掉有用信息。
 * 需要完整字段（设置页）请用 effectivePersonas()。
 */
function listPersonas() {
  return effectivePersonas().map(p => ({ id: p.id, name: p.name, weight: p.weight }));
}

function findPersona(id) {
  return effectivePersonas().find(p => p.id === id) || null;
}

function resetState() {
  lastPersonaId = null;
}

module.exports = {
  pickPersona,
  buildSystemPrompt,
  buildUserPrefix,
  getTemperature,
  listPersonas,
  findPersona,
  resetState,
  // 生效列表（设置页要展示"现在实际有哪些"）
  // effectivePersonas({ includeDisabled: true }) 用于编辑器：显示全部，
  // 且内置项显示的是叠加覆盖之后的**生效值**
  effectivePersonas,
  // 内置默认值。设置页拿它做"恢复默认"，也用于判断某条是内置还是自定义
  BUILTIN,
  // 兼容旧名：改造前 PERSONAS 就是上面那份内置定义，语义没变
  PERSONAS: BUILTIN,
};
