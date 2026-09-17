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

  // bridge
  const port = getByPath(cfg, 'bridge.port');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail('bridge.port', `端口需为 1-65535 的整数，实际为 ${JSON.stringify(port)}`, DEFAULTS.bridge.port);
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
