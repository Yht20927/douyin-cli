// core/runtime/context.js — 命令运行上下文（RunContext）工厂
//
// 为什么需要这一层
// ----------------
// 改造前，ctx 的组装逻辑直接写死在 cli.js:66-87 里，而 cli.js 是无 module.exports、
// require 即执行 main() 的脚本（硬约束 C1），Electron 主进程根本没法复用它。
//
// 把 ctx 的构造抽到这里之后：
//   - CLI（cli.js）与 Electron 主进程共用同一套组装逻辑，行为不会漂移
//   - ctx 可以在构造时注入 logger / signal / taskId，供 GUI 做进度与取消
//
// 新增字段（相对改造前的 ctx）
// ---------------------------
//   logger    —— 带 command/taskId 上下文的子 logger（P0 新增）
//   signal    —— AbortSignal，长任务取消（P0 起支持，TaskQueue 接入后生效）
//   taskId    —— 队列任务 ID（P0 起透传，P2 接入 TaskQueue）
//   profileId —— 多账号预留维度（D4，首版恒为 'default'）
//   events    —— 事件发射器（P2 接入 TaskQueue 后非空）
//
// 保持向后兼容：原有字段（bridge/audit/config/bridgeCall/loggedCall/cmdXxx）语义不变。

const { AuditLogger } = require('../audit');
const { BridgeClient } = require('../client/bridge-client');
const { SITE } = require('../commands/helpers');
const configModule = require('../config');
const loggerModule = require('./logger');

/** 默认 profile（D4 多账号预留：首版只有这一条路径） */
const DEFAULT_PROFILE = 'default';

/**
 * 创建命令运行上下文。
 *
 * @param {object} [opts]
 * @param {object} [opts.bridge]      - 复用已有 BridgeClient（测试注入）
 * @param {object} [opts.audit]       - 复用已有 AuditLogger（测试注入）
 * @param {string} [opts.command]     - 命令名，进日志上下文
 * @param {string} [opts.taskId]      - 队列任务 ID
 * @param {AbortSignal} [opts.signal] - 取消信号
 * @param {string} [opts.profileId]   - 账号 profile（多账号预留）
 * @param {string} [opts.accountUid]  - 当前操作账号 uid（CLI --account / GUI 当前账号）
 * @param {object} [opts.events]      - 事件发射器（TaskQueue 提供）
 * @param {Function} [opts.onWait]    - 节奏等待回调，见 core/risk-control.enforceDelay
 * @param {object} [opts.logContext]  - 附加到日志上的额外上下文
 * @param {Array}  [opts.extraSinks]  - 只挂在本 ctx 的 logger 上的额外 sink
 * @param {object} [opts.logger]      - 覆盖根 logger（缺省用全局单例）
 * @returns {object} ctx
 */
function createContext(opts = {}) {
  const config = configModule.get();

  const bridge = opts.bridge || new BridgeClient({
    host: config.bridge.host,
    port: config.bridge.port,
    token: config.bridge.token,
  });

  const audit = opts.audit || new AuditLogger();

  // extraSinks 只挂在这个 ctx 的 logger 上，不影响全局 ——
  // 任务队列靠它把单个任务的进度单独捕获出来（见 core/runtime/task-queue.js）
  const logger = (opts.logger || loggerModule.getLogger()).child(
    {
      profileId: opts.profileId || DEFAULT_PROFILE,
      ...(opts.command ? { command: opts.command } : {}),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      ...(opts.logContext || {}),
    },
    opts.extraSinks || []
  );

  const ctx = {
    // ── 原有字段（语义不变）──
    bridge,
    audit,
    config,
    // ── P0 新增 ──
    logger,
    signal: opts.signal || null,
    taskId: opts.taskId || null,
    profileId: opts.profileId || DEFAULT_PROFILE,
    // 本次调用要落到哪个账号。CLI 来自 --account/DOUYIN_ACCOUNT，GUI 来自
    // "当前在看哪个号"。为空时读操作由服务端轮换；写操作由服务端拒绝多账号歧义。
    accountUid: opts.accountUid != null && opts.accountUid !== '' ? String(opts.accountUid) : null,
    events: opts.events || null,
    // 节奏等待的回调。CLI 下为 null → enforceDelay 走默认的 stderr 打印；
    // GUI 下由 TaskQueue 注入 → 等待过程在界面上画倒计时并可取消。
    onWait: opts.onWait || null,
    // ── 通信（下面填充）──
    bridgeCall: null,
    loggedCall: null,
    // ── 命令间互相调用的引用（延迟绑定）──
    cmdGet: null,
    cmdPost: null,
    cmdAnalyze: null,
    cmdSearch: null,
    cmdLike: null,
  };

  // ═══ Bridge 通信 ═══
  // 账号从这里穿透到每一次请求：写操作带 opType:'write'，服务端据此强制
  // 显式账号并把 expectAccount 下发给油猴端二次校验。
  if (typeof audit.setAccount === 'function') audit.setAccount(ctx.accountUid);
  ctx.bridgeCall = async function bridgeCall(expression, awaitPromise = true, opts = {}) {
    const account = opts.account !== undefined ? opts.account : ctx.accountUid;
    const resp = await bridge.call({
      site: SITE,
      account: account || undefined,
      opType: opts.opType === 'write' ? 'write' : 'read',
      expression,
      awaitPromise,
    });
    if (resp.ok) {
      // 读操作未指定账号时由服务端轮换。把实际服务的账号钉在 ctx 上：
      // 同一命令的后续请求（翻页 get --all、逐条 enrich）必须继续找同一个号，
      // 否则 cursor 来自 A 号却拿去问 B 号，跨号拼接的结果会错乱。
      if (!ctx.accountUid && resp.account) ctx.accountUid = String(resp.account);
      if (typeof audit.setAccount === 'function') audit.setAccount(ctx.accountUid);
      return resp.value;
    }
    // 服务端的"账号未连接/多账号需指定"是用户可读的，原样抛出；
    // 其余错误保持改造前文案。
    const err = new Error(resp.error || 'Bridge Server 返回未知错误');
    if (resp.code) err.code = resp.code;
    if (resp.available) err.available = resp.available;
    throw err;
  };

  // 保持与改造前 cli.js:40-60 完全一致：把结果摘要同时写审计与 events 表
  ctx.loggedCall = async function loggedCall(endpoint, params, expression, opts = {}) {
    const t0 = Date.now();
    try {
      const result = await ctx.bridgeCall(expression, true, opts);
      const ms = Date.now() - t0;
      const sum = {};
      if (result) {
        if (result.comments) sum.count = result.comments.length;
        if (result.has_more !== undefined) sum.has_more = result.has_more;
        if (result.aweme_list) sum.count = result.aweme_list.length;
        if (result.data) sum.count = (result.data || []).filter(d => d.aweme_info).length;
        if (result.comment) { sum.cid = result.comment.cid; sum.status_code = 0; }
        if (result.status_code !== undefined && !sum.status_code) sum.status_code = result.status_code;
      }
      audit.logApiCall(endpoint, params, ms, 'success', sum);
      return result;
    } catch (e) {
      audit.logApiCall(endpoint, params, Date.now() - t0, 'error', { error: e.message });
      throw e;
    }
  };

  return ctx;
}

/**
 * 绑定命令互相调用的引用。
 *
 * 必须与 createContext 分开，因为 commands/index.js 里的命令模块会反过来
 * require 本模块 —— 在 createContext 内部同步 require('../commands') 会形成环。
 * 调用方（cli.js / Electron 主进程）负责在创建 ctx 之后调用一次。
 *
 * @param {object} ctx
 * @param {object} [commands] - 命令注册表，缺省用 require('../commands')
 * @returns {object} 同一个 ctx（便于链式）
 */
function bindCommands(ctx, commands) {
  const registry = commands || require('../commands');
  ctx.cmdGet = (args) => registry.get(ctx, args);
  ctx.cmdPost = (args) => registry.post(ctx, args);
  ctx.cmdAnalyze = (args) => registry.analyze(ctx, args);
  ctx.cmdSearch = (args) => registry.search(ctx, args);
  ctx.cmdLike = (args) => registry.like(ctx, args);
  return ctx;
}

module.exports = {
  createContext,
  bindCommands,
  DEFAULT_PROFILE,
};
