// lib/memory/events.js — 事件流读写
//
// 替代 audit.json 的全表扫描路径：所有"按视频/用户/命令查询历史"的需求都走这里。
// audit.json 仍由 audit.js 同步双写，作为只读灾备快照。

const { getDb } = require('./db');

/**
 * 追加一条事件。返回 lastInsertRowid，失败返回 null（不抛异常，避免污染主流程）。
 *
 * 字段语义：
 * - ts: ms 时间戳（事件结束时刻；running 状态可用 started ts）
 * - sessionId: 由 audit.js 维护的 session 标识
 * - command: 'get' / 'post' / ...
 * - status: 'success' / 'error' / 'running'
 * - awemeId / uid / cid: 主键索引字段（从 args 抽取一份冗余在列上，避免 JSON 解析）
 * - args / summary: 任意结构，存为 JSON 文本
 * - error: 错误消息字符串
 * - resultPath: 大结果落地的相对路径（如 logs/results/get-xxx.json）
 * - platform: 默认 'douyin'，预留跨平台
 */
function append(evt) {
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO events (
        ts, session_id, command, status, duration_ms,
        aweme_id, uid, cid, args_json, summary_json,
        error, result_path, platform
      ) VALUES (
        @ts, @sessionId, @command, @status, @durationMs,
        @awemeId, @uid, @cid, @argsJson, @summaryJson,
        @error, @resultPath, @platform
      )
    `);
    const info = stmt.run({
      ts: evt.ts || Date.now(),
      sessionId: evt.sessionId || null,
      command: evt.command,
      status: evt.status || 'success',
      durationMs: evt.durationMs ?? null,
      awemeId: evt.awemeId || (evt.args && evt.args.aweme_id) || null,
      uid: evt.uid || (evt.args && evt.args.uid) || null,
      cid: evt.cid || (evt.args && evt.args.cid) || null,
      argsJson: evt.args ? JSON.stringify(evt.args) : null,
      summaryJson: evt.summary ? JSON.stringify(evt.summary) : null,
      error: evt.error || null,
      resultPath: evt.resultPath || null,
      platform: evt.platform || 'douyin',
    });
    return info.lastInsertRowid;
  } catch (e) {
    // SQLite 出问题不应阻塞 CLI，audit.json 仍是真实之源
    if (process.env.DOUYIN_DEBUG) console.warn('[events.append] failed:', e.message);
    return null;
  }
}

/**
 * 通用查询。filters 任一字段为 null/undefined 即跳过该条件。
 * @param {object} filters - { command, awemeId, uid, status, since, until, sessionId }
 * @param {object} opts    - { limit=100, order='asc'|'desc' (默认 desc) }
 * @returns {Array<object>} 反序列化后的事件数组（args/summary 为对象）
 */
function query(filters = {}, opts = {}) {
  try {
    const db = getDb();
    const where = [];
    const params = {};
    if (filters.command)   { where.push('command = @command');     params.command = filters.command; }
    if (filters.awemeId)   { where.push('aweme_id = @awemeId');    params.awemeId = filters.awemeId; }
    if (filters.uid)       { where.push('uid = @uid');             params.uid = filters.uid; }
    if (filters.status)    { where.push('status = @status');       params.status = filters.status; }
    if (filters.sessionId) { where.push('session_id = @sessionId');params.sessionId = filters.sessionId; }
    if (filters.since)     { where.push('ts >= @since');           params.since = filters.since; }
    if (filters.until)     { where.push('ts <= @until');           params.until = filters.until; }
    if (filters.platform)  { where.push('platform = @platform');   params.platform = filters.platform; }

    const order = opts.order === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.max(1, Math.min(opts.limit || 100, 100000));
    const sql = `
      SELECT id, ts, session_id, command, status, duration_ms,
             aweme_id, uid, cid, args_json, summary_json, error, result_path, platform
      FROM events
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ts ${order}, id ${order}
      LIMIT ${limit}
    `;
    const rows = db.prepare(sql).all(params);
    return rows.map(rowToEvent);
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[events.query] failed:', e.message);
    return [];
  }
}

/**
 * 找到某视频上次成功 'get' 的时间（Unix 秒），用于 --new 增量。
 * 返回 null 表示从未拉过或 SQL 失败（调用方应回退到 audit.json 路径）。
 */
function findLastFetchTime(awemeId) {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT max(ts) AS ms
      FROM events
      WHERE command = 'get' AND status = 'success' AND aweme_id = ?
    `).get(awemeId);
    return row && row.ms ? Math.floor(row.ms / 1000) : null;
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[events.findLastFetchTime] failed:', e.message);
    return null;
  }
}

/**
 * 简单计数（脚本/测试用）。
 */
function count(filters = {}) {
  try {
    const db = getDb();
    const where = [];
    const params = {};
    if (filters.command) { where.push('command = @command'); params.command = filters.command; }
    if (filters.status)  { where.push('status = @status');   params.status  = filters.status; }
    if (filters.awemeId) { where.push('aweme_id = @awemeId'); params.awemeId = filters.awemeId; }
    const sql = `SELECT count(*) AS n FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    return db.prepare(sql).get(params).n;
  } catch (e) {
    return 0;
  }
}

function cleanupBefore(ts, opts = {}) {
  try {
    const db = getDb();
    if (opts.dryRun) {
      return db.prepare('SELECT count(*) AS n FROM events WHERE ts < ?').get(ts).n;
    }
    const limit = opts.limit || 1000;
    return db.prepare('DELETE FROM events WHERE ts < ? LIMIT ?').run(ts, limit).changes;
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[events.cleanupBefore] failed:', e.message);
    return 0;
  }
}

function rowToEvent(r) {
  return {
    id: r.id,
    ts: r.ts,
    sessionId: r.session_id,
    command: r.command,
    status: r.status,
    durationMs: r.duration_ms,
    awemeId: r.aweme_id,
    uid: r.uid,
    cid: r.cid,
    args: r.args_json ? safeParse(r.args_json) : null,
    summary: r.summary_json ? safeParse(r.summary_json) : null,
    error: r.error,
    resultPath: r.result_path,
    platform: r.platform,
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

module.exports = { append, query, findLastFetchTime, count, cleanupBefore };
