// lib/memory/comments.js — 评论实体
//
// 设计要点：
// - 主键 (platform, cid)；upsert 合并语义：first_seen 取早，last_seen 取晚；
//   text/digg/sentiment/priority/replied/reply_cid 仅在 excluded 非空 / 非默认时才覆盖。
// - text_hash 用于 P3/P4 跨评论去重，由调用方传入或由本模块自动 md5(normalize(text))。
// - 所有写操作 try/catch，失败返回 false/0/null，不污染主流程。

const crypto = require('crypto');
const { getDb } = require('./db');

const PLATFORM = 'douyin';

/** 文本规范化：去首尾空白 + 折叠空白 + 转小写。用于 text_hash 与去重。 */
function normalizeText(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function hashText(s) {
  if (!s) return null;
  return crypto.createHash('md5').update(normalizeText(s), 'utf8').digest('hex');
}

/**
 * Upsert 一条评论。
 *
 * @param {object} fields
 * @param {string} fields.cid (必填)
 * @param {string} fields.awemeId (必填)
 * @param {string} [fields.uid]
 * @param {string} [fields.text]
 * @param {number} [fields.digg]
 * @param {number} [fields.createdAt] 评论创建时间（秒，按抖音原值）
 * @param {boolean|number} [fields.isSticker]
 * @param {string} [fields.parentCid]
 * @param {number} [fields.seenAt] 此次观察时间 ms，默认 Date.now()
 * @returns {boolean}
 */
function upsert(fields) {
  if (!fields || !fields.cid || !fields.awemeId) return false;
  try {
    const db = getDb();
    _upsertStmt(db).run(_paramsFor(fields));
    return true;
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[comments.upsert] failed:', e.message);
    return false;
  }
}

/**
 * 批量 upsert（事务）。entries 中的每个对象同 upsert(fields)。返回写入条数。
 */
function upsertMany(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  try {
    const db = getDb();
    const stmt = _upsertStmt(db);
    const tx = db.transaction((rows) => {
      let n = 0;
      for (const e of rows) {
        if (!e || !e.cid || !e.awemeId) continue;
        stmt.run(_paramsFor(e));
        n++;
      }
      return n;
    });
    return tx(entries);
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[comments.upsertMany] failed:', e.message);
    return 0;
  }
}

function _upsertStmt(db) {
  return db.prepare(`
    INSERT INTO comments (
      cid, platform, aweme_id, uid, text, text_hash, digg, created_at,
      is_sticker, parent_cid, first_seen, last_seen
    ) VALUES (
      @cid, @platform, @awemeId, @uid, @text, @textHash, @digg, @createdAt,
      @isSticker, @parentCid, @seenAt, @seenAt
    )
    ON CONFLICT(platform, cid) DO UPDATE SET
      aweme_id   = excluded.aweme_id,
      uid        = COALESCE(excluded.uid, uid),
      text       = COALESCE(excluded.text, text),
      text_hash  = COALESCE(excluded.text_hash, text_hash),
      digg       = COALESCE(excluded.digg, digg),
      created_at = COALESCE(excluded.created_at, created_at),
      is_sticker = CASE WHEN excluded.is_sticker = 1 THEN 1 ELSE is_sticker END,
      parent_cid = COALESCE(excluded.parent_cid, parent_cid),
      first_seen = MIN(COALESCE(first_seen, excluded.first_seen), excluded.first_seen),
      last_seen  = MAX(COALESCE(last_seen, 0), excluded.last_seen)
  `);
}

function _paramsFor(f) {
  return {
    cid: String(f.cid),
    platform: PLATFORM,
    awemeId: String(f.awemeId),
    uid: f.uid || null,
    text: f.text != null ? String(f.text) : null,
    textHash: f.text != null ? hashText(f.text) : null,
    digg: f.digg != null ? Number(f.digg) : null,
    createdAt: f.createdAt != null ? Number(f.createdAt) : null,
    isSticker: f.isSticker ? 1 : 0,
    parentCid: f.parentCid || null,
    seenAt: f.seenAt || Date.now(),
  };
}

/**
 * 标记某条评论已被回复。reply_cid 是我们刚发出的新评论 cid。
 * 该评论行不存在时自动建占位行（仅 cid+aweme_id 已知，其它字段 null）。
 */
function markReplied(cid, awemeId, replyCid) {
  if (!cid || !awemeId) return false;
  try {
    upsert({ cid, awemeId });
    const db = getDb();
    db.prepare(`UPDATE comments SET replied = 1, reply_cid = ? WHERE platform = ? AND cid = ?`)
      .run(replyCid || null, PLATFORM, cid);
    return true;
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[comments.markReplied] failed:', e.message);
    return false;
  }
}

/**
 * 写入 LLM 分析结果（情感 / 优先级）。
 */
function setAnalysis(cid, { sentiment, priority }) {
  if (!cid) return false;
  try {
    const db = getDb();
    db.prepare(`UPDATE comments SET sentiment = ?, priority = ? WHERE platform = ? AND cid = ?`)
      .run(sentiment || null, priority != null ? Number(priority) : null, PLATFORM, cid);
    return true;
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[comments.setAnalysis] failed:', e.message);
    return false;
  }
}

/** 读取一条评论。tags/sentiment/replied 都直接返回原始字段。 */
function get(cid) {
  if (!cid) return null;
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT cid, platform, aweme_id, uid, text, text_hash, digg, created_at,
             is_sticker, parent_cid, sentiment, priority, replied, reply_cid,
             first_seen, last_seen
      FROM comments WHERE platform = ? AND cid = ?
    `).get(PLATFORM, cid);
    if (!row) return null;
    return {
      cid: row.cid,
      awemeId: row.aweme_id,
      uid: row.uid,
      text: row.text,
      textHash: row.text_hash,
      digg: row.digg,
      createdAt: row.created_at,
      isSticker: !!row.is_sticker,
      parentCid: row.parent_cid,
      sentiment: row.sentiment,
      priority: row.priority,
      replied: !!row.replied,
      replyCid: row.reply_cid,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
    };
  } catch (e) {
    return null;
  }
}

/**
 * 列出某用户的全部评论（跨视频），按 created_at DESC。
 */
function listByUid(uid, opts = {}) {
  if (!uid) return [];
  try {
    const db = getDb();
    const limit = Math.max(1, Math.min(opts.limit || 200, 10000));
    const rows = db.prepare(`
      SELECT cid, aweme_id, text, digg, created_at, sentiment, priority, replied, reply_cid
      FROM comments WHERE platform = ? AND uid = ?
      ORDER BY COALESCE(created_at, 0) DESC LIMIT ${limit}
    `).all(PLATFORM, uid);
    return rows.map(_mapShort);
  } catch (e) {
    return [];
  }
}

/**
 * 列出某视频的评论。
 */
function listByVideo(awemeId, opts = {}) {
  if (!awemeId) return [];
  try {
    const db = getDb();
    const limit = Math.max(1, Math.min(opts.limit || 200, 10000));
    const where = ['platform = ?', 'aweme_id = ?'];
    const params = [PLATFORM, awemeId];
    if (opts.replied != null) { where.push('replied = ?'); params.push(opts.replied ? 1 : 0); }
    if (opts.sentiment) { where.push('sentiment = ?'); params.push(opts.sentiment); }
    const rows = db.prepare(`
      SELECT cid, aweme_id, uid, text, digg, created_at, sentiment, priority, replied, reply_cid
      FROM comments WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(priority, 0) DESC, COALESCE(digg, 0) DESC
      LIMIT ${limit}
    `).all(...params);
    return rows.map(_mapShort);
  } catch (e) {
    return [];
  }
}

function _mapShort(r) {
  return {
    cid: r.cid,
    awemeId: r.aweme_id,
    uid: r.uid,
    text: r.text,
    digg: r.digg,
    createdAt: r.created_at,
    sentiment: r.sentiment,
    priority: r.priority,
    replied: !!r.replied,
    replyCid: r.reply_cid,
  };
}

function count(opts = {}) {
  try {
    const db = getDb();
    const where = ['platform = ?'];
    const params = [PLATFORM];
    if (opts.awemeId) { where.push('aweme_id = ?'); params.push(opts.awemeId); }
    if (opts.uid)     { where.push('uid = ?');      params.push(opts.uid); }
    if (opts.replied != null) { where.push('replied = ?'); params.push(opts.replied ? 1 : 0); }
    return db.prepare(`SELECT count(*) AS n FROM comments WHERE ${where.join(' AND ')}`)
      .get(...params).n;
  } catch (e) { return 0; }
}

/**
 * 查询已回复的评论 cid 列表，供 Skill 层去重。
 * filters: { awemeId, since }，均为可选。
 */
function listReplied(filters = {}, opts = {}) {
  try {
    const db = getDb();
    const where = ['platform = ?', 'replied = 1'];
    const params = [PLATFORM];
    if (filters.awemeId) { where.push('aweme_id = ?'); params.push(String(filters.awemeId)); }
    if (filters.since)   { where.push('last_seen >= ?'); params.push(Number(filters.since)); }
    const limit = Math.max(1, Math.min(opts.limit || 10000, 100000));
    const rows = db.prepare(`
      SELECT cid, aweme_id, reply_cid, last_seen
      FROM comments
      WHERE ${where.join(' AND ')}
      ORDER BY last_seen DESC
      LIMIT ${limit}
    `).all(...params);
    return rows.map(r => ({
      cid: r.cid,
      awemeId: r.aweme_id,
      replyCid: r.reply_cid,
      lastSeen: r.last_seen,
    }));
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[comments.listReplied] failed:', e.message);
    return [];
  }
}

module.exports = {
  upsert, upsertMany, get, markReplied, setAnalysis,
  listByUid, listByVideo, listReplied, count, hashText, normalizeText,
};
