#!/usr/bin/env node
// cli.js — 抖音评论 CLI 入口（薄壳）
//
// 本文件只做四件事：解析 argv → 建 ctx → 调 runCommand → 打印结果 / 友好报错。
// 真正的实现在 core/runtime/ 与 core/commands/ —— 这样 Electron 主进程可以复用
// 同一套调度与错误文案（改造前 ctx 组装写在 cli.js 里且 require 即执行 main()，
// 主进程无法复用，见硬约束 C1）。
//
// 前置条件：
//   1. Bridge Server 运行中（node server.js，或由桌面应用内置启动）
//   2. 浏览器已安装油猴脚本 scripts/douyin.user.js
//   3. 浏览器已打开 douyin.com 任意页面且处于登录态

const loggerModule = require('./core/runtime/logger');
const { createContext, bindCommands } = require('./core/runtime/context');
const { runCommand, describeError } = require('./core/runtime/run-command');
const { safeSerialize } = require('./core/shared/serialize');

// ═══════════════════════════════════════════════════════════
// 帮助
// ═══════════════════════════════════════════════════════════

// 说明：本文件刻意保留两处 console.log（help 文本与最终 JSON 结果）。
// 它们是 CLI 与终端之间的**直接契约输出**，不是可路由的日志 —— 走 logger
// 反而会让 help 之类的正常输出混进 app.log。诊断类输出一律经 logger。
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

  通用选项： --no-log（本次不记录日志）
  环境变量： DOUYIN_DEBUG=1 输出 debug 级日志

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

  if (!cmd || cmd === 'help' || cmd === '--help') {
    printHelp();
    return;
  }

  const noLog = args.includes('--no-log');

  // 日志 sink：console（诊断→stderr、输出→stdout，与改造前逐字节一致）
  // + 文件（JSON Lines 留痕，解决"诊断只进 stderr、进程一退就没了"）
  loggerModule.configure({
    sinks: [loggerModule.consoleSink(), loggerModule.fileSink()],
    level: process.env.DOUYIN_DEBUG ? 'debug' : 'info',
  });

  const ctx = createContext({ command: cmd });
  bindCommands(ctx);
  ctx.audit.setNoLog(noLog);

  try {
    loggerModule.resetOutputCount();
    const result = await runCommand(ctx, cmd, args.slice(1));

    // stdout 只放命令返回的 JSON —— 所有日志一律走 stderr，保证可管道解析。
    //
    // 但有些命令在人类可读模式下已经自己输出过了（如 `replied` 逐行打印 cid、
    // `log` 打印可读行），此时再打印一遍 JSON 会破坏原有输出格式。
    // 约定：本次运行产生过 output 就不再打印返回值 ——
    // 这样命令可以「无条件返回结构化数据」（GUI 需要）而 CLI 行为保持不变。
    if (result !== undefined && loggerModule.outputCount() === 0) {
      console.log(JSON.stringify(safeSerialize(result), null, 2));
    }
  } catch (e) {
    if (!noLog && ctx.audit._currentOp) {
      ctx.audit.endOperation('error', {}, null, e.message);
    }
    // 经 logger 输出而不是直接 console.error —— 这样报错也会写进 app.log 留痕
    const logger = loggerModule.getLogger();
    for (const line of describeError(e)) logger.error(line);
    process.exit(1);
  } finally {
    loggerModule.getLogger().close();
  }
}

// 直接运行时才执行；被 require 时不动 —— 彻底解决"require 即执行 main"（C1）
if (require.main === module) main();
