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

  try {
    return await handler(ctx, argv);
  } catch (e) {
    closeUnclosedOperation(ctx, e);
    throw e;
  }
}

/**
 * 审计兜底：命令中途抛错且没自己收尾时，把未闭合的操作记为 error。
 *
 * 改造前这段逻辑写在 cli.js 的 catch 里，桌面应用走 runCommand 就漏掉了 ——
 * 于是 GUI 侧的执行失败不会进 events 表，事件日志与失败模式学习都会缺数据。
 * 移到 core 后 CLI 与 GUI 得到同一保证。
 *
 * endOperation 自身对 `_noLog` 与 `_currentOp` 为 null 都有守卫，
 * 因此这里重复调用是安全且幂等的（命令已自行收尾时不会产生第二条记录）。
 *
 * @param {object} ctx
 * @param {Error} e
 */
function closeUnclosedOperation(ctx, e) {
  try {
    if (ctx && ctx.audit && typeof ctx.audit.endOperation === 'function') {
      ctx.audit.endOperation('error', {}, null, (e && e.message) || String(e));
    }
  } catch (_) {
    // 兜底逻辑本身绝不能掩盖原始错误
  }
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
    // 桌面版的桥接服务是随应用启动的，这里只给 `node server.js` 的话，
    // 界面用户会被指向一个他根本没有的终端（同一类问题见 问题.md §三 的空态）。
    return [
      '错误: Bridge Server 未启动，命令发不出去',
      '  桌面应用：重启本工具即可（服务随应用启动）；仍不行看「诊断」页有没有端口冲突',
      '  命令行：先运行 node server.js',
    ];
  }
  if (msg.includes('Unauthorized')) {
    return [
      '错误: 认证失败 —— 浏览器里的脚本和本工具之间的凭证对不上',
      '  桌面应用：到「连接」页重新安装一次脚本（安装地址里带着当前凭证）',
      '  命令行：检查 config.json 中的 bridge.token 是否与脚本一致',
    ];
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
  closeUnclosedOperation,
};
