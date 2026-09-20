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
    const limit = clampLimit(opts.limit);
    // 与 listByVideo 共用 _mapShort，所以选同样的列 —— 少选一列不会报错，
    // 只会让那个字段变成 undefined，于是"是不是贴纸"取决于这条行是从哪个查询来的。
    const rows = db.prepare(`
      SELECT cid, aweme_id, text, digg, created_at, is_sticker, parent_cid,
             sentiment, priority, replied, reply_cid
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
 * listByVideo 的 limit 硬上限。
 *
 * 导出的理由：调用方（core/data/views.js）需要知道**实际生效**的上限是多少，
 * 才能判断自己拿到的列表是不是被截断了。以前 views 拿自己写的 20000 去比
 * `rows.length >= scanLimit`，而这里悄悄把 limit 夹到 10000 —— 那个条件
 * 在结构上永远不可能成立，"扫描被截断、计数可能偏小"的提示因此永远不出现。
 * 谁拥有 SQL 里的 LIMIT，谁就负责把这个数说清楚。
 */
const MAX_LIMIT = 10000;

/** 把请求的 limit 夹到 [1, MAX_LIMIT]；缺省 200 */
function clampLimit(n) {
  const v = Number(n);
  return Math.max(1, Math.min(Number.isFinite(v) && v > 0 ? v : 200, MAX_LIMIT));
}

/**
 * 列出某视频的评论。
 *
 * @param {string} awemeId
 * @param {object} [opts]
 * @param {boolean} [opts.replied] - 按已回复/未回复过滤
 * @param {string}  [opts.sentiment]
 * @param {string}  [opts.order]   - ORDERS 的键，未知值回退 priority
 * @param {string}  [opts.search]  - 关键词，匹配评论文本**或**用户昵称
 * @param {number}  [opts.limit]   - 会被夹到 [1, MAX_LIMIT]
 */
function listByVideo(awemeId, opts = {}) {
  if (!awemeId) return [];
  try {
    const db = getDb();
    const limit = clampLimit(opts.limit);
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
             c.is_sticker, c.parent_cid,
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

/**
 * 某视频的评论总数（不受 limit 影响）。界面用它显示「共 N 条」，而不是拿列表长度当总数。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.replied] - 只看已回复/未回复
 * @param {string} [opts.excludeUid] - 排掉这个 uid（我自己的）。
 *   「待处理」列表会把我们发出去的回复滤掉，而这个总数若不跟着滤，
 *   界面就会出现「共 99 条 · 当前显示 95 条」——同一屏两个口径，
 *   与 statsForVideo 的 pending 也对不上（那里是排掉的）。
 * @param {string} [opts.search]
 */
function countByVideo(awemeId, opts = {}) {
  if (!awemeId) return 0;
  try {
    const where = ['platform = ?', 'aweme_id = ?'];
    const params = [PLATFORM, awemeId];
    if (opts.replied != null) { where.push('replied = ?'); params.push(opts.replied ? 1 : 0); }
    if (opts.excludeUid != null) { where.push('uid IS NOT ?'); params.push(String(opts.excludeUid)); }
    if (opts.search) {
      // 与 listByVideo 的搜索条件**逐字一致**。两处稍有差别，"共 N 条"与
      // 列表里实际有几条就会对不上，而这类不一致在这个项目里已经返工过好几次。
      const q = `%${String(opts.search).trim()}%`;
      where.push('(text LIKE ? OR uid IN (SELECT uid FROM users WHERE platform = ? AND nickname LIKE ?))');
      params.push(q, PLATFORM, q);
    }
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
    // 与 get() 用同一套驼峰字段名。filters.classify 判定贴纸就读这个，
    // 之前这里没带出来、那边又写成读蛇形，两处各错一半 —— 合起来是永不生效。
    isSticker: !!r.is_sticker,
    parentCid: r.parent_cid,
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
 * 一次算多个视频的评论统计。
 *
 * 为什么要有这个：运营对象列表要给几百个视频各算一次"待回复"，逐个调
 * statsForVideo 就是几百次查询。但**口径必须与 statsForVideo 逐字一致**
 * （同样的 mine 定义、同样的 pending 减项）—— 这个项目已经因为"同一份数据
 * 三处显示三个数"返工过（见 statsForVideo 的注释），不能在这里再长一套。
 *
 * 返回的 Map 里**没有**某个 awemeId，表示那个视频一条评论都没有 ——
 * 这与"查不到"是两回事，调用方自己拿 statsForVideo 的 empty 形状兜底。
 *
 * @param {string[]} awemeIds
 * @param {object} [opts]
 * @param {string} [opts.excludeUid] - 我自己的 uid（来自 videos.myUid）
 * @returns {Map<string, {total:number, replied:number, pending:number, mine:number}>}
 */
function statsForVideos(awemeIds, opts = {}) {
  const out = new Map();
  const ids = [...new Set((awemeIds || []).filter(Boolean).map(String))];
  if (!ids.length) return out;
  try {
    const db = getDb();
    const exclude = opts.excludeUid ? String(opts.excludeUid) : null;
    // 分批：SQLite 的绑定参数个数有上限（旧构建是 999），一次几百个 id
    // 加上 3 个固定参数就顶到边了。分批不改变结果，只是别去赌上限。
    const CHUNK = 400;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const holes = chunk.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT aweme_id,
          count(*) AS total,
          sum(CASE WHEN replied = 1 THEN 1 ELSE 0 END) AS replied,
          sum(CASE WHEN replied = 0 AND (? IS NOT NULL AND uid = ?) THEN 1 ELSE 0 END) AS mine
        FROM comments
        WHERE platform = ? AND aweme_id IN (${holes})
        GROUP BY aweme_id
      `).all(exclude, exclude, PLATFORM, ...chunk);

      for (const r of rows) {
        const total = r.total || 0;
        const replied = r.replied || 0;
        const mine = r.mine || 0;
        out.set(String(r.aweme_id), {
          total,
          replied,
          mine,
          pending: Math.max(0, total - replied - mine),
        });
      }
    }
  } catch (e) {
    logger.debug('[comments.statsForVideos] failed: ' + e.message);
  }
  return out;
}

/**
 * 回复效果：我们回过的那些人，后来还来不来。
 *
 * 这是"互动引流"这个打法的核心问题 —— 回了 119 条之后到底有没有效果，
 * 此前只能靠感觉。数据其实都在库里：
 *   - 我们回过的评论：`replied = 1`，且 `reply_cid` 指向我们自己发的那条
 *   - 我们自己发的那条：cid = reply_cid，带 created_at（抖音秒）
 *   - 对方后来又来评论：同一视频下、同一个 uid、时间在我们回复**之后**
 *
 * 三处已知的诚实声明（都返回给调用方，界面必须跟着显示）：
 *
 * 1. **二次互动只在"我们的回复有时间戳"的那部分上算**。早期发出的回复
 *    `created_at` 可能是 null，那时无法判断先后 —— 把它算作"没再来"是
 *    凭空冤枉，算作"来了"是编数据。所以分子分母都只取有时间戳的那些，
 *    并把 `withTime` 一起报出去。
 * 2. **回复获赞要靠重新拉取才更新**。digg 是拉评论时抄下来的快照，
 *    没拉过的回复一直是 null/0 —— 所以给 `withLikes`，别把 0 当成"没人赞"。
 * 3. 对方"又来了"可能是回复了我们、也可能只是又留了一条 ——
 *    这里只判"该用户在该视频下又出现了"，界面上的措辞必须与此一致，
 *    不能写成"对方回复了你"。
 *
 * @param {object} [opts]
 * @param {number} [opts.since] - 毫秒时间戳，只算这次之后发出的回复
 * @returns {{replied:number, withTime:number, second:number, secondRate:number|null,
 *   withLikes:number, likes:number}}
 */
function replyEffectStats(opts = {}) {
  const empty = { replied: 0, withTime: 0, second: 0, secondRate: null, withLikes: 0, likes: 0 };
  try {
    const db = getDb();
    const params = [PLATFORM];
    let sinceSql = '';
    if (opts.since) {
      // created_at 是抖音的**秒**，opts.since 是毫秒 —— 单位不同不能直接比。
      // `IS NULL OR` 这一半是必须的：没有时间戳的行**不能**被范围过滤掉 ——
      // 它们正是 withTime 要单独统计的那批，直接滤掉的话
      // "已回复 N 条（其中 M 条能判定先后）"里的 N 会跟着范围一起缩水，
      // 而读者无从知道少的那些是因为"太久以前"还是"没记时间"。
      sinceSql = ' AND (r.created_at IS NULL OR r.created_at >= ?)';
      params.push(Math.floor(opts.since / 1000));
    }
    const row = db.prepare(`
      SELECT
        count(*) AS replied,
        sum(CASE WHEN r.created_at IS NOT NULL THEN 1 ELSE 0 END) AS with_time,
        sum(CASE WHEN r.created_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM comments c3
          WHERE c3.platform = c.platform
            AND c3.aweme_id = c.aweme_id
            AND c3.uid = c.uid
            AND c3.created_at > r.created_at
        ) THEN 1 ELSE 0 END) AS second,
        sum(CASE WHEN r.digg IS NOT NULL AND r.digg > 0 THEN 1 ELSE 0 END) AS with_likes,
        sum(COALESCE(r.digg, 0)) AS likes
      FROM comments c
      JOIN comments r ON r.cid = c.reply_cid AND r.platform = c.platform
      WHERE c.platform = ? AND c.replied = 1${sinceSql}
    `).get(...params);

    const replied = row.replied || 0;
    const withTime = row.with_time || 0;
    const second = row.second || 0;
    return {
      replied,
      withTime,
      second,
      // 分母是"能判定先后的那些"，不是全部 —— 见上面第 1 条
      secondRate: withTime > 0 ? second / withTime : null,
      withLikes: row.with_likes || 0,
      likes: row.likes || 0,
    };
  } catch (e) {
    logger.debug('[comments.replyEffectStats] failed: ' + e.message);
    return empty;
  }
}

/**
 * 按本地日期统计"我每天发出了多少条回复"。
 *
 * 这是运营的**产出**曲线，与"每天进来多少条评论"配对看，才知道回复跟不跟得上。
 * 之前没有任何地方能回答"我上周回了多少条" —— 只有总数（119）。
 *
 * 口径：`uid = 我` 且 `parent_cid` 非空。
 * 后者是关键：我们自己发的**顶级评论**（评论引流里那种独立评论）不算"回复"，
 * 把它算进来的话，产出曲线会突然拔高一段，而那段其实不是回复。
 *
 * 日期用 `date(created_at, 'unixepoch', 'localtime')` 换算 ——
 * created_at 是抖音的**秒**，且要按**本机时区**归日，才能和界面上的
 * `localDay()` 对上。少了 'localtime' 会按 UTC 归，晚上发的回复会落到第二天。
 *
 * @param {object} opts
 * @param {number} opts.uid   - 我的 uid（拿不到就返回空 Map）
 * @param {number} [opts.since] - 毫秒时间戳（含）
 * @returns {Map<string, number>} 'YYYY-MM-DD' → 条数
 */
function dailyReplyCounts(opts = {}) {
  const out = new Map();
  if (!opts.uid) return out;
  try {
    const db = getDb();
    const params = [PLATFORM, String(opts.uid)];
    let sinceSql = '';
    if (opts.since) {
      // 秒与毫秒两种时间戳都存在过，两边都兜住（见 db.js 的时间戳约定）
      sinceSql = ' AND created_at >= ?';
      params.push(Math.floor(opts.since / 1000));
    }
    const rows = db.prepare(`
      SELECT date(created_at, 'unixepoch', 'localtime') AS day, count(*) AS n
      FROM comments
      WHERE platform = ? AND uid = ? AND parent_cid IS NOT NULL AND created_at IS NOT NULL${sinceSql}
      GROUP BY day
    `).all(...params);
    for (const r of rows) {
      if (r.day) out.set(String(r.day), r.n || 0);
    }
  } catch (e) {
    logger.debug('[comments.dailyReplyCounts] failed: ' + e.message);
  }
  return out;
}

/**
 * 撤销"已回复"标记：把指着这条回复的父评论放回未回复状态。
 *
 * 用途：删除自己发出的那条回复之后，本地也得跟着回退 —— 不然界面继续显示
 * 「已回复」、待回复数也不涨回来，而那条回复在抖音上已经不存在了。
 * 按 `reply_cid` 反查，不需要调用方再传 awemeId（它本来就记在父行上）。
 *
 * @param {string} replyCid - 被删掉的那条回复的 cid
 * @returns {number} 受影响的父评论条数（0 表示没有评论指着它）
 */
function unmarkReplied(replyCid) {
  if (!replyCid) return 0;
  try {
    const info = getDb().prepare(`
      UPDATE comments SET replied = 0, reply_cid = NULL
      WHERE platform = ? AND reply_cid = ?
    `).run(PLATFORM, String(replyCid));
    return info.changes;
  } catch (e) {
    logger.debug('[comments.unmarkReplied] failed: ' + e.message);
    return 0;
  }
}

/**
 * 删掉一条本地评论记录。
 *
 * 只在**抖音上那条评论真的被删掉之后**调用 —— 本地留着它会让"本地 N 条"
 * 与抖音对不上，而库里没有墓碑位可放。要留痕的话语料库那边有
 * （`corpus.setOutcome(id, 'deleted')`，delete-comment 命令已经在做）。
 *
 * @param {string} cid
 * @returns {number} 删除的行数（0 = 本来就没有）
 */
function remove(cid) {
  if (!cid) return 0;
  try {
    const info = getDb().prepare(
      'DELETE FROM comments WHERE platform = ? AND cid = ?'
    ).run(PLATFORM, String(cid));
    return info.changes;
  } catch (e) {
    logger.debug('[comments.remove] failed: ' + e.message);
    return 0;
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
  MAX_LIMIT, clampLimit,
  ORDER_NAMES,
  ORDER_INFO, listReplied, count, statsForVideo, statsForVideos, replyEffectStats,
  dailyReplyCounts, unmarkReplied, remove, cleanupBefore, hashText, normalizeText,
};
