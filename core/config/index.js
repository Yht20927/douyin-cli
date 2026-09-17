// core/config/index.js — 配置的单一真源
//
// 为什么需要这一层
// ----------------
// 改造前，config.json 被 4 处独立 require：cli.js:17、server.js:14、risk-control.js:40、
// llm.js:11。这带来三个问题：
//
//   1. **模块级缓存导致改配置不生效**。risk-control.js 有 `_config` 缓存（原 :35-45），
//      改完 config.json 不重启进程永远读不到新值。
//   2. **没有默认值合并**。缺字段时各处自己写 `|| 兜底`，散落且不一致。
//   3. **没有校验**。非法值（如 intervals.write = [0,0]）各自静默回退，用户不知道。
//
// 本模块的约定
// ------------
// - 所有消费方调用 `get()` 取值，**不要在模块级缓存返回值**（否则又变回老问题）。
// - 用户配置只写要改的项，其余从 DEFAULTS 补齐（深合并）。
// - `get()` 每次返回**深拷贝**，调用方改动不会污染缓存。
// - `set()` 原子写盘并刷新内存；桌面设置页保存后无需重启。
// - 校验失败不抛错（配置问题不该让应用起不来），而是回退默认值并记录 warning，
//   由 GUI 诊断页/设置页展示。
//
// 关于 DEFAULTS 的边界
// --------------------
// 这里**只放真正被代码消费的配置项**。改造前的 config.example.json 里 `vision` 块、
// 以及实际 config.json 里的 `multimodal.screenshotCount` / `autoScreenshotRatio`
// 全是死配置（全代码无人读取），本次一并清除。新增配置项时必须同时有消费点，
// 避免重蹈"看着能配、实际不生效"的覆辙。

const fs = require('fs');
const path = require('path');
const paths = require('../paths');

// ═══════════════════════════════════════════════════════════
// 默认值
// ═══════════════════════════════════════════════════════════

const DEFAULTS = {
  app: {
    // 关窗口时最小化到托盘而不是退出（定时拉取要求应用常驻）
    minimizeToTray: true,
  },
  bridge: {
    host: '127.0.0.1',
    port: 19422,
    token: '',
    heartbeatInterval: 30000,
    heartbeatTimeout: 10000,
    heartbeatMaxFailures: 3,
    requestTimeout: 30000,
    // 抖音搜索结果等大响应可能远超 1MB，默认 64MB
    maxBodySize: 67108864,
    // 连接健康监测：桌面应用据此在界面上显示"已连接/离线"
    connectionWatch: {
      // 轮询 /api/status 的间隔
      pollIntervalSec: 5,
      // 连续多久没有活跃连接就判定为离线并提示
      offlineAlertSec: 60,
    },
  },
  llm: {
    api_key: '',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    max_tokens: 4096,
    timeout_ms: 60000,
    max_retries: 3,
  },
  intervals: {
    // 写操作间隔（秒），risk-control 硬强制
    write: [40, 55],
    // 读操作间隔（秒）
    read: [30, 50],
    // 读操作是否也强制阻塞。
    // CLI 下为 false（保持"读操作只建议不阻塞"的既有语义，避免交互式查询每次卡 30s）；
    // 桌面 GUI 下由主进程置 true —— 因为 GUI 里没有 agent 自觉遵守间隔，必须由代码兜住。
    readEnforce: false,
  },
  multimodal: {
    // text-only | screenshots | video
    // 注意：screenshots/video 需要本机 ffmpeg/ffprobe，桌面版不内置（D11），
    // 缺依赖时代码会自动降级回 text-only（video-context.js:79-87）
    mode: 'text-only',
  },

  // ═══════════════════════════════════════════════════════════
  // policy —— 节奏决策：能发多快
  //
  // 这些默认值全部来自 全局规则.md 与 评论区运营.md，但改造前**代码里一条都没实现**，
  // 只写在 markdown 里靠人自觉。现在由 core/policy 强制，并在界面上可视。
  // ═══════════════════════════════════════════════════════════
  policy: {
    // ── 总量与轮次（全局规则.md §1）──
    /** 每日写操作上限 */
    dailyWriteQuota: 30,
    /** 每日轮次上限 */
    dailyRounds: 3,
    /** 单轮连续写操作上限，达到后强制冷却 */
    roundMaxWrites: 10,
    /** 单轮触顶后的强制冷却时长（秒）。全局规则写的是 3-5 分钟，取中 */
    roundCooldownSec: 300,
    /**
     * 超过这个轮次后风控概率显著上升（全局规则.md §88）。
     * 不是硬拦截，而是把界面提示升级为"本日不建议继续"。
     */
    riskEscalateAfterRounds: 2,

    // ── 风控熔断（§11）──
    /** 命中风控码后全局停止写操作的时长（分钟） */
    riskCooldownMin: 30,
    /** 触发熔断的风控错误码 */
    riskCodeStopList: [8, 2053],
    /** 连续失败断路器：窗口内失败次数达到阈值即暂停自动发布 */
    circuitBreaker: { windowMs: 600000, failThreshold: 3 },

    // ── 单轮内的细分上限（评论区运营.md）──
    /** 同一作品单轮最多回复多少条 */
    maxPerVideoPerRound: 30,
    /** 同一用户单轮最多回复多少条（不同评论也算） */
    maxPerUidPerRound: 1,
    /** 连续这么多条都不匹配回复条件就停止本轮（避免无意义空转） */
    stopAfterConsecutiveSkips: 5,
  },

  // ═══════════════════════════════════════════════════════════
  // filters —— 内容决策：回不回、怎么回
  //
  // 决策树来自 评论区运营.md 的评论分类流程；词表从 reply-strategy.md 与
  // 评论风格指南.md 抢救而来。词表放这里（而非 prompt 文本里）是为了让
  // **发布前的自动校验**能用同一份数据 —— 见 D22 的"能结构化的就结构化"。
  // ═══════════════════════════════════════════════════════════
  filters: {
    /** 同一个 cid 只回复一次（一生一次，跨日跨轮生效） */
    skipReplied: true,
    /** 跳过贴纸评论 */
    skipSticker: true,
    /** 跳过无意义水评 */
    skipWater: true,
    /**
     * 短评论判定为水评候选的长度上限（**含**）。
     * 默认 3，对应 评论区运营.md 的「长度 < 4 且无明确语义」。
     * 注意是"候选"：还要么命中 waterWords，要么没有任何优先信号，才会真的跳过。
     */
    waterCommentMaxLen: 3,
    /** 超过这个长度且提到具体细节 → 判定为高质量反馈，优先回复 */
    qualityFeedbackMinLen: 15,

    /** 回复长度约束。prefer 给模型看，hardMin/hardMax 是发布前的硬校验 */
    replyLength: { prefer: [8, 40], hardMin: 3, hardMax: 55 },
    /** 回复中 emoji 数量上限 */
    maxEmojiPerReply: 3,
    /** 回复最多几行（超过视为"过长段落"） */
    maxLines: 3,

    /** 优先回复的信号词。命中任一即进入文字回复路线 */
    prioritySignals: {
      askForHelp: ['怎么', '如何', '为什么', '哪里', '在哪', '求', '?', '？'],
      negativeEmotion: ['失望', '生气', '无语', '抱怨', '垃圾', '差评', '翻车', '骗'],
    },

    /** 水评词。长度 ≤ waterCommentMaxLen 且命中这些词 → 跳过 */
    waterWords: [
      '666', '哈哈', '哈哈哈', '嘿嘿', '来了', '前排', '沙发',
      '路过', '打卡', '+1', 'dd', '顶', '阅', '好', '嗯', '哦',
    ],

    /** 社区调性词（评论风格指南.md）—— 鼓励使用 */
    toneWords: [
      '大佬', '学到了', '太强了', 'yyds', 'DNA动了',
      '狠狠共情了', '破防了', '真实', '谁懂', '绝了',
    ],

    /**
     * 禁止出现的措辞。**这是发布前硬校验用的机器可读清单**，
     * 同时经 {{FORBIDDEN_PHRASES}} 注入 prompt —— 单一来源，不会漂移。
     * 前 8 条是 AI 腔特征（reply-strategy.md），后 3 条是敷衍表达（评论风格指南.md）。
     */
    forbiddenPhrases: [
      '值得注意的是',
      '综上所述',
      '总而言之',
      '总的来说',
      '从某种程度上说',
      '客观来说',
      '笔者认为',
      '感谢您的分享',
      '非常赞同您的观点',
      '不错',
      '很好',
      '学习了',
    ],

    /**
     * 禁止的结构性模式。用正则表达，供发布前校验。
     * 每条带一句说明，界面展示时直接用它，不必再维护一份文案。
     */
    forbiddenPatterns: [
      { name: '结构化列表', pattern: '(?:^|\\n)\\s*[1-9][.、)]\\s*\\S', hint: '不要用 1. 2. 3. 这种列表' },
      { name: '三段式', pattern: '首先[\\s\\S]{0,40}其次', hint: '不要写"首先…其次…最后…"' },
      { name: '完整 GitHub 链接', pattern: 'https?://(?:www\\.)?github\\.com/\\S+', hint: '直贴链接会被限流，改写成 owner/repo' },
      { name: '过长段落', pattern: '\\n[\\s\\S]*\\n[\\s\\S]*\\n', hint: '最多三行' },
    ],

    /**
     * 纯表情评论的回复方式（评论区运营.md 的表情映射表）。
     *
     * match 里同时列出 Unicode 与抖音方括号两种形式：接口返回的表情有时是
     * 真实 Unicode 字符，有时就是 `[玫瑰]` 这样的文本（尤其用户从面板里选的表情），
     * 只认一种会漏掉一半情况。
     */
    emojiOnly: {
      enabled: true,
      map: [
        {
          match: ['❤️', '🌹', '😘', '💕', '[玫瑰]', '[爱心]', '[心]', '[亲吻]'],
          reply: ['🌹', '❤️'],
        },
        {
          match: ['👍', '💪', '🔥', '👏', '[赞]', '[强]', '[鼓掌]', '[火]'],
          reply: ['🤝', '💪'],
        },
        {
          match: ['😂', '🤣', '😄', '[笑哭]', '[呲牙]', '[大笑]'],
          reply: ['😄', '😂'],
        },
        {
          match: ['🎉', '🥳', '✨', '[庆祝]', '[撒花]'],
          reply: ['🎉', '❤️'],
        },
      ],
      /** 判断不出类型时的兜底候选 */
      pool: ['🌹', '🤝', '😊', '👍', '❤️', '🎉'],
    },
  },
};

/** 敏感字段路径（点号分隔）。GUI 默认打码、导出配置时剔除 */
const SENSITIVE_KEYS = ['llm.api_key', 'bridge.token'];

// ═══════════════════════════════════════════════════════════
// 内部状态
// ═══════════════════════════════════════════════════════════

/** 合并后的配置（含默认值） */
let _merged = null;
/** 用户配置原文（不含默认值），set() 时用于保留未知字段 */
let _raw = null;
/** 上次加载的校验告警 */
let _warnings = [];

// ═══════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 深拷贝（只处理纯对象/数组/原始值，配置项足够） */
function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
    return out;
  }
  return v;
}

/**
 * 深合并：把 src 覆盖到 base 上（数组整体替换，不做元素级合并）。
 * 返回新对象，不修改入参。
 */
function deepMerge(base, src) {
  const out = deepClone(base);
  if (!isPlainObject(src)) return out;
  for (const k of Object.keys(src)) {
    const sv = src[k];
    if (isPlainObject(sv) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], sv);
    } else if (sv !== undefined) {
      out[k] = deepClone(sv);
    }
  }
  return out;
}

/** 按点号路径取值 */
function getByPath(obj, dotPath) {
  if (!dotPath) return obj;
  return dotPath.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/** 按点号路径设值（就地修改 target） */
function setByPath(target, dotPath, value) {
  const keys = dotPath.split('.');
  let cur = target;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isPlainObject(cur[keys[i]])) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function isPositiveNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

// ═══════════════════════════════════════════════════════════
// 校验
// ═══════════════════════════════════════════════════════════

/**
 * 校验用户配置，非法项回退默认值并记录告警。
 * 不抛错 —— 配置问题不该让应用起不来。
 * @param {object} cfg - 深合并后的配置（会被就地修正）
 * @returns {Array<{key:string, message:string, fallback:any}>}
 */
function validate(cfg) {
  const warnings = [];
  const fail = (key, message, fallback) => {
    warnings.push({ key, message, fallback });
    setByPath(cfg, key, deepClone(fallback));
  };

  // app
  if (typeof getByPath(cfg, 'app.minimizeToTray') !== 'boolean') {
    fail('app.minimizeToTray', '需为布尔值', DEFAULTS.app.minimizeToTray);
  }

  // bridge
  // 注意端口 0 是合法的（表示由系统分配空闲端口），故下限为 0
  const port = getByPath(cfg, 'bridge.port');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail('bridge.port', `端口需为 0-65535 的整数（0 表示由系统分配），实际为 ${JSON.stringify(port)}`, DEFAULTS.bridge.port);
  }
  for (const k of ['pollIntervalSec', 'offlineAlertSec']) {
    const v = getByPath(cfg, `bridge.connectionWatch.${k}`);
    if (!isPositiveNumber(v)) {
      fail(`bridge.connectionWatch.${k}`, `需为正数，实际为 ${JSON.stringify(v)}`, DEFAULTS.bridge.connectionWatch[k]);
    }
  }
  for (const k of ['heartbeatInterval', 'requestTimeout']) {
    const v = getByPath(cfg, `bridge.${k}`);
    if (!isPositiveNumber(v)) {
      fail(`bridge.${k}`, `需为正数，实际为 ${JSON.stringify(v)}`, DEFAULTS.bridge[k]);
    }
  }
  const maxBody = getByPath(cfg, 'bridge.maxBodySize');
  if (!Number.isInteger(maxBody) || maxBody <= 0) {
    fail('bridge.maxBodySize', `需为正整数，实际为 ${JSON.stringify(maxBody)}`, DEFAULTS.bridge.maxBodySize);
  }

  // llm
  const maxTokens = getByPath(cfg, 'llm.max_tokens');
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    fail('llm.max_tokens', `需为正整数，实际为 ${JSON.stringify(maxTokens)}`, DEFAULTS.llm.max_tokens);
  }
  for (const k of ['timeout_ms', 'max_retries']) {
    const v = getByPath(cfg, `llm.${k}`);
    if (!isPositiveNumber(v)) {
      fail(`llm.${k}`, `需为正数，实际为 ${JSON.stringify(v)}`, DEFAULTS.llm[k]);
    }
  }
  if (!getByPath(cfg, 'llm.base_url')) {
    fail('llm.base_url', '不能为空', DEFAULTS.llm.base_url);
  }

  // intervals：两个正整数组成的数组，顺序自动纠正
  for (const k of ['write', 'read']) {
    const v = getByPath(cfg, `intervals.${k}`);
    const ok = Array.isArray(v) && v.length === 2 && v.every(isPositiveNumber);
    if (!ok) {
      fail(`intervals.${k}`, `需为 [最小秒数, 最大秒数] 两个正数，实际为 ${JSON.stringify(v)}`, DEFAULTS.intervals[k]);
    } else if (v[0] > v[1]) {
      setByPath(cfg, `intervals.${k}`, [v[1], v[0]]);
      warnings.push({
        key: `intervals.${k}`,
        message: `最小值大于最大值，已自动纠正为 [${v[1]}, ${v[0]}]`,
        fallback: [v[1], v[0]],
      });
    }
  }
  if (typeof getByPath(cfg, 'intervals.readEnforce') !== 'boolean') {
    fail('intervals.readEnforce', '需为布尔值', DEFAULTS.intervals.readEnforce);
  }

  // policy：全是正整数型的节奏参数
  for (const k of [
    'dailyWriteQuota', 'dailyRounds', 'roundMaxWrites', 'roundCooldownSec',
    'riskEscalateAfterRounds', 'riskCooldownMin',
    'maxPerVideoPerRound', 'maxPerUidPerRound', 'stopAfterConsecutiveSkips',
  ]) {
    const v = getByPath(cfg, `policy.${k}`);
    if (!Number.isInteger(v) || v < 0) {
      fail(`policy.${k}`, `需为不小于 0 的整数，实际为 ${JSON.stringify(v)}`, DEFAULTS.policy[k]);
    }
  }
  for (const k of ['windowMs', 'failThreshold']) {
    const v = getByPath(cfg, `policy.circuitBreaker.${k}`);
    if (!Number.isInteger(v) || v <= 0) {
      fail(`policy.circuitBreaker.${k}`, `需为正整数，实际为 ${JSON.stringify(v)}`, DEFAULTS.policy.circuitBreaker[k]);
    }
  }
  const stopCodes = getByPath(cfg, 'policy.riskCodeStopList');
  if (!Array.isArray(stopCodes) || stopCodes.some(x => !Number.isInteger(x))) {
    fail('policy.riskCodeStopList', `需为整数数组，实际为 ${JSON.stringify(stopCodes)}`, DEFAULTS.policy.riskCodeStopList);
  }

  // filters
  for (const k of ['skipReplied', 'skipSticker', 'skipWater']) {
    if (typeof getByPath(cfg, `filters.${k}`) !== 'boolean') {
      fail(`filters.${k}`, '需为布尔值', DEFAULTS.filters[k]);
    }
  }
  for (const k of ['waterCommentMaxLen', 'qualityFeedbackMinLen', 'maxEmojiPerReply', 'maxLines']) {
    const v = getByPath(cfg, `filters.${k}`);
    if (!Number.isInteger(v) || v < 0) {
      fail(`filters.${k}`, `需为不小于 0 的整数，实际为 ${JSON.stringify(v)}`, DEFAULTS.filters[k]);
    }
  }
  {
    const rl = getByPath(cfg, 'filters.replyLength');
    const preferOk = rl && Array.isArray(rl.prefer) && rl.prefer.length === 2 && rl.prefer.every(isPositiveNumber);
    const boundsOk = rl && Number.isInteger(rl.hardMin) && Number.isInteger(rl.hardMax) && rl.hardMin >= 0 && rl.hardMax >= rl.hardMin;
    if (!preferOk || !boundsOk) {
      fail(
        'filters.replyLength',
        `需为 { prefer:[最小,最大], hardMin, hardMax 且 hardMax>=hardMin }，实际为 ${JSON.stringify(rl)}`,
        DEFAULTS.filters.replyLength
      );
    }
  }
  for (const k of ['waterWords', 'toneWords', 'forbiddenPhrases', 'forbiddenPatterns']) {
    if (!Array.isArray(getByPath(cfg, `filters.${k}`))) {
      fail(`filters.${k}`, `需为数组，实际为 ${JSON.stringify(getByPath(cfg, `filters.${k}`))}`, DEFAULTS.filters[k]);
    }
  }
  for (const k of ['askForHelp', 'negativeEmotion']) {
    if (!Array.isArray(getByPath(cfg, `filters.prioritySignals.${k}`))) {
      fail(`filters.prioritySignals.${k}`, '需为数组', DEFAULTS.filters.prioritySignals[k]);
    }
  }
  {
    const eo = getByPath(cfg, 'filters.emojiOnly');
    const ok = eo && typeof eo.enabled === 'boolean' && Array.isArray(eo.map)
      && Array.isArray(eo.pool) && eo.pool.length > 0;
    if (!ok) {
      fail('filters.emojiOnly', `需为 { enabled, map:[], pool:[] }，实际为 ${JSON.stringify(eo)}`, DEFAULTS.filters.emojiOnly);
    }
  }

  // multimodal
  const mode = getByPath(cfg, 'multimodal.mode');
  if (!['text-only', 'screenshots', 'video'].includes(mode)) {
    fail('multimodal.mode', `需为 text-only / screenshots / video 之一，实际为 ${JSON.stringify(mode)}`, DEFAULTS.multimodal.mode);
  }

  return warnings;
}

// ═══════════════════════════════════════════════════════════
// 读取
// ═══════════════════════════════════════════════════════════

/**
 * 从磁盘读取用户配置原文。
 * 文件不存在或内容为空 → 空对象（正常情况，不是错误）；
 * 内容非法 JSON / 非对象 → 空对象 + 一条 '(file)' 告警。
 * @returns {{raw:object, warning:object|null}}
 */
function readRaw() {
  const file = paths.configFile();
  try {
    if (!fs.existsSync(file)) return { raw: {}, warning: null };
    const text = fs.readFileSync(file, 'utf8').trim();
    if (!text) return { raw: {}, warning: null };
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      return {
        raw: {},
        warning: { key: '(file)', message: `config.json 顶层需为对象，实际为 ${Array.isArray(parsed) ? '数组' : typeof parsed}，已全部使用默认值`, fallback: null },
      };
    }
    return { raw: parsed, warning: null };
  } catch (e) {
    return {
      raw: {},
      warning: { key: '(file)', message: `config.json 解析失败，已全部使用默认值：${e.message}`, fallback: null },
    };
  }
}

/** 加载并缓存。首次调用或 reload() 时执行 */
function ensureLoaded() {
  if (_merged) return;
  const { raw, warning } = readRaw();
  _raw = raw;
  const merged = deepMerge(DEFAULTS, _raw);
  const warns = validate(merged);
  // 文件级告警放在最前，便于诊断页优先展示
  _warnings = warning ? [warning, ...warns] : warns;
  _merged = merged;
}

/**
 * 重新从磁盘加载配置。桌面设置页保存后、或外部改了 config.json 时调用。
 * @returns {object} 重新加载后的完整配置
 */
function reload() {
  _merged = null;
  ensureLoaded();
  return deepClone(_merged);
}

/**
 * 取配置。
 * @param {string} [dotPath] - 点号路径，如 'llm.model'。省略则返回完整配置
 * @returns {*} 值的深拷贝
 */
function get(dotPath) {
  ensureLoaded();
  return deepClone(getByPath(_merged, dotPath));
}

/**
 * 取用户配置原文（不含默认值补齐项）。
 * 导出配置、或在设置页展示"用户显式改过什么"时用。
 */
function getRaw() {
  ensureLoaded();
  return deepClone(_raw);
}

/** 上次加载产生的校验告警 */
function getWarnings() {
  ensureLoaded();
  return _warnings.map(w => ({ ...w }));
}

// ═══════════════════════════════════════════════════════════
// 写入
// ═══════════════════════════════════════════════════════════

/**
 * 深合并写入用户配置并刷新内存。
 *
 * 只写用户配置原文（保留未知字段），不把默认值固化进文件 —— 这样默认值
 * 以后调整时老用户能自动享受新默认值。
 *
 * @param {object} patch - 要合并进去的配置片段，如 { llm: { model: 'x' } }
 * @returns {{config:object, warnings:Array}}
 */
function set(patch) {
  ensureLoaded();
  if (!isPlainObject(patch)) throw new TypeError('config.set(patch) 需要一个对象');

  const nextRaw = deepMerge(_raw, patch);
  const probe = deepMerge(DEFAULTS, nextRaw);
  const warnings = validate(probe);

  // 把校验修正回写到用户配置，保证落盘的文件里不含非法值。
  // 用户原始输入不丢 —— 通过返回值里的 warnings 告知调用方改了什么。
  for (const w of warnings) {
    if (w.key === '(file)') continue;
    setByPath(nextRaw, w.key, deepClone(w.fallback));
  }

  const file = paths.configFile();
  paths.ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(nextRaw, null, 2) + '\n');
  fs.renameSync(tmp, file);

  _raw = nextRaw;
  _merged = probe;
  _warnings = warnings;

  return { config: deepClone(_merged), warnings };
}

// ═══════════════════════════════════════════════════════════
// 诊断
// ═══════════════════════════════════════════════════════════

/**
 * 脱敏后的配置快照，供诊断页展示。
 * @returns {{file:string, exists:boolean, sensitiveKeys:string[], config:object, warnings:Array}}
 */
function describe() {
  ensureLoaded();
  const redacted = deepClone(_merged);
  for (const key of SENSITIVE_KEYS) {
    const v = getByPath(redacted, key);
    if (v) setByPath(redacted, key, `***已设置（${String(v).length} 字符）***`);
  }
  const file = paths.configFile();
  return {
    file,
    exists: fs.existsSync(file),
    sensitiveKeys: SENSITIVE_KEYS,
    config: redacted,
    warnings: getWarnings(),
  };
}

/** 清空内存缓存（测试用） */
function reset() {
  _merged = null;
  _raw = null;
  _warnings = [];
}

module.exports = {
  DEFAULTS,
  SENSITIVE_KEYS,
  get,
  getRaw,
  getWarnings,
  set,
  reload,
  describe,
  reset,
  // 供测试与工具使用
  _internal: { deepMerge, deepClone, validate },
};
