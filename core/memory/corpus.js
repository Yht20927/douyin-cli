// lib/memory/corpus.js — 回复语料库（P3）
//
// 设计要点：
// - 每条「我们发布过的回复」入表一行，reply_hash = md5(normalize(reply_text))，
//   用于去重护栏（同一句不要再发第二次）。
// - outcome：published / risk_blocked / deleted / unknown。published 是默认成功值，
//   非成功状态下也允许写入（让 effectiveness 后台异步回填）。
// - effectiveness 留给未来按点赞/二次评论数后台回填，本模块只暴露 setEffectiveness。
// - 所有 SQL 包 try/catch，失败返回 null/false/0/[]。

const { getDb } = require('./db');
const { hashText, normalizeText } = require('./comments');

const PLATFORM = 'douyin';

/**
 * 追加一条 reply 语料。
 * @param {object} fields
 * @param {string} fields.replyText (必填)
 * @param {string} [fields.srcCid]    被回复评论的 cid
 * @param {string} [fields.srcText]   被回复评论的原文（已 sanitize 后短文本即可）
 * @param {string} [fields.awemeId]
 * @param {number} [fields.postedAt]  ms
 * @param {string} [fields.outcome]   默认 'published'
 * @returns {number|null} lastInsertRowid，失败 null
 */
function append(fields) {
  if (!fields || !fields.replyText) return null;
  try {
    const db = getDb();
    const info = db.prepare(`
      INSERT INTO reply_corpus (
        platform, src_cid, src_text, reply_text, reply_hash,
        aweme_id, posted_at, outcome, reply_cid
      ) VALUES (
        @platform, @srcCid, @srcText, @replyText, @replyHash,
        @awemeId, @postedAt, @outcome, @replyCid
      )
      ON CONFLICT(platform, reply_hash) DO UPDATE SET
        posted_at = excluded.posted_at,
        outcome = excluded.outcome,
        reply_cid = COALESCE(excluded.reply_cid, reply_cid),
        src_cid = COALESCE(excluded.src_cid, src_cid),
        src_text = COALESCE(excluded.src_text, src_text),
        aweme_id = COALESCE(excluded.aweme_id, aweme_id)
    `).run({
      platform: PLATFORM,
      srcCid: fields.srcCid || null,
      srcText: fields.srcText != null ? String(fields.srcText) : null,
      replyText: String(fields.replyText),
      replyHash: hashText(fields.replyText),
      awemeId: fields.awemeId || null,
      postedAt: fields.postedAt || Date.now(),
      outcome: fields.outcome || 'published',
      replyCid: fields.replyCid ? String(fields.replyCid) : null,
    });
    return info.lastInsertRowid;
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[corpus.append] failed:', e.message);
    return null;
  }
}

/**
 * 检查一段文本是否曾经发布过（按 reply_hash）。
 * @returns {{id, replyText, postedAt, outcome, awemeId}|null}
 */
function findByText(replyText) {
  if (!replyText) return null;
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT id, reply_text, posted_at, outcome, aweme_id
      FROM reply_corpus WHERE platform = ? AND reply_hash = ? AND outcome = 'published'
      ORDER BY posted_at DESC LIMIT 1
    `).get(PLATFORM, hashText(replyText));
    if (!row) return null;
    return {
      id: row.id,
      replyText: row.reply_text,
      postedAt: row.posted_at,
      outcome: row.outcome,
      awemeId: row.aweme_id,
    };
  } catch (e) {
    return null;
  }
}

/**
 * 取最近 N 条「成功」回复，作为 LLM few-shot。
 * @param {object} [opts]
 * @param {number} [opts.limit=20]
 * @param {string} [opts.awemeId]   仅本视频
 * @param {string[]} [opts.outcomes=['published']]
 */
function findByReplyCid(replyCid) {
  if (!replyCid) return null;
  try {
    const row = getDb().prepare(`
      SELECT id, reply_text, posted_at, outcome, aweme_id
      FROM reply_corpus WHERE platform = ? AND reply_cid = ?
      ORDER BY posted_at DESC LIMIT 1
    `).get(PLATFORM, String(replyCid));
    if (!row) return null;
    return {
      id: row.id,
      replyText: row.reply_text,
      postedAt: row.posted_at,
      outcome: row.outcome,
      awemeId: row.aweme_id,
    };
  } catch (e) { return null; }
}

function recent(opts = {}) {
  try {
    const db = getDb();
    const limit = Math.max(1, Math.min(opts.limit || 20, 200));
    const where = ['platform = ?'];
    const params = [PLATFORM];
    const outcomes = opts.outcomes || ['published'];
    if (outcomes.length > 0) {
      where.push(`outcome IN (${outcomes.map(() => '?').join(',')})`);
      params.push(...outcomes);
    }
    if (opts.awemeId) { where.push('aweme_id = ?'); params.push(opts.awemeId); }
    const rows = db.prepare(`
      SELECT id, src_cid, src_text, reply_text, aweme_id, posted_at, outcome, effectiveness
      FROM reply_corpus WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(posted_at, 0) DESC LIMIT ${limit}
    `).all(...params);
    return rows.map(_map);
  } catch (e) {
    return [];
  }
}

/**
 * 关键词搜索（src_text 或 reply_text）。
 */
function search(keyword, opts = {}) {
  if (!keyword) return [];
  try {
    const db = getDb();
    const limit = Math.max(1, Math.min(opts.limit || 50, 500));
    const like = `%${String(keyword).replace(/[%_]/g, m => '\\' + m)}%`;
    const rows = db.prepare(`
      SELECT id, src_cid, src_text, reply_text, aweme_id, posted_at, outcome, effectiveness
      FROM reply_corpus
      WHERE platform = ? AND (src_text LIKE ? ESCAPE '\\' OR reply_text LIKE ? ESCAPE '\\')
      ORDER BY COALESCE(posted_at, 0) DESC LIMIT ${limit}
    `).all(PLATFORM, like, like);
    return rows.map(_map);
  } catch (e) {
    return [];
  }
}

function setOutcome(id, outcome) {
  if (!id) return false;
  try {
    getDb().prepare(`UPDATE reply_corpus SET outcome = ? WHERE id = ?`).run(outcome || null, id);
    return true;
  } catch (e) { return false; }
}

function setEffectiveness(id, value) {
  if (!id) return false;
  try {
    getDb().prepare(`UPDATE reply_corpus SET effectiveness = ? WHERE id = ?`).run(value, id);
    return true;
  } catch (e) { return false; }
}

function count(opts = {}) {
  try {
    const db = getDb();
    const where = ['platform = ?'];
    const params = [PLATFORM];
    if (opts.outcome) { where.push('outcome = ?'); params.push(opts.outcome); }
    if (opts.awemeId) { where.push('aweme_id = ?'); params.push(opts.awemeId); }
    return db.prepare(`SELECT count(*) AS n FROM reply_corpus WHERE ${where.join(' AND ')}`)
      .get(...params).n;
  } catch (e) { return 0; }
}

function cleanupBefore(ts, opts = {}) {
  try {
    const db = getDb();
    if (opts.dryRun) {
      return db.prepare('SELECT count(*) AS n FROM reply_corpus WHERE platform = ? AND posted_at < ?').get(PLATFORM, ts).n;
    }
    const limit = opts.limit || 1000;
    return db.prepare('DELETE FROM reply_corpus WHERE platform = ? AND posted_at < ? LIMIT ?').run(PLATFORM, ts, limit).changes;
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[corpus.cleanupBefore] failed:', e.message);
    return 0;
  }
}

function _map(r) {
  return {
    id: r.id,
    srcCid: r.src_cid,
    srcText: r.src_text,
    replyText: r.reply_text,
    awemeId: r.aweme_id,
    postedAt: r.posted_at,
    outcome: r.outcome,
    effectiveness: r.effectiveness,
  };
}

module.exports = {
  append, findByText, findByReplyCid, recent, search, setOutcome, setEffectiveness, count, cleanupBefore,
  // re-export helpers for convenience
  hashText, normalizeText,
};
