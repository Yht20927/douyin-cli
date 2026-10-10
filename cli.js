#!/usr/bin/env node
// cli.js — 抖音评论 CLI（Bridge Framework 版）
//
// 依赖 Bridge Server (server.js) 运行中，
// 且浏览器已安装油猴脚本 scripts/douyin.user.js 并打开 douyin.com 页面。

const fs = require('fs');
const path = require('path');
const { AuditLogger } = require('./lib/audit');
const { BridgeClient } = require('./lib/client/bridge-client');
const { safeSerialize } = require('./lib/shared/serialize');
const commands = require('./lib/commands');
const { SITE, CLIENT_PROTOCOL_VERSION } = require('./lib/commands/helpers');

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
// 账号上下文
//
// 多账号下每次调用都要落到某个具体账号上：
//   - 指定了 --account（或 DOUYIN_ACCOUNT）→ 精确路由到该账号
//   - 未指定 + 读操作 → 服务端按账号轮换
//   - 未指定 + 写操作 → 多账号时直接拒绝（服务端也会拦一次兜底）
// 解析出来的账号存在这里，由 bridgeCall/loggedCall 注入每一次请求，
// 于是所有命令（含 suggest/campaign 这类内部再调 cmdPost 的复合命令）自动穿透。
// ═══════════════════════════════════════════════════════════

/** @type {string|null} 解析后的平台 uid；null = 未指定 */
let currentAccount = null;

/** 最近一次调用实际落到的账号（由服务端回传） */
let servedAccount = null;

/**
 * 通过 /api/status 取当前在线的账号。
 * 服务端也读 config.json 解析别名，但"服务端用的那份"和"CLI 用的这份"可能不是同一个文件
 * （本 skill 就在 skills/ 与 project/ 各部署一份），所以别名以本地 config 为准兜底。
 */
async function fetchAccounts() {
  try {
    const st = await bridge.status();
    const list = (st && st.accounts && st.accounts[SITE]) || [];
    const aliases = (config.accounts && config.accounts.aliases) || {};
    // 同账号多标签页会重复上报，按 uid 去重
    const seen = new Map();
    for (const a of list) {
      if (!a.alive) continue;
      if (!seen.has(a.account)) seen.set(a.account, { ...a, alias: a.alias || aliases[a.account] || null });
    }
    return [...seen.values()];
  } catch (e) {
    return [];
  }
}

/**
 * 账号的展示名，按可识别性排序：别名 > 平台昵称 > uid。
 * 括号里始终带 uid —— 它是唯一能被 --account 精确定位的标识。
 */
function accountLabel(a) {
  if (!a) return '';
  const name = a.alias || a.nickname;
  const base = name ? `${name}(${a.account})` : a.account;
  // 脚本不是最新版时打标记：否则"昵称为空"这类问题看不出是脚本旧还是探测失败
  return isOutdated(a) ? `${base} ⚠脚本v${a.clientVersion == null ? '?' : a.clientVersion}` : base;
}

/** 该连接的油猴脚本是否落后于当前注册契约 */
function isOutdated(a) {
  return a.clientVersion !== CLIENT_PROTOCOL_VERSION;
}

/** 账号的展示名（按 uid 查在线列表） */
function nameOf(uid, online) {
  const a = (online || []).find(x => x.account === uid);
  return a ? accountLabel(a) : String(uid);
}

/** 一行账号横幅（打到 stderr，不污染 stdout 的 JSON）；mode: 'write'|'identity'|'read' */
function printAccountBanner(rawAccount, online, mode) {
  if (process.env.DOUYIN_NO_ACCOUNT_BANNER === '1') return;
  const list = online.map(accountLabel).join('、');
  if (rawAccount) {
    console.error(`[账号] 指定 ${nameOf(currentAccount, online)}（在线 ${online.length}：${list || '无'}）`);
  } else if (online.length > 0) {
    // 只有"纯读"才按账号轮换；写与读取自身数据（my/dm list）都必须落到指定账号
    console.error(`[账号] 在线 ${online.length}：${list}${mode === 'read' ? '（读操作按账号轮换）' : ''}`);
  } else {
    console.error('[账号] 无账号在线 — 确认浏览器已登录对应账号并打开站点页面（未登录的标签页不会连接）');
  }
  const stale = online.filter(isOutdated);
  if (stale.length) {
    console.error(
      `[账号] ⚠ ${stale.map(a => a.account).join('、')} 的油猴脚本不是最新版`
      + `（上报 v${stale.map(a => (a.clientVersion == null ? '未上报' : a.clientVersion)).join('/')}，当前 v${CLIENT_PROTOCOL_VERSION}）`
      + ` — 昵称等新字段不会出现，去 Tampermonkey 重装 ${SCRIPT_FILE}`
    );
  }
}

/**
 * 把用户输入的账号（uid 或别名）解析成 uid。
 * 解析不出时抛出带可用账号清单的错误，避免"静默发错号"。
 * @param {string|null} raw
 * @param {Array} [online] 已取的在线账号列表（省一次 /api/status）
 * @param {object} [opts]
 * @param {boolean} [opts.lenient] 本地过滤场景：解析不出就原样返回（允许离线/历史账号）
 */
async function resolveAccount(raw, online, opts = {}) {
  if (!raw) return null;
  const aliases = (config.accounts && config.accounts.aliases) || {};
  // 直接给了已在别名表里的 uid
  if (aliases[raw] !== undefined) return raw;
  // 给的是别名
  const hit = Object.entries(aliases).find(([, a]) => a === raw);
  if (hit) return hit[0];

  const list = online || await fetchAccounts();
  const m = list.find(a => a.account === raw || a.alias === raw);
  if (m) return m.account;

  // 本地查询当作过滤条件：账号离线也要能查历史，所以不校验、原样使用
  if (opts.lenient) return raw;

  const known = [
    ...Object.entries(aliases).map(([uid, a]) => `${a} (${uid})`),
    ...list.filter(a => aliases[a.account] === undefined).map(a => `${a.account} (在线，未设别名)`),
  ];
  throw new Error(
    `未知账号 "${raw}"。` +
    (known.length ? `\n可用账号：\n  ${known.join('\n  ')}` : '\n当前没有在线账号。') +
    `\n用 \`node cli.js accounts\` 查看，\`node cli.js accounts alias <uid> <别名>\` 设置别名。`
  );
}

/**
 * 只读本地记忆、把 --account 当过滤条件的命令：账号不必在线（可查历史）。
 * 这些命令的 --account 不参与 bridge 路由，所以解析可以宽松。
 */
const LOCAL_QUERY = new Set(['log', 'events', 'profile', 'dashboard']);

/**
 * 判断这次调用会不会在平台上产生写操作。
 * 复合命令按「真正写的那一层」判定：suggest 只有 --auto 才发，draft post 才发，
 * campaign 只有 run 才发（daemon 是独立进程，由子进程自己再校验一次）。
 */
function isWriteInvocation(cmd, args) {
  switch (cmd) {
    case 'post':
    case 'like':
    case 'delete-comment':
    case 'upload-image':
    case 'browse':            // 会按概率点赞
      return true;
    case 'dm':
      return args[0] === 'send';
    case 'draft':
      return args[0] === 'post';
    case 'suggest':
      return args.includes('--auto');
    case 'campaign':
      return args[0] === 'run';
    default:
      return false;
  }
}

/**
 * 判断这次调用是否「读取当前账号自身的数据」。
 * 这类命令（不像 get/search 那样是公共内容）返回值完全取决于落到哪个号：
 * 多账号下必须显式指定，否则会把 A 号的作品/私信当成通用的结果返回。
 * 注意 dm send 是写操作、由 isWriteInvocation 管，这里只认读侧子命令。
 */
function isIdentityScoped(cmd, args) {
  switch (cmd) {
    case 'my':
      return true;
    case 'dm':
      return args[0] === 'list' || args[0] === 'listen';
    default:
      return false;
  }
}

/** 一次调用需要在平台侧落到的具体账号（写 + 读取自身数据）——用于横幅与错误文案 */
function accountMode(cmd, args) {
  if (isWriteInvocation(cmd, args)) return 'write';
  if (isIdentityScoped(cmd, args)) return 'identity';
  return 'read';
}

/**
 * 需要明确账号归属的调用（写 / 读取自身数据）必须具备唯一的账号。
 * 只有一个在线账号时自动采用；多个账号时拒绝并要求 --account。
 * 返回 null 表示"放行为未指定"（无账号或仅一个未识别连接），交由服务端判定。
 */
async function ensureAccount(online, mode = 'write') {
  if (currentAccount) return currentAccount;
  online = online || await fetchAccounts();
  if (online.length > 1) {
    const list = online.map(a => a.alias ? `  ${a.alias} (${a.account})` : `  ${a.account}`).join('\n');
    const what = mode === 'identity' ? '该命令读取「当前账号」自身的数据（如 my），' : '写操作';
    throw new Error(
      `当前有 ${online.length} 个账号在线，${what}必须用 --account 显式指定账号：\n${list}`
    );
  }
  if (online.length === 1) {
    currentAccount = online[0].account;
    return currentAccount;
  }
  return null;
}

/** 横幅里提示重装哪个脚本文件 */
const SCRIPT_FILE = 'scripts/douyin.user.js';

/** 从参数里摘掉 `--account <x>`，避免污染各命令的位置参数解析 */
function extractAccountArg(args) {
  const idx = args.indexOf('--account');
  if (idx === -1) return { args, raw: null };
  const val = args[idx + 1];
  if (val === undefined || val.startsWith('--')) {
    throw new Error('--account 需要一个值（uid 或别名）');
  }
  const rest = args.slice();
  rest.splice(idx, 2);
  return { args: rest, raw: val };
}

// ═══════════════════════════════════════════════════════════
// Bridge 通信（通过 BridgeClient）
// ═══════════════════════════════════════════════════════════

/**
 * @param {object} [opts]
 * @param {'read'|'write'} [opts.opType] 写操作会让服务端校验账号显式性
 * @param {boolean} [opts.noThrottle]
 * @param {string|null} [opts.account] 覆盖当前账号（默认用 currentAccount）
 */
async function bridgeCall(expression, awaitPromise = true, opts = {}) {
  const resp = await bridge.call({
    site: SITE,
    expression,
    awaitPromise,
    account: opts.account !== undefined ? opts.account : currentAccount,
    opType: opts.opType || 'read',
    noThrottle: opts.noThrottle === true,
  });
  if (resp.ok) {
    // 服务端回传实际服务该请求的账号，用于审计归属
    servedAccount = resp.account || null;
    if (servedAccount) {
      // 钉扎：本次调用还没定账号（未指定 + 读操作轮换）时，采用服务端选中的账号，
      // 让同一命令内的后续调用（分页 get --all、browse 的多次搜索）不再换号 ——
      // 否则 cursor 来自 A 号却拿去问 B 号，跨号拼接结果会错乱。
      if (!currentAccount) currentAccount = servedAccount;
      audit.setAccount(currentAccount);
    }
    return resp.value;
  }
  throw new Error(resp.error || 'Bridge Server 返回未知错误');
}

async function loggedCall(endpoint, params, expression, opts = {}) {
  const t0 = Date.now();
  try {
    const result = await bridgeCall(expression, true, opts);
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
    if (servedAccount) sum.account = servedAccount;
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
  fetchAccounts,
  /** 本次调用指定的账号 uid（未指定为 null）；命令可用于记录归属 */
  get account() { return currentAccount; },
  /**
   * 覆盖本次调用的账号。
   * 供复合命令把内部子调用钉在某个账号上（如 campaign 按 campaigns.account 发布），
   * 覆盖后所有经 ctx.bridgeCall 的请求都跟着走这个账号。
   */
  setAccount(uid) { currentAccount = uid || null; },
  // 命令间互相调用的引用（延迟绑定）
  cmdGet: null,
  cmdPost: null,
  cmdAnalyze: null,
  cmdSearch: null,
  cmdLike: null,
  cmdBrowse: null,
};

// ═══════════════════════════════════════════════════════════
// accounts 命令：查看 / 设置账号别名
// ═══════════════════════════════════════════════════════════

async function cmdAccounts(args) {
  const cfgPath = path.join(__dirname, 'config.json');

  if (args[0] === 'alias') {
    const uid = args[1];
    const name = args.slice(2).join(' ').trim();
    if (!uid || !name) {
      throw new Error('用法: node cli.js accounts alias <uid> <别名>');
    }
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { /* 用空配置起步 */ }
    cfg.accounts = cfg.accounts || {};
    cfg.accounts.aliases = cfg.accounts.aliases || {};
    cfg.accounts.aliases[uid] = name;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    return { ok: true, uid, alias: name, config: cfgPath };
  }

  const aliases = (config.accounts && config.accounts.aliases) || {};
  const online = await fetchAccounts();
  const seen = new Set();
  const rows = [];
  for (const a of online) {
    seen.add(a.account);
    const alias = a.alias || aliases[a.account] || null;
    rows.push({
      // 连接的身份就是账号名：别名 > 平台昵称 > uid
      id: alias || a.nickname || a.account,
      account: a.account,
      nickname: a.nickname || null,
      alias,
      clientVersion: a.clientVersion == null ? null : a.clientVersion,
      scriptOutdated: isOutdated(a),
      online: true,
      channel: a.channel,
      lastServedAt: a.lastServedAt || 0,
      lastWriteAt: a.lastWriteAt || 0,
    });
  }
  for (const [uid, name] of Object.entries(aliases)) {
    if (!seen.has(uid)) rows.push({ id: name, account: uid, nickname: null, alias: name, clientVersion: null, scriptOutdated: null, online: false });
  }
  return { ok: true, onlineCount: online.length, accounts: rows };
}

// 绑定命令（注入上下文）
ctx.cmdGet = (args) => commands.get(ctx, args);
ctx.cmdPost = (args) => commands.post(ctx, args);
ctx.cmdAnalyze = (args) => commands.analyze(ctx, args);
ctx.cmdSearch = (args) => commands.search(ctx, args);
ctx.cmdLike = (args) => commands.like(ctx, args);
ctx.cmdBrowse = (args) => commands.browse(ctx, args);

// ═══════════════════════════════════════════════════════════
// 帮助
// ═══════════════════════════════════════════════════════════

function printHelp() {
  console.log(`
Douyin Comment CLI (Bridge Framework)

  node cli.js search <keyword>                搜索视频
  node cli.js get <aweme_id>                  获取评论 (--all --depth N --new --since <ts>)
  node cli.js replies <cid> <aweme_id>        获取回复列表
  node cli.js my                              我的作品（多账号需 --account 指定是哪个号）
  node cli.js user <sec_user_id | 主页URL>     查看用户作品信息 (--count N --cursor <ts>)
  node cli.js post <aweme_id> "内容"           发表评论
  node cli.js post <aweme_id> "回复" --reply-to <cid>
  node cli.js post <aweme_id> "@1179139456380456 内容" --reply-to <cid> --at <uid> <sec_uid>
  node cli.js post <aweme_id> "内容" --image <图片路径>     发表图片评论（--image 可重复/逗号分隔）
  node cli.js upload-image --image <图片路径>               仅上传图片，返回 uri（不发评论）
  node cli.js like <aweme_id>                 点赞视频
  node cli.js like <aweme_id> --unlike        取消点赞
  node cli.js delete-comment <cid>            删除评论
  node cli.js download <aweme_id>             下载视频（含音频）
  node cli.js download <aweme_id> --audio-only  仅下载音频（BGM）
  node cli.js download <aweme_id> --out <dir>   指定输出目录
  node cli.js analyze <aweme_id>              LLM 分析（情感/分类/优先级）
  node cli.js suggest <aweme_id>              LLM 回复建议（--auto 自动发布）
  node cli.js dashboard                       仪表盘 HTML
  node cli.js dashboard --video <aweme_id> --days 14
  node cli.js log [--tail N] [--video <id>] [--uid <uid>] [--command <cmd>] [--failed]
  node cli.js profile <uid>                   用户交互历史（事件流）
  node cli.js whois <uid>                     用户全量画像（评论 + 我的回复 + 标签）
  node cli.js note <uid> [--tier vip|normal|blacklist|spam] [--tag T] [--untag T] [--notes "..."] [--clear]
  node cli.js events [--tail N] [--video <id>] [--uid <uid>] [--cmd <cmd>] [--status success|error] [--since <ts>] [--json]
  node cli.js corpus <search|recent|stats> [...]   回复语料库
  node cli.js browse [--max-notes N]            模拟浏览行为（搜索+看视频+偶尔点赞）
  node cli.js failures [--limit N] [--recent]      失败模式 top-N（避雷清单）
  node cli.js dedup "<候选回复文本>"                  检查文本是否曾经发过
  node cli.js replied                                已回复 cid 列表（--json --aweme <id>）
  node cli.js replied --count                        已回复总数
  node cli.js dm send <user_id> "内容"            发送私信
  node cli.js dm listen [--timeout N]              监听收到的私信
  node cli.js dm list                              查看最近收到的消息
  node cli.js cleanup [--days 90] [--dry-run]      清理过期记忆（events/comments/corpus）
  node cli.js preflight [command]           节奏守卫自检（距下次写需等多久 / 命令是否可执行）
  node cli.js repo-info [<owner/repo>]       获取 GitHub 仓库真实信息（推广评论事实源，缓存 1h，--refresh 强制刷新）
  node cli.js factcheck "<文本>"               推广评论发布前事实校验（star 数/仓库名/版本号 vs repo-info 缓存）
  node cli.js campaign <create|plan|run|stop|pause|resume|status|list>  推广引擎（跨视频可暂停可恢复；run --daemon 后台）

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

  多账号：
  node cli.js accounts                                列出账号（uid / 别名 / 在线 / 最近服务时间）
  node cli.js accounts alias <uid> <别名>              给账号起个好记的别名
  通用选项： --account <uid|别名>   指定用哪个账号
             公共读操作（get/search/user/…）不指定时按账号轮换，且同一条命令内钉扎同一账号；
             写操作（post/like/…）与读取自身数据的命令（my / dm list / dm listen）
             多账号时必须显式指定 —— 否则会把某个号的作品/私信当成通用结果返回。
             --account 也作为本地查询命令（log / events / dashboard / profile）的过滤条件，
             不指定则看全部账号。

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
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  noLog = argv.includes('--no-log');
  audit.setNoLog(noLog);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    printHelp();
    return;
  }

  // accounts 自己就是账号管理入口，不做账号解析
  if (cmd === 'accounts') {
    try {
      console.log(JSON.stringify(safeSerialize(await cmdAccounts(argv.slice(1))), null, 2));
    } catch (e) {
      console.error(`错误: ${e.message}`);
      process.exit(2);
    }
    return;
  }

  // 摘掉 --account，并解析本次调用的账号
  let args, rawAccount;
  try {
    const ex = extractAccountArg(argv.slice(1));
    args = ex.args;
    // 环境变量兜底：campaign 的 daemon 是独立子进程，靠它把身份传下来
    rawAccount = ex.raw || process.env.DOUYIN_ACCOUNT || null;
  } catch (e) {
    console.error(`错误: ${e.message}`);
    process.exit(2);
  }

  const handler = commands[cmd];
  if (!handler) {
    console.error(`未知命令: ${cmd}`);
    console.error('运行 "node cli.js help" 查看用法。');
    process.exit(1);
  }

  try {
    const online = await fetchAccounts();
    currentAccount = await resolveAccount(rawAccount, online, { lenient: LOCAL_QUERY.has(cmd) });
    const mode = accountMode(cmd, args);
    // 写操作 / 读取自身数据必须能落到一个明确账号：多账号时强制要求 --account
    if (mode !== 'read') await ensureAccount(online, mode);
    // 让"本地命令零 bridge 调用"也带上账号归属（如 dedup 这类纯本地命令）
    audit.setAccount(currentAccount);
    printAccountBanner(rawAccount, online, mode);

    const result = await handler(ctx, args);

    // 读操作轮到哪个账号是服务端决定的：事后补一行，否则调完也不知道是哪个号拉的
    if (mode === 'read' && !rawAccount && online.length > 1 && servedAccount) {
      console.error(`[账号] 本次由 ${nameOf(servedAccount, online)} 服务`);
    }
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
