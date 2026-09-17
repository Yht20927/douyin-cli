// lib/memory/users.js — 用户实体
//
// 设计要点：
// - upsert：合并语义。新字段非空才覆盖；first_seen 取早，last_seen 取晚；comment_count/reply_count 累加。
// - tier 用枚举字符串，不强校验（避免后续扩展时改 schema）。
// - tags 是 JSON 数组字符串，addTag/removeTag 自动去重。
// - 所有写操作 try/catch，SQL 失败返回 null，不影响主流程。

const { getDb } = require('./db');

const PLATFORM = 'douyin';

/**
 * Upsert 一个用户。fields 中的字段会和已有记录智能合并。
 *
 * @param {object} fields
 * @param {string} fields.uid (必填)
 * @param {string} [fields.secUid]
 * @param {string} [fields.nickname]
 * @param {number} [fields.seenAt] 此次观察时间 ms
 * @param {number} [fields.commentDelta]  本次新增观察到该用户评论数（默认 0）
 * @param {number} [fields.replyDelta]    本次新增对该用户的回复数（默认 0）
 * @returns {boolean} 成功 true，失败 false
 */
function upsert(fields) {
  if (!fields || !fields.uid) return false;
  try {
    const db = getDb();
    const seenAt = fields.seenAt || Date.now();
    const cd = fields.commentDelta || 0;
    const rd = fields.replyDelta || 0;
    db.prepare(`
      INSERT INTO users (uid, platform, sec_uid, nickname, first_seen, last_seen, comment_count, reply_count)
      VALUES (@uid, @platform, @secUid, @nickname, @seenAt, @seenAt, @cd, @rd)
      ON CONFLICT(platform, uid) DO UPDATE SET
        sec_uid = COALESCE(excluded.sec_uid, sec_uid),
        nickname = COALESCE(excluded.nickname, nickname),
        first_seen = MIN(first_seen, excluded.first_seen),
        last_seen  = MAX(last_seen, excluded.last_seen),
        comment_count = comment_count + @cd,
        reply_count   = reply_count + @rd
    `).run({
      uid: fields.uid,
      platform: PLATFORM,
      secUid: fields.secUid || null,
      nickname: fields.nickname || null,
      seenAt,
      cd,
      rd,
    });
    return true;
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[users.upsert] failed:', e.message);
    return false;
  }
}

/**
 * 批量 upsert（事务 + 一次 prepare），用于 cmdGet 拉到 N 条评论后一次性写入。
 * 每个 entry 同 upsert(fields)；commentDelta 默认 1。
 */
function upsertMany(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO users (uid, platform, sec_uid, nickname, first_seen, last_seen, comment_count, reply_count)
      VALUES (@uid, @platform, @secUid, @nickname, @seenAt, @seenAt, @cd, @rd)
      ON CONFLICT(platform, uid) DO UPDATE SET
        sec_uid = COALESCE(excluded.sec_uid, sec_uid),
        nickname = COALESCE(excluded.nickname, nickname),
        first_seen = MIN(first_seen, excluded.first_seen),
        last_seen  = MAX(last_seen, excluded.last_seen),
        comment_count = comment_count + @cd,
        reply_count   = reply_count + @rd
    `);
    const tx = db.transaction((rows) => {
      let n = 0;
      for (const e of rows) {
        if (!e || !e.uid) continue;
        stmt.run({
          uid: e.uid,
          platform: PLATFORM,
          secUid: e.secUid || null,
          nickname: e.nickname || null,
          seenAt: e.seenAt || Date.now(),
          cd: e.commentDelta != null ? e.commentDelta : 1,
          rd: e.replyDelta || 0,
        });
        n++;
      }
      return n;
    });
    return tx(entries);
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[users.upsertMany] failed:', e.message);
    return 0;
  }
}

/**
 * 读取一个用户，返回 null 表示不存在或 SQL 失败。tags 已反序列化为数组。
 */
function get(uid) {
  if (!uid) return null;
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT uid, platform, sec_uid, nickname, first_seen, last_seen,
             comment_count, reply_count, tier, tags_json, notes
      FROM users WHERE platform = ? AND uid = ?
    `).get(PLATFORM, uid);
    if (!row) return null;
    return {
      uid: row.uid,
      platform: row.platform,
      secUid: row.sec_uid,
      nickname: row.nickname,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      commentCount: row.comment_count,
      replyCount: row.reply_count,
      tier: row.tier,
      tags: row.tags_json ? safeParse(row.tags_json) : [],
      notes: row.notes,
    };
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[users.get] failed:', e.message);
    return null;
  }
}

/**
 * 设置用户分级（vip / normal / blacklist / spam / null 清除）。
 * 自动确保用户行存在（upsert）。
 */
function setTier(uid, tier) {
  if (!uid) return false;
  try {
    upsert({ uid }); // 确保存在
    const db = getDb();
    db.prepare(`UPDATE users SET tier = ? WHERE platform = ? AND uid = ?`)
      .run(tier || null, PLATFORM, uid);
    return true;
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[users.setTier] failed:', e.message);
    return false;
  }
}

/** 给用户加一个标签（原子 SQL，防并发丢更新）。 */
function addTag(uid, tag) {
  if (!uid || !tag) return false;
  try {
    upsert({ uid });
    const t = String(tag);
    const db = getDb();
    db.prepare(`
      UPDATE users SET tags_json = (
        CASE
          WHEN tags_json IS NULL OR tags_json = '[]' THEN json_array(?)
          WHEN EXISTS (SELECT 1 FROM json_each(tags_json) WHERE value = ?) THEN tags_json
          ELSE json_insert(tags_json, '$[#]', ?)
        END
      ) WHERE platform = ? AND uid = ?
    `).run(t, t, t, PLATFORM, String(uid));
    return true;
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[users.addTag] failed:', e.message);
    return false;
  }
}

/** 移除一个标签（原子 SQL）。 */
function removeTag(uid, tag) {
  if (!uid || !tag) return false;
  try {
    const t = String(tag);
    const info = getDb().prepare(`
      UPDATE users SET tags_json = (
        SELECT COALESCE(json_group_array(value), '[]')
        FROM json_each(tags_json) WHERE value != ?
      ) WHERE platform = ? AND uid = ?
    `).run(t, PLATFORM, String(uid));
    return info.changes > 0;
  } catch (e) {
    return false;
  }
}

/** 设置 notes 自由文本（覆盖式）。 */
function setNotes(uid, notes) {
  if (!uid) return false;
  try {
    upsert({ uid });
    const db = getDb();
    db.prepare(`UPDATE users SET notes = ? WHERE platform = ? AND uid = ?`)
      .run(notes || null, PLATFORM, uid);
    return true;
  } catch (e) {
    return false;
  }
}

/** 列出所有用户（可按 tier 过滤），按 last_seen DESC。 */
function list(opts = {}) {
  try {
    const db = getDb();
    const where = ['platform = ?'];
    const params = [PLATFORM];
    if (opts.tier) { where.push('tier = ?'); params.push(opts.tier); }
    const limit = Math.max(1, Math.min(opts.limit || 100, 10000));
    const rows = db.prepare(`
      SELECT uid, sec_uid, nickname, first_seen, last_seen, comment_count, reply_count, tier, tags_json
      FROM users WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(last_seen, 0) DESC LIMIT ${limit}
    `).all(...params);
    return rows.map(r => ({
      uid: r.uid,
      nickname: r.nickname,
      tier: r.tier,
      commentCount: r.comment_count,
      replyCount: r.reply_count,
      lastSeen: r.last_seen,
      tags: r.tags_json ? safeParse(r.tags_json) : [],
    }));
  } catch (e) {
    return [];
  }
}

function count() {
  try {
    return getDb().prepare(`SELECT count(*) AS n FROM users WHERE platform = ?`).get(PLATFORM).n;
  } catch (e) { return 0; }
}

// ── 内部 ──
function _writeTags(uid, tags) {
  const db = getDb();
  db.prepare(`UPDATE users SET tags_json = ? WHERE platform = ? AND uid = ?`)
    .run(JSON.stringify(tags), PLATFORM, uid);
  return true;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return []; }
}

module.exports = { upsert, upsertMany, get, setTier, addTag, removeTag, setNotes, list, count };
