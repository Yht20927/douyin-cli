// lib/memory/videos.js — 视频实体
//
// 设计要点：
// - 主键 (platform, aweme_id)；upsert 合并语义：title/author_uid 在 excluded 非空时覆盖；
//   is_mine 一旦为 1 就不会回退；total_comments_seen 累加；last_get_ts/last_post_ts 取较大值。
// - 失败不抛，返回 false/null。

const { getDb } = require('./db');

const PLATFORM = 'douyin';

/**
 * Upsert 一个视频。
 * @param {object} fields
 * @param {string} fields.awemeId (必填)
 * @param {string} [fields.title]
 * @param {string} [fields.authorUid]
 * @param {boolean|number} [fields.isMine]
 * @param {number} [fields.commentsSeenDelta] 本次新增观察评论数（默认 0）
 * @param {number} [fields.lastGetTs] ms
 * @param {number} [fields.lastPostTs] ms
 * @returns {boolean}
 */
function upsert(fields) {
  if (!fields || !fields.awemeId) return false;
  try {
    const db = getDb();
    const delta = fields.commentsSeenDelta || 0;
    db.prepare(`
      INSERT INTO videos (
        aweme_id, platform, title, author_uid, is_mine,
        total_comments_seen, last_get_ts, last_post_ts
      ) VALUES (
        @awemeId, @platform, @title, @authorUid, @isMine,
        @delta, @lastGetTs, @lastPostTs
      )
      ON CONFLICT(platform, aweme_id) DO UPDATE SET
        title       = COALESCE(excluded.title, title),
        author_uid  = COALESCE(excluded.author_uid, author_uid),
        is_mine     = CASE WHEN excluded.is_mine = 1 THEN 1 ELSE is_mine END,
        total_comments_seen = total_comments_seen + @delta,
        last_get_ts  = MAX(COALESCE(last_get_ts, 0),  COALESCE(excluded.last_get_ts, 0)),
        last_post_ts = MAX(COALESCE(last_post_ts, 0), COALESCE(excluded.last_post_ts, 0))
    `).run({
      awemeId: String(fields.awemeId),
      platform: PLATFORM,
      title: fields.title || null,
      authorUid: fields.authorUid || null,
      isMine: fields.isMine ? 1 : 0,
      delta,
      lastGetTs: fields.lastGetTs || null,
      lastPostTs: fields.lastPostTs || null,
    });
    return true;
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[videos.upsert] failed:', e.message);
    return false;
  }
}

/** 标记一次成功的 get：last_get_ts + 累计评论数。 */
function markGet(awemeId, commentsSeenDelta = 0, ts = null) {
  return upsert({ awemeId, lastGetTs: ts || Date.now(), commentsSeenDelta });
}

/** 标记一次成功的 post：last_post_ts。 */
function markPost(awemeId, ts = null) {
  return upsert({ awemeId, lastPostTs: ts || Date.now() });
}

function get(awemeId) {
  if (!awemeId) return null;
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT aweme_id, platform, title, author_uid, is_mine,
             total_comments_seen, last_get_ts, last_post_ts, campaign_id
      FROM videos WHERE platform = ? AND aweme_id = ?
    `).get(PLATFORM, awemeId);
    if (!row) return null;
    return {
      awemeId: row.aweme_id,
      platform: row.platform,
      title: row.title,
      authorUid: row.author_uid,
      isMine: !!row.is_mine,
      totalCommentsSeen: row.total_comments_seen,
      lastGetTs: row.last_get_ts,
      lastPostTs: row.last_post_ts,
      campaignId: row.campaign_id,
    };
  } catch (e) { return null; }
}

function list(opts = {}) {
  try {
    const db = getDb();
    const limit = Math.max(1, Math.min(opts.limit || 100, 10000));
    const where = ['platform = ?'];
    const params = [PLATFORM];
    if (opts.isMine != null) { where.push('is_mine = ?'); params.push(opts.isMine ? 1 : 0); }
    const rows = db.prepare(`
      SELECT aweme_id, title, author_uid, is_mine,
             total_comments_seen, last_get_ts, last_post_ts
      FROM videos WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(last_get_ts, last_post_ts, 0) DESC
      LIMIT ${limit}
    `).all(...params);
    return rows.map(r => ({
      awemeId: r.aweme_id,
      title: r.title,
      authorUid: r.author_uid,
      isMine: !!r.is_mine,
      totalCommentsSeen: r.total_comments_seen,
      lastGetTs: r.last_get_ts,
      lastPostTs: r.last_post_ts,
    }));
  } catch (e) { return []; }
}

function count() {
  try {
    return getDb().prepare(`SELECT count(*) AS n FROM videos WHERE platform = ?`).get(PLATFORM).n;
  } catch (e) { return 0; }
}

module.exports = { upsert, markGet, markPost, get, list, count };
