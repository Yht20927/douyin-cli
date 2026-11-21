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
const { flattenConnections } = require('./core/shared/protocol');
const { extractAccountArg, CLIENT_PROTOCOL_VERSION } = require('./core/commands/helpers');
const accountsModule = require('./core/memory/accounts');

// ═══════════════════════════════════════════════════════════
// 账号准入（多账号）
//
// 服务端已经有两道护栏：指定账号必须精确命中、写操作多账号时拒绝歧义。
// 这里做的是 CLI 体验层：
//   - 把 --account（uid 或昵称）解析成在线连接的真实 uid
//   - 读取自身数据的命令（my / dm list）在多个号在线时必须显式指定
//   - 把在线账号与脚本版本打到 stderr，stdout 保持纯数据
// ═══════════════════════════════════════════════════════════

/** 需要浏览器连接的命令。其余命令只读写本地库，「账号离线」不该拦住它们。 */
const BRIDGE_COMMANDS = new Set([
  'search', 'get', 'replies', 'my', 'user', 'enrich',
  'post', 'upload-image', 'like', 'delete-comment',
  'analyze', 'suggest', 'dm', 'getReply',
]);

function commandUsesBridge(cmd, args) {
  if (cmd === 'draft') return args[0] === 'post';
  return BRIDGE_COMMANDS.has(cmd);
}

/** 会真正在平台上产生写操作的调用（复合命令按最内层判定） */
function isWriteInvocation(cmd, args) {
  switch (cmd) {
    case 'post':
    case 'like':
    case 'delete-comment':
    case 'upload-image':
      return true;
    case 'dm':
      return args[0] === 'send';
    case 'draft':
      return args[0] === 'post';
    case 'suggest':
      return args.includes('--auto');
    case 'getReply':
      return args.includes('--interactive');
    default:
      return false;
  }
}

/** 读取「当前账号自身」的数据：不同账号结果完全不同，多账号时必须显式指定 */
function isIdentityScoped(cmd, args) {
  if (cmd === 'my') return true;
  if (cmd === 'dm') return args[0] === 'list' || args[0] === 'listen';
  return false;
}

function accountLabel(a) {
  if (!a) return '';
  const base = a.nickname ? `${a.nickname}(${a.uid})` : a.uid;
  if (a.clientVersion !== CLIENT_PROTOCOL_VERSION) {
    return `${base} ⚠脚本v${a.clientVersion == null ? '?' : a.clientVersion}`;
  }
  return base;
}

/** 在线账号（按 uid 去重，只取活着的、认得出账号的连接） */
async function fetchOnlineAccounts(bridge) {
  try {
    const st = await bridge.status();
    const seen = new Map();
    // /api/status 的 connections 是**按站点分组的对象**（线格式），不是数组。
    // 直接 for…of 会抛 TypeError，再被下面的 catch 吞成"没有在线账号" ——
    // 于是多账号的写准入与 --account 解析全部静默失效。统一走 flattenConnections。
    for (const c of flattenConnections(st)) {
      if (!c || c.alive === false) continue;
      const uid = c.uid || (c.account && c.account.uid) || '';
      if (!uid) continue;
      const key = String(uid);
      const next = {
        uid: key,
        nickname: c.nickname || (c.account && c.account.nickname) || '',
        clientVersion: typeof c.clientVersion === 'number' ? c.clientVersion : null,
      };
      // 同账号多标签页：优先保留上报了脚本版本的那条 —— 否则一个旧标签页
      // 会让整个账号被误报成"脚本不是最新版"。
      const prev = seen.get(key);
      if (!prev || (prev.clientVersion == null && next.clientVersion != null)) seen.set(key, next);
    }
    return [...seen.values()];
  } catch (e) {
    // 服务没起 / 端口不通：账号入退让位于后续命令自己报"未启动"，
    // 这里静默返回空表（本地查询命令因此照常可用）。
    return [];
  }
}

function printAccountBanner(rawAccount, resolvedUid, online, mode) {
  if (process.env.DOUYIN_NO_ACCOUNT_BANNER === '1') return;
  const names = online.map(accountLabel).join('、');
  if (rawAccount) {
    const hit = online.find(a => a.uid === String(resolvedUid));
    console.error(`[账号] 指定 ${hit ? accountLabel(hit) : resolvedUid}（在线 ${online.length}：${names || '无'}）`);
  } else if (online.length > 0) {
    console.error(`[账号] 在线 ${online.length}：${names}${mode === 'read' ? '（读操作按账号轮换）' : ''}`);
  } else {
    console.error('[账号] 无账号在线 — 确认浏览器已登录对应账号并打开站点页面（未登录的标签页不会连接）');
  }
  const stale = online.filter(a => a.clientVersion !== CLIENT_PROTOCOL_VERSION);
  if (stale.length > 0) {
    const got = stale.map(a => (a.clientVersion == null ? '未上报' : a.clientVersion)).join('/');
    console.error(`[账号] ⚠ ${stale.map(a => a.uid).join('、')} 的油猴脚本不是最新版（上报 v${got}，当前 v${CLIENT_PROTOCOL_VERSION}）`
      + ' — 昵称等新字段不会出现，去 Tampermonkey 重装 scripts/douyin.user.js');
  }
}

/**
 * 解析本次调用的账号，并做写操作/自身数据的准入。
 *
 * @returns {Promise<{uid: string|null, online: Array, mode: string}>}
 */
async function resolveAccountForCommand(ctx, rawAccount, cmd, args) {
  const online = await fetchOnlineAccounts(ctx.bridge);
  let uid = rawAccount ? accountsModule.resolveUid(rawAccount) : null;

  if (rawAccount) {
    // 本地名册认不出时，用在线列表的昵称兜底（账号可能刚登录、还没落库）
    const hit = online.find(a =>
      a.uid === String(rawAccount)
      || a.nickname === String(rawAccount)
      || a.uid === String(uid)
      || a.nickname === String(uid)
    );
    if (hit) uid = hit.uid;
    else if (commandUsesBridge(cmd, args)) {
      const list = online.length
        ? `\n当前在线：\n${online.map(a => `  ${accountLabel(a)}`).join('\n')}`
        : '\n当前没有在线账号。';
      // 区分"名册里有、但现在没连"与"完全没见过"：前者让用户去浏览器登录，
      // 后者多半是 uid/昵称打错了 —— 两种情况给的动作不一样。
      const known = uid ? accountsModule.get(String(uid)) : null;
      const why = known
        ? `账号 "${rawAccount}" 未连接（本机登记过 ${known.nickname || known.uid}）。`
        : `未知账号 "${rawAccount}"。`;
      throw new Error(`${why}${list}\n请用浏览器登录该账号后重试，或直接传在线账号的 uid。`);
    }
  }

  const mode = isWriteInvocation(cmd, args) ? 'write'
    : (isIdentityScoped(cmd, args) ? 'identity' : 'read');

  if (!uid && mode !== 'read') {
    if (online.length > 1) {
      const list = online.map(a => `  ${accountLabel(a)}`).join('\n');
      const what = mode === 'identity'
        ? '该命令读取「当前账号」自身的数据，'
        : '写操作';
      throw new Error(`当前有 ${online.length} 个账号在线，${what}必须用 --account 显式指定账号：\n${list}`);
    }
    if (online.length === 1) uid = online[0].uid;
  }

  return { uid: uid || null, online, mode };
}

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
                                              --all 全量：逐页拉到底，跨页去重、页间按
                                              intervals.commentPage(默认 1-3 秒)等待
  node cli.js replies <cid> <aweme_id>        获取回复列表
  node cli.js my                              我的作品
  node cli.js videos                          本地视频列表 (--mine --account <uid> --limit N --json)
  node cli.js user <sec_user_id | 主页URL>     查看用户作品信息 (--count N --cursor <ts>)
  node cli.js enrich [aweme_id]               补全视频信息（标题/封面/互动数据）
                                              (--missing 默认，只补没标题的；--all 全部重抓；--limit N)
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
             --account <uid|昵称>（多账号时指定；本地查询命令兼作过滤条件）
  环境变量： DOUYIN_DEBUG=1 输出 debug 级日志
             DOUYIN_ACCOUNT=<uid|昵称> 等价于 --account

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

  // ── 账号 ──
  //
  // 与 main 分支同一套语义：`--account <uid|昵称>` 或 DOUYIN_ACCOUNT 决定这次
  // 调用落到哪个号。写操作在多账号时必须显式指定（服务端还会再拦一次）；
  // 本地查询命令（videos/log/events/profile）把它当过滤条件，账号离线也能查。
  let accountRaw = process.env.DOUYIN_ACCOUNT || null;
  let cmdArgs = args.slice(1);
  try {
    const ex = extractAccountArg(cmdArgs);
    cmdArgs = ex.args;
    if (ex.raw) accountRaw = ex.raw;
  } catch (e) {
    console.error(`[账号] ${e.message}`);
    process.exit(1);
  }

  const ctx = createContext({ command: cmd });
  bindCommands(ctx);
  ctx.audit.setNoLog(noLog);

  if (commandUsesBridge(cmd, cmdArgs)) {
    try {
      const resolved = await resolveAccountForCommand(ctx, accountRaw, cmd, cmdArgs);
      ctx.accountUid = resolved.uid;
      if (typeof ctx.audit.setAccount === 'function') ctx.audit.setAccount(resolved.uid);
      printAccountBanner(accountRaw, resolved.uid, resolved.online, resolved.mode);
    } catch (e) {
      loggerModule.getLogger().error(`[账号] ${e.message}`);
      process.exit(1);
    }
  } else if (accountRaw) {
    // 本地查询命令：--account 当过滤条件，账号离线也要能查历史。
    // resolveUid 认不出时原样保留（由查询条件决定命中与否）。
    ctx.accountUid = accountsModule.resolveUid(accountRaw);
    if (typeof ctx.audit.setAccount === 'function') ctx.audit.setAccount(ctx.accountUid);
  }

  try {
    loggerModule.resetOutputCount();
    const result = await runCommand(ctx, cmd, cmdArgs);

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
    // 审计兜底已移进 runCommand（core），CLI 与桌面应用得到同一保证
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
