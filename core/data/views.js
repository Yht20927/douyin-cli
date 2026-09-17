// core/data/views.js — 给界面用的视图模型
//
// 为什么不复用命令
// ----------------
// 命令是要发到抖音去的、要守节奏、要占串行队列的。而"把本地已经存下来的评论
// 列个表"只是在读 SQLite —— 没有风控风险、也不该占着队列让下一个真实操作排队。
// 所以界面看数据走这里，动手（拉新评论、发布）才走队列。
//
// 判定（回不回、怎么回）仍复用 core/policy/filters 的同一个决策树 ——
// 界面上看到的原因与发布时被拦的原因必须一致，不能两处各判一套。

const filters = require('../policy/filters');
const videos = require('../memory/videos');
const comments = require('../memory/comments');
const users = require('../memory/users');
const drafts = require('../memory/drafts');

/**
 * 批量取用户分级。逐条查会变成 N 次查询，而列表一次就是几百条。
 * @param {string[]} uids
 * @returns {Map<string, object>}
 */
function loadUsers(uids) {
  const map = new Map();
  for (const uid of new Set(uids.filter(Boolean).map(String))) {
    try {
      const u = users.get(uid);
      if (u) map.set(uid, u);
    } catch (e) { /* 单条查不到不影响其余 */ }
  }
  return map;
}

/**
 * 抖音原生时间（秒）→ 毫秒。
 *
 * comments.created_at / videos.create_time 直接来自抖音 API 的 create_time，单位是秒；
 * 而本项目自己产生的时间戳一律是毫秒（见 core/memory/db.js 的单位约定）。
 * 界面按毫秒算"多久之前"，不转换就会把 2026 年的评论显示成"20692 天前"。
 *
 * 用位数判断而不是无条件乘 1000：万一将来某处已经是毫秒，乘法会把它推到几万年之后，
 * 反而更难发现。此处只对"看起来像秒"的值做转换。
 */
function douyinTimeToMs(t) {
  if (t == null) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  // 十位及以下按秒处理（毫秒时间戳目前是 13 位）
  return n < 1e11 ? n * 1000 : n;
}

/** 用户信息裁剪成界面需要的最小集 */
function slimUser(u) {
  if (!u) return null;
  return {
    uid: u.uid,
    nickname: u.nickname || '',
    tier: u.tier || null,
    tags: u.tags || [],
    commentCount: u.commentCount || 0,
    replyCount: u.replyCount || 0,
    lastSeen: u.lastSeen || null,
  };
}

/**
 * 对一批评论跑决策树，返回与行一一对应的判定结果。
 *
 * 已回复的用行上的 replied 列直接判定 —— 决策树里那次查询本来就是查同一列，
 * 列表场景下每次重查一遍纯属浪费。
 *
 * @param {Array<object>} rows - comments.listByVideo 的返回
 * @returns {Map<string, object>} cid → 判定结果
 */
function decideAll(rows) {
  const userMap = loadUsers(rows.map(r => r.uid));
  const out = new Map();
  for (const r of rows) {
    const u = userMap.get(String(r.uid));
    const decision = filters.classify(
      { cid: r.cid, uid: r.uid, text: r.text },
      {
        // 行上已有 replied 列，直接用它，不再回查数据库
        isReplied: (cid) => cid === r.cid && !!r.replied,
        userTier: () => (u && u.tier) || null,
      }
    );
    out.set(r.cid, decision);
  }
  return out;
}

/**
 * 我的作品列表（附评论统计）。
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {number} [opts.days] - 只看最近 N 天拉取过的；0 表示不限
 */
function listMyVideos(opts = {}) {
  const limit = opts.limit || 50;
  const list = videos.list({ isMine: true, limit });
  const cutoff = opts.days ? Date.now() - opts.days * 24 * 3600 * 1000 : 0;

  return list
    .filter(v => !cutoff || (v.lastGetTs || 0) >= cutoff)
    .map(v => {
      const total = comments.count({ awemeId: v.awemeId });
      const replied = comments.count({ awemeId: v.awemeId, replied: true });
      return {
        ...v,
        // 注意别叫 stats —— videos.list() 返回的 stats 是视频自身的互动数据
        // （播放/点赞/评论/分享），两者语义完全不同，混用会互相覆盖
        commentStats: {
          total,
          replied,
          pending: Math.max(0, total - replied),
        },
      };
    });
}

/** 单个视频的详情 + 本地评论统计 */
function videoDetail(awemeId) {
  const v = videos.get(awemeId);
  if (!v) return null;
  const total = comments.count({ awemeId });
  const replied = comments.count({ awemeId, replied: true });
  return {
    ...v,
    commentStats: { total, replied, pending: Math.max(0, total - replied) },
  };
}

/** 界面上的筛选标签 → listByVideo 的参数 */
const FILTERS = {
  all: () => ({}),
  pending: () => ({ replied: false }),
  replied: () => ({ replied: true }),
};

/**
 * 某视频下的评论列表（带判定结果与用户信息）。
 *
 * @param {string} awemeId
 * @param {object} [opts]
 * @param {'all'|'pending'|'replied'|'reply'|'emoji_reply'|'skip'} [opts.filter='all']
 *        reply/emoji_reply/skip 是按**判定结果**过滤，需要在内存里筛
 * @param {number} [opts.limit]
 * @param {string} [opts.search] - 按评论文本或昵称模糊匹配
 */
function listComments(awemeId, opts = {}) {
  const filter = opts.filter || 'all';
  const limit = opts.limit || 200;

  // 按判定结果过滤时无法在 SQL 层做，得先把候选行取全再筛
  const dbFilter = FILTERS[filter] ? FILTERS[filter]() : {};
  const rows = comments.listByVideo(awemeId, {
    ...dbFilter,
    // 判定类过滤要放宽 SQL 取数，否则"跳过"的评论根本没取出来
    limit: FILTERS[filter] ? limit : Math.max(limit, 500),
  });

  const decisions = decideAll(rows);
  const userMap = loadUsers(rows.map(r => r.uid));

  let items = rows.map(r => ({
    ...r,
    // 归一成毫秒供界面使用（原始值在 createdAtRaw 里保留，便于排查）
    createdAt: douyinTimeToMs(r.createdAt),
    createdAtRaw: r.createdAt,
    user: slimUser(userMap.get(String(r.uid))),
    decision: decisions.get(r.cid) || null,
  }));

  if (!FILTERS[filter]) {
    items = items.filter(i => (i.decision && i.decision.action) === filter);
  }

  if (opts.search) {
    const q = String(opts.search).toLowerCase();
    items = items.filter(i =>
      (i.text || '').toLowerCase().includes(q)
      || ((i.user && i.user.nickname) || '').toLowerCase().includes(q)
    );
  }

  return items.slice(0, limit);
}

/** 单条评论的完整信息（含判定与用户画像） */
function commentDetail(cid) {
  const c = comments.get(cid);
  if (!c) return null;
  const u = users.get(String(c.uid));
  const decisions = decideAll([{
    cid: c.cid, uid: c.uid, text: c.text, replied: c.replied,
  }]);
  return {
    cid: c.cid,
    awemeId: c.awemeId,
    uid: c.uid,
    text: c.text,
    digg: c.digg,
    createdAt: douyinTimeToMs(c.createdAt),
    createdAtRaw: c.createdAt,
    sentiment: c.sentiment,
    priority: c.priority,
    replied: !!c.replied,
    replyCid: c.replyCid,
    parentCid: c.parentCid,
    parentText: c.parentText || null,
    user: slimUser(u),
    decision: decisions.get(c.cid) || null,
  };
}

/** 某视频下评论按判定结果分组统计 —— 工作台的标签页计数用 */
function videoStats(awemeId) {
  const rows = comments.listByVideo(awemeId, { limit: 5000 });
  const decisions = decideAll(rows);
  const by = { reply: 0, emoji_reply: 0, skip: 0 };
  let replied = 0;

  for (const r of rows) {
    if (r.replied) replied++;
    const d = decisions.get(r.cid);
    if (d && by[d.action] !== undefined) by[d.action]++;
  }

  return {
    total: rows.length,
    replied,
    pending: rows.length - replied,
    byDecision: by,
  };
}

/**
 * 草稿箱（附视频标题，省得界面再去查）。
 *
 * 注意 drafts.list() 返回的是**原始数据库行**（下划线字段名），
 * 与 memory 层其他模块返回驼峰对象不同。这里统一转成驼峰再交给界面，
 * 免得界面到处混用两种命名。
 */
function listDrafts(opts = {}) {
  const rows = drafts.list({ posted: false, limit: opts.limit || 200 });
  const titles = new Map();

  return rows.map(r => {
    const awemeId = r.aweme_id;
    if (!titles.has(awemeId)) {
      const v = videos.get(awemeId);
      titles.set(awemeId, v ? v.title : null);
    }
    return {
      id: r.id,
      awemeId,
      videoTitle: titles.get(awemeId) || null,
      replyToCid: r.reply_to_cid || null,
      text: r.text,
      personaId: r.persona_id || null,
      createdAt: r.created_at,
      posted: !!r.posted,
    };
  });
}

/** 总览数字（今日页与诊断用） */
function overview() {
  const all = videos.list({ isMine: true, limit: 10000 });
  let total = 0;
  let replied = 0;
  for (const v of all) {
    total += comments.count({ awemeId: v.awemeId });
    replied += comments.count({ awemeId: v.awemeId, replied: true });
  }
  return {
    videos: all.length,
    comments: total,
    replied,
    pending: Math.max(0, total - replied),
    drafts: drafts.count({ posted: false }),
    users: users.count(),
  };
}

module.exports = {
  listMyVideos,
  videoDetail,
  listComments,
  commentDetail,
  videoStats,
  listDrafts,
  overview,
  // 供测试
  _decideAll: decideAll,
};
