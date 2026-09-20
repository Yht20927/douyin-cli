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
        aweme_id, platform, title, desc, cover_url, author_uid, is_mine, ops_uid,
        total_comments_seen, last_get_ts, last_post_ts,
        play_count, digg_count, comment_count, share_count, create_time
      ) VALUES (
        @awemeId, @platform, @title, @desc, @coverUrl, @authorUid, @isMine, @opsUid,
        @delta, @lastGetTs, @lastPostTs,
        @playCount, @diggCount, @commentCount, @shareCount, @createTime
      )
      ON CONFLICT(platform, aweme_id) DO UPDATE SET
        title       = COALESCE(excluded.title, title),
        desc        = COALESCE(excluded.desc, desc),
        cover_url   = COALESCE(excluded.cover_url, cover_url),
        author_uid  = COALESCE(excluded.author_uid, author_uid),
        is_mine     = CASE WHEN excluded.is_mine = 1 THEN 1 ELSE is_mine END,
        -- 最近一次是哪个账号操作过它。别人的视频没有归属账号，这一列是
        -- "运营对象按账号隔离"的唯一依据；不传就保留原值（拉评论/补全都不该把它抹掉）
        ops_uid     = COALESCE(excluded.ops_uid, ops_uid),
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
      opsUid: fields.opsUid ? String(fields.opsUid) : null,
      delta,
      lastGetTs: fields.lastGetTs || null,
      lastPostTs: fields.lastPostTs || null,
      playCount: numOrNull(fields.playCount),
      diggCount: numOrNull(fields.diggCount),
      commentCount: numOrNull(fields.commentCount),
      shareCount: numOrNull(fields.shareCount),
      createTime: numOrNull(fields.createTime),
    });
    // 互动数据的历史快照接在这里，而不是散在 my / enrich / user 三个命令里 ——
    // 那些地方加一处就要记着加第二处，漏掉的表现是"某条路径的数据没有历史"，
    // 而界面上只会显示一条断掉的曲线，没人知道该去查哪里。
    snapshotStats(String(fields.awemeId));
    return true;
  } catch (e) {
    logger.debug('[videos.upsert] failed: ' + e.message);
    return false;
  }
}

/**
 * 把当前互动数据记一行快照（每个视频每天一行）。
 *
 * 只在**至少有一个统计数非空**时写：`markGet` / `markPost` 也会走 upsert，
 * 它们只带 aweme_id 和时间戳 —— 那种调用不该在这张表里留下"四个字段全是
 * NULL"的空行，否则图上会出现一堆断点。
 *
 * 写的是**库里生效的值**（upsert 之后重新读一次），不是本次传入的字段：
 * upsert 用 COALESCE 保留旧值，只传了 digg 的那次调用，play_count 在表里
 * 仍有值 —— 拿入参去记快照会把它记成 NULL。
 *
 * 同日重复调用走 UPSERT 覆盖，并且**只在数值真的变了时才写**（DO UPDATE 的
 * WHERE 子句）：刷新列表是常态操作，不加这一条会让每次刷新都产生一次无谓的写。
 *
 * @param {string} awemeId
 * @param {number} [ts]
 */
function snapshotStats(awemeId, ts = Date.now()) {
  if (!awemeId) return false;
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT play_count, digg_count, comment_count, share_count
      FROM videos WHERE platform = ? AND aweme_id = ?
    `).get(PLATFORM, String(awemeId));
    if (!row) return false;
    if (row.play_count == null && row.digg_count == null
      && row.comment_count == null && row.share_count == null) return false;

    const d = new Date(ts);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    db.prepare(`
      INSERT INTO video_stats_history
        (platform, aweme_id, day, ts, play_count, digg_count, comment_count, share_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, aweme_id, day) DO UPDATE SET
        ts            = excluded.ts,
        play_count    = excluded.play_count,
        digg_count    = excluded.digg_count,
        comment_count = excluded.comment_count,
        share_count   = excluded.share_count
      -- 数值没变就不写。用 IS NOT 而不是 <>：这几列经常是 NULL，
      -- 而「NULL <> NULL」在 SQL 里求值为 NULL（即假），会让两边都是 NULL 也算变化。
      -- ⚠️ 这段注释里不要用反引号：它在 JS 的模板字符串里会**直接终止模板**
      WHERE excluded.play_count    IS NOT play_count
         OR excluded.digg_count    IS NOT digg_count
         OR excluded.comment_count IS NOT comment_count
         OR excluded.share_count   IS NOT share_count
    `).run(PLATFORM, String(awemeId), day, ts,
      row.play_count, row.digg_count, row.comment_count, row.share_count);
    return true;
  } catch (e) {
    logger.debug('[videos.snapshotStats] failed: ' + e.message);
    return false;
  }
}

/**
 * 一张表里的历史快照。
 *
 * @param {object} [opts]
 * @param {string} [opts.awemeId] - 只取某个视频的
 * @param {number} [opts.since]   - 毫秒时间戳，按 `ts` 过滤
 * @param {number} [opts.limit]
 * @returns {Array<{awemeId, day, ts, plays, likes, comments, shares}>} 按 day 升序
 */
function listStatsHistory(opts = {}) {
  try {
    const db = getDb();
    const where = ['platform = ?'];
    const params = [PLATFORM];
    if (opts.awemeId) { where.push('aweme_id = ?'); params.push(String(opts.awemeId)); }
    if (opts.since) { where.push('ts >= ?'); params.push(Number(opts.since)); }
    const limit = Math.max(1, Math.min(opts.limit || 10000, 100000));
    const rows = db.prepare(`
      SELECT aweme_id, day, ts, play_count, digg_count, comment_count, share_count
      FROM video_stats_history
      WHERE ${where.join(' AND ')}
      ORDER BY day ASC, aweme_id ASC
      LIMIT ${limit}
    `).all(...params);
    return rows.map(r => ({
      awemeId: r.aweme_id,
      day: r.day,
      ts: r.ts,
      plays: r.play_count,
      likes: r.digg_count,
      comments: r.comment_count,
      shares: r.share_count,
    }));
  } catch (e) {
    logger.debug('[videos.listStatsHistory] failed: ' + e.message);
    return [];
  }
}

/**
 * 标记一次成功的 get：last_get_ts + 累计评论数。
 *
 * ⚠️ 参数改成对象了（原来是 `(awemeId, delta, ts)`）。加账号这一维之后
 * 三个位置参数变成四个，`markGet(id, n, null, me)` 这种写法里那个 `null`
 * 是个地雷 —— 迟早有人把 uid 传进 ts 的位置。
 *
 * @param {object} [opts]
 * @param {number} [opts.commentsSeenDelta]
 * @param {number} [opts.ts]
 * @param {string} [opts.accountUid] - 本次操作是哪个账号做的（写进 ops_uid）
 */
function markGet(awemeId, opts = {}) {
  return upsert({
    awemeId,
    lastGetTs: opts.ts || Date.now(),
    commentsSeenDelta: opts.commentsSeenDelta || 0,
    opsUid: opts.accountUid || null,
  });
}

/**
 * 标记一次成功的 post：last_post_ts。
 * @param {object} [opts]
 * @param {number} [opts.ts]
 * @param {string} [opts.accountUid]
 */
function markPost(awemeId, opts = {}) {
  return upsert({ awemeId, lastPostTs: opts.ts || Date.now(), opsUid: opts.accountUid || null });
}

function get(awemeId) {
  if (!awemeId) return null;
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT aweme_id, platform, title, desc, cover_url, author_uid, is_mine, ops_uid,
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
      opsUid: row.ops_uid || null,
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
 * @param {string} [opts.accountUid] - 只看**这个账号**的作品（隐含 isMine=1）。
 *   账号级隔离的主入口：`is_mine=1` 只说"是本机某个登录账号的作品"，
 *   不区分是哪个号 —— 不加这一条，两个号的作品会混在一张列表里。
 * @param {string} [opts.opsUid] - 只看向**这个账号**运营过的视频（按 ops_uid）。
 *   别人的视频没有 author_uid，隔离只能靠它
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
    if (opts.accountUid) {
      // 括号不能省：它与后面的条件之间是 AND，没有括号会变成
      // `is_mine = 1 AND author_uid = ? AND <其它>` 看着一样，但一旦将来
      // 有人把 where 改成 OR 连接就会静默错 —— 显式分组，别依赖巧合
      where.push('(is_mine = 1 AND author_uid = ?)');
      params.push(String(opts.accountUid));
    }
    if (opts.opsUid) { where.push('ops_uid = ?'); params.push(String(opts.opsUid)); }
    // 注意 create_time 是**秒**、last_get_ts 是**毫秒**（见 db.js 的单位约定）。
    // 两者不在同一个排序键里混用，各自内部比大小没问题。
    const orderBy = opts.order === 'publish'
      ? 'COALESCE(create_time, 0) DESC, COALESCE(last_get_ts, last_post_ts, 0) DESC'
      : 'COALESCE(last_get_ts, last_post_ts, 0) DESC';
    const rows = db.prepare(`
      SELECT aweme_id, title, desc, cover_url, author_uid, is_mine, ops_uid,
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
      opsUid: r.ops_uid || null,
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
 * 「还没补全」的判定条件 —— `listMissingInfo` 与 `countMissingInfo` **共用这一份**。
 *
 * 两处各写一遍是这个函数存在的唯一理由：界面的「补全视频信息（N 个）」用的是
 * count，点下去实际补的是 list。两边条件一旦漂移，用户看到的就是
 * "按钮说还有 40 个、点完只补了 3 个、数字还是 40"。
 *
 * 为什么条件不是"只看标题"：抖音作品的 desc 允许为空（很多作品就是不写文案），
 * 而 `upsert` 里是 `title: fields.title || null` —— 补全成功也只会留下 NULL。
 * 只看标题的那一版后果实测过：这类视频**永远**待在待补全里，按钮上的数字不降，
 * 每点一次都把同一批 200 条重抓一遍（白付 200 次请求的风控暴露）。
 * 封面没有这个坑：详情接口一定会给一张封面。
 *
 * @param {object} [opts] - { all, accountUid }
 * @returns {{where: string[], params: any[]}}
 */
function missingInfoWhere(opts = {}) {
  const where = ['platform = ?'];
  const params = [PLATFORM];
  where.push(opts.all ? '1 = 1'
    : "(title IS NULL OR title = '') AND (cover_url IS NULL OR cover_url = '')");
  // 账号隔离：只补"这个账号自己的作品"与"它运营过的视频"。
  // 不隔离的话，B 号点一次「补全视频信息」会去补 A 号运营的视频 ——
  // 那是拿 B 的登录状态去做 A 的活，风控上也不该发生。
  if (opts.accountUid) {
    where.push('((is_mine = 1 AND author_uid = ?) OR ops_uid = ?)');
    params.push(String(opts.accountUid), String(opts.accountUid));
  }
  return { where, params };
}

/**
 * 信息不全的视频 —— 补全命令的候选集。
 *
 * 为什么会有这种行：`get`（拉评论）与 `post`（发回复）只能 upsert 一行
 * 只有 aweme_id + 时间戳的记录 —— 抖音的评论接口根本不返回视频信息。
 * 于是"运营对象"列表里这些视频的标题、封面全是空的，只能靠 ID 尾号认。
 * 补全走 /aweme/v1/web/aweme/detail/（油猴脚本里已有的 getDetail），
 * 一次请求同时带回 desc / 封面 / 作者 / 统计数。
 *
 * 排序用"最近互动"而不是插入顺序：正在运营的那些最该先补上。
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=100]
 * @param {boolean} [opts.all=false] - true 时连已有标题的也返回（重抓互动数据）
 * @param {string} [opts.accountUid] - 限定账号
 */
function listMissingInfo(opts = {}) {
  const limit = Math.max(1, Math.min(opts.limit || 100, 10000));
  const { where, params } = missingInfoWhere(opts);
  // 这里**不吞异常**（与下面 countMissingInfo 相反）：它只有一个调用方 ——
  // 补全命令。查询失败却返回空数组，命令就会对用户说"没有需要补全的视频"，
  // 而真相是"一条都没查出来"。让异常冒到队列，任务上写着失败原因。
  const rows = getDb().prepare(`
    SELECT aweme_id, title, cover_url, author_uid, ops_uid, is_mine,
           last_get_ts, last_post_ts
    FROM videos WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(last_get_ts, last_post_ts, 0) DESC
    LIMIT ${limit}
  `).all(...params);
  return rows.map(r => ({
    awemeId: r.aweme_id,
    title: r.title,
    coverUrl: r.cover_url,
    authorUid: r.author_uid,
    opsUid: r.ops_uid || null,
    isMine: !!r.is_mine,
    lastGetTs: r.last_get_ts,
    lastPostTs: r.last_post_ts,
  }));
}

/** 还有多少条视频没补过（界面用它决定要不要显示"补全"入口、按钮上写几） */
function countMissingInfo(opts = {}) {
  try {
    const { where, params } = missingInfoWhere(opts);
    return getDb().prepare(
      `SELECT count(*) AS n FROM videos WHERE ${where.join(' AND ')}`
    ).get(...params).n;
  } catch (e) {
    // 计数只影响一个角标，不值得让整页报错 —— 但不能无声变成 0：
    // 表现会是"补全按钮整个消失了"，没人知道为什么。
    logger.warn('[videos.countMissingInfo] 计数失败（界面会当成 0）: ' + e.message);
    return 0;
  }
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
  // ⚠️ **兜底用，新代码不要调它。**
  //
  // 它返回的是"is_mine 里 author_uid 出现最多的那个账号" —— 一个全局猜测。
  // 两个号各有作品时它静默挑一个，另一个号发的评论会被判成路人。
  // 正确的做法是 `accounts.resolveCurrent(ctx)` 拿到**当前账号**再往下传。
  // 保留这个函数只为兼容旧数据/旧测试，以及"确实拿不到账号"时不做判断。
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
    if (opts.accountUid) { where.push('(is_mine = 1 AND author_uid = ?)'); params.push(String(opts.accountUid)); }
    if (opts.opsUid) { where.push('ops_uid = ?'); params.push(String(opts.opsUid)); }
    return getDb().prepare(
      `SELECT count(*) AS n FROM videos WHERE ${where.join(' AND ')}`
    ).get(...params).n;
  } catch (e) { return 0; }
}

module.exports = {
  upsert, markGet, markPost, get, list, count, myUid, listMissingInfo, countMissingInfo,
  snapshotStats, listStatsHistory,
};
