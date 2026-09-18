// lib/memory/comments.js — 评论实体
//
// 设计要点：
// - 主键 (platform, cid)；upsert 合并语义：first_seen 取早，last_seen 取晚；
//   text/digg/sentiment/priority/replied/reply_cid 仅在 excluded 非空 / 非默认时才覆盖。
// - text_hash 用于 P3/P4 跨评论去重，由调用方传入或由本模块自动 md5(normalize(text))。
// - 所有写操作 try/catch，失败返回 false/0/null，不污染主流程。

const crypto = require('crypto');
const { getDb } = require('./db');
const logger = require('../runtime/logger');

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
    logger.debug('[comments.upsert] failed: ' + e.message);
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
    logger.debug('[comments.upsertMany] failed: ' + e.message);
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
    logger.debug('[comments.markReplied] failed: ' + e.message);
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
    logger.debug('[comments.setAnalysis] failed: ' + e.message);
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
 * 批量取多行评论（按 cid），返回 Map。
 *
 * 为什么需要它：一条评论被回复后，**我们发出去的那条回复本身也是 comments 表里的一行**
 * （见 commands/post.js 的落库段，cid = 原评论的 reply_cid）。要回答"我当时回了什么"，
 * 就得按 reply_cid 把那行查回来。工作台一页 300 条、其中已回复的往往上百条，
 * 逐条调用 get() 就是上百次查询 —— 这里一次 IN 查询解决。
 *
 * @param {string[]} cids
 * @returns {Map<string, {cid:string, uid:string|null, text:string|null, createdAt:number|null}>}
 */
function getMany(cids) {
  const out = new Map();
  const list = [...new Set((cids || []).filter(Boolean).map(String))];
  if (!list.length) return out;
  try {
    const db = getDb();
    // 分批：SQLite 对单个语句的绑定参数个数有上限，几百条一次已经不安全
    const CHUNK = 400;
    for (let i = 0; i < list.length; i += CHUNK) {
      const chunk = list.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT cid, uid, text, created_at FROM comments
        WHERE platform = ? AND cid IN (${ph})
      `).all(PLATFORM, ...chunk);
      for (const r of rows) {
        out.set(r.cid, { cid: r.cid, uid: r.uid, text: r.text, createdAt: r.created_at });
      }
    }
  } catch (e) {
    // 用 debug 而不是 warn：查不到只影响"显示当时回了什么"，不影响任何写操作
    logger.debug('[comments.getMany] failed: ' + e.message);
  }
  return out;
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
 * 排序方式。
 *
 * **每一种都以 `created_at DESC, cid DESC` 结尾**，这不是装饰：
 * 前几个键大量并列（priority 只有跑过 analyze 才有值、digg 多数是 0、
 * create_time 只精确到秒），没有唯一 tiebreaker 时 SQLite 的返回顺序
 * 由查询计划决定 —— 表现是「回复了一条评论，整个列表跟着错位」，
 * 以及「同一次刷新前后顺序不一样」。实测过：把 cid 标记为已回复会让该行
 * 换到别的位置，窗口边界的评论直接掉出列表。
 *
 * cid 是主键的一部分，天然唯一，用它兜底最稳。
 */
const ORDERS = {
  /** 默认：优先看高优先级/高赞的，同档内新的在前 */
  priority: 'COALESCE(priority, 0) DESC, COALESCE(digg, 0) DESC, created_at DESC, cid DESC',
  newest: 'created_at DESC, cid DESC',
  oldest: 'created_at ASC, cid ASC',
  digg: 'COALESCE(digg, 0) DESC, created_at DESC, cid DESC',
};

const ORDER_NAMES = Object.keys(ORDERS);

/** 供界面展示的排序选项（文案与实现对得上，两处不会漂移） */
const ORDER_INFO = [
  { name: 'priority', label: '优先级' },
  { name: 'newest', label: '最新在前' },
  { name: 'oldest', label: '最早在前' },
  { name: 'digg', label: '点赞最多' },
];

/**
 * 列出某视频的评论。
 *
 * @param {string} awemeId
 * @param {object} [opts]
 * @param {boolean} [opts.replied] - 按已回复/未回复过滤
 * @param {string}  [opts.sentiment]
 * @param {string}  [opts.order]   - ORDERS 的键，未知值回退 priority
 * @param {string}  [opts.search]  - 关键词，匹配评论文本**或**用户昵称
 * @param {number}  [opts.limit]
 */
function listByVideo(awemeId, opts = {}) {
  if (!awemeId) return [];
  try {
    const db = getDb();
    const limit = Math.max(1, Math.min(opts.limit || 200, 10000));
    const where = ['c.platform = ?', 'c.aweme_id = ?'];
    const params = [PLATFORM, awemeId];
    if (opts.replied != null) { where.push('c.replied = ?'); params.push(opts.replied ? 1 : 0); }
    if (opts.sentiment) { where.push('c.sentiment = ?'); params.push(opts.sentiment); }

    // 搜索下推到 SQL。
    //
    // 改造前搜索是在**取完 limit 行之后**在内存里做的，于是搜一个排在第 600 位的
    // 评论永远搜不到，界面还会显示「这个筛选下没有评论」—— 用户以为是没拉到数据。
    // 昵称在 users 表里，用子查询带进来，省得调用方再查一轮。
    if (opts.search) {
      const q = `%${String(opts.search).trim()}%`;
      where.push('(c.text LIKE ? OR c.uid IN (SELECT uid FROM users WHERE platform = ? AND nickname LIKE ?))');
      params.push(q, PLATFORM, q);
    }

    const order = ORDERS[opts.order] || ORDERS.priority;
    const rows = db.prepare(`
      SELECT c.cid, c.aweme_id, c.uid, c.text, c.digg, c.created_at,
             c.sentiment, c.priority, c.replied, c.reply_cid
      FROM comments c WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ${limit}
    `).all(...params);
    return rows.map(_mapShort);
  } catch (e) {
    return [];
  }
}

/** 某视频的评论总数（不受 limit 影响）。界面用它显示「共 N 条」，而不是拿列表长度当总数 */
function countByVideo(awemeId, opts = {}) {
  if (!awemeId) return 0;
  try {
    const where = ['platform = ?', 'aweme_id = ?'];
    const params = [PLATFORM, awemeId];
    if (opts.replied != null) { where.push('replied = ?'); params.push(opts.replied ? 1 : 0); }
    return getDb().prepare(
      `SELECT count(*) AS n FROM comments WHERE ${where.join(' AND ')}`
    ).get(...params).n;
  } catch (e) { return 0; }
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
 * 某视频的评论统计（一次查询）。
 *
 * 与 count() 的区别：pending 会**排掉我自己发的评论**。
 * 评论区里我以作者身份发出的回复也算评论，不排掉的话"待回复"会把
 * 自己说过的话算进去 —— 实测某个视频 36 条评论里 25 条是自己发的，
 * 于是"待回复 26"这个数字毫无参考价值。
 *
 * @param {string} awemeId
 * @param {object} [opts]
 * @param {string} [opts.excludeUid] - 我自己的 uid（来自 videos.myUid）
 * @returns {{total:number, replied:number, pending:number, mine:number}}
 */
function statsForVideo(awemeId, opts = {}) {
  const empty = { total: 0, replied: 0, pending: 0, mine: 0 };
  if (!awemeId) return empty;
  try {
    const db = getDb();
    const exclude = opts.excludeUid ? String(opts.excludeUid) : null;
    const row = db.prepare(`
      SELECT
        count(*) AS total,
        sum(CASE WHEN replied = 1 THEN 1 ELSE 0 END) AS replied,
        sum(CASE WHEN replied = 0 AND (? IS NOT NULL AND uid = ?) THEN 1 ELSE 0 END) AS mine
      FROM comments
      WHERE platform = ? AND aweme_id = ?
    `).get(exclude, exclude, PLATFORM, String(awemeId));

    const total = row.total || 0;
    const replied = row.replied || 0;
    const mine = row.mine || 0;
    return {
      total,
      replied,
      mine,
      // 待回复 = 未回复、且不是我发的
      pending: Math.max(0, total - replied - mine),
    };
  } catch (e) {
    return empty;
  }
}

/**
 * 清理 last_seen 早于 ts 的评论（TTL）。dryRun 只计数。返回删除/命中数。
 */
function cleanupBefore(ts, opts = {}) {
  try {
    const db = getDb();
    if (opts.dryRun) {
      return db.prepare('SELECT count(*) AS n FROM comments WHERE platform = ? AND last_seen < ?').get(PLATFORM, ts).n;
    }
    const limit = opts.limit || 1000;
    // 用子查询取 rowid 再删：`DELETE ... LIMIT` 需要 SQLite 编译期开
    // SQLITE_ENABLE_UPDATE_DELETE_LIMIT，而 Node 内置的 SQLite 没开 ——
    // 直接写会抛 "near \"LIMIT\": syntax error"，被下面的 catch 吞掉返回 0。
    // 症状是 dry-run 报告 would_delete: N、真跑报告 deleted: 0，不报错不告警，
    // 表因此无界增长。子查询形式在任何构建下都成立。
    return db.prepare(
      'DELETE FROM comments WHERE rowid IN (SELECT rowid FROM comments WHERE platform = ? AND last_seen < ? LIMIT ?)'
    ).run(PLATFORM, ts, limit).changes;
  } catch (e) {
    // 用 warn 而不是 debug：这里失败的表现是「报告删了 0 条」——
    // 看起来像「没有东西要清理」，用户不会去查 debug 日志。
    // 之前 DELETE ... LIMIT 的语法错误就是这样静默存在了很久。
    logger.warn('[comments.cleanupBefore] 清理失败（本次 0 条被删除）: ' + e.message);
    return 0;
  }
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
    logger.debug('[comments.listReplied] failed: ' + e.message);
    return [];
  }
}

module.exports = {
  upsert, upsertMany, get, getMany, markReplied, setAnalysis,
  listByUid, listByVideo,
  countByVideo,
  ORDER_NAMES,
  ORDER_INFO, listReplied, count, statsForVideo, cleanupBefore, hashText, normalizeText,
};
