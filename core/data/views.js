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
const accounts = require('../memory/accounts');
const events = require('../memory/events');
const failures = require('../memory/failures');
const llmUsage = require('../memory/llm-usage');

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
 * @param {object} [opts]
 * @param {string|null} [opts.myUid] - "我自己"的 uid。**多账号时必须传视频
 *   归属账号**（videos.get(awemeId).authorUid）—— 全局 myUid 是"作品最多的
 *   账号"，用它会把另一个号在自己的视频下发的评论误判成路人。
 * @returns {Map<string, object>} cid → 判定结果
 */
function decideAll(rows, opts = {}) {
  const userMap = loadUsers(rows.map(r => r.uid));
  let myUid = opts.myUid != null ? opts.myUid : null;
  if (myUid == null) {
    try { myUid = videos.myUid(); } catch (e) { /* 忽略 */ }
  }

  const out = new Map();
  for (const r of rows) {
    const u = userMap.get(String(r.uid));
    const decision = filters.classify(
      // isSticker 必须带上：贴纸评论的跳过规则读的就是它。
      // 这里以前只传 {cid, uid, text}，等于在最后一环又把刚修好的字段丢了。
      { cid: r.cid, uid: r.uid, text: r.text, isSticker: r.isSticker },
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
 * "这条视频下，哪个 uid 算是我" —— 判定"我发的评论"用。
 *
 * 对**我自己的作品**：author_uid 就是拉取时登录的那个号（`my` 命令写入），
 * 是逐视频的确定值 —— 多账号时全局 myUid（作品数最多的号）会把另一个号在
 * 自己视频下发的评论误判成路人，所以必须优先用它。
 *
 * 对**别人的视频**：author_uid 是**那个视频的作者**，不是我 ——
 * 拿它当"我"会把视频作者在自己评论区发的评论（很常见）误判成"我发的"，
 * 于是它从「待处理」里消失、还被标成"已回复"。core/commands/user.js 会给
 * 抓来的作品写 authorUid + isMine:false，所以这条路径上是真的会踩到，
 * 不是理论风险。这种情况只能用全局 myUid。
 */
function videoMyUid(awemeId, accountUid = null) {
  try {
    const v = videos.get(awemeId);
    // isMine 必须一起判断 —— 只判 authorUid 非空就把两者混为一谈了
    if (v && v.isMine && v.authorUid) return String(v.authorUid);
  } catch (e) { /* 查不到就往下退 */ }
  // 别人的视频：author_uid 是**视频作者**，不是我。这里必须用**当前账号**——
  // 全局 myUid()（作品数最多的号）两个号时必然有一个错的
  if (accountUid) return String(accountUid);
  try { return videos.myUid(); } catch (e) { return null; }
}

/**
 * 「我」是谁 —— 这一层所有判断的基准，以及"到底知不知道"。
 *
 * 账号由调用方从 `accounts.resolveCurrent()` 拿（它优先跟随浏览器当前登录的号）。
 * 拿不到时**退回旧的全局猜测并标出来**（`certain: false`），而不是静默合并 ——
 * 静默合并不就是这个 bug 本身。
 *
 * @returns {{uid:string|null, certain:boolean}}
 */
function resolveActor(opts = {}) {
  if (opts.accountUid) return { uid: String(opts.accountUid), certain: true, scopedUid: String(opts.accountUid) };
  const guess = safeMyUid();
  // 解析不出来时两个字段的用途**必须分开**：
  //
  //   uid       —— 「谁算是我」，用于把某条评论判成自己发的。这里用旧的全局猜测
  //                是可以的：猜错最多是某条评论的归属标错，不会让数据消失。
  //   scopedUid —— **按账号过滤列表**用。这里必须是 null（不过滤）——
  //                拿一个猜测去过滤，会把另一个号的数据整片藏起来，
  //                而界面上显示的是"你的作品是空的"，用户只会以为数据丢了。
  //                所以拿不到账号时：显示全部 + 由 accountCertain 让界面提示。
  return { uid: guess, certain: false, scopedUid: null };
}

/**
 * 我的作品列表（附评论统计）。
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {number} [opts.days] - 只看最近 N 天拉取过的；0 表示不限
 */
function listMyVideos(opts = {}) {
  const limit = opts.limit || 50;
  const actor = resolveActor(opts);
  // 按发布时间排：翻自己的作品时，期待的是"最新发的在最前面"
  //
  // accountUid 是这次修复的核心：`is_mine=1` 只说"本机某个登录账号的作品"，
  // 不区分是哪个号 —— 只按它过滤，两个号的作品就混在一张列表里，
  // 于是"换了号刷新后列表没变"。
  const list = videos.list({ isMine: true, limit, order: 'publish', accountUid: actor.scopedUid });
  const cutoff = opts.days ? Date.now() - opts.days * 24 * 3600 * 1000 : 0;

  return list
    .filter(v => !cutoff || (v.lastGetTs || 0) >= cutoff)
    .map(v => ({
      ...v,
      // 待回复按**本视频的归属账号**排自己的评论 —— 多账号时全局 myUid
      // 会把别的号在自己视频下的评论算成待回复
      commentStats: comments.statsForVideo(v.awemeId, {
        excludeUid: v.authorUid || actor.uid,
      }),
      // 内容归属账号的昵称（连接名册里登记过的才有）——
      // 多账号时用户靠它分辨"这条是哪个号发的"
      accountNickname: v.authorUid ? accounts.nicknameOf(v.authorUid) : null,
    }));
}

/** 单个视频的详情 + 本地评论统计 */
function videoDetail(awemeId, opts = {}) {
  const v = videos.get(awemeId);
  if (!v) return null;
  const actor = resolveActor(opts);
  return {
    ...v,
    commentStats: comments.statsForVideo(awemeId, {
      // 我自己的作品用它的归属账号；别人的视频用当前账号
      excludeUid: v.isMine && v.authorUid ? String(v.authorUid) : actor.uid,
    }),
  };
}

/** 取我自己的 uid，拿不到就返回 null（调用方据此跳过相关判断） */
function safeMyUid() {
  try { return videos.myUid(); } catch (e) { return null; }
}

/**
 * 运营对象的排序方式。界面那份下拉由这里驱动，不自己再写一份
 * （同 comments.ORDER_INFO 的做法：两处各写一套，迟早只剩一处是对的）。
 */
const TARGET_ORDERS = [
  { name: 'pending', label: '待回复最多' },
  { name: 'recent', label: '最近互动' },
  { name: 'comments', label: '评论数最多' },
];

/**
 * 一次扫描多少个视频。
 *
 * 排序键（待回复数）只能在内存里算，**必须先把候选全取出来再排序**，
 * 否则"待回复最多的那个"可能排在扫描范围之外、根本不会出现在榜首。
 * 打满时如实标注，不假装完整。
 */
const TARGET_SCAN_LIMIT = 1000;

/**
 * 运营对象 —— 不是"我发的作品"，而是"我正在运营的那些评论区"。
 *
 * 为什么单列一张表：本工具的实际打法是在**别人的**视频评论区互动引流，
 * 而 `videos.is_mine` 只标自己的作品。实测某台机器上 215 个视频里只有 7 个
 * 是自己的，1850 条评论（96%）落在别人的视频下 —— 而「我的作品」列表
 * 恰恰是工作台的唯一入口，于是真正在运营的那批评论区在界面上不可达。
 *
 * 判定"值得运营"的标准是**本地存到过评论**：视频行本身由 `get`/`post` 的
 * `markGet` upsert 出来（title/author 都是空的），只有评论区真的抓过，
 * 它才是一个有东西可干的运营对象。
 *
 * @param {object} [opts]
 * @param {'pending'|'recent'|'comments'} [opts.order='pending']
 * @param {number} [opts.limit=200]
 */
function listTargets(opts = {}) {
  const wanted = opts.order || 'pending';
  // 认不出的排序回落成待回复。这里刻意**不**额外返回一个"你给的排序不认识"字段：
  // 界面上的下拉选项就来自下面的 orders，递不进不认识的值，那个字段只会成为
  // 又一个人人以为在用、其实没人读的返回字段。
  const order = TARGET_ORDERS.some(o => o.name === wanted) ? wanted : 'pending';
  const limit = Math.max(1, Number(opts.limit) || 200);

  const actor = resolveActor(opts);
  const myUid = actor.uid;
  // 只取别人的视频；我自己的作品在「我的作品」里，且那里的口径是另一套。
  //
  // **按 ops_uid 隔离**：别人的视频没有归属账号，只能靠"是哪次操作、哪个账号
  // 看到的"来分。不隔离的话，B 号会看到 A 号运营过的全部对象，点进去发的
  // 回复还会以 B 的身份发出去 —— 正是用户报的那个问题。
  const rows = videos.list({
    isMine: false,
    limit: TARGET_SCAN_LIMIT,
    order: 'activity',
    opsUid: actor.scopedUid,
  });
  const statMap = comments.statsForVideos(rows.map(v => v.awemeId), { excludeUid: myUid });
  const userMap = loadUsers(rows.map(v => v.authorUid));
  const EMPTY = { total: 0, replied: 0, mine: 0, pending: 0 };

  const items = rows
    .map(v => {
      const au = v.authorUid ? String(v.authorUid) : null;
      const author = au ? userMap.get(au) : null;
      return {
        awemeId: v.awemeId,
        title: v.title || null,
        coverUrl: v.coverUrl || null,
        authorUid: au,
        // 视频作者的昵称取自用户表 —— 它是从评论里认出来的，可能没有
        authorNickname: author ? author.nickname : null,
        createTime: douyinTimeToMs(v.createTime),
        lastGetTs: v.lastGetTs || null,
        lastPostTs: v.lastPostTs || null,
        commentStats: statMap.get(String(v.awemeId)) || EMPTY,
      };
    })
    // 一条评论都没存到过的不算运营对象：那是抓取留下的空壳，点进去也只有空列表
    .filter(t => t.commentStats.total > 0);

  const pick = {
    pending: t => t.commentStats.pending,
    comments: t => t.commentStats.total,
    recent: t => Math.max(t.lastPostTs || 0, t.lastGetTs || 0),
  }[order];
  items.sort((a, b) => pick(b) - pick(a));

  const total = items.length;
  return {
    items: items.slice(0, limit),
    total,
    shown: Math.min(total, limit),
    truncated: total > limit,
    // 扫描上限与本轮实际扫了多少 —— 两个数都要给，界面才能说清"可能不全"的原因
    scanned: rows.length,
    scanLimit: TARGET_SCAN_LIMIT,
    scanCapped: rows.length >= TARGET_SCAN_LIMIT,
    // 本页数据属于哪个账号。界面必须显示它 —— 用户报的正是"换了号数据没变"，
    // 而只要把"当前是哪个号"摆出来，这件事立刻可验证
    accountUid: actor.uid,
    accountCertain: actor.certain,
    // 多少个视频还没标题（`get`/`post` 建出来的壳）。界面靠它决定要不要显示
    // 「补全视频信息」那个入口 —— 全都有标题时摆一个按钮只会让人问"这是干嘛的"
    // 注意口径：它是**补全命令实际会处理的条数**（含「我的作品」与不在本列表的
    // 历史对象），所以会大于上面的 total。界面必须把这句话讲出来，否则看起来像计数坏了
    missingInfoCount: videos.countMissingInfo({ accountUid: actor.scopedUid }),
    order,
    orders: TARGET_ORDERS,
  };
}

/** 界面上的筛选标签 → listByVideo 的参数 */
/** 按判定结果过滤（无法下推到 SQL，只能在内存里筛） */
const DECISION_FILTERS = ['reply', 'emoji_reply', 'skip'];

/**
 * 判定类筛选一次最多扫多少行 —— 打满时界面会明确提示可能不全。
 *
 * 这个数**必须**等于 comments.listByVideo 的硬上限，不能凭感觉另写一个：
 * 那里会把 limit 夹到 MAX_LIMIT，这里如果写个更大的数（以前写的是 20000），
 * `rows.length >= scanLimit` 就永远不成立，"扫描被截断、计数可能偏小"的提示
 * 因此在结构上永远不可能出现 —— 一条承诺了但永远不会说的话。
 */
const SCAN_LIMIT = comments.MAX_LIMIT;

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

  // 判定结果（reply / emoji_reply / skip）无法在 SQL 层表达，只能在内存里筛；
  // 「待处理」要排掉我自己的评论，那一步同样只能在内存里做。
  // 这两类筛选必须**先取全、再筛、最后截断**：改造前是「SQL 先截断到 500，
  // 再在内存里筛，再截断到 limit」，于是排在 500 名之后的评论在本标签页里
  // 根本看不到，而头部计数（取 5000 行）又说有 —— 两个数字对不上，且都不说明原因。
  const isDecisionFilter = DECISION_FILTERS.includes(filter);
  const dbFilter = FILTERS[filter] ? FILTERS[filter]() : {};
  // "我自己"按本视频的归属账号判定；别人的视频则用**当前账号**
  // （多账号时全局 myUid 必然有一个是错的，见 videoMyUid 的注释）
  const myUid = videoMyUid(awemeId, opts.accountUid);
  // 「待处理」的自我过滤。**总数必须跟着一起排**：post.js 会把我们发出去的回复
  // 以 replied=0、uid=myUid 存进 comments 表，不排掉的话这个标签页里会混进一堆
  // "我自己刚发出去的回复"（它同时又出现在「已回复」页里）；而总数若不跟着排，
  // 界面会显示「共 99 条 · 当前显示 95 条」—— 同一屏两个口径，
  // 与「运营对象」、作品列表上的"待回复"也对不上。
  const needMineFilter = filter === 'pending' && myUid != null;
  const needsMemoryFilter = isDecisionFilter || needMineFilter;

  const rows = comments.listByVideo(awemeId, {
    ...dbFilter,
    order,
    // 搜索已下推到 SQL，这里不再需要为了搜索而放宽取数。
    // 只有判定类筛选要先取全（判定下推不到 SQL）；「待处理」的自我过滤
    // 在 SQL 里能表达（uid IS NOT ?），所以它照常用 limit 取数，
    // 总量交给 countByVideo 精确算 —— 不必为一个计数扫一万行、
    // 还要对每一行跑一遍判定树。
    search: opts.search || undefined,
    limit: isDecisionFilter ? SCAN_LIMIT : limit,
  });

  const decisions = decideAll(rows, { myUid });
  const userMap = loadUsers(rows.map(r => r.uid));

  let items = rows.map(r => ({
    ...r,
    // 归一成毫秒供界面使用（原始值在 createdAtRaw 里保留，便于排查）
    createdAt: douyinTimeToMs(r.createdAt),
    createdAtRaw: r.createdAt,
    // 这条评论是不是**当前账号**发的。界面据此决定要不要给「删除」按钮 ——
    // 判定不能靠 decision.reason 里的文案（那是给人看的话，改一个字就失效）
    isMine: myUid != null && String(r.uid) === String(myUid),
    user: slimUser(userMap.get(String(r.uid))),
    decision: decisions.get(r.cid) || null,
  }));

  if (isDecisionFilter) {
    items = items.filter(i => (i.decision && i.decision.action) === filter);
  } else if (needMineFilter) {
    items = items.filter(i => String(i.uid) !== String(myUid));
  }

  // 总数在截断之前取，界面才能说「共 N 条，当前显示 M 条」而不是把列表长度当总数。
  // 「待处理」走 SQL 精确计数（已经排掉我自己的评论，口径与列表一致）；
  // 判定类只能在内存里数，上限是 SCAN_LIMIT，由 scanCapped 如实标注。
  const matched = items.length;
  const total = isDecisionFilter
    ? matched
    : comments.countByVideo(awemeId, {
      ...dbFilter,
      search: opts.search,
      excludeUid: needMineFilter ? myUid : null,
    });
  // 截断的判定用**真实总数**比，而不是用"我这次取了多少"比：
  // 取数上限一路（pending 走的是 limit）下 matched 永远 ≤ limit，
  // 于是 truncated 恒为 false，"还有更多"这个事实从来没被说出来过。
  const truncated = total > matched;
  items = items.slice(0, limit);

  // 补回复正文放在截断之后：只为我们真正要返回的那几十/几百条查，
  // 而不是为判定筛选用到的两万条全查一遍
  items = attachReply(items);

  return {
    items,
    total,
    shown: items.length,
    truncated,
    // 取数上限被打满时，上面的 total 也可能偏小 —— 如实标出来，而不是假装完整。
    // 比的是**实际生效**的上限：listByVideo 会把 limit 夹到 MAX_LIMIT，
    // 拿"我要的数"去比就会永远不相等，这个提示因此从来没显示过。
    scanCapped: needsMemoryFilter && rows.length >= comments.clampLimit(SCAN_LIMIT),
    // 「优先级」这一排序靠 analyze 写回的 priority 列。没跑过分析时它全是 NULL，
    // 而 ORDER 里是 COALESCE(priority, 0) —— 每一档都相等，顺序**悄悄**退化成
    // "点赞最多 + 最新"。界面靠这个标志决定要不要说出这件事。
    priorityReady: rows.some(r => r.priority != null),
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
    cid: c.cid, uid: c.uid, text: c.text, replied: c.replied, isSticker: c.isSticker,
  }]);
  const withReply = attachReply([{
    cid: c.cid, replyCid: c.replyCid,
  }])[0];
  const myUid = videoMyUid(c.awemeId);
  return {
    replyText: withReply.replyText,
    isMine: myUid != null && String(c.uid) === String(myUid),
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
 * @param {number} [opts.scanLimit] - 判定统计的取数上限（默认 SCAN_LIMIT，即 listByVideo 的硬上限）
 */
function videoStats(awemeId, opts = {}) {
  const scanLimit = opts.scanLimit || SCAN_LIMIT;
  // 与 listByVideo 实际夹到的那个数比，不是与我们请求的数比
  const effectiveLimit = comments.clampLimit(scanLimit);
  // 取全部评论跑判定：待回复的计数要排除"我自己的评论"，而那需要 myUid，
  // 所以不能只按 replied=0 取数 —— 我发的评论 replied 也是 0。
  const rows = comments.listByVideo(awemeId, { limit: scanLimit, order: 'newest' });
  const myUid = videoMyUid(awemeId, opts.accountUid);
  const decisions = decideAll(rows, { myUid });
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
    scanCapped: rows.length >= effectiveLimit,
  };
}

/**
 * 草稿箱（附视频标题，省得界面再去查）。
 *
 * 注意 drafts.list() 返回的是**原始数据库行**（下划线字段名），
 * 与 memory 层其他模块返回驼峰对象不同。这里统一转成驼峰再交给界面，
 * 免得界面到处混用两种命名。
 *
 * 返回 `{ items, total, matched, truncated, q }` 而不是裸数组：drafts.list 会把 limit
 * 夹到 MAX_LIMIT，只返数组的话第 201 条草稿既看不到也不提示，而界面的"共 N 条"
 * 会拿列表长度当真实总数（作品列表改造前正是这个 bug）。
 *
 * @param {object} [opts]
 * @param {string} [opts.q] - 关键词，命中草稿正文 / 视频标题 / 被回复的评论原文
 * @param {string} [opts.accountUid] - 当前账号（缺省时不隔离，见 resolveActor）
 */
function listDrafts(opts = {}) {
  const actor = resolveActor(opts);
  const limit = drafts.clampLimit(opts.limit || drafts.MAX_LIMIT);
  const q = typeof opts.q === 'string' ? opts.q.trim() : '';
  // 草稿也要按账号隔离：一条草稿是"以某个号的身份回某条评论"，
  // 换号后它必须消失，否则 B 号会把 A 号准备的回复发出去（且以 B 的登录状态发）
  const rows = drafts.list({ posted: false, limit, accountUid: actor.scopedUid, q });
  const titles = new Map();

  // 草稿是"回复某条评论"的，但列表与发布确认框此前都只显示一句"回复评论" ——
  // 用户看不出它到底回的是谁、针对什么内容，只能凭草稿正文猜。
  // 被回复评论的原文一次性查回来（每条草稿一次 get 的话，200 条就是 200 次查询）。
  const targetMap = comments.getMany(rows.map(r => r.reply_to_cid).filter(Boolean));

  // 人格 id → 中文名。effectivePersonas() 每次都要读配置并重建数组，
  // 所以按整箱只解析一次，而不是每行查一遍。
  const personaNames = new Map();
  const personaName = (id) => {
    if (!id) return null;
    if (!personaNames.has(id)) {
      const p = require('../personas').findPersona(id);
      personaNames.set(id, (p && p.name) || null);
    }
    return personaNames.get(id);
  };

  const items = rows.map(r => {
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
      // 解析不到时为 null（自定义人格被删掉过），界面据此退回显示原始 id
      personaName: personaName(r.persona_id),
      // 图片回复的本地路径。发布时必须一并带上，否则草稿箱里存的图会被静默丢掉
      imagePath: r.image_path || null,
      createdAt: r.created_at,
      posted: !!r.posted,
    };
  });

  // count 而不是拿 items.length 当总数：界面上那句"共 N 条"必须是真实条数。
  // 两个数都要给，因为它们是两件事：
  //   matched —— 当前搜索条件命中多少条（不带 q 时等于 total）
  //   total   —— 草稿箱里到底还有多少条待发布（侧栏角标用它；否则搜一个词
  //              角标就变成"3 条"，而那是搜索结果数，不是箱子的量）
  const matched = drafts.count({ posted: false, accountUid: actor.scopedUid, q });
  const total = q
    ? drafts.count({ posted: false, accountUid: actor.scopedUid })
    : matched;
  // 按账号过滤时，account_uid 为 NULL 的草稿不会出现在上面这个集合里
  // （无法判断归属的草稿不该被当成自己的发出去）。它们必须被说出来，
  // 否则就是"生成明明成功了但草稿箱空空如也"。
  // 不与 accountUid 一起传：两个条件相加恒为 0。
  const unattributed = actor.scopedUid
    ? drafts.count({ posted: false, unattributed: true })
    : 0;
  return {
    items, total, matched, unattributed,
    truncated: matched > items.length,
    q,
    accountUid: actor.uid,
    accountCertain: actor.certain,
  };
}

/**
 * 一批视频在本地库里的状态 —— 「找视频」页用它区分「已收录」与「可加入」。
 *
 * 为什么不让界面逐个查 `videos.get`：搜索结果一页 20 条，逐个 IPC 就是 20 次
 * 往返；而且这里要的是一张薄表，不是完整详情。
 *
 * @param {string[]} awemeIds
 * @param {object} [opts]
 * @param {string} [opts.accountUid] - 当前账号
 */
function targetStatus(awemeIds, opts = {}) {
  const ids = [...new Set((awemeIds || []).filter(Boolean).map(String))];
  const blank = {
    inLibrary: false, isMine: false, mineOfCurrent: false, title: null,
    coverUrl: null, commentCount: 0, pending: 0, lastGetTs: null,
  };
  const out = {};
  for (const id of ids) out[id] = { ...blank };
  if (ids.length === 0) return out;
  try {
    const actor = resolveActor(opts);
    const statMap = comments.statsForVideos(ids, { excludeUid: actor.uid });
    for (const id of ids) {
      const v = videos.get(id);
      const st = statMap.get(id);
      out[id] = {
        ...blank,
        inLibrary: !!v,
        isMine: !!(v && v.isMine),
        // 这个视频是不是**当前账号**在运营的（归属账号或 ops_uid 对得上）
        mineOfCurrent: !!(v && actor.scopedUid
          && ((v.isMine && String(v.authorUid) === String(actor.scopedUid))
            || String(v.opsUid || '') === String(actor.scopedUid))),
        title: v ? v.title : null,
        coverUrl: v ? v.coverUrl : null,
        commentCount: st ? st.total : 0,
        pending: st ? st.pending : 0,
        lastGetTs: v ? v.lastGetTs : null,
      };
    }
  } catch (e) { /* 查不到就保持"都不在库里"，界面据此显示"可加入" */ }
  return out;
}

/**
 * 查重：这段文本以前发过没有。
 *
 * 走这里而不是 `dedup` 命令：命令要占串行队列、要等读间隔，而这件事只是
 * 查一次本地语料库（`corpus.findByText` 是一次带唯一索引的查询）。写回复时
 * 想确认"这句没发过"是即时动作，让用户为它等 30 秒是错的。
 * 命令本身留着 —— 脚本与 CLI 仍然用它。
 *
 * @param {string} text
 * @returns {{duplicate:boolean, text:string, error?:string, match:null|object}}
 */
function checkDuplicate(text) {
  const t = text == null ? '' : String(text);
  if (!t.trim()) return { duplicate: false, text: t, match: null };
  try {
    const m = corpus.findByText(t);
    if (!m) return { duplicate: false, text: t, match: null };
    const v = m.awemeId ? videos.get(String(m.awemeId)) : null;
    return {
      duplicate: true,
      text: t,
      match: {
        replyText: m.replyText || null,
        postedAt: douyinTimeToMs(m.postedAt),
        awemeId: m.awemeId || null,
        awemeTitle: v ? v.title : null,
        outcome: m.outcome || null,
      },
    };
  } catch (e) {
    // 查重失败**不能**报成"没发过" —— 那会让人放心地发一句重复的。
    // 带上 error，界面据此说"这次没查成"。
    return { duplicate: false, text: t, match: null, error: '本地语料库读取失败，这次没有查成' };
  }
}

/**
 * 最近的事件（诊断页的「操作历史」）。
 *
 * 走 data 视图而不是 `events` 命令：命令要占串行队列、等读间隔，而这只读
 * 本地表。命令本身留着（CLI 与脚本在用，且它是唯一能按 status/uid 细筛的入口）。
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {string} [opts.command] - 只看某个命令
 * @param {'success'|'error'} [opts.status]
 */
function listEvents(opts = {}) {
  try {
    const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 200));
    return events.query(
      { command: opts.command || undefined, status: opts.status || undefined },
      { limit, order: 'desc' }
    ).map(e => ({
      id: e.id,
      ts: e.ts,
      command: e.command,
      status: e.status,
      durationMs: e.durationMs,
      awemeId: e.awemeId,
      uid: e.uid,
      error: e.error || null,
    }));
  } catch (e) {
    return [];
  }
}

/**
 * 最近搜过的关键词（找视频页的空态用）。
 *
 * 为什么从 events 表来，而不是内置一组"推荐词"：这一页缺的不是点子，是入口。
 * 内置的词是这个工具的作者想象中的领域 —— 对用它卖水果的人是噪音，而噪音会被
 * 摆在空态最显眼的位置。events 里那一行是真的：`search` 命令每次跑成都写一行，
 * `args.keyword` 就是当时搜的那句（见 core/commands/search.js）。
 * 所以这里给的是「你上次搜过的那些，再来一遍」，一句可核对的话。
 *
 * 只把 status='success' 的那几次摆成关键词：失败的那一次没有返回结果，
 * "你搜过 X"虽然仍成立，但把失败摆在建议位上等于让人重复一次注定没结果的操作。
 * ⚠️ 但**查询本身不按 status 过滤** —— 翻了 N 条里没有一条成功，与"根本没有搜索记录"
 * 是两种处境，界面要分开说。过滤写在查询里会让前一种永远拿不到 scanned，
 * 于是空态只能对着它说"还没有搜索记录"，那是句假话。
 *
 * 扫描上限是必须的：events 是唯一一张**只增不减**的表（cleanup 按 TTL 清），
 * 而这里要的是"最近"。`scanned` 与 `truncated` 一起返回 —— 空态里那句
 * "只在这些记录里找过"必须说得出，否则"没有搜索历史"就成了假话
 * （被清理过的库、以及搜了很多次但都不是同一批词，都藏在这个数后面）。
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=8]   - 最多给几个关键词
 * @param {number} [opts.scan=400]  - 最多读多少行事件
 * @returns {{items: Array<{keyword:string,times:number,lastTs:number,
 *   lastCount:number|null}>, scanned: number, truncated: boolean}}
 *   scanned = 翻到的 search 事件条数（**含失败的**）
 */
function searchHistory(opts = {}) {
  const want = Math.max(1, Math.min(Number(opts.limit) || 8, 20));
  const scan = Math.max(1, Math.min(Number(opts.scan) || 400, 2000));
  // query() 而不是 queryStrict()：这是"少显示几条也无所谓"的读者。
  // 这里的读失败只会让空态变成"没找到历史"，而它本来就允许为空。
  const rows = events.query({ command: 'search' }, { limit: scan, order: 'desc' });
  const byKw = new Map();
  for (const e of rows) {
    if (e.status !== 'success') continue;
    const kw = e.args && typeof e.args.keyword === 'string' ? e.args.keyword.trim() : '';
    if (!kw) continue;
    const hit = byKw.get(kw);
    if (hit) {
      hit.times += 1;   // desc 顺序，第一条就是最近的那次，lastTs / lastCount 不再覆盖
    } else {
      byKw.set(kw, { keyword: kw, times: 1, lastTs: e.ts, lastCount: (e.summary || {}).count ?? null });
    }
  }
  const items = [...byKw.values()].slice(0, want);
  return { items, scanned: rows.length, truncated: rows.length >= scan };
}

/**
 * 清理**预演**：按 TTL 算一下"会删掉多少行"，但不删。
 *
 * 诊断页的清理按钮必须先给这个数再让人点确认 —— 一个只说"确定要清理吗？"
 * 的按钮等于让人闭着眼睛按。真正执行的是 `cleanup` 命令（走队列、有审计）。
 *
 * @param {object} [opts]
 * @param {number} [opts.days=90]
 */
function cleanupPreview(opts = {}) {
  const days = Math.max(1, Number(opts.days) || 90);
  const cutoff = Date.now() - days * 86400000;
  const count = (fn) => { try { return fn(); } catch (e) { return null; } };
  return {
    days,
    cutoff,
    events: count(() => events.cleanupBefore(cutoff, { dryRun: true })),
    comments: count(() => comments.cleanupBefore(cutoff, { dryRun: true })),
    corpus: count(() => corpus.cleanupBefore(cutoff, { dryRun: true })),
  };
}

/**
 * 用户详情（`whois` 命令的视图版）。
 *
 * 为什么放这里而不是直接调命令：它与 listComments / listTargets 是同一类东西
 * —— 读本地 SQLite。走队列会让"点开一个用户"等上读间隔。
 *
 * 与 `whois` 命令的两点差异，都是刻意的：
 *   1. **真实总数用 count()**，不是列表长度。命令那边把 `listByUid(limit:500)`
 *      的长度当"该用户共评论 N 条" —— 超过 500 条时会少报，而没有任何提示。
 *   2. 补上 `truncated`：界面据此说"还有更多"，而不是假装这就是全部。
 *
 * @param {string} uid
 * @param {object} [opts]
 * @param {number} [opts.limit=100]
 */
function userProfile(uid, opts = {}) {
  const id = uid == null ? '' : String(uid);
  if (!id) return null;
  const limit = Math.max(1, Math.min(Number(opts.limit) || 100, 500));
  const user = users.get(id);
  const total = comments.count({ uid: id });
  const rows = comments.listByUid(id, { limit });

  // 「我回过他哪几条」：被他评论过、且我们回过的行，其 reply_cid 指向我们发的那条
  const repliedRows = rows.filter(r => r.replied && r.replyCid);
  const myReplyMap = repliedRows.length
    ? comments.getMany(repliedRows.map(r => r.replyCid))
    : new Map();

  const titleOf = (awemeId) => {
    try { const v = videos.get(awemeId); return v ? v.title : null; } catch (e) { return null; }
  };

  const commentItems = rows.map(r => ({
    cid: r.cid,
    awemeId: r.awemeId,
    videoTitle: titleOf(r.awemeId),
    text: r.text,
    digg: r.digg || 0,
    createdAt: douyinTimeToMs(r.createdAt),
    sentiment: r.sentiment || null,
    priority: r.priority || null,
    replied: !!r.replied,
    myReply: r.replyCid
      ? ((myReplyMap.get(String(r.replyCid)) || {}).text || null)
      : null,
  }));

  return {
    uid: id,
    found: !!user,
    profile: user ? {
      nickname: user.nickname || null,
      secUid: user.secUid || null,
      firstSeen: user.firstSeen || null,
      lastSeen: user.lastSeen || null,
      commentCount: user.commentCount || 0,
      replyCount: user.replyCount || 0,
      tier: user.tier || null,
      tags: user.tags || [],
      notes: user.notes || null,
    } : null,
    totalComments: total,
    shownComments: commentItems.length,
    truncated: total > commentItems.length,
    repliedCount: commentItems.filter(c => c.replied).length,
    pendingCount: commentItems.filter(c => !c.replied).length,
    comments: commentItems,
  };
}

/** 某个用户相关的事件（用户详情页的「交互历史」） */
function userEvents(uid, opts = {}) {
  const id = uid == null ? '' : String(uid);
  if (!id) return [];
  try {
    const limit = Math.max(1, Math.min(Number(opts.limit) || 30, 200));
    return events.query({ uid: id }, { limit, order: 'desc' }).map(e => ({
      id: e.id,
      ts: e.ts,
      command: e.command,
      status: e.status,
      durationMs: e.durationMs,
      error: e.error || null,
    }));
  } catch (e) {
    return [];
  }
}

/**
 * 总览数字（今日页与诊断用）。
 *
 * @param {object} [opts]
 * @param {'all'|'mine'} [opts.scope='all'] - 统计范围。
 *   **默认 all**：本工具的实际工作面包括别人视频下的评论区（见 listTargets），
 *   只算自己的作品会把 96% 的评论排除在外。
 */
function overview(opts = {}) {
  const scope = normScope(opts.scope);
  const actor = resolveActor(opts);
  const all = videos.list(scope === 'mine'
    // 指定了账号就只算**这个号**的作品；拿不到账号时退回旧的全局口径，
    // 并由 accountCertain 标出来让界面提示
    ? { isMine: true, limit: 10000, accountUid: actor.scopedUid }
    : { limit: 10000 });
  // 用 statsForVideo 逐视频算，而不是 count() 相减：
  // count() 不排"我自己发的评论"，于是待回复会把我们发出去的回复也算进去，
  // 与作品列表、工作台两个页面的口径都不一致（同一份数据在三处显示三个数）。
  let total = 0;
  let replied = 0;
  let mine = 0;
  for (const v of all) {
    // 只有我自己的作品，其 author_uid 才是我（见 videoMyUid 的注释）；
    // 别人的视频用当前账号
    const excludeUid = (v.isMine && v.authorUid) ? String(v.authorUid) : actor.uid;
    const s = comments.statsForVideo(v.awemeId, { excludeUid });
    total += s.total;
    replied += s.replied;
    mine += s.mine;
  }
  return {
    scope,
    accountUid: actor.uid,
    accountCertain: actor.certain,
    videos: all.length,
    comments: total,
    replied,
    mine,
    pending: Math.max(0, total - replied - mine),
    drafts: drafts.count({ posted: false }),
    users: users.count(),
  };
}

/**
 * 统计范围归一化。"mine" 之外的一切（含 undefined）都算 "all" ——
 * 默认必须是全量，理由见 overview 的注释。
 */
function normScope(scope) {
  return scope === 'mine' ? 'mine' : 'all';
}

/**
 * 播放增长（需要 schema v12 的 video_stats_history）。
 *
 * 为什么这件事当初答不出来：`videos.play_count` 是单值列，每次刷新被覆盖，
 * 所以"这条视频这周涨了多少"根本没有数据可算。v12 起每次刷新（以及补全信息）
 * 会按天落一行快照，这张卡才有东西可画。
 *
 * 三条口径纪律：
 *
 * 1. **按天求和时必须报出"当天覆盖了几个视频"**。总播放 = 各视频当天读数之和，
 *    而视频的覆盖数是会变的（新补全了一个视频，总和就会跳一下 —— 那是覆盖变化，
 *    不是增长）。所以每天的行里都带 `videos`，界面在覆盖数不恒定时要说明。
 * 2. **只有一天快照的视频给不出增量**（delta 为 null），不能当成 0 ——
 *    0 是"一点没涨"，null 是"没有两次读数可比"。
 * 3. 增量用窗口内**首末两次**读数之差，不是"最新值减窗口开始前的值" ——
 *    后者需要窗口外的数据，而窗口外可能是几个月前。
 *
 * @param {object} opts
 * @param {number} opts.since - 毫秒
 * @param {'all'|'mine'} opts.scope
 * @returns {{daily:Array, perVideo:Array, covered:number, totalDays:number}}
 */
function buildGrowth(opts) {
  const rows = videos.listStatsHistory({ since: opts.since, limit: 50000 });
  if (rows.length === 0) return { daily: [], perVideo: [], covered: 0, totalDays: 0 };

  // scope=mine 时按归属过滤。快照表里没有 is_mine，所以回查一次 videos
  let allowed = null;
  if (opts.scope === 'mine') {
    allowed = new Set(videos.list({ isMine: true, limit: 10000, accountUid: opts.scopedUid })
      .map(v => String(v.awemeId)));
  }

  const dailyMap = new Map();   // day → { plays, likes, videos }
  const perVideoMap = new Map(); // awemeId → { first, last }
  for (const r of rows) {
    if (allowed && !allowed.has(String(r.awemeId))) continue;
    const d = dailyMap.get(r.day) || { plays: 0, likes: 0, videos: 0 };
    d.plays += r.plays || 0;
    d.likes += r.likes || 0;
    d.videos += 1;
    dailyMap.set(r.day, d);

    const pv = perVideoMap.get(r.awemeId) || {};
    if (!pv.first) pv.first = r;      // rows 已按 day 升序，第一条就是最早的
    pv.last = r;
    perVideoMap.set(r.awemeId, pv);
  }

  const daily = [...dailyMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, v]) => ({ day, plays: v.plays, likes: v.likes, videos: v.videos }));

  // 标题：一次取全再查表，别逐条 videos.get（几十条就是几十次查询）
  const titleMap = new Map(
    videos.list({ limit: 10000 }).map(v => [String(v.awemeId), v.title])
  );

  const perVideo = [...perVideoMap.entries()].map(([awemeId, pv]) => {
    const one = pv.first === pv.last;
    return {
      awemeId,
      title: titleMap.get(String(awemeId)) || null,
      plays: pv.last.plays,
      likes: pv.last.likes,
      // 只有一天快照 → 给不出增量（null，不是 0，见上面的第 2 条）
      playsDelta: one ? null : (pv.last.plays || 0) - (pv.first.plays || 0),
      likesDelta: one ? null : (pv.last.likes || 0) - (pv.first.likes || 0),
      days: one ? 1 : Math.round((pv.last.ts - pv.first.ts) / 86400000) + 1,
      fromDay: pv.first.day,
      toDay: pv.last.day,
    };
  }).sort((a, b) => (b.playsDelta || 0) - (a.playsDelta || 0));

  return { daily, perVideo, covered: perVideo.length, totalDays: daily.length };
}

/** 本地时区 "YYYY-MM-DD"。按天聚合评论用 —— 运营关心的是"哪天互动多" */
function localDay(ms) {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 数据分析页的全量聚合。
 *
 * 一次循环把图表要用的所有原料算好 —— 图表页需要跨"全部作品"的统计，
 * 而现有的 videoStats/listComments 都是单视频口径。逐作品一趟循环里
 * 同时算出：作品对比、每日评论分布、判定分布、高赞评论、活跃用户，
 * 避免每个卡片各扫一遍库。
 *
 * 口径纪律（与作品列表/工作台保持一致）：
 *   - 待回复 = 本地评论 - 已回复 - 我自己发的
 *   - 判定分布对每一行统计（含已回复与我发的），与三个筛选标签页同口径
 *   - 每日分布与高赞/活跃榜只统计**评论者**的原评论：我发出的回复也是
 *     comments 表的一行（uid=myUid），不排掉的话"我回复的那天"会变成互动高峰
 *
 * @returns {object} 各集合可能为空数组（还没拉过数据），界面据此显示空态
 */
function analytics(opts = {}) {
  const scanLimit = opts.scanLimit || SCAN_LIMIT;
  const effectiveLimit = comments.clampLimit(scanLimit);
  // 时间范围（天）。界面上是 7/30/90 三档，但这里不写死 —— 允许任意正整数，
  // 免得调参时还要改 core。上限 365：再多也没有数据，只会让图挤成一根线。
  const dayWindow = Math.max(1, Math.min(Number(opts.dayWindow) || 30, 365));
  const since = Date.now() - dayWindow * 86400000;
  // 默认 all：真实工作面是 208 个别人的视频 / 1850 条评论，
  // 而 is_mine=1 的只有 7 个 / 62 条 —— 只算自己作品的数据页在分析 3% 的业务
  const scope = normScope(opts.scope);

  const actor = resolveActor(opts);
  const myUid = actor.uid;
  const vids = videos.list(
    scope === 'mine'
      ? { isMine: true, limit: 500, order: 'publish', accountUid: actor.scopedUid }
      : { limit: 500, order: 'publish' }
  );

  const totals = { videos: vids.length, plays: 0, likes: 0, apiComments: 0, shares: 0 };
  const videoRows = [];
  const dailyMap = new Map();           // day → { count, replied }
  const decision = { reply: 0, emoji_reply: 0, skip: 0 };
  const userCount = new Map();          // uid → 本地评论条数
  const notableComments = [];           // 评论者的原评论（供高赞榜）
  let localComments = 0;
  let repliedTotal = 0;
  let pendingTotal = 0;
  let scanned = 0;
  let capped = false;
  /** 互动数据真的有值的作品数（分母是 vids.length） */
  let statsWithData = 0;

  const nickOf = (uid) => {
    try { const u = users.get(uid); return (u && u.nickname) || null; } catch (e) { return null; }
  };

  for (const v of vids) {
    const st = v.stats || {};
    // 判空用 != null 而不是 || ：0 次播放是**有数据**，null 才是没拉到过
    if (st.plays != null || st.likes != null || st.comments != null || st.shares != null) statsWithData++;
    totals.plays += st.plays || 0;
    totals.likes += st.likes || 0;
    totals.apiComments += st.comments || 0;
    totals.shares += st.shares || 0;

    const rows = comments.listByVideo(v.awemeId, { limit: scanLimit, order: 'newest' });
    if (rows.length >= effectiveLimit) capped = true;
    scanned += rows.length;
    // 归属账号逐视频判定：A 号的视频里 A 自己的评论才算"我发的"。
    // isMine 必须一起判断 —— 别人视频的 author_uid 是那个视频的作者，
    // 拿它当"我"会把作者的评论算成我发的、从待回复里扣掉（见 videoMyUid）。
    const vMyUid = (v.isMine && v.authorUid) ? String(v.authorUid) : myUid;
    const decisions = decideAll(rows, { myUid: vMyUid });

    let vReplied = 0;
    let vMine = 0;
    for (const r of rows) {
      localComments++;

      const d = decisions.get(r.cid);
      if (d && decision[d.action] !== undefined) decision[d.action]++;

      const isMineRow = vMyUid != null && String(r.uid) === String(vMyUid);
      if (!isMineRow) {
        const ms = douyinTimeToMs(r.createdAt);
        if (ms) {
          const day = localDay(ms);
          const bucket = dailyMap.get(day) || { count: 0, replied: 0 };
          bucket.count++;
          if (r.replied) bucket.replied++;
          dailyMap.set(day, bucket);
        }
        const uidKey = String(r.uid);
        userCount.set(uidKey, (userCount.get(uidKey) || 0) + 1);
        notableComments.push({
          cid: r.cid, uid: uidKey, awemeId: v.awemeId, videoTitle: v.title,
          text: r.text || '', digg: r.digg || 0,
          createdAt: douyinTimeToMs(r.createdAt), replied: !!r.replied,
        });
      }

      if (isMineRow) vMine++;
      else if (r.replied) vReplied++;
    }
    const vPending = Math.max(0, rows.length - vReplied - vMine);
    repliedTotal += vReplied;
    pendingTotal += vPending;

    videoRows.push({
      awemeId: v.awemeId,
      title: v.title || '（无标题）',
      createTime: douyinTimeToMs(v.createTime),
      // 上面四个数把 null 折成了 0，界面上分不出"0 次播放"和"没拉到过"。
      // 所以单给一个布尔：作品对比图只该画真有数据的那些 ——
      // 否则 208 个没有互动数据的视频会以一排 0 长度的条挤进图里。
      hasStats: st.plays != null || st.likes != null || st.comments != null || st.shares != null,
      stats: { plays: st.plays || 0, likes: st.likes || 0, comments: st.comments || 0, shares: st.shares || 0 },
      commentStats: { total: rows.length, replied: vReplied, mine: vMine, pending: vPending },
    });
  }

  // 最近 N 天的时间轴（没有评论的日子补零 —— 图表断一天会让人以为数据丢了）
  //
  // 三个字段是**三种不同的问题**，界面上的措辞必须与它们各自一致：
  //   count   当天进来了多少条评论（评论者写的）
  //   replied 当天进来的评论里，后来被我们回掉了多少（**按评论产生的日期归集**，
  //           不是"我们那天回了多少条"）
  //   sent    我们那天**发出**了多少条回复（产出视角）
  //
  // ⚠️ 不能把 `replied` 叫成"每日已回" —— 它与 `sent` 是两回事，
  // 一个按"评论何时来"归集、一个按"我们何时发"归集，混用会得出
  // "上周回复量 30 条"这种把回复记在评论那天头上的数字。
  const sentMap = comments.dailyReplyCounts({ uid: myUid, since });
  const daily = [];
  const today = new Date();
  for (let i = dayWindow - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = localDay(d.getTime());
    const b = dailyMap.get(key) || { count: 0, replied: 0 };
    daily.push({ day: key, count: b.count, replied: b.replied, sent: sentMap.get(key) || 0 });
  }

  notableComments.sort((a, b) => b.digg - a.digg);
  const topComments = notableComments.slice(0, 8)
    .map((c) => ({ ...c, nickname: nickOf(c.uid) }));

  const topUsers = [...userCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([uid, count]) => ({ uid, count, nickname: nickOf(uid) }));

  // ── 运营成本与效果 ──
  //
  // 这四块**不吃 scope**：LLM 花了多少钱、命令跑了多少趟、失败了几次、
  // 回复之后对方还来不来 —— 这些都是"我干了什么"，与"统计哪些视频"无关。
  // 界面上要放在同一个口径切换下面，所以必须在注释和文案里说清这一点，
  // 否则用户会以为切到「仅我的」时这些数字也该跟着变。
  //
  // 失败模式库按**累计**给，不按时间范围过滤：表里的 hit_count 是累计值，
  // 拿它配一个"最近 7 天"的筛选，会得到"7 天内出现过、但次数是历史累计"
  // 这种两个口径混在一起的数字。
  const llm = llmUsage.stats({ since });
  const llmTotals = llm.reduce((acc, r) => ({
    calls: acc.calls + (r.calls || 0),
    tokens: acc.tokens + (r.total_tokens || 0),
    cost: acc.cost + (r.total_cost || 0),
  }), { calls: 0, tokens: 0, cost: 0 });
  const llmMs = llm.filter(r => r.avg_duration_ms != null);
  const llmAvgMs = llmMs.length
    ? Math.round(llmMs.reduce((s, r) => s + r.avg_duration_ms * (r.calls || 0), 0)
      / Math.max(1, llmMs.reduce((s, r) => s + (r.calls || 0), 0)))
    : null;

  const ops = events.commandStats({ since });

  return {
    scope,
    accountUid: actor.uid,
    accountCertain: actor.certain,
    // 本次统计的时间范围。界面要拿它写清楚"这些数字是哪段时间的" ——
    // 一个不带时间范围的百分比，读者只能自己猜
    range: { dayWindow, since },
    llm: {
      since,
      calls: llmTotals.calls,
      tokens: llmTotals.tokens,
      cost: llmTotals.cost,
      avgMs: llmAvgMs,
      byPurpose: llm.map(r => ({
        purpose: r.purpose || '（未标注）',
        model: r.model || null,
        calls: r.calls || 0,
        tokens: r.total_tokens || 0,
        cost: r.total_cost || 0,
        avgMs: r.avg_duration_ms != null ? Math.round(r.avg_duration_ms) : null,
      })),
    },
    ops: {
      since,
      total: ops.reduce((s, r) => s + r.total, 0),
      errors: ops.reduce((s, r) => s + r.errors, 0),
      byCommand: ops,
    },
    // 累计，不受时间范围影响（见上面的说明）
    failures: failures.top(6),
    replyEffect: comments.replyEffectStats({ since }),
    // 播放增长（schema v12 起才有数据；升级前是空的，界面要能显示"还没有历史"）
    growth: buildGrowth({ since, scope, scopedUid: actor.scopedUid }),
    // 两种范围各有多少个视频。界面上那个「全部 / 仅我的」切换用它标数字，
    // 也让"我们到底在统计什么"可见
    scopeCounts: {
      all: videos.count({}),
      // 「仅我的」在这个账号下有多少个 —— 两个号的数字本来就该不一样
      mine: videos.count({ isMine: true, accountUid: actor.scopedUid }),
    },
    totals: {
      ...totals,
      localComments,
      replied: repliedTotal,
      pending: pendingTotal,
      drafts: drafts.count({ posted: false }),
      scanned,
      capped,
      // 上限本身。界面以前拿 scanned 印在"上限"那句话里，
      // 于是显示的永远是"扫了 62 条"而不是"最多扫 1 万条" —— 一句话两个意思。
      scanLimit: effectiveLimit,
      // 作品数也被 videos.list 的 500 夹过一次。不标出来的话，
      // 有 600 个作品的人看到的"全部作品"其实是前 500 个，且毫无提示。
      videosCapped: (scope === 'mine'
        ? videos.count({ isMine: true, accountUid: actor.scopedUid })
        : videos.count({})) > vids.length,
      // 有多少个作品的互动数据是真的有值。
      // 别人的视频只有评论、没有播放/点赞（互动数据只在「刷新列表」时写，
      // 而那一步只更新我的作品），所以"总播放"这类数字的分母必须说清楚 ——
      // 否则 215 个作品配一个只覆盖 7 个的数字，读起来像全量。
      statsWithData,
    },
    videos: videoRows,
    daily,
    decision,
    topComments,
    topUsers,
  };
}

module.exports = {
  listMyVideos,
  listTargets,
  videoDetail,
  listComments,
  commentDetail,
  videoStats,
  listDrafts,
  overview,
  analytics,
  targetStatus,
  checkDuplicate,
  listEvents,
  searchHistory,
  cleanupPreview,
  userProfile,
  userEvents,
  videoMyUid,
  // 供测试：这两个常量必须始终相等，否则"扫描被截断"的提示又会变成死代码
  SCAN_LIMIT,
  // 供测试
  TARGET_ORDERS,
  TARGET_SCAN_LIMIT,
  _decideAll: decideAll,
  _normScope: normScope,
};
