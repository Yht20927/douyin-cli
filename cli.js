#!/usr/bin/env node
// cli.js — 抖音评论 CLI（Bridge Framework 版）
//
// 依赖 Bridge Server (server.js) 运行中，
// 且浏览器已安装油猴脚本 scripts/douyin.user.js 并打开 douyin.com 页面。

const fs = require('fs');
const path = require('path');
const { AuditLogger } = require('./core/audit');
const { BridgeClient } = require('./core/client/bridge-client');
const { safeSerialize } = require('./core/shared/serialize');
const commands = require('./core/commands');
const { SITE } = require('./core/commands/helpers');

// ── 配置（经 core/config 单一真源，含默认值合并与校验）──
const config = require('./core/config').get();

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
  cmdSearch: null,
  cmdLike: null,
};

// 绑定命令（注入上下文）
ctx.cmdGet = (args) => commands.get(ctx, args);
ctx.cmdPost = (args) => commands.post(ctx, args);
ctx.cmdAnalyze = (args) => commands.analyze(ctx, args);
ctx.cmdSearch = (args) => commands.search(ctx, args);
ctx.cmdLike = (args) => commands.like(ctx, args);

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
  node cli.js user <sec_user_id | 主页URL>     查看用户作品信息 (--count N --cursor <ts>)
  node cli.js post <aweme_id> "内容"           发表评论
  node cli.js post <aweme_id> "回复" --reply-to <cid>
  node cli.js post <aweme_id> "@1179139456380456 内容" --reply-to <cid> --at <uid> <sec_uid>
  node cli.js post <aweme_id> "内容" --image <图片路径>     发表图片评论（--image 可重复/逗号分隔）
  node cli.js upload-image --image <图片路径>               仅上传图片，返回 uri（不发评论）
  node cli.js like <aweme_id>                 点赞视频
  node cli.js like <aweme_id> --unlike        取消点赞
  node cli.js delete-comment <cid>            删除评论
  node cli.js analyze <aweme_id>              LLM 分析（情感/分类/优先级）
  node cli.js suggest <aweme_id>              LLM 回复建议（--auto 自动发布）
  node cli.js log [--tail N] [--video <id>] [--uid <uid>] [--command <cmd>] [--failed]
  node cli.js profile <uid>                   用户交互历史（事件流）
  node cli.js whois <uid>                     用户全量画像（评论 + 我的回复 + 标签）
  node cli.js note <uid> [--tier vip|normal|blacklist|spam] [--tag T] [--untag T] [--notes "..."] [--clear]
  node cli.js events [--tail N] [--video <id>] [--uid <uid>] [--cmd <cmd>] [--status success|error] [--since <ts>] [--json]
  node cli.js corpus <search|recent|stats> [...]   回复语料库
  node cli.js failures [--limit N] [--recent]      失败模式 top-N（避雷清单）
  node cli.js dedup "<候选回复文本>"                  检查文本是否曾经发过
  node cli.js replied                                已回复 cid 列表（--json --aweme <id>）
  node cli.js replied --count                        已回复总数
  node cli.js dm send <user_id> "内容"            发送私信
  node cli.js dm listen [--timeout N]              监听收到的私信
  node cli.js dm list                              查看最近收到的消息
  node cli.js cleanup [--days 90] [--dry-run]      清理过期记忆（events/comments/corpus）
  node cli.js preflight [command]           节奏守卫自检（距下次写需等多久 / 命令是否可执行）

  AI 回复生成（ReplyEngine）：
  node cli.js getReply <aweme_id>                    生成视频的顶级评论
  node cli.js getReply <aweme_id> <cid>              生成对特定评论的回复
  node cli.js getReply <aweme_id> --count N           生成多条候选评论
  node cli.js getReply <aweme_id> --persona <id>      指定人格
  node cli.js getReply <aweme_id> --batch             批量生成回复（对未回复评论）
  node cli.js getReply <aweme_id> <cid> --interactive  交互式审核（生成→编辑→发布）

  草稿管理：
  node cli.js draft list [--video <aweme_id>]        列出待发布草稿
  node cli.js draft save <aweme_id> "文本" [--reply-to <cid>] [--persona <id>]  保存草稿
  node cli.js draft show <draft_id>                   查看草稿
  node cli.js draft post <draft_id>                   发布草稿
  node cli.js draft delete <draft_id>                 删除草稿

  node cli.js comment <cid>                           查询单条评论实体
  node cli.js validate-prompts [<template>]           校验提示词模板格式

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
      console.log(JSON.stringify(safeSerialize(result), null, 2));
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
    } else if (/HTML 页面|非 JSON|空响应/.test(e.message)) {
      // 油猴端 bridgeFetchJson 抛出的友好错误，原样输出（已含 hint）
      console.error(`错误: ${e.message}`);
      console.error('提示: 若反复出现，请刷新 douyin.com 页面并确认仍处于登录态；写操作短时间内频繁失败通常是触发了风控，建议间隔 30 分钟后再试。');
    } else {
      console.error(`错误: ${e.message}`);
    }
    process.exit(1);
  }
}

main();
