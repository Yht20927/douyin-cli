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
 * @param {object} [opts.events]      - 事件发射器（TaskQueue 提供）
 * @param {object} [opts.logContext]  - 附加到日志上的额外上下文
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

  const logger = loggerModule.getLogger().child({
    profileId: opts.profileId || DEFAULT_PROFILE,
    ...(opts.command ? { command: opts.command } : {}),
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.logContext || {}),
  });

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
    events: opts.events || null,
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
  // 保持与改造前 cli.js:34-38 完全一致的行为
  ctx.bridgeCall = async function bridgeCall(expression, awaitPromise = true) {
    const resp = await bridge.call({ site: SITE, expression, awaitPromise });
    if (resp.ok) return resp.value;
    throw new Error(resp.error || 'Bridge Server 返回未知错误');
  };

  // 保持与改造前 cli.js:40-60 完全一致：把结果摘要同时写审计与 events 表
  ctx.loggedCall = async function loggedCall(endpoint, params, expression) {
    const t0 = Date.now();
    try {
      const result = await ctx.bridgeCall(expression);
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
