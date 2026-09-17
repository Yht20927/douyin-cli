// lib/memory/failures.js — 发布失败模式（P3）
//
// 设计要点：
// - 每条 post 失败按"原因 signature"做归一化，UPSERT 累加 hit_count；
//   signature 是稳定字符串：例如 'status_code=8'、'sticker_reply'、'dup_text'。
// - mitigation 不在这里硬编码业务，由调用方记录或从 ENV/JSON 配置加载。
// - 目的：① 给 suggest 注入「避雷清单」；② 后续 P4 自适应风控查询冷却期使用。

const { getDb } = require('./db');

const PLATFORM = 'douyin';

/**
 * 把一段错误文本/状态码归一化为 signature。
 * 输入可以是 Error / string / { status_code, message } 等，返回稳定字符串。
 */
function classify(input) {
  if (input == null) return 'unknown';
  // 显式 status_code 优先
  if (typeof input === 'object') {
    if (input.status_code != null) return `status_code=${input.status_code}`;
    if (input.signature) return String(input.signature);
    if (input.message) return classify(input.message);
    return 'unknown';
  }
  const msg = String(input);
  // 尝试在错误消息里抓 status_code
  const m = msg.match(/status_code\s*=\s*(\d+)/i);
  if (m) return `status_code=${m[1]}`;
  // 油猴侧典型错误
  if (/HTML\s*页面|非\s*JSON|空响应/i.test(msg)) return 'bridge_html_response';
  if (/ECONNREFUSED|Bridge Server 未启动/i.test(msg)) return 'bridge_offline';
  if (/Unauthorized|认证失败/i.test(msg)) return 'bridge_unauthorized';
  if (/服务器未返回评论数据/i.test(msg)) return 'no_comment_returned';
  if (/重复|duplicate|dup_text/i.test(msg)) return 'dup_text';
  if (/sticker|表情包/i.test(msg)) return 'sticker_reply';
  // 兜底：截前 80 字符做 signature（同样错误会被汇总）
  return 'msg:' + msg.slice(0, 80);
}

/**
 * 记录一次失败，hit_count++，更新 last_hit / example_text。
 * @returns {boolean}
 */
function record(input, opts = {}) {
  try {
    const sig = classify(input);
    const db = getDb();
    const now = Date.now();
    const exampleText = opts.exampleText || (typeof input === 'string' ? String(input).slice(0, 200) : null);
    db.prepare(`
      INSERT INTO failure_patterns (platform, signature, hit_count, last_hit, example_text, mitigation)
      VALUES (@platform, @signature, 1, @lastHit, @exampleText, @mitigation)
      ON CONFLICT(platform, signature) DO UPDATE SET
        hit_count    = hit_count + 1,
        last_hit     = excluded.last_hit,
        example_text = COALESCE(excluded.example_text, example_text),
        mitigation   = COALESCE(excluded.mitigation, mitigation)
    `).run({
      platform: PLATFORM,
      signature: sig,
      lastHit: now,
      exampleText,
      mitigation: opts.mitigation || null,
    });
    return true;
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[failures.record] failed:', e.message);
    return false;
  }
}

/**
 * Top-N 失败模式（按 hit_count DESC）。
 */
function top(limit = 10) {
  try {
    const db = getDb();
    const n = Math.max(1, Math.min(limit || 10, 200));
    const rows = db.prepare(`
      SELECT id, signature, hit_count, last_hit, example_text, mitigation
      FROM failure_patterns WHERE platform = ?
      ORDER BY hit_count DESC, last_hit DESC LIMIT ${n}
    `).all(PLATFORM);
    return rows.map(_map);
  } catch (e) { return []; }
}

/**
 * 最近 N 条（按 last_hit DESC）。
 */
function recent(limit = 10) {
  try {
    const db = getDb();
    const n = Math.max(1, Math.min(limit || 10, 200));
    const rows = db.prepare(`
      SELECT id, signature, hit_count, last_hit, example_text, mitigation
      FROM failure_patterns WHERE platform = ?
      ORDER BY last_hit DESC LIMIT ${n}
    `).all(PLATFORM);
    return rows.map(_map);
  } catch (e) { return []; }
}

function get(signature) {
  try {
    const row = getDb().prepare(`
      SELECT id, signature, hit_count, last_hit, example_text, mitigation
      FROM failure_patterns WHERE platform = ? AND signature = ?
    `).get(PLATFORM, signature);
    return row ? _map(row) : null;
  } catch (e) { return null; }
}

function setMitigation(signature, mitigation) {
  if (!signature) return false;
  try {
    getDb().prepare(`UPDATE failure_patterns SET mitigation = ? WHERE platform = ? AND signature = ?`)
      .run(mitigation || null, PLATFORM, signature);
    return true;
  } catch (e) { return false; }
}

/**
 * 最近 ms 毫秒内的失败模式（按 last_hit DESC，含累计 hit_count）。
 * 用于风控断路器：近期高频失败 → 暂停自动发布。
 */
function recentWithin(ms) {
  try {
    const cutoff = Date.now() - ms;
    return getDb().prepare(`
      SELECT signature, hit_count, last_hit, example_text, mitigation
      FROM failure_patterns WHERE platform = ? AND last_hit >= ?
      ORDER BY last_hit DESC
    `).all(PLATFORM, cutoff).map(_map);
  } catch (e) { return []; }
}

function count() {
  try {
    return getDb().prepare(`SELECT count(*) AS n FROM failure_patterns WHERE platform = ?`).get(PLATFORM).n;
  } catch (e) { return 0; }
}

function _map(r) {
  return {
    id: r.id,
    signature: r.signature,
    hitCount: r.hit_count,
    lastHit: r.last_hit,
    exampleText: r.example_text,
    mitigation: r.mitigation,
  };
}

module.exports = { classify, record, top, recent, recentWithin, get, setMitigation, count };
