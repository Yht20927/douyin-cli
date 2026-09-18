// lib/memory/videos.js — 视频实体
//
// 设计要点：
// - 主键 (platform, aweme_id)；upsert 合并语义：title/author_uid 在 excluded 非空时覆盖；
//   is_mine 一旦为 1 就不会回退；total_comments_seen 累加；last_get_ts/last_post_ts 取较大值。
// - 失败不抛，返回 false/null。

const { getDb } = require('./db');
const logger = require('../runtime/logger');

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
/**
 * 数值字段的归一化：undefined / null / NaN 一律给 null，
 * 让 SQL 里的 COALESCE 保留旧值而不是把已有数字抹掉。
 */
function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function upsert(fields) {
  if (!fields || !fields.awemeId) return false;
  try {
    const db = getDb();
    const delta = fields.commentsSeenDelta || 0;
    db.prepare(`
      INSERT INTO videos (
        aweme_id, platform, title, desc, cover_url, author_uid, is_mine,
        total_comments_seen, last_get_ts, last_post_ts,
        play_count, digg_count, comment_count, share_count, create_time
      ) VALUES (
        @awemeId, @platform, @title, @desc, @coverUrl, @authorUid, @isMine,
        @delta, @lastGetTs, @lastPostTs,
        @playCount, @diggCount, @commentCount, @shareCount, @createTime
      )
      ON CONFLICT(platform, aweme_id) DO UPDATE SET
        title       = COALESCE(excluded.title, title),
        desc        = COALESCE(excluded.desc, desc),
        cover_url   = COALESCE(excluded.cover_url, cover_url),
        author_uid  = COALESCE(excluded.author_uid, author_uid),
        is_mine     = CASE WHEN excluded.is_mine = 1 THEN 1 ELSE is_mine END,
        total_comments_seen = total_comments_seen + @delta,
        last_get_ts  = MAX(COALESCE(last_get_ts, 0),  COALESCE(excluded.last_get_ts, 0)),
        last_post_ts = MAX(COALESCE(last_post_ts, 0), COALESCE(excluded.last_post_ts, 0)),
        -- 互动数据用 COALESCE 保留旧值：拉取失败/字段缺失时不该把已有数字抹成 null
        play_count    = COALESCE(excluded.play_count, play_count),
        digg_count    = COALESCE(excluded.digg_count, digg_count),
        comment_count = COALESCE(excluded.comment_count, comment_count),
        share_count   = COALESCE(excluded.share_count, share_count),
        create_time   = COALESCE(excluded.create_time, create_time)
    `).run({
      awemeId: String(fields.awemeId),
      platform: PLATFORM,
      title: fields.title || null,
      desc: fields.desc || null,
      coverUrl: fields.coverUrl || null,
      authorUid: fields.authorUid || null,
      isMine: fields.isMine ? 1 : 0,
      delta,
      lastGetTs: fields.lastGetTs || null,
      lastPostTs: fields.lastPostTs || null,
      playCount: numOrNull(fields.playCount),
      diggCount: numOrNull(fields.diggCount),
      commentCount: numOrNull(fields.commentCount),
      shareCount: numOrNull(fields.shareCount),
      createTime: numOrNull(fields.createTime),
    });
    return true;
  } catch (e) {
    logger.debug('[videos.upsert] failed: ' + e.message);
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
      SELECT aweme_id, platform, title, desc, cover_url, author_uid, is_mine,
             total_comments_seen, last_get_ts, last_post_ts, campaign_id,
             play_count, digg_count, comment_count, share_count, create_time
      FROM videos WHERE platform = ? AND aweme_id = ?
    `).get(PLATFORM, awemeId);
    if (!row) return null;
    return {
      awemeId: row.aweme_id,
      platform: row.platform,
      title: row.title,
      desc: row.desc,
      coverUrl: row.cover_url,
      stats: {
        plays: row.play_count,
        likes: row.digg_count,
        comments: row.comment_count,
        shares: row.share_count,
      },
      createTime: row.create_time,
      authorUid: row.author_uid,
      isMine: !!row.is_mine,
      totalCommentsSeen: row.total_comments_seen,
      lastGetTs: row.last_get_ts,
      lastPostTs: row.last_post_ts,
      campaignId: row.campaign_id,
    };
  } catch (e) { return null; }
}

/**
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {boolean} [opts.isMine]
 * @param {'activity'|'publish'} [opts.order='activity']
 *   - activity：按"最近拉取/回复过"排。适合"我最近在忙哪个视频"这类视图
 *   - publish ：按**作品发布时间**排。作品列表用这个 —— 用户翻自己的作品时
 *     期待的是"最新发的在最前面"，而不是"最近拉取过的在最前面"
 */
function list(opts = {}) {
  try {
    const db = getDb();
    const limit = Math.max(1, Math.min(opts.limit || 100, 10000));
    const where = ['platform = ?'];
    const params = [PLATFORM];
    if (opts.isMine != null) { where.push('is_mine = ?'); params.push(opts.isMine ? 1 : 0); }
    // 注意 create_time 是**秒**、last_get_ts 是**毫秒**（见 db.js 的单位约定）。
    // 两者不在同一个排序键里混用，各自内部比大小没问题。
    const orderBy = opts.order === 'publish'
      ? 'COALESCE(create_time, 0) DESC, COALESCE(last_get_ts, last_post_ts, 0) DESC'
      : 'COALESCE(last_get_ts, last_post_ts, 0) DESC';
    const rows = db.prepare(`
      SELECT aweme_id, title, desc, cover_url, author_uid, is_mine,
             total_comments_seen, last_get_ts, last_post_ts,
             play_count, digg_count, comment_count, share_count, create_time
      FROM videos WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ${limit}
    `).all(...params);
    return rows.map(r => ({
      awemeId: r.aweme_id,
      title: r.title,
      desc: r.desc,
      coverUrl: r.cover_url,
      authorUid: r.author_uid,
      isMine: !!r.is_mine,
      totalCommentsSeen: r.total_comments_seen,
      lastGetTs: r.last_get_ts,
      lastPostTs: r.last_post_ts,
      stats: {
        plays: r.play_count,
        likes: r.digg_count,
        comments: r.comment_count,
        shares: r.share_count,
      },
      createTime: r.create_time,
    }));
  } catch (e) { return []; }
}

/**
 * 取"我自己的 uid"。
 *
 * 依据：is_mine=1 的视频，其 author_uid 就是我。由 `my` 命令写入。
 * 这是识别"我自己的评论"的唯一途径 —— 评论区的每条评论都带 author uid，
 * 与它相同的就是我发的（包括我以作者身份发出的回复）。
 *
 * 注意：只有跑过一次 `my`（界面上的「刷新列表」）之后才有值。
 * 没有值时返回 null，调用方应据此跳过"自己的评论"这层判断，而不是误判成别人。
 *
 * @returns {string|null}
 */
function myUid() {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT author_uid, count(*) AS n
      FROM videos
      WHERE platform = ? AND is_mine = 1 AND author_uid IS NOT NULL
      GROUP BY author_uid
      ORDER BY n DESC
      LIMIT 1
    `).get(PLATFORM);
    return row && row.author_uid ? String(row.author_uid) : null;
  } catch (e) {
    return null;
  }
}

/**
 * 视频总数。
 * @param {object} [opts]
 * @param {boolean} [opts.isMine] - 只数我的作品
 */
function count(opts = {}) {
  try {
    const where = ['platform = ?'];
    const params = [PLATFORM];
    if (opts.isMine != null) { where.push('is_mine = ?'); params.push(opts.isMine ? 1 : 0); }
    return getDb().prepare(
      `SELECT count(*) AS n FROM videos WHERE ${where.join(' AND ')}`
    ).get(...params).n;
  } catch (e) { return 0; }
}

module.exports = { upsert, markGet, markPost, get, list, count, myUid };
