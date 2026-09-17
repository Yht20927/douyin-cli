// lib/audit.js — 审计日志模块（从 cli.js 提取）
//
// v3 起：endOperation 末尾旁路写入 SQLite events 表（lib/memory/events.js）。
// SQLite 写失败不影响主流程；audit.json 仍是真实之源，事件流是查询副本。

const fs = require('fs');
const path = require('path');

// 默认 logs 在项目根；通过 DOUYIN_LOG_DIR 可重定向（测试用）
const LOG_DIR = process.env.DOUYIN_LOG_DIR
  ? path.resolve(process.env.DOUYIN_LOG_DIR)
  : path.join(__dirname, '..', 'logs');
const AUDIT_FILE = path.join(LOG_DIR, 'audit.json');
const RESULTS_DIR = path.join(LOG_DIR, 'results');

// 延迟加载，避免 better-sqlite3 加载失败时整个 audit 模块挂掉
let _events = null;
function eventsModule() {
  if (_events === null) {
    try { _events = require('./memory/events'); }
    catch (e) {
      if (process.env.DOUYIN_DEBUG) console.warn('[audit] events module unavailable:', e.message);
      _events = false;
    }
  }
  return _events || null;
}

class AuditLogger {
  constructor() {
    this._audit = null;
    this._currentOp = null;
    this._noLog = false;
  }

  setNoLog(v) { this._noLog = v; }

  ensureDirs() {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }

  load() {
    if (!fs.existsSync(AUDIT_FILE)) return { version: '2.0', updated: new Date().toISOString(), sessions: [] };
    try { return JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')); }
    catch (e) { return { version: '2.0', updated: new Date().toISOString(), sessions: [] }; }
  }

  save() {
    if (this._noLog) return;
    this._audit.updated = new Date().toISOString();
    const tmp = AUDIT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._audit, null, 2));
    fs.renameSync(tmp, AUDIT_FILE);
  }

  newSession() {
    const last = this._audit.sessions[this._audit.sessions.length - 1];
    if (last && !last.ended) return last;
    const s = {
      sessionId: new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19) + '-' + Math.random().toString(36).substring(2, 6),
      started: new Date().toISOString(),
      ended: null,
      operations: [],
    };
    this._audit.sessions.push(s);
    if (this._audit.sessions.length > 50) this._audit.sessions = this._audit.sessions.slice(-50);
    return s;
  }

  startOperation(cmd, args) {
    if (this._noLog) return;
    this.ensureDirs();
    this._audit = this.load();
    const s = this.newSession();
    this._currentOp = {
      index: s.operations.length + 1,
      command: cmd,
      args,
      started: new Date().toISOString(),
      ended: null,
      durationMs: null,
      status: 'running',
      summary: {},
      apiCalls: [],
    };
    s.operations.push(this._currentOp);
    this.save();
  }

  logApiCall(endpoint, params, durationMs, status, summary) {
    if (this._noLog || !this._currentOp) return;
    this._currentOp.apiCalls.push({
      seq: this._currentOp.apiCalls.length + 1,
      endpoint,
      params,
      durationMs,
      status,
      summary: summary || {},
    });
  }

  endOperation(status, summary, resultData, error) {
    if (this._noLog || !this._currentOp) return;
    this._currentOp.ended = new Date().toISOString();
    this._currentOp.durationMs = Date.now() - new Date(this._currentOp.started).getTime();
    this._currentOp.status = status;
    if (summary) this._currentOp.summary = summary;
    if (error) this._currentOp.error = error;

    const largeResults = ['get', 'search', 'my', 'replies'];
    if (resultData && largeResults.includes(this._currentOp.command) && status === 'success') {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      let label = this._currentOp.command;
      if (this._currentOp.args.aweme_id) label += '-' + this._currentOp.args.aweme_id;
      else if (this._currentOp.args.keyword) label += '-' + sanitize(this._currentOp.args.keyword);
      else if (this._currentOp.args.cid) label += '-' + this._currentOp.args.cid;
      const fp = path.join(RESULTS_DIR, label + '-' + ts + '.json');
      fs.writeFileSync(fp, JSON.stringify({
        command: this._currentOp.command,
        args: this._currentOp.args,
        started: this._currentOp.started,
        ...resultData,
      }, null, 2));
      this._currentOp.resultFile = 'logs/results/' + path.basename(fp);
    } else if (resultData && status === 'success') {
      this._currentOp.result = resultData;
    }
    // AUDIT_DOUBLE_WRITE=false 时停双写 audit.json（events 表为唯一源；默认 true 保持兼容）
    if (process.env.AUDIT_DOUBLE_WRITE !== 'false') {
      this.save();
    }

    // ── v3 旁路：写入 SQLite events 表（失败不影响主流程） ──
    try {
      const events = eventsModule();
      if (events) {
        const op = this._currentOp;
        const session = (this._audit && this._audit.sessions || []).slice(-1)[0];
        events.append({
          ts: op.ended ? new Date(op.ended).getTime() : Date.now(),
          sessionId: session ? session.sessionId : null,
          command: op.command,
          status: op.status,
          durationMs: op.durationMs,
          awemeId: op.args && op.args.aweme_id || null,
          uid: op.args && op.args.uid || null,
          cid: op.args && op.args.cid || null,
          args: op.args || null,
          summary: op.summary || null,
          error: op.error || null,
          resultPath: op.resultFile || null,
        });
      }
    } catch (e) { /* 静默：events.append 自身已 try/catch */ }

    this._currentOp = null;
  }

  /**
   * 查找某视频上次成功拉取的时间（Unix 秒），用于 --new 增量
   *
   * v3 起：优先走 SQLite events 表（O(log N)，索引覆盖），失败时回退到 audit.json 全表扫。
   */
  findLastFetchTime(awemeId) {
    // ── 路径 A：SQLite ──
    try {
      const events = eventsModule();
      if (events && typeof events.findLastFetchTime === 'function') {
        const t = events.findLastFetchTime(awemeId);
        if (t != null) return t;
        // SQL 返回 null 有两种语义：
        //   1) events 表里真没有该视频的 get 记录
        //   2) v3 之前的历史只在 audit.json 中，未 import
        // 为避免遗漏 (2)，直接 fallthrough 到路径 B
      }
    } catch (e) { /* 静默回退 */ }

    // ── 路径 B：audit.json 全表扫（兼容历史） ──
    const a = this.load();
    let latest = null;
    for (const s of (a.sessions || [])) {
      for (const op of (s.operations || [])) {
        if (op.command === 'get' && op.args && op.args.aweme_id === awemeId && op.status === 'success' && op.ended) {
          const t = new Date(op.ended).getTime() / 1000;
          if (latest === null || t > latest) latest = t;
        }
      }
    }
    return latest;
  }
}

function sanitize(s) {
  return (s || '').replace(/[<>:"/\\|?*'\s]/g, '_').substring(0, 20);
}

module.exports = { AuditLogger };
