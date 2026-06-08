#!/usr/bin/env node
// cli.js — 抖音评论 CLI（Bridge Framework 版）
//
// 依赖 Bridge Server (server.js) 运行中，
// 且浏览器已安装油猴脚本 scripts/douyin.user.js 并打开 douyin.com 页面。

const fs = require('fs');
const path = require('path');
const { AuditLogger } = require('./lib/audit');
const { BridgeClient } = require('./lib/client/bridge-client');
const commands = require('./lib/commands');
const { SITE } = require('./lib/commands/helpers');

// ── 配置 ──
let config = {};
try { config = require('./config.json'); } catch (e) { /* use defaults */ }

// ── Bridge 客户端 ──
const bridge = new BridgeClient({
  host: config.bridge?.host || '127.0.0.1',
  port: config.bridge?.port || 19422,
  token: config.bridge?.token || '',
});

// ── 审计日志 ──
const audit = new AuditLogger();
let noLog = false;

// ═══════════════════════════════════════════════════════════
// Bridge 通信（通过 BridgeClient）
// ═══════════════════════════════════════════════════════════

async function bridgeCall(expression, awaitPromise = true) {
  const resp = await bridge.call({ site: SITE, expression, awaitPromise });
  if (resp.ok) return resp.value;
  throw new Error(resp.error || 'Bridge Server 返回未知错误');
}

async function loggedCall(endpoint, params, expression) {
  const t0 = Date.now();
  try {
    const result = await bridgeCall(expression);
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
}

// ═══════════════════════════════════════════════════════════
// 命令上下文（注入到各命令模块）
// ═══════════════════════════════════════════════════════════

const ctx = {
  bridge,
  audit,
  config,
  bridgeCall,
  loggedCall,
  // 命令间互相调用的引用（延迟绑定）
  cmdGet: null,
  cmdPost: null,
  cmdAnalyze: null,
};

// 绑定命令（注入上下文）
ctx.cmdGet = (args) => commands.get(ctx, args);
ctx.cmdPost = (args) => commands.post(ctx, args);
ctx.cmdAnalyze = (args) => commands.analyze(ctx, args);

// ═══════════════════════════════════════════════════════════
// 帮助
// ═══════════════════════════════════════════════════════════

function printHelp() {
  console.log(`
Douyin Comment CLI (Bridge Framework)

  node cli.js search <keyword>                搜索视频
  node cli.js get <aweme_id>                  获取评论 (--all --depth N --new --since <ts>)
  node cli.js replies <cid> <aweme_id>        获取回复列表
  node cli.js my                              我的作品
  node cli.js post <aweme_id> "内容"           发表评论
  node cli.js post <aweme_id> "回复" --reply-to <cid>
  node cli.js post <aweme_id> "@1179139456380456 内容" --reply-to <cid> --at <uid> <sec_uid>
  node cli.js analyze <aweme_id>              LLM 分析（情感/分类/优先级）
  node cli.js suggest <aweme_id>              LLM 回复建议（--auto 自动发布）
  node cli.js dashboard                       仪表盘 HTML
  node cli.js dashboard --video <aweme_id> --days 14
  node cli.js log [--tail N] [--video <id>] [--failed]
  node cli.js profile <uid>                   用户交互历史

  通用选项： --raw（原始输出） --no-log（本次不记录日志）

  前置条件：
  1. Bridge Server 运行中: node server.js
  2. 浏览器已安装油猴脚本 scripts/douyin.user.js
  3. 浏览器已打开 douyin.com 任意页面
`);
}

// ═══════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const rawMode = args.includes('--raw');
  noLog = args.includes('--no-log');
  audit.setNoLog(noLog);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    printHelp();
    return;
  }

  const handler = commands[cmd];
  if (!handler) {
    console.error(`未知命令: ${cmd}`);
    console.error('运行 "node cli.js help" 查看用法。');
    process.exit(1);
  }

  try {
    const result = await handler(ctx, args.slice(1));
    if (result !== undefined) {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (e) {
    if (!noLog && audit._currentOp) {
      audit.endOperation('error', {}, null, e.message);
    }
    // ECONNREFUSED 友好提示
    if (e.message.includes('ECONNREFUSED') || e.message.includes('Bridge Server 未启动')) {
      console.error('错误: Bridge Server 未启动，请先运行:');
      console.error('  node server.js');
    } else if (e.message.includes('Unauthorized')) {
      console.error('错误: 认证失败 — 请检查 config.json 中的 bridge.token');
    } else {
      console.error(`错误: ${e.message}`);
    }
    process.exit(1);
  }
}

main();
