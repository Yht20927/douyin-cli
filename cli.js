#!/usr/bin/env node
// cli.js — 抖音评论 CLI（Bridge Framework 版）
//
// 依赖 Bridge Server (server.js) 运行中，
// 且浏览器已安装油猴脚本 scripts/douyin.user.js 并打开 douyin.com 页面。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { AuditLogger } = require('./lib/audit');
const { generateDashboardHTML } = require('./lib/dashboard');

// ── 配置 ──
let config = {};
try { config = require('./config.json'); } catch (e) { /* use defaults */ }
const BRIDGE_HOST = config.bridge?.host || '127.0.0.1';
const BRIDGE_PORT = config.bridge?.port || 19422;
const BRIDGE_TOKEN = config.bridge?.token || '';
const SITE = 'douyin.com';

// ── 审计日志 ──
const audit = new AuditLogger();
let noLog = false;

// ═══════════════════════════════════════════════════════════
// Bridge 通信
// ═══════════════════════════════════════════════════════════

function bridgeCall(expression, awaitPromise = true) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ site: SITE, expression, awaitPromise });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (BRIDGE_TOKEN) headers['Authorization'] = `Bearer ${BRIDGE_TOKEN}`;
    const req = http.request({
      hostname: BRIDGE_HOST, port: BRIDGE_PORT, path: '/api/call',
      method: 'POST',
      headers,
      timeout: 35000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const obj = JSON.parse(data);
          if (obj.ok) resolve(obj.value);
          else reject(new Error(obj.error || 'Unknown error'));
        } catch (e) {
          reject(new Error(`Invalid response: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', (e) => reject(new Error(`Bridge Server not running (${BRIDGE_HOST}:${BRIDGE_PORT}) — ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
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
// 辅助函数
// ═══════════════════════════════════════════════════════════

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function getFlag(args, flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx === -1) return defaultValue;
  const val = args[idx + 1];
  if (val === undefined || val.startsWith('--')) return defaultValue;
  const n = Number(val);
  // 19 位抖音 ID 超过 JS 安全整数范围，必须保持字符串
  if (isNaN(n)) return val;
  if (n > Number.MAX_SAFE_INTEGER || n < Number.MIN_SAFE_INTEGER) return val;
  return n;
}

function formatComment(c) {
  const out = {
    cid: c.cid,
    text: (c.text || '').substring(0, 120),
    likes: c.digg_count || c.likes || 0,
    replies: c.reply_comment_total || c.replies || 0,
    time: c.create_time || c.time || 0,
    user: c.user ? { nickname: c.user.nickname, uid: c.user.uid || c.user.uid_str, avatar: c.user.avatar_thumb?.url_list?.[0] || c.user.avatar_medium?.url_list?.[0] || '' } : null,
  };
  if (c.children) out.children = c.children;
  return out;
}

// ═══════════════════════════════════════════════════════════
// 命令实现
// ═══════════════════════════════════════════════════════════

async function cmdSearch(args) {
  const kw = args[0];
  if (!kw) throw new Error('keyword required');
  const offset = getFlag(args, '--offset', 0);
  const count = getFlag(args, '--count', 10);

  const expr = `window.__bridge.search('${esc(kw)}', ${offset}, ${count})`;
  audit.startOperation('search', { keyword: kw, offset, count });

  const data = await loggedCall('search', { keyword: kw, offset, count }, expr);
  const items = (data.data || []).filter(d => d.aweme_info).map(d => ({
    aweme_id: d.aweme_info.aweme_id,
    desc: (d.aweme_info.desc || '').substring(0, 80),
    author: d.aweme_info.author?.nickname || '',
    uid: d.aweme_info.author?.uid || '',
    time: d.aweme_info.create_time || 0,
    plays: d.aweme_info.statistics?.play_count || 0,
  }));
  audit.endOperation('success', { count: items.length }, { result: items });
  return items;
}

async function cmdGet(args) {
  const awemeId = args[0];
  if (!awemeId) throw new Error('aweme_id required');

  const all = args.includes('--all');
  const depth = getFlag(args, '--depth', 0);
  const perPage = getFlag(args, '--count', 20);
  const replyLimit = getFlag(args, '--reply-limit', 50);
  const pages = getFlag(args, '--pages', all ? Infinity : 1);
  const isNew = args.includes('--new');
  const since = getFlag(args, '--since', null);

  let cutoff = null;
  if (isNew) {
    cutoff = audit.findLastFetchTime(awemeId);
    if (!cutoff) console.error('[info] No previous fetch for this video, doing full fetch');
  } else if (since) {
    cutoff = Number(since);
  }

  const startOpArgs = { aweme_id: awemeId, all, depth, pages };
  if (cutoff) startOpArgs.since = cutoff;
  audit.startOperation('get', startOpArgs);

  const allComments = [];
  let cursor = 0;
  let pageCount = 0;

  while (pageCount < pages) {
    const expr = `window.__bridge.getComments('${awemeId}', ${cursor}, ${perPage})`;
    const data = await loggedCall('get', { aweme_id: awemeId, cursor, count: perPage }, expr);
    const comments = data.comments || [];
    pageCount++;

    let filtered = comments;
    if (cutoff) {
      filtered = comments.filter(c => (c.create_time || 0) > cutoff);
      if (filtered.length < comments.length) {
        // 遇到旧评论，添加过滤后的并停止
        allComments.push(...filtered);
        break;
      }
    }

    // 展开嵌套回复
    if (depth >= 1) {
      for (let i = 0; i < filtered.length; i++) {
        const c = filtered[i];
        const replyCount = c.reply_comment_total || 0;
        if (replyCount > 0) {
          const children = await fetchAllReplies(c.cid, awemeId, replyLimit);
          c.children = children.map(formatComment);
        }
      }
    }

    allComments.push(...filtered);

    if (!data.has_more) break;
    cursor = data.cursor || cursor + perPage;
  }

  const result = allComments.map(formatComment);
  audit.endOperation('success', { comments: result.length, pages: pageCount }, { comments: result });
  return result;
}

async function fetchAllReplies(cid, awemeId, limit = 50) {
  const all = [];
  let cursor = 0;
  const pageSize = Math.min(20, limit);  // 每页最多 20，不超过 limit
  while (all.length < limit) {
    const expr = `window.__bridge.replies('${cid}', '${awemeId}', ${cursor}, ${pageSize})`;
    const data = await bridgeCall(expr);
    const comments = data.comments || [];
    all.push(...comments);
    if (!data.has_more || comments.length === 0) break;
    cursor = data.cursor || cursor + pageSize;
  }
  // 截断到 limit
  return all.slice(0, limit);
}

async function cmdReplies(args) {
  const cid = args[0];
  if (!cid) throw new Error('cid required');
  let cursor = getFlag(args, '--cursor', 0);
  let count = getFlag(args, '--count', 20);
  let awemeId = '';
  for (let i = 1; i < args.length; i++) {
    if (!args[i].startsWith('--') && args[i] !== cid && !awemeId) awemeId = args[i];
  }

  audit.startOperation('replies', { cid, aweme_id: awemeId, cursor, count });
  const expr = `window.__bridge.replies('${cid}', '${awemeId}', ${cursor}, ${count})`;
  const data = await loggedCall('replies', { cid, aweme_id: awemeId, cursor, count }, expr);
  const items = (data.comments || []).map(formatComment);
  audit.endOperation('success', { count: items.length }, { comments: items });
  return items;
}

async function cmdMy(args) {
  const count = getFlag(args, '--count', 18);
  audit.startOperation('my', { count });

  const expr = `window.__bridge.myPosts(0, ${count})`;
  const data = await loggedCall('my', { count }, expr);
  const items = (data.aweme_list || []).map(a => ({
    aweme_id: a.aweme_id,
    desc: (a.desc || '').substring(0, 80),
    time: a.create_time || 0,
    stats: {
      plays: a.statistics?.play_count || 0,
      likes: a.statistics?.digg_count || 0,
      comments: a.statistics?.comment_count || 0,
      shares: a.statistics?.share_count || 0,
    },
  }));
  audit.endOperation('success', { count: items.length }, { result: items });
  return items;
}

async function cmdPost(args) {
  const awemeId = args[0];
  const text = args[1];
  if (!awemeId || !text) throw new Error('aweme_id and text required');
  const replyTo = getFlag(args, '--reply-to', null);
  const rrid = getFlag(args, '--reply-to-reply', null);
  // @ 提及支持: --at <uid> <sec_uid>
  let atUid = null, atSecUid = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--at') { atUid = args[++i]; atSecUid = args[++i]; }
  }

  let mentions = 'null';
  if (atUid && atSecUid) {
    const atPos = text.indexOf('@');
    if (atPos >= 0) {
      // 找到 @ 后面昵称的结束位置（空格或文本结束）
      let charEnd = atPos + 1;
      while (charEnd < text.length && text[charEnd] !== ' ') charEnd++;
      // text_extra 的 start/end 是 UTF-8 字节位置
      const byteStart = Buffer.byteLength(text.substring(0, atPos), 'utf8');
      const byteEnd = Buffer.byteLength(text.substring(0, charEnd), 'utf8');
      mentions = JSON.stringify([{ start: byteStart, end: byteEnd, user_id: atUid, sec_uid: atSecUid, type: 0 }]);
    }
  }

  audit.startOperation('post', { aweme_id: awemeId, text, reply_to: replyTo });
  const expr = `window.__bridge.publish('${esc(awemeId)}', '${esc(text)}', ${replyTo ? `'${esc(replyTo)}'` : 'null'}, ${rrid ? `'${esc(rrid)}'` : 'null'}, ${mentions})`;
  const data = await loggedCall('post', { aweme_id: awemeId, text }, expr);

  // 检查外层 status_code（非 0 即为失败）
  if (data.status_code !== undefined && data.status_code !== 0) {
    const err = new Error(`status_code=${data.status_code}`);
    audit.endOperation('error', { status_code: data.status_code }, null, err.message);
    throw err;
  }

  // 有 comment 对象即视为发布成功（与旧 CDP 版本行为一致）
  // comment.status 可能是 1(可见) 或 7(审核中)，不影响发布结果
  if (!data.comment) {
    const err = new Error('publish returned no comment');
    audit.endOperation('error', {}, null, err.message);
    throw err;
  }

  const result = {
    cid: data.comment?.cid || '',
    text: data.comment?.text || text,
    time: data.comment?.create_time || 0,
    status: 'published',
  };
  audit.endOperation('success', { cid: result.cid }, { result });
  return result;
}

async function cmdAnalyze(args) {
  const awemeId = args[0];
  if (!awemeId) throw new Error('aweme_id required');

  const llm = require('./lib/llm');
  audit.startOperation('analyze', { aweme_id: awemeId });

  // 先获取评论
  console.error('Fetching comments...');
  const commentsData = await cmdGet([awemeId, '--all', '--depth', '0']);

  if (!commentsData || commentsData.length === 0) {
    audit.endOperation('success', { analyzed: 0 }, { result: [] });
    return [];
  }

  console.error(`Analyzing ${commentsData.length} comments...`);
  const client = new llm.LLMClient(config.llm || {});
  const results = await client.analyzeComments(commentsData);
  if (!results || results.length === 0) {
    console.error('Warning: LLM returned no analysis results');
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const fp = path.join(__dirname, 'logs', 'results', `analyze-${awemeId}-${ts}.json`);
  fs.writeFileSync(fp, JSON.stringify(results, null, 2));

  audit.endOperation('success', { analyzed: results.length }, { result: results, resultFile: 'logs/results/' + path.basename(fp) });
  return results;
}

async function cmdSuggest(args) {
  const awemeId = args[0];
  if (!awemeId) throw new Error('aweme_id required');
  const auto = args.includes('--auto');
  const minPriority = getFlag(args, '--min-priority', 0);

  const llm = require('./lib/llm');
  audit.startOperation('suggest', { aweme_id: awemeId, auto, min_priority: minPriority });

  // 先分析
  console.error('Analyzing comments...');
  let analysis;
  try {
    analysis = await cmdAnalyze([awemeId]);
  } catch (e) {
    audit.endOperation('error', {}, null, e.message);
    throw e;
  }

  if (!analysis || analysis.length === 0) {
    console.log('No comments to reply to.');
    audit.endOperation('success', { suggested: 0 });
    return [];
  }

  // 筛选需回复的
  const toReply = analysis.filter(a => a.priority >= minPriority && a.sentiment !== 'negative');

  // 读取策略
  let strategy = '';
  try { strategy = fs.readFileSync(path.join(__dirname, 'reply-strategy.md'), 'utf8'); } catch (e) { /* */ }

  const client = new llm.LLMClient(config.llm || {});
  const suggestions = await client.suggestReplies(toReply, strategy);

  const results = [];
  for (const s of suggestions.slice(0, 30)) {
    if (auto && s.reply) {
      try {
        const postResult = await cmdPost([s.aweme_id || awemeId, s.reply, '--reply-to', s.cid]);
        results.push({ ...s, posted: true, post_cid: postResult.cid });
      } catch (e) {
        results.push({ ...s, posted: false, error: e.message });
      }
    } else {
      results.push(s);
    }
  }

  audit.endOperation('success', { suggested: results.length, posted: auto ? results.filter(r => r.posted).length : 0 }, { result: results });
  return results;
}

async function cmdDashboard(args) {
  const videoId = getFlag(args, '--video', null);
  const days = getFlag(args, '--days', 14);

  audit.startOperation('dashboard', { video_id: videoId, days });
  const html = generateDashboardHTML(videoId, days);

  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const fp = path.join(__dirname, 'logs', `dashboard-${ts}.html`);
  fs.writeFileSync(fp, html);
  console.error(`Dashboard saved: ${fp}`);

  // 尝试打开浏览器
  try {
    const { exec } = require('child_process');
    exec(`start "" "${fp}"`);
  } catch (e) { /* */ }

  audit.endOperation('success', { file: 'logs/' + path.basename(fp) });
  console.log(JSON.stringify({ file: 'logs/' + path.basename(fp) }));
}

async function cmdLog(args) {
  const tail = getFlag(args, '--tail', 10);
  const videoId = getFlag(args, '--video', null);
  const failedOnly = args.includes('--failed');

  const a = audit.load();
  const ops = [];
  for (const s of (a.sessions || [])) {
    for (const op of (s.operations || [])) {
      if (videoId && op.args?.aweme_id !== videoId) continue;
      if (failedOnly && op.status !== 'error') continue;
      ops.push(op);
    }
  }

  const recent = ops.slice(-tail);
  for (const op of recent) {
    const icon = op.status === 'success' ? '✅' : '❌';
    const dur = op.durationMs ? `${(op.durationMs / 1000).toFixed(1)}s` : '—';
    console.log(`${icon} [${op.started?.substring(0, 19) || '?'}] ${op.command} ${JSON.stringify(op.args)} ${dur}`);
    if (op.summary && Object.keys(op.summary).length) {
      console.log(`   summary: ${JSON.stringify(op.summary)}`);
    }
    if (op.resultFile) console.log(`   result: ${op.resultFile}`);
  }
  if (recent.length === 0) console.log('No matching operations found.');
}

async function cmdProfile(args) {
  const uid = args[0];
  if (!uid) throw new Error('uid required');

  const a = audit.load();
  const interactions = [];
  for (const s of (a.sessions || [])) {
    for (const op of (s.operations || [])) {
      if (op.command === 'post' && op.args?.reply_to) {
        interactions.push({ time: op.started, type: 'replied', op_index: op.index });
      }
    }
  }

  console.log(JSON.stringify({
    uid,
    first_seen: interactions[0]?.time || 'unknown',
    total_interactions: interactions.length,
    interactions,
  }, null, 2));
}

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

  const COMMANDS = {
    search: cmdSearch,
    get: cmdGet,
    replies: cmdReplies,
    my: cmdMy,
    post: cmdPost,
    analyze: cmdAnalyze,
    suggest: cmdSuggest,
    dashboard: cmdDashboard,
    log: cmdLog,
    profile: cmdProfile,
  };

  if (!cmd || cmd === 'help' || cmd === '--help') {
    printHelp();
    return;
  }

  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(`Unknown command: ${cmd}`);
    console.error('Run "node cli.js help" for usage.');
    process.exit(1);
  }

  try {
    const result = await handler(args.slice(1));
    if (result !== undefined) {
      if (rawMode) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    }
  } catch (e) {
    if (!noLog && audit._currentOp) {
      audit.endOperation('error', {}, null, e.message);
    }
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
