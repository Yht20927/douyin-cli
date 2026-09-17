// core/runtime/run-command.js — 命令调度与错误归一化
//
// 为什么需要这一层
// ----------------
// 改造前这段逻辑写在 cli.js:157-211 的 main() 里，而 cli.js 是无 module.exports、
// require 即执行 main() 的脚本（硬约束 C1），Electron 主进程无法复用。
// 抽出来之后 CLI 与 GUI 共用同一套调度与错误映射，提示文案不会漂移。

const commands = require('../commands');

/** 全部已注册命令名 */
function listCommands() {
  return Object.keys(commands);
}

/** 命令是否存在 */
function hasCommand(name) {
  return Object.prototype.hasOwnProperty.call(commands, name);
}

/**
 * 执行一条命令。
 *
 * 约定：命令签名统一为 `(ctx, argv) => Promise<any>`，这与改造前
 * cli.js 的 `commands[cmd](ctx, args.slice(1))` 完全一致。
 *
 * @param {object} ctx   - 由 createContext() 创建的上下文
 * @param {string} name  - 命令名
 * @param {string[]} argv - 命令参数（不含命令名本身）
 * @returns {Promise<any>} 命令返回值（undefined 表示命令自己已输出内容）
 * @throws {Error} 未知命令时抛 code='UNKNOWN_COMMAND' 的错误
 */
async function runCommand(ctx, name, argv = []) {
  if (!ctx) throw new Error('runCommand(ctx, name, argv)：ctx 不能为空');
  const handler = commands[name];
  if (!handler) {
    const err = new Error(`未知命令: ${name}`);
    err.code = 'UNKNOWN_COMMAND';
    throw err;
  }
  return handler(ctx, argv);
}

/**
 * 把错误归一化为面向用户的提示。CLI 打印它，GUI 显示它 —— 同一套文案。
 *
 * 返回多行数组而不是单行，因为部分错误有配套的"怎么做"提示。
 *
 * @param {Error} e
 * @returns {string[]} 待展示的行
 */
function describeError(e) {
  const msg = (e && e.message) || String(e);

  if (e && e.code === 'UNKNOWN_COMMAND') {
    return [msg, '运行 "node cli.js help" 查看用法。'];
  }
  if (msg.includes('ECONNREFUSED') || msg.includes('Bridge Server 未启动')) {
    return ['错误: Bridge Server 未启动，请先运行:', '  node server.js'];
  }
  if (msg.includes('Unauthorized')) {
    return ['错误: 认证失败 — 请检查 config.json 中的 bridge.token'];
  }
  // 油猴端 bridgeFetchJson 抛出的两类友好错误（scripts/douyin.user.js）：
  //   「抖音返回了 HTML 页面（可能登录态失效/被风控/账号校验中）...」
  //   「响应不是合法 JSON」
  // 注：改造前这里的正则写作 /非 JSON/，而实际文案是「不是合法 JSON」——
  // 少了那个"法"字就永远匹配不上，导致第二条提示从未生效。此处一并修正，
  // 因为"刷新页面确认登录态 + 疑似风控"正是非 JSON 响应的正确处理建议。
  if (/HTML 页面|合法 JSON|空响应/.test(msg)) {
    return [
      `错误: ${msg}`,
      '提示: 若反复出现，请刷新 douyin.com 页面并确认仍处于登录态；写操作短时间内频繁失败通常是触发了风控，建议间隔 30 分钟后再试。',
    ];
  }
  return [`错误: ${msg}`];
}

module.exports = {
  listCommands,
  hasCommand,
  runCommand,
  describeError,
};
