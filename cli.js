#!/usr/bin/env node
// douyin_cli.js — 抖音评论 CLI (daemon 持久连接)
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DAEMON_PORT = 19422;
const DAEMON = process.argv[2] === 'daemon';

// Daemon 健壮性模块
const { acquireLock, releaseLock, ReconnectManager, PageMonitor, HeartbeatMonitor } = require('./lib/daemon');
const { CDPClient } = require('./lib/cdp');

// ===== 审计日志 =====
const LOG_DIR = path.join(__dirname, 'logs');
const AUDIT_FILE = path.join(LOG_DIR, 'audit.json');
const RESULTS_DIR = path.join(LOG_DIR, 'results');
let audit = null;
let currentOp = null;
let noLog = false;

function ensureLogDirs() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
}
function loadAudit() {
  if (!fs.existsSync(AUDIT_FILE)) return { version: '1.0', updated: new Date().toISOString(), sessions: [] };
  try { return JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')); }
  catch(e) { return { version: '1.0', updated: new Date().toISOString(), sessions: [] }; }
}
function saveAudit() {
  if (noLog) return;
  audit.updated = new Date().toISOString();
  const tmp = AUDIT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(audit, null, 2));
  fs.renameSync(tmp, AUDIT_FILE);
}
function newSession() {
  const last = audit.sessions[audit.sessions.length - 1];
  if (last && !last.ended) return last;
  const s = { sessionId: new Date().toISOString().replace(/[:.]/g,'-').substring(0,19)+'-'+Math.random().toString(36).substring(2,6), started: new Date().toISOString(), ended: null, operations: [] };
  audit.sessions.push(s);
  if (audit.sessions.length > 50) audit.sessions = audit.sessions.slice(-50);
  return s;
}
function startOperation(cmd, args) {
  if (noLog) return;
  ensureLogDirs(); audit = loadAudit();
  const s = newSession();
  currentOp = { index: s.operations.length + 1, command: cmd, args, started: new Date().toISOString(), ended: null, durationMs: null, status: 'running', summary: {}, apiCalls: [] };
  s.operations.push(currentOp);
  saveAudit();
}
function logApiCall(endpoint, params, durationMs, status, summary) {
  if (noLog || !currentOp) return;
  currentOp.apiCalls.push({ seq: currentOp.apiCalls.length + 1, endpoint, params, durationMs, status, summary: summary || {} });
}
function endOperation(status, summary, resultData, error) {
  if (noLog || !currentOp) return;
  currentOp.ended = new Date().toISOString();
  currentOp.durationMs = Date.now() - new Date(currentOp.started).getTime();
  currentOp.status = status;
  if (summary) currentOp.summary = summary;
  if (error) currentOp.error = error;
  const largeResults = ['get','search','my','replies'];
  if (resultData && largeResults.includes(currentOp.command) && status === 'success') {
    const ts = new Date().toISOString().replace(/[:.]/g,'-').substring(0,19);
    let label = currentOp.command;
    if (currentOp.args.aweme_id) label += '-' + currentOp.args.aweme_id;
    else if (currentOp.args.keyword) label += '-' + sanitize(currentOp.args.keyword);
    else if (currentOp.args.cid) label += '-' + currentOp.args.cid;
    const fp = path.join(RESULTS_DIR, label + '-' + ts + '.json');
    fs.writeFileSync(fp, JSON.stringify({ command: currentOp.command, args: currentOp.args, started: currentOp.started, ...resultData }, null, 2));
    currentOp.resultFile = 'logs/results/' + path.basename(fp);
  } else if (resultData && status === 'success') {
    currentOp.result = resultData;
  }
  saveAudit(); currentOp = null;
}
function sanitize(s) { return (s||'').replace(/[<>:"/\\|?*'\s]/g,'_').substring(0,20); }
function findLastFetchTime(awemeId) {
  const a = loadAudit();
  let latest = null;
  for (const s of (a.sessions || [])) {
    for (const op of (s.operations || [])) {
      if (op.command === 'get' && op.args?.aweme_id === awemeId && op.status === 'success' && op.ended) {
        const t = new Date(op.ended).getTime() / 1000;
        if (latest === null || t > latest) latest = t;
      }
    }
  }
  return latest;
}
async function loggedSend(endpoint, params, expression, awaitPromise) {
  const t0 = Date.now();
  try {
    const res = await sendToDaemon({ expression, awaitPromise: awaitPromise !== false });
    const ms = Date.now() - t0;
    const sum = {};
    if (res.ok && res.value) {
      const v = res.value;
      if (v.comments) sum.count = v.comments.length;
      if (v.has_more !== undefined) sum.has_more = v.has_more;
      if (v.aweme_list) sum.count = v.aweme_list.length;
      if (v.data) sum.count = (v.data||[]).filter(d=>d.aweme_info).length;
      if (v.comment) { sum.cid = v.comment.cid; sum.status_code = 0; }
      if (v.status_code !== undefined && !sum.status_code) sum.status_code = v.status_code;
    }
    logApiCall(endpoint, params, ms, res.ok ? 'success' : 'error', sum);
    return res;
  } catch(e) {
    logApiCall(endpoint, params, Date.now() - t0, 'error', { error: e.message });
    throw e;
  }
}

// ===== DevToolsActivePort 读取 =====
function getBrowserWsUrl() {
  const envPort = process.env.CDP_PORT;
  if (envPort) return `ws://127.0.0.1:${envPort}/devtools/browser`;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
              'Google', 'Chrome', 'User Data', 'DevToolsActivePort'),
  ];
  for (const portFile of candidates) {
    if (fs.existsSync(portFile)) {
      const lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
      if (lines.length >= 2 && lines[0] && lines[1])
        return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
    }
  }
  throw new Error('找不到 Chrome 调试端口。请启用 chrome://inspect/#remote-debugging');
}

// ===== 桥接脚本 =====
const BRIDGE = (function() {/*
window.__dy = {
  _q: function() { return {
    device_platform:'webapp',aid:'6383',channel:'channel_pc_web',
    pc_client_type:'1',pc_libra_divert:'Windows',
    update_version_code:'170400',support_h265:'1',support_dash:'1',
    version_code:'170400',version_name:'17.4.0',
    cookie_enabled:'true',screen_width:'1920',screen_height:'1080',
    browser_language:'zh-CN',browser_platform:'Win32',
    browser_name:'Chrome',browser_version:'148.0.0.0',
    browser_online:'true',engine_name:'Blink',engine_version:'148.0.0.0',
    os_name:'Windows',os_version:'10',
    cpu_core_num:'12',device_memory:'16',platform:'PC',
    downlink:'10',effective_type:'4g',round_trip_time:'100'
  };},

  replies: async function(cid, awemeId, cursor, count) {
    var p = new URLSearchParams(Object.assign(this._q(), {aweme_id:awemeId, comment_id:cid, cursor:cursor||0, count:count||10, item_type:'0', pc_img_format:'webp', cut_version:'1'}));
    var r = await fetch('/aweme/v1/web/comment/list/reply/?'+p, {credentials:'include'});
    return await r.json();
  },
  getComments: async function(id,c,n) {
    var p = new URLSearchParams(Object.assign(this._q(), {aweme_id:id, cursor:c||0, count:n||20, item_type:'0', pc_img_format:'webp', cut_version:'1'}));
    var r = await fetch('/aweme/v1/web/comment/list/?'+p, {credentials:'include'});
    return await r.json();
  },

  myPosts: async function(cursor,count) {
    var info = await (await fetch('/aweme/v1/web/query/user/?device_platform=webapp&aid=6383&channel=channel_pc_web', {credentials:'include'})).json();
    var secUid = (info.user||{}).sec_uid || '';
    var p = new URLSearchParams(Object.assign(this._q(), {sec_user_id:secUid, max_cursor:cursor||0, count:count||18, locate_query:'false', show_live_replay_strategy:'1', need_time_list:'1', time_list_query:'0', whale_cut_token:'', cut_version:'1', publish_video_strategy_type:'2', from_user_page:'0'}));
    var r = await fetch('/aweme/v1/web/aweme/post/?'+p, {credentials:'include'});
    return await r.json();
  },

  search: async function(kw,offset,count) {
    var p = new URLSearchParams(Object.assign(this._q(), {keyword:kw, offset:offset||0, count:count||10, search_channel:'aweme_general', search_source:'normal_search', query_correct_type:'1', is_filter_search:'0', need_filter_settings:'0', list_type:'single'}));
    var r = await fetch('/aweme/v1/web/general/search/single/?'+p, {credentials:'include'});
    return await r.json();
  },

  publish: async function(id,text,rid,rrid) {
    var b = new URLSearchParams({aweme_id:id,text:text,item_type:'0',app_name:'aweme',enter_from:'others_homepage',previous_page:'others_homepage',comment_send_celltime:'3000',comment_video_celltime:'2000',one_level_comment_rank:'-1',paste_edit_method:'non_paste',text_extra:'[]'});
    if(rid){b.set('reply_id',rid);b.set('comment_id',rid)}
    if(rrid)b.set('reply_to_reply_id',rrid);
    var q = new URLSearchParams(Object.assign(this._q(), {app_name:'aweme',enter_from:'others_homepage',previous_page:'others_homepage',aweme_id:id,item_type:'0'}));
    var r = await fetch('/aweme/v1/web/comment/publish/?'+q, {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:b.toString(),credentials:'include'});
    return await r.json();
  }
};
console.log('[CLI] Bridge ready');
*/}).toString().match(/\/\*([\s\S]*)\*\//)[1];

// ===== CDP 工具 =====
let cdpMsgId = 0;
function cdp(ws, method, params, sessionId) {
  return new Promise((resolve, reject) => {
    const mid = ++cdpMsgId;
    const msg = { id: mid, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 30000);
    function onMsg(data) {
      try {
        const obj = JSON.parse(data.toString());
        if (obj.id === mid) {
          ws.removeListener('message', onMsg);
          clearTimeout(timer);
          if (obj.error) reject(new Error(obj.error.message));
          else resolve(obj.result);
        }
      } catch(e) {}
    }
    ws.on('message', onMsg);
    ws.send(JSON.stringify(msg));
  });
}

async function findAndConnect() {
  const browserWsUrl = getBrowserWsUrl();
  const ws = new WebSocket(browserWsUrl);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const result = await cdp(ws, 'Target.getTargets');
  const targets = result.targetInfos || [];
  let page = targets.find(t => t.url && t.url.includes('douyin.com') && t.type === 'page');
  if (!page) page = targets.find(t => t.type === 'page' && t.url && !t.url.startsWith('chrome://'));
  if (!page) { ws.close(); throw new Error('No Douyin page found.'); }
  const attachResult = await cdp(ws, 'Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const sessionId = attachResult.sessionId;
  return { ws, sessionId, page };
}

// ===== Daemon =====
async function runDaemon() {
  // PID JSON 锁（含僵尸检测）
  acquireLock();

  // 用指数退避重连包装连接逻辑
  const reconnect = new ReconnectManager();
  const pageState = { value: 'running', lastActivity: Date.now() };
  let cdpClient = null;
  let sessionId = null;
  let heartbeat = null;

  async function doConnect() {
    console.error('[daemon] Connecting to Chrome...');
    const { ws, sessionId: sid, page } = await findAndConnect();
    sessionId = sid;
    cdpClient = new CDPClient(ws);
    pageState.value = 'running';
    console.error(`[daemon] Connected: ${page.title || page.url?.substring(0, 50)}`);

    // Bridge 注入
    await cdpClient.send('Runtime.enable', {}, sessionId);
    await cdpClient.send('Runtime.evaluate', {
      expression: `delete window.__dy; ${BRIDGE}`, awaitPromise: false,
    }, sessionId);
    console.error('[daemon] Bridge injected');

    // 页面感知 — 离开暂停，回来自动恢复
    const monitor = new PageMonitor(pageState);
    await cdpClient.send('Page.enable', {}, sessionId);
    cdpClient.on('Page.frameNavigated', async (params) => {
      if (!params.frame) return;
      const url = params.frame.url || '';
      monitor.handleNavigation(cdpClient, url);
      // 回到 Douyin 后验证 bridge，失败则重连
      if (pageState.value === 'recovering' || pageState.value === 'running') {
        const ok = await monitor.verifyBridge(cdpClient, sessionId);
        if (!ok) {
          console.error('[daemon] Bridge lost after navigation, reconnecting...');
          if (heartbeat) heartbeat.stop();
          cdpClient.close();
          reconnect.attempt(doConnect).catch(e => {
            console.error(`[daemon] Fatal: ${e.message}`);
            cleanup();
          });
        } else {
          pageState.value = 'running';
          console.error('[daemon] Bridge recovered, resuming operations');
        }
      }
    });

    // 心跳
    heartbeat = new HeartbeatMonitor({
      interval: 60000, failureThreshold: 3,
    });
    heartbeat.onConnectionLost = () => {
      console.error('[daemon] Heartbeat lost, reconnecting...');
      heartbeat.stop();
      cdpClient.close();
      reconnect.attempt(doConnect).catch(e => {
        console.error(`[daemon] Fatal: ${e.message}`);
        cleanup();
      });
    };
    heartbeat.start(cdpClient, sessionId);

    return { cdpClient, sessionId, heartbeat };
  }

  // 首次连接（带重试）
  try {
    await reconnect.attempt(doConnect);
  } catch(e) {
    console.error(`[daemon] Initial connection failed: ${e.message}`);
    releaseLock();
    process.exit(1);
  }

  let lastActivity = Date.now();
  const INACTIVE_TIMEOUT = 20 * 60 * 1000;

  const server = http.createServer(async (req, res) => {
    lastActivity = Date.now();

    // 页面离开时拒绝操作
    if (pageState.value !== 'running' && req.url !== '/ping' && req.url !== '/stop') {
      res.writeHead(503);
      res.end(JSON.stringify({ ok: false, error: 'Daemon paused — page navigated away from Douyin' }));
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/ping') {
      if (pageState.value !== 'running') {
        res.end(JSON.stringify({ ok: true, status: pageState.value }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/eval') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { expression, awaitPromise } = JSON.parse(body);
          const result = await cdpClient.send('Runtime.evaluate', {
            expression, returnByValue: true, awaitPromise: awaitPromise !== false,
          }, sessionId);
          res.end(JSON.stringify({ ok: true, value: result.result?.value }));
        } catch(e) { res.end(JSON.stringify({ ok: false, error: e.message })); }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/stop') {
      res.end(JSON.stringify({ ok: true }));
      cleanup(); return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(DAEMON_PORT, '127.0.0.1', () => {
    console.error(`[daemon] Listening on http://127.0.0.1:${DAEMON_PORT}`);
  });

  const timer = setInterval(() => {
    if (Date.now() - lastActivity > INACTIVE_TIMEOUT) {
      console.error('[daemon] Inactive timeout, exiting.');
      cleanup();
    }
  }, 60000);

  function cleanup() {
    clearInterval(timer);
    try { cdpClient?.close(); } catch(e) {}
    try { server.close(); } catch(e) {}
    releaseLock();
    process.exit(0);
  }
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

// ===== CLI → Daemon 通信 =====
function sendToDaemon(data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request({
      hostname: '127.0.0.1', port: DAEMON_PORT, path: '/eval', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('Invalid daemon response')); }
      });
    });
    req.on('error', () => reject(new Error('Daemon not running. Start with: node cli.js daemon')));
    req.write(body); req.end();
  });
}

// ===== Dashboard HTML 生成 =====
function generateDashboardHTML(videoId, days) {
  const title = videoId ? `视频 ${videoId} 评论仪表盘` : '抖音评论运营仪表盘';

  // 从审计日志中提取真实数据
  let totalComments = 0, repliedCount = 0, todayNew = 0;
  const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
  const dailyComments = {};
  const now = Date.now();
  const cutoffMs = now - days * 24 * 60 * 60 * 1000;

  try {
    const a = loadAudit();
    const todayStart = new Date(); todayStart.setHours(0,0,0,0); const todayTs = todayStart.getTime() / 1000;

    // 遍历所有操作，统计评论数和回复数
    for (const s of (a.sessions || [])) {
      for (const op of (s.operations || [])) {
        if (op.status !== 'success') continue;
        const opTime = op.started ? new Date(op.started).getTime() : 0;
        if (opTime < cutoffMs) continue;
        if (videoId && op.args?.aweme_id !== videoId) continue;

        // 评论获取 — 累加评论数
        if (op.command === 'get' && op.summary?.comments) {
          totalComments += op.summary.comments;
          // 按天统计
          const dayKey = op.started ? op.started.substring(0, 10) : 'unknown';
          dailyComments[dayKey] = (dailyComments[dayKey] || 0) + op.summary.comments;
          // 今日新增
          if (op.args?.since && op.args.since >= todayTs) {
            todayNew += op.summary.comments;
          }
        }
        // 回复发布 — 统计已回复
        if (op.command === 'post' && op.result?.status === 'published') {
          repliedCount++;
        }
        // LLM 分析结果 — 提取情感分布
        if (op.command === 'analyze' && op.resultFile) {
          try {
            const fp = path.join(__dirname, op.resultFile);
            if (fs.existsSync(fp)) {
              const analysisData = JSON.parse(fs.readFileSync(fp, 'utf8'));
              const items = Array.isArray(analysisData) ? analysisData : [];
              for (const item of items) {
                if (item.sentiment === 'positive') sentimentCounts.positive++;
                else if (item.sentiment === 'negative') sentimentCounts.negative++;
                else sentimentCounts.neutral++;
              }
            }
          } catch {}
        }
      }
    }

    // 如果没有 get 操作但有 results 文件，尝试从 results 文件中直接统计
    if (totalComments === 0) {
      try {
        const resultsDir = path.join(__dirname, 'logs', 'results');
        if (fs.existsSync(resultsDir)) {
          const files = fs.readdirSync(resultsDir).filter(f => f.startsWith('get-') && f.endsWith('.json'));
          for (const f of files) {
            if (videoId && !f.includes(videoId)) continue;
            try {
              const data = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'));
              const cmts = data.comments || [];
              totalComments += cmts.length;
            } catch {}
          }
        }
      } catch {}
    }
  } catch {}

  const pendingReplies = Math.max(0, totalComments - repliedCount);

  // 构建趋势数据
  const dayLabels = [];
  const dayValues = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().substring(0, 10);
    dayLabels.push(key.substring(5)); // MM-DD
    dayValues.push(dailyComments[key] || 0);
  }

  // 如果没有分析数据，提供默认分布
  const hasSentiment = sentimentCounts.positive + sentimentCounts.neutral + sentimentCounts.negative > 0;
  const sPos = hasSentiment ? sentimentCounts.positive : 0;
  const sNeu = hasSentiment ? sentimentCounts.neutral : 0;
  const sNeg = hasSentiment ? sentimentCounts.negative : 0;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:1200px;margin:0 auto;padding:20px;background:#f5f5f5}
h1{color:#1a1a1a}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin:20px 0}
.card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.card .label{color:#666;font-size:13px}.card .value{font-size:28px;font-weight:700;color:#1a1a1a}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(400px,1fr));gap:16px;margin:20px 0}
.chart-box{background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.hint{text-align:center;padding:20px;color:#999;font-size:14px}
</style></head>
<body>
<h1>${title}</h1>
<p>${new Date().toLocaleString('zh-CN')} | 最近 ${days} 天${videoId ? ' | 视频 ' + videoId : ''}</p>
<div class="cards">
<div class="card"><div class="label">评论总数</div><div class="value">${totalComments || '—'}</div></div>
<div class="card"><div class="label">待回复</div><div class="value">${pendingReplies || '—'}</div></div>
<div class="card"><div class="label">已回复</div><div class="value">${repliedCount || '—'}</div></div>
<div class="card"><div class="label">今日新增</div><div class="value">${todayNew || '—'}</div></div>
</div>
<div class="charts">
<div class="chart-box"><canvas id="s-chart"></canvas></div>
<div class="chart-box"><canvas id="t-chart"></canvas></div>
</div>
${!hasSentiment ? '<div class="hint">💡 运行 analyze 命令后，情感分布图表将展示真实数据</div>' : ''}
<script>
new Chart(document.getElementById('s-chart'),{type:'doughnut',data:{labels:['正面','中性','负面'],datasets:[{data:[${sPos},${sNeu},${sNeg}],backgroundColor:['#4CAF50','#FFC107','#F44336']}]},options:{responsive:true,plugins:{title:{display:true,text:'情感分布'}}}});
new Chart(document.getElementById('t-chart'),{type:'line',data:{labels:${JSON.stringify(dayLabels)},datasets:[{label:'评论数',data:${JSON.stringify(dayValues)},borderColor:'#2196F3',fill:false,tension:0.3}]},options:{responsive:true,plugins:{title:{display:true,text:'评论趋势（' + days + '天）'}},scales:{y:{beginAtZero:true}}}});
<\/script></body></html>`;
}

// ===== CLI 命令 =====
async function runCli() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const rawMode = args.includes('--raw');
  noLog = args.includes('--no-log');

  try {

  if (!cmd || cmd === 'help') {
    console.log(`
Douyin Comment CLI

  node cli.js daemon                      启动 daemon
  node cli.js ping                        探活 daemon
  node cli.js my                          我的作品
  node cli.js search <keyword>            搜索视频
  node cli.js get <aweme_id>              获取评论 (--all --depth N --new --since <ts>)
  node cli.js replies <cid> <aweme_id>    获取回复列表
  node cli.js post <aweme_id> "内容"       发表评论
  node cli.js post <aweme_id> "回复" --reply-to <cid>
  node cli.js analyze <aweme_id>           LLM 分析（情感/分类/优先级）
  node cli.js suggest <aweme_id>           LLM 回复建议（--auto 自动发布）
  node cli.js dashboard                    仪表盘 HTML
  node cli.js stop                         停止 daemon
  node cli.js log [--tail N] [--video <id>] [--failed]  查看操作日志

  通用选项： --raw（原始输出） --no-log（本次不记录日志）
`);
    return;
  }

  if (cmd === 'ping') {
    startOperation('ping', {});
    try {
      const res = await sendToDaemon({ expression: '1', awaitPromise: false });
      console.log('pong (daemon alive)');
      endOperation('success', {}, { result: 'pong' });
    } catch(e) {
      console.log('Daemon not running');
      endOperation('error', {}, null, e.message);
      process.exit(1);
    }
    return;
  }

  if (cmd === 'stop') {
    startOperation('stop', {});
    try { await sendToDaemon({ expression: '1' }); } catch(e) {}
    const req = http.request({ hostname: '127.0.0.1', port: DAEMON_PORT, path: '/stop', method: 'POST' });
    req.on('error', () => {});
    req.end();
    console.log('Daemon stopped.');
    endOperation('success', {}, { result: 'Daemon stopped.' });
    return;
  }

  if (cmd === 'replies') {
    const cid = args[1];
    if (!cid) { console.error('cid required'); process.exit(1); }
    let cursor = 0, count = 20, awemeId = '';
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--cursor') cursor = parseInt(args[++i]) || 0;
      else if (args[i] === '--count') count = parseInt(args[++i]) || 20;
      else if (!awemeId && !args[i].startsWith('--')) awemeId = args[i];
    }
    startOperation('replies', { cid, aweme_id: awemeId, cursor, count });
    console.error(`Fetching replies for ${cid}...`);
    const res = await loggedSend('replies', { cid, aweme_id: awemeId, cursor, count }, `window.__dy.replies('${cid}', '${awemeId}', ${cursor}, ${count})`, true);
    if (!res.ok) throw new Error(res.error);
    const data = res.value || {};
    const items = (data.comments || []).map(c => ({
      cid: c.cid,
      text: c.text,
      likes: c.digg_count || 0,
      time: c.create_time,
      user: { nickname: c.user?.nickname || '', uid: c.user?.uid || '', avatar: (c.user?.avatar_thumb?.url_list || [])[0] || '' },
    }));
    console.log(rawMode ? JSON.stringify(data, null, 2) : JSON.stringify(items, null, 2));
    console.error(`\nReplies: ${items.length}`);
    endOperation('success', { replies: items.length }, { comments: items });
    return;
  }

  if (cmd === 'my') {
    let cursor = 0, count = 18;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--cursor') cursor = parseInt(args[++i]) || 0;
      else if (args[i] === '--count') count = parseInt(args[++i]) || 18;
    }
    startOperation('my', { cursor, count });
    console.error('Fetching my posts...');
    const res = await loggedSend('myPosts', { cursor, count }, `window.__dy.myPosts(${cursor}, ${count})`, true);
    if (!res.ok) throw new Error(res.error);
    const data = res.value || {};
    const items = (data.aweme_list || []).map(p => ({
      aweme_id: p.aweme_id,
      desc: (p.desc || '').substring(0, 80),
      time: p.create_time,
      stats: { plays: p.statistics?.play_count || 0, likes: p.statistics?.digg_count || 0, comments: p.statistics?.comment_count || 0, shares: p.statistics?.share_count || 0 },
    }));
    console.log(rawMode ? JSON.stringify(data, null, 2) : JSON.stringify(items, null, 2));
    console.error(`\nMy posts: ${items.length} (has_more: ${data.has_more})`);
    endOperation('success', { posts: items.length, has_more: data.has_more }, { aweme_list: items });
    return;
  }

  if (cmd === 'search') {
    const keyword = args[1];
    if (!keyword) { console.error('keyword required'); process.exit(1); }
    let offset = 0, count = 10;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--offset') offset = parseInt(args[++i]) || 0;
      else if (args[i] === '--count') count = parseInt(args[++i]) || 10;
    }
    startOperation('search', { keyword, offset, count });
    console.error(`Searching: "${keyword}"...`);
    const res = await loggedSend('search', { keyword, offset, count }, `window.__dy.search('${keyword.replace(/'/g, "\\'")}', ${offset}, ${count})`, true);
    if (!res.ok) throw new Error(res.error);
    const data = res.value || {};
    const items = (data.data || []).filter(d => d.aweme_info).map(d => ({
      aweme_id: d.aweme_info.aweme_id,
      desc: (d.aweme_info.desc || '').substring(0, 80),
      author: d.aweme_info.author?.nickname || '',
      uid: d.aweme_info.author?.uid || '',
      time: d.aweme_info.create_time,
      plays: d.aweme_info.statistics?.play_count || 0,
    }));
    console.log(rawMode ? JSON.stringify(data, null, 2) : JSON.stringify(items, null, 2));
    console.error(`\nFound: ${items.length} videos`);
    endOperation('success', { found: items.length }, { results: items });
    return;
  }

  if (cmd === 'log') {
    let tail = 10, videoFilter = null, failedOnly = false;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--tail') tail = parseInt(args[++i]) || 10;
      else if (args[i] === '--video') videoFilter = args[++i];
      else if (args[i] === '--failed') failedOnly = true;
    }
    const a = loadAudit();
    let ops = [];
    for (const s of (a.sessions || [])) {
      for (const op of (s.operations || [])) {
        ops.push({ sessionId: s.sessionId, ...op });
      }
    }
    if (videoFilter) ops = ops.filter(o => o.args?.aweme_id === videoFilter);
    if (failedOnly) ops = ops.filter(o => o.status !== 'success');
    ops = ops.slice(-tail);
    if (!ops.length) { console.log('(no matching log entries)'); return; }
    for (const o of ops) {
      const statusIcon = o.status === 'success' ? '✅' : o.status === 'running' ? '⏳' : '❌';
      const dur = o.durationMs != null ? ` ${(o.durationMs / 1000).toFixed(1)}s` : '';
      console.log(`${statusIcon} [${o.started?.substring(0,19) || '?'}] ${o.command} ${JSON.stringify(o.args)}${dur}`);
      if (o.error) console.log(`   error: ${o.error}`);
      if (o.resultFile) console.log(`   result: ${o.resultFile}`);
      else if (o.result) console.log(`   result: ${JSON.stringify(o.result)}`);
      if (o.summary && Object.keys(o.summary).length) console.log(`   summary: ${JSON.stringify(o.summary)}`);
    }
    return;
  }

  if (cmd === 'get' || cmd === 'post') {
    const awemeId = args[1];
    if (!awemeId) { console.error('aweme_id required'); process.exit(1); }

    if (cmd === 'get') {
      let pages = 1, allMode = false, depth = 0, newMode = false, sinceCutoff = null;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--pages') pages = parseInt(args[++i]) || 1;
        else if (args[i] === '--all') allMode = true;
        else if (args[i] === '--depth') depth = parseInt(args[++i]) || 0;
        else if (args[i] === '--new') newMode = true;
        else if (args[i] === '--since') sinceCutoff = parseInt(args[++i]) || 0;
      }
      if (newMode && !sinceCutoff) {
        sinceCutoff = findLastFetchTime(awemeId);
        if (sinceCutoff) console.error(`[new] cutoff: ${new Date(sinceCutoff * 1000).toISOString()}`);
        else console.error('[new] no previous fetch found, pulling all');
      }
      const maxPages = (allMode || sinceCutoff) ? 999 : pages;
      const modeLabel = sinceCutoff ? `since=${sinceCutoff}` : (allMode ? 'all' : `pages=${pages}`);
      startOperation('get', { aweme_id: awemeId, mode: modeLabel, depth, since: sinceCutoff || undefined });
      console.error(`Fetching comments for ${awemeId} (${modeLabel}) depth=${depth}...`);

      // 拉一级评论
      let all = [], cursor = 0, actualPages = 0;
      for (let p = 0; p < maxPages; p++) {
        const res = await loggedSend('getComments', { aweme_id: awemeId, cursor, count: 20 }, `window.__dy.getComments('${awemeId}', ${cursor}, 20)`, true);
        if (!res.ok) throw new Error(res.error);
        const data = res.value || {};
        const comments = data.comments || [];
        if (sinceCutoff) {
          const fresh = comments.filter(c => c.create_time > sinceCutoff);
          all.push(...fresh);
          if (fresh.length < comments.length) {
            console.error(`  Page ${p + 1}: ${fresh.length} new / ${comments.length} total → cutoff reached`);
            actualPages++; break;
          }
          console.error(`  Page ${p + 1}: ${fresh.length} new (total: ${all.length})`);
        } else {
          all.push(...comments);
          console.error(`  Page ${p + 1}: ${comments.length} (total: ${all.length})`);
        }
        actualPages++;
        if (!data.has_more || !comments.length) break;
        cursor = data.cursor || (cursor + comments.length);
      }

      // 递归拉回复
      async function fetchChildren(comments, currentDepth) {
        if (currentDepth >= depth) return;
        let fetched = 0, hasRepliesCount = 0;
        for (const c of comments) {
          const replyCount = c.reply_comment_total || 0;
          if (replyCount > 0) {
            hasRepliesCount++;
            try {
              const r = await loggedSend('replies', { cid: c.cid, aweme_id: awemeId, depth: currentDepth + 1 }, `window.__dy.replies('${c.cid}', '${awemeId}', 0, ${Math.min(replyCount, 50)})`, true);
              if (r.ok && r.value) {
                const rdata = r.value;
                c.children = rdata.comments || [];
                fetched += c.children.length;
                if (c.children.length > 0) await fetchChildren(c.children, currentDepth + 1);
              } else {
                console.error(`  [warn] replies failed for ${c.cid}: ${r.error || 'empty'}`);
              }
            } catch(e) { console.error(`  [warn] replies error for ${c.cid}: ${e.message}`); }
          }
        }
        console.error(`  Depth ${currentDepth + 1}: ${hasRepliesCount} parents → ${fetched} replies`);
      }
      await fetchChildren(all, 0);

      const clean = (list) => list.map(c => {
        const obj = {
          cid: c.cid, text: c.text, likes: c.digg_count || 0, replies: c.reply_comment_total || 0, time: c.create_time,
          user: { nickname: c.user?.nickname || '', uid: c.user?.uid || '', avatar: (c.user?.avatar_thumb?.url_list || [])[0] || '' },
        };
        if (c.children && c.children.length > 0) obj.children = clean(c.children);
        return obj;
      });
      const cleaned = clean(all);

      if (rawMode) {
        console.log(JSON.stringify(all, null, 2));
      } else {
        console.log(JSON.stringify(cleaned, null, 2));
      }
      console.error(`\nTotal: ${all.length} comments`);
      endOperation('success', { comments: all.length, pages: actualPages }, { comments: cleaned });

    } else { // post
      const content = args[2];
      if (!content) { console.error('content required'); process.exit(1); }
      let replyId = 'null', replyIdRaw = null;
      for (let i = 3; i < args.length; i++) {
        if (args[i] === '--reply-to') { replyIdRaw = args[++i]; replyId = `'${replyIdRaw}'`; }
      }
      startOperation('post', { aweme_id: awemeId, text: content, reply_to: replyIdRaw });
      const sc = content.replace(/'/g, "\\'");
      console.error(`Publishing: "${content}"`);
      const res = await loggedSend('publish', { aweme_id: awemeId, text: content, reply_to: replyIdRaw }, `window.__dy.publish('${awemeId}', '${sc}', ${replyId})`, true);
      if (!res.ok) throw new Error(res.error);
      const rv = res.value || {};
      if (rawMode) {
        console.log(JSON.stringify(rv, null, 2));
      } else if (rv.comment) {
        console.log(JSON.stringify({ cid: rv.comment.cid, text: rv.comment.text, time: rv.comment.create_time, status: 'published' }, null, 2));
      } else {
        console.log(JSON.stringify({ error: `status_code=${rv.status_code}` }, null, 2));
      }
      console.error(rv.comment ? '✅ 成功' : `❌ status_code=${rv.status_code}`);
      if (rv.comment) {
        endOperation('success', {}, { cid: rv.comment.cid, text: rv.comment.text, status: 'published' });
      } else {
        endOperation('error', { status_code: rv.status_code }, null, `status_code=${rv.status_code}`);
      }
    }
    return;
  }

  // ===== 运营智能命令 =====

  if (cmd === 'analyze') {
    const analyzeAwemeId = args[1];
    if (!analyzeAwemeId) { console.error('aweme_id required'); process.exit(1); }
    const { LLMClient } = require('./lib/llm');
    const llmCheck = new LLMClient();
    if (!llmCheck.apiKey) {
      console.error('LLM API key not configured. Set api_key in config.json or OPENAI_API_KEY env.');
      process.exit(1);
    }
    startOperation('analyze', { aweme_id: analyzeAwemeId });
    try {
      console.error(`Analyzing comments for ${analyzeAwemeId}...`);
      const res = await sendToDaemon({ expression: `window.__dy.getComments('${analyzeAwemeId}', 0, 50)`, awaitPromise: true });
      if (!res.ok) throw new Error(res.error);
      const data = res.value || {};
      const comments = (data.comments || []).slice(0, 100);
      console.error(`  Got ${comments.length} comments, sending to LLM...`);

      const result = await llmCheck.analyzeComments(comments, { style: '自然友好' });
      console.log(JSON.stringify(result, null, 2));
      console.error(`\nAnalyzed: ${result.length} comments`);
      endOperation('success', { analyzed: result.length });
    } catch(e) {
      endOperation('error', {}, null, e.message);
      throw e;
    }
    return;
  }

  if (cmd === 'suggest') {
    const suggestAwemeId = args[1];
    if (!suggestAwemeId) { console.error('aweme_id required'); process.exit(1); }
    const { LLMClient } = require('./lib/llm');
    let autoMode = false, minPrio = 3;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--auto') autoMode = true;
      if (args[i] === '--min-priority') minPrio = parseInt(args[++i]) || 3;
    }
    startOperation('suggest', { aweme_id: suggestAwemeId, auto: autoMode, min_priority: minPrio });
    console.error(`Generating reply suggestions for ${suggestAwemeId}...`);

    // 1. 拉评论
    const res = await sendToDaemon({ expression: `window.__dy.getComments('${suggestAwemeId}', 0, 50)`, awaitPromise: true });
    if (!res.ok) throw new Error(res.error);
    const data = res.value || {};
    const comments = (data.comments || []).slice(0, 100);

    // 2. LLM 分析 + 生成建议
    const llm = new LLMClient();
    const analyzed = await llm.analyzeComments(comments, { style: '自然友好' });
    const prioritized = analyzed.filter(c => c.priority >= minPrio);
    const suggestions = await llm.suggestReplies(
      prioritized.map(a => {
        const orig = comments.find(c => c.cid === a.cid);
        return { cid: a.cid, text: orig?.text || '', category: a.category };
      }),
      { style: '自然友好，15-50 字' },
      ''
    );

    if (autoMode) {
      // 自动发布
      let published = 0, skipped = 0;
      for (const s of suggestions) {
        if (!s.reply) { skipped++; continue; }
        try {
          const pr = await sendToDaemon({
            expression: `window.__dy.publish('${suggestAwemeId}', '${s.reply.replace(/'/g, "\\'")}', '${s.cid}')`,
            awaitPromise: true,
          });
          if (pr.ok && pr.value?.comment) { published++; s.status = 'published'; s.reply_cid = pr.value.comment.cid; }
          else { skipped++; s.status = 'failed'; s.error = `status_code=${pr.value?.status_code}`; }
        } catch(e) { skipped++; s.status = 'error'; s.error = e.message; }
      }
      console.log(JSON.stringify({ published, skipped, details: suggestions }, null, 2));
      console.error(`\nPublished: ${published}, Skipped: ${skipped}`);
      endOperation('success', { published, skipped });
    } else {
      console.log(JSON.stringify({ aweme_id: suggestAwemeId, suggestions }, null, 2));
      console.error(`\nSuggestions: ${suggestions.length}`);
      endOperation('success', { suggestions: suggestions.length });
    }
    return;
  }

  if (cmd === 'dashboard') {
    let videoId = null, days = 7, open = true;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--video') videoId = args[++i];
      else if (args[i] === '--days') days = parseInt(args[++i]) || 7;
      else if (args[i] === '--no-open') open = false;
    }
    startOperation('dashboard', { video: videoId, days });
    console.error(`Generating dashboard${videoId ? ' for ' + videoId : ''} (${days} days)...`);

    const html = generateDashboardHTML(videoId, days);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const outPath = path.join(__dirname, 'logs', `dashboard-${ts}.html`);
    ensureLogDirs();
    fs.writeFileSync(outPath, html);
    console.log(outPath);
    console.error(`\nDashboard saved: ${outPath}`);
    if (open) {
      const { exec } = require('child_process');
      exec(`start "" "${outPath}"`);
    }
    endOperation('success', { path: outPath });
    return;
  }

  if (cmd === 'profile') {
    // 简单实现：从 audit 中提取用户交互数据
    startOperation('profile', { args: args.slice(1) });
    const uid = args[1];
    if (!uid) { console.error('uid required'); process.exit(1); }
    ensureLogDirs();
    const audit = loadAudit();
    const interactions = [];
    for (const s of (audit.sessions || [])) {
      for (const op of (s.operations || [])) {
        if (op.command === 'post' && op.args?.reply_to) {
          // 从 args 中提取是否回复了此用户
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
    endOperation('success', { uid, interactions: interactions.length });
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);

  } catch(e) {
    if (!noLog && currentOp) endOperation('error', {}, null, e.message);
    throw e;
  }
}

// ===== 入口 =====
if (DAEMON) {
  runDaemon().catch(e => { console.error('[daemon] Error:', e.message); process.exit(1); });
} else {
  runCli().catch(e => { console.error('[CLI] Error:', e.message); process.exit(1); });
}
