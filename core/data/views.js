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
const corpus = require('../memory/corpus');

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

/**
 * 给一批评论补上「我们当时回的那句是什么」。
 *
 * 已发出的回复本身也是 comments 表里的一行（commands/post.js 落库时
 * cid = 原评论的 reply_cid），所以按 reply_cid 就能把正文查回来。
 * reply_corpus 是兜底：老数据里那行可能已被 cleanup 清掉，但语料库还留着。
 *
 * 查不到时保持 null —— 界面据此如实说「回复内容未记录」。
 * 返回空字符串则会被读成"回过，但内容是空的"，那是另一回事。
 *
 * @param {Array<object>} items - 含 replyCid 字段的行
 */
function attachReply(items) {
  const ids = items.map(i => i.replyCid).filter(Boolean).map(String);
  // 一条都不用查时省掉这次查询，但**不能**直接 return items ——
  // 那样这一批就缺少 replyText 字段，而另一批有，调用方得同时处理
  // "字段不存在"和"字段是 null"两种"没有值"。
  const rows = ids.length ? comments.getMany(ids) : new Map();

  return items.map((it) => {
    // 字段形状必须稳定：没有 reply_cid 的行也要给出 replyText: null，
    // 而不是干脆不带这个字段。否则调用方看到的是 undefined 与 null 两种
    // "没有值"，而这个项目已经吃过好几次"名字差一点、值恒为 undefined"的亏。
    if (!it.replyCid) return { ...it, replyText: null, replyAt: null };
    const key = String(it.replyCid);
    const row = rows.get(key);
    let text = row && row.text ? row.text : null;
    let at = row && row.createdAt != null ? row.createdAt : null;

    if (!text) {
      try {
        const c = corpus.findByReplyCid(key);
        if (c && c.replyText) {
          text = c.replyText;
          if (at == null) at = c.postedAt;
        }
      } catch (e) { /* 兜底查不到就维持 null，不影响其余字段 */ }
    }

    return { ...it, replyText: text, replyAt: douyinTimeToMs(at) };
  });
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
  // 我自己的 uid：用于排掉"我发的评论"与我发出的回复（见 core/memory/videos.myUid）。
  // 拿不到（还没跑过 `my`）时不传，决策树会跳过这层判断而不是误判。
  let myUid = null;
  try { myUid = videos.myUid(); } catch (e) { /* 忽略 */ }

  const out = new Map();
  for (const r of rows) {
    const u = userMap.get(String(r.uid));
    const decision = filters.classify(
      { cid: r.cid, uid: r.uid, text: r.text },
      {
        // 行上已有 replied 列，直接用它，不再回查数据库
        isReplied: (cid) => cid === r.cid && !!r.replied,
        userTier: () => (u && u.tier) || null,
        myUid,
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
  // 按发布时间排：翻自己的作品时，期待的是"最新发的在最前面"
  const list = videos.list({ isMine: true, limit, order: 'publish' });
  const cutoff = opts.days ? Date.now() - opts.days * 24 * 3600 * 1000 : 0;
  const myUid = safeMyUid();

  return list
    .filter(v => !cutoff || (v.lastGetTs || 0) >= cutoff)
    .map(v => ({
      ...v,
      // 注意别叫 stats —— videos.list() 返回的 stats 是视频自身的互动数据
      // （播放/点赞/评论/分享），两者语义完全不同，混用会互相覆盖
      commentStats: comments.statsForVideo(v.awemeId, { excludeUid: myUid }),
    }));
}

/** 单个视频的详情 + 本地评论统计 */
function videoDetail(awemeId) {
  const v = videos.get(awemeId);
  if (!v) return null;
  return {
    ...v,
    commentStats: comments.statsForVideo(awemeId, { excludeUid: safeMyUid() }),
  };
}

/** 取我自己的 uid，拿不到就返回 null（调用方据此跳过相关判断） */
function safeMyUid() {
  try { return videos.myUid(); } catch (e) { return null; }
}

/** 界面上的筛选标签 → listByVideo 的参数 */
/** 按判定结果过滤（无法下推到 SQL，只能在内存里筛） */
const DECISION_FILTERS = ['reply', 'emoji_reply', 'skip'];

/** 判定类筛选一次最多扫多少行 —— 打满时界面会明确提示可能不全 */
const TOTAL_SCAN_LIMIT = 20000;

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
  const rawFilter = opts.filter || 'all';
  // 未知 filter 一律退回 all 并如实告知，而不是静默返回空数组。
  // 改造前 `FILTERS[filter] ? ... : ...` 会把任何拼错的 filter 当成「按判定结果过滤」，
  // 于是 filter="typo" 返回 0 条、界面显示「这个筛选下没有评论」—— 看起来像没数据。
  const known = FILTERS[rawFilter] || DECISION_FILTERS.includes(rawFilter);
  const filter = known ? rawFilter : 'all';
  const unknownFilter = known ? null : rawFilter;
  const limit = Math.max(1, Number(opts.limit) || 200);
  const order = opts.order || 'priority';

  // 判定结果（reply / emoji_reply / skip）无法在 SQL 层表达，只能在内存里筛。
  // 这类筛选必须**先取全、再筛、最后截断**：改造前是「SQL 先截断到 500，
  // 再在内存里筛，再截断到 limit」，于是排在 500 名之后的评论在本标签页里
  // 根本看不到，而头部计数（取 5000 行）又说有 —— 两个数字对不上，且都不说明原因。
  const isDecisionFilter = DECISION_FILTERS.includes(filter);
  const dbFilter = FILTERS[filter] ? FILTERS[filter]() : {};

  const rows = comments.listByVideo(awemeId, {
    ...dbFilter,
    order,
    // 搜索已下推到 SQL，这里不再需要为了搜索而放宽取数
    search: opts.search || undefined,
    limit: isDecisionFilter ? TOTAL_SCAN_LIMIT : limit,
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

  if (isDecisionFilter) {
    items = items.filter(i => (i.decision && i.decision.action) === filter);
  } else if (filter === 'pending') {
    // 「待处理」排掉我自己的评论。
    // post.js 会把我们发出去的回复以 replied=0、uid=myUid 存进 comments 表，
    // 不排掉的话这个标签页里会混进一堆"我自己刚发出去的回复"，
    // 而它同时又出现在「已回复」标签页里 —— 用户无法判断到底还剩几条要处理。
    const myUid = safeMyUid();
    if (myUid != null) items = items.filter(i => String(i.uid) !== String(myUid));
  }

  // 总数在截断之前取，界面才能说「共 N 条，当前显示 M 条」而不是把列表长度当总数
  const matched = items.length;
  const truncated = matched > limit;
  items = items.slice(0, limit);

  // 补回复正文放在截断之后：只为我们真正要返回的那几十/几百条查，
  // 而不是为判定筛选用到的两万条全查一遍
  items = attachReply(items);

  return {
    items,
    total: isDecisionFilter ? matched : comments.countByVideo(awemeId, dbFilter, opts.search),
    shown: items.length,
    truncated,
    // 取数上限被打满时，上面的 total 也可能偏小 —— 如实标出来，而不是假装完整
    scanCapped: isDecisionFilter && rows.length >= TOTAL_SCAN_LIMIT,
    order,
    filter,
    unknownFilter,
  };
}

/** 单条评论的完整信息（含判定、用户画像、以及我们回过的那句） */
function commentDetail(cid) {
  const c = comments.get(cid);
  if (!c) return null;
  const u = users.get(String(c.uid));
  const decisions = decideAll([{
    cid: c.cid, uid: c.uid, text: c.text, replied: c.replied,
  }]);
  const withReply = attachReply([{
    cid: c.cid, replyCid: c.replyCid,
  }])[0];
  return {
    replyText: withReply.replyText,
    replyAt: withReply.replyAt,
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

/**
 * 某视频下评论按判定结果分组统计 —— 工作台的标签页计数用。
 *
 * ⚠️ 「待回复」的口径必须与 statsForVideo（作品列表用的那个）**完全一致**：
 * 两者都排除我自己发的评论。改造前这里是 `rows.length - replied`，不排自己发的，
 * 而 post.js 会把我们发出去的回复也 upsert 进 comments 表（uid=myUid、replied=0），
 * 于是同一个作品在作品列表显示「待回复 10」、进工作台显示「待回 35」，
 * 而且"待处理"标签页里混着一堆判定为"这是我自己发的评论"的行。
 *
 * @param {string} awemeId
 * @param {object} [opts]
 * @param {number} [opts.scanLimit] - 判定统计的取数上限（默认 20000）
 */
function videoStats(awemeId, opts = {}) {
  const scanLimit = opts.scanLimit || 20000;
  // 取全部评论跑判定：待回复的计数要排除"我自己的评论"，而那需要 myUid，
  // 所以不能只按 replied=0 取数 —— 我发的评论 replied 也是 0。
  const rows = comments.listByVideo(awemeId, { limit: scanLimit, order: 'newest' });
  const decisions = decideAll(rows);
  const myUid = safeMyUid();
  const by = { reply: 0, emoji_reply: 0, skip: 0 };
  let replied = 0;
  let mine = 0;

  for (const r of rows) {
    // byDecision 统计**每一行**（含已回复的、我自己发的）——
    // 它必须与「建议回复 / 表情回复 / 跳过」三个标签页显示的内容一一对应，
    // 那三个标签页是按判定结果筛的，不做已回复/自己的排除。
    const d = decisions.get(r.cid);
    if (d && by[d.action] !== undefined) by[d.action]++;

    if (myUid != null && String(r.uid) === String(myUid)) mine++;
    else if (r.replied) replied++;
  }

  return {
    total: rows.length,
    replied,
    mine,
    // 与 statsForVideo（作品列表用的那个）**同一口径**：排除我发的、排除已回复的。
    // 改造前这里是 rows.length - replied，不排自己发的，于是同一个作品在作品列表
    // 显示「待回复 10」、进工作台显示「待回 35」—— 而 post.js 会把我们发出去的
    // 回复也 upsert 进 comments 表（uid=myUid、replied=0），mine 必然 > 0。
    pending: rows.length - replied - mine,
    byDecision: by,
    // 被打满时计数可能偏小；界面据此提示"统计可能不全"而不是假装精确
    scanCapped: rows.length >= scanLimit,
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

  // 草稿是"回复某条评论"的，但列表与发布确认框此前都只显示一句"回复评论" ——
  // 用户看不出它到底回的是谁、针对什么内容，只能凭草稿正文猜。
  // 被回复评论的原文一次性查回来（每条草稿一次 get 的话，200 条就是 200 次查询）。
  const targetMap = comments.getMany(rows.map(r => r.reply_to_cid).filter(Boolean));

  return rows.map(r => {
    const awemeId = r.aweme_id;
    if (!titles.has(awemeId)) {
      const v = videos.get(awemeId);
      titles.set(awemeId, v ? v.title : null);
    }
    const target = r.reply_to_cid ? targetMap.get(String(r.reply_to_cid)) : null;
    return {
      id: r.id,
      awemeId,
      videoTitle: titles.get(awemeId) || null,
      replyToCid: r.reply_to_cid || null,
      // 被回复的评论原文 + 作者 uid。
      // uid 是给发布用的：策略里「同一个用户每轮最多回复几条」靠 meta.uid 判定，
      // 草稿发布链路此前不传它，导致这条规则从草稿箱发时不生效（见 DraftsView）。
      replyToText: target ? target.text : null,
      replyToUid: target ? target.uid : null,
      text: r.text,
      personaId: r.persona_id || null,
      // 图片回复的本地路径。发布时必须一并带上，否则草稿箱里存的图会被静默丢掉
      imagePath: r.image_path || null,
      createdAt: r.created_at,
      posted: !!r.posted,
    };
  });
}

/** 总览数字（今日页与诊断用） */
function overview() {
  const all = videos.list({ isMine: true, limit: 10000 });
  // 用 statsForVideo 逐视频算，而不是 count() 相减：
  // count() 不排"我自己发的评论"，于是待回复会把我们发出去的回复也算进去，
  // 与作品列表、工作台两个页面的口径都不一致（同一份数据在三处显示三个数）。
  let total = 0;
  let replied = 0;
  let mine = 0;
  const myUid = safeMyUid();
  for (const v of all) {
    const s = comments.statsForVideo(v.awemeId, { excludeUid: myUid });
    total += s.total;
    replied += s.replied;
    mine += s.mine;
  }
  return {
    videos: all.length,
    comments: total,
    replied,
    mine,
    pending: Math.max(0, total - replied - mine),
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
