// lib/commands/helpers.js — 命令共享的辅助函数和上下文

const { sleepAbortable } = require('../runtime/abort');

const SITE = 'douyin.com';

/**
 * 转义字符串，使其可以安全地放进单引号包裹的 JS 表达式。
 *
 * 用途：命令会把「一段 JS 表达式」通过 Bridge 发到浏览器页面里 eval，
 * 参数都是拼进这段表达式字符串的。所以这里必须产出合法的 JS 字符串字面量内容。
 *
 * ⚠️ 这里曾经只转义 `\` 和 `'`，**漏了换行**。后果是：任何含换行的回复内容
 * 都会让拼出来的表达式出现未转义的换行，浏览器侧直接报
 * `SyntaxError: string literal contains an unescaped line break`，
 * 发布失败 —— 而 AI 生成的回复里带换行相当常见。
 *
 * 现在改为借助 JSON.stringify 产出转义体：它一次覆盖反斜杠、双引号、
 * 换行（\n）、回车（\r）、制表符与各类控制字符，不会再漏。
 * 只需额外处理单引号 —— JSON 不转义它，但调用方用单引号包裹。
 *
 * @param {*} s
 * @returns {string} 可直接放进 '...' 中的内容（不含首尾引号）
 */
function escapeExpression(s) {
  // 保持原有的 null/undefined 语义（String(null) === 'null'），
  // 不顺手改成空串 —— 那是调用方的 bug，应该显式暴露而不是被这里抹平。
  const json = JSON.stringify(String(s));
  if (json === undefined) return '';
  return json.slice(1, -1)
    // 单引号：JSON 不转义它，但调用方用单引号包裹
    .replace(/'/g, "\\'")
    // U+2028 / U+2029：JSON 认为它们可以直接出现，但它们在 JS 里是**行终止符**。
    // ES2019 起允许出现在字符串字面量中，旧引擎会报 "unescaped line break"。
    // 抖音页面是现代 Chrome，不受影响；但转义掉成本为零，
    // 也让"结果里不含任何行终止符"成为一个可以写死的不变量。
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * 从参数列表中提取 --flag value 形式的选项
 */
function getFlag(args, flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx === -1) return defaultValue;
  const val = args[idx + 1];
  if (val === undefined || typeof val !== 'string' || val.startsWith('--')) return defaultValue;
  const n = Number(val);
  // 19 位抖音 ID 超过 JS 安全整数范围，必须保持字符串
  if (isNaN(n)) return val;
  if (n > Number.MAX_SAFE_INTEGER || n < Number.MIN_SAFE_INTEGER) return val;
  return n;
}

/**
 * 格式化评论数据（清洗字段、截断文本）
 */
function formatComment(c) {
  const out = {
    cid: c.cid != null ? String(c.cid) : c.cid,
    text: (c.text || '').substring(0, 120),
    likes: c.digg_count || c.likes || 0,
    replies: c.reply_comment_total || c.replies || 0,
    time: c.create_time || c.time || 0,
    user: c.user ? {
      nickname: c.user.nickname,
      uid: c.user.uid || c.user.uid_str,
      avatar: c.user.avatar_thumb?.url_list?.[0] || c.user.avatar_medium?.url_list?.[0] || '',
    } : null,
  };
  if (c.children) out.children = c.children;
  return out;
}

/** 随机选择数组中的一个元素 */
function randomChoice(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 随机整数 [min, max] */
function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** 加权随机选择 */
function weightedRandom(items, weights) {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const w = weights || items.map(() => 1);
  const total = w.reduce((s, x) => s + x, 0);
  let rnd = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    rnd -= w[i];
    if (rnd <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * 统一命令审计样板：startOperation → work → endOperation。
 *
 * 收敛各命令重复的 startOperation / try-catch-end('error') / endOperation('success')
 * 三段式；出错时自动以 'error' 收尾并重新抛出（与旧命令依赖 cli.js 主入口
 * 兜底 endOperation 的行为一致，但不再需要触碰 audit._currentOp 私有字段）。
 *
 * @param {object} ctx - { audit }
 * @param {string} opName - 操作名（events.command / audit operation）
 * @param {object} meta - 操作参数元数据（透传 startOperation 第二参）
 * @param {() => Promise<{summary?: object, result?: any, output?: any}>} work
 *   - summary: 端成功摘要（endOperation 第二参，默认 {}）
 *   - result:  附加结果对象（endOperation 第三参，原样透传——key 结构由调用方决定，
 *              如 { result: items } 或 { comments: items }）
 *   - output:  命令最终返回值（缺省 undefined）
 * @returns {Promise<any>} work().output
 */
async function withAudit(ctx, opName, meta, work) {
  const audit = ctx.audit;
  audit.startOperation(opName, meta);
  let out;
  try {
    out = await work();
  } catch (e) {
    audit.endOperation('error', {}, null, e.message);
    throw e;
  }
  audit.endOperation(out?.status || 'success', out?.summary || {},
    out?.result !== undefined ? out.result : null);
  return out?.output;
}

/**
 * 构造 risk-control.enforceDelay 的选项。
 *
 * 把 ctx 上的取消信号与等待回调透传下去 —— CLI 下这两个都是 undefined，
 * 于是 enforceDelay 走默认的 stderr 打印，输出与改造前逐字节一致；
 * GUI 下由 TaskQueue 注入，等待过程就能在界面上画倒计时并可取消。
 *
 * @param {object} ctx
 * @param {string[]} args
 * @returns {{force:boolean, signal:(AbortSignal|null|undefined), onWait:(Function|null|undefined)}}
 */
function throttleOpts(ctx, args) {
  return {
    force: Array.isArray(args) && args.includes('--no-throttle'),
    signal: ctx ? ctx.signal : undefined,
    onWait: ctx ? ctx.onWait : undefined,
  };
}

/**
 * 一条命令**内部**重复请求之间的等待（区间单位是秒，取自 config.intervals）。
 *
 * 为什么需要它、而不是直接用 riskControl.enforceDelay：
 * enforceDelay 读的是 events 表里"上一条命令"的成功时间，而那一行是在
 * `endOperation` 时才写的 —— 于是一条跑 200 次请求的命令（逐条补全、全量翻页）
 * 在循环里每次算出的"距上次读"都是同一个旧值，**内部零间隔**。
 * 换句话说：命令与命令之间的节奏有人管，命令内部的没人管 —— 而"内部"才是量大的一面。
 * 每个调用点都该显式等一次，这就是 get.js 的翻页等待与 enrich.js 的逐条等待共用的那段。
 *
 * @param {number[]} range - [minSec, maxSec]；传空数组或 [0,0] 表示不等
 * @param {object} [opts] - { signal, onWait } 取消信号 / 等待上报
 */
async function pace(range, opts = {}) {
  const [a, b] = Array.isArray(range) && range.length === 2 ? range : [0, 0];
  const lo = Math.round(Math.min(a, b) * 1000);
  const hi = Math.round(Math.max(a, b) * 1000);
  const ms = hi > lo ? randomInt(lo, hi) : lo;
  if (ms <= 0) return;

  // 上报等待：这是**量大的一面**（逐条补全、全量翻页每轮都走这里），
  // 而改造前这里是一段裸 sleep —— 界面上"读间隔到底还要等多久"永远是问号。
  // 与 enforceDelay 同一个回调契约，所以队列只管落一处。
  // onWait 缺省（CLI）时什么都不做：命令行输出保持与改造前逐字节一致。
  const { signal, onWait } = opts;
  if (onWait) {
    onWait({
      phase: 'pace',
      waitMs: ms,
      deadline: Date.now() + ms,
      reason: `单次请求之间的节奏，等 ${Math.ceil(ms / 1000)}s（配置 ${a}–${b}s）`,
      type: 'read',
    });
  }
  // 被打断时不补报 end：抛错会一路出命令入口，队列的 finally 负责清 task.wait
  await sleepAbortable(ms, signal);
  if (onWait) onWait({ phase: 'end', waitMs: 0, deadline: Date.now(), reason: '', type: 'read' });
}

module.exports = {
  SITE,
  escapeExpression,
  getFlag,
  formatComment,
  randomChoice,
  randomInt,
  weightedRandom,
  withAudit,
  throttleOpts,
  pace,
};
