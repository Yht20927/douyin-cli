// core/memory/accounts.js — 连接过的账号登记表
//
// 账号级数据隔离的"名册"：油猴脚本注册连接时上报登录账号
// （nickname / avatar / uid），这里落库保存。用途：
//   1. 界面把 uid 翻译成人能认的昵称（作品列表上标注"哪个号的内容"）；
//   2. 发布链路把"视频归属账号"与"浏览器当前登录账号"做比对（post.js 守卫）。
//
// 只有**连上来过**的账号才会出现在这张表里 —— 它是"本机见过的账号"，
// 不是"抖音全量账号"。

const { getDb } = require('./db');
const logger = require('../runtime/logger');
const { flattenConnections } = require('../shared/protocol');
const PLATFORM = 'douyin';

/**
 * 登记一个账号（连接注册时调用）。重复连接只更新资料与 last_seen，
 * first_seen 保持不变 —— "第一次见到它"是不可变的事实。
 */
function upsert(account = {}) {
  const uid = account.uid != null ? String(account.uid) : '';
  if (!uid) return null;
  const now = Date.now();
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO accounts (platform, uid, nickname, avatar, sec_uid, first_seen, last_seen)
      VALUES (@platform, @uid, @nickname, @avatar, @secUid, @now, @now)
      ON CONFLICT(platform, uid) DO UPDATE SET
        nickname = COALESCE(excluded.nickname, accounts.nickname),
        avatar = COALESCE(excluded.avatar, accounts.avatar),
        sec_uid = COALESCE(excluded.sec_uid, accounts.sec_uid),
        last_seen = excluded.last_seen
    `).run({
      platform: PLATFORM,
      uid,
      nickname: account.nickname || null,
      avatar: account.avatar || null,
      secUid: account.secUid || null,
      now,
    });
    return uid;
  } catch (e) {
    // 不能静默：这张表是发布链路「视频归属账号 vs 当前登录账号」比对的数据源，
    // 它停止更新的表现是比对读到空名册，而不是任何报错。
    logger.warn(`[accounts] 登记账号失败 uid=${uid}: ${e.message}`);
    return null;
  }
}

function get(uid) {
  if (uid == null || uid === '') return null;
  try {
    const row = getDb().prepare(
      'SELECT uid, nickname, avatar, sec_uid, first_seen, last_seen FROM accounts WHERE platform = ? AND uid = ?'
    ).get(PLATFORM, String(uid));
    if (!row) return null;
    return {
      uid: row.uid,
      nickname: row.nickname || null,
      avatar: row.avatar || null,
      secUid: row.sec_uid || null,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
    };
  } catch (e) {
    return null;
  }
}

/** 昵称的便捷读取（界面标注用）。没有登记过返回 null。 */
function nicknameOf(uid) {
  const a = get(uid);
  return a ? a.nickname : null;
}

function list() {
  try {
    return getDb().prepare(
      'SELECT uid, nickname, avatar, sec_uid, first_seen, last_seen FROM accounts WHERE platform = ? ORDER BY last_seen DESC'
    ).all(PLATFORM).map(row => ({
      uid: row.uid,
      nickname: row.nickname || null,
      avatar: row.avatar || null,
      secUid: row.sec_uid || null,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
    }));
  } catch (e) {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// 当前账号
//
// 这个应用里几乎所有"我"的判断都依赖它：我的作品是哪些、哪条评论是我发的、
// 待回复该排掉谁的、发布是以谁的身份。改造前这些全部落到
// `videos.myUid()` —— 一个"is_mine 里 author_uid 出现最多的那个"的**全局猜测**：
// 两个号各有作品时静默挑一个，另一个号发的评论被判成路人；而「我的作品」
// 列表更是把两个号的作品混在一起（它只按 is_mine 过滤，从不按账号）。
//
// 解析顺序（`resolveCurrent`）：
//   1. `ctx.accountUid` —— 调用方显式指定的（GUI 注入它刚轮询到的账号）
//   2. **桥接页面上唯一登录的账号** —— 这是"自动跟随"：你在浏览器里换了号，
//      下一次操作就跟着换。这一条是主路径
//   3. accounts 表里用户选定的（is_current）—— 只在多开（多个号同时在线）时
//      才需要人工指定，且必须仍在在线列表里，否则视为过期
//   4. null —— 拿不到就返回 null，让调用方**跳过**相关判断，
//      而不是随便挑一个号假装是我
// ═══════════════════════════════════════════════════════════

/** 最近一次解析出的执行账号。声明放在使用点之前，别让读者以为它有 TDZ 风险 */
let _lastExecutor = null;

/** 用户选定的账号 uid（没选过返回 null） */
function currentUid() {
  try {
    const row = getDb().prepare(
      'SELECT uid FROM accounts WHERE platform = ? AND is_current = 1 LIMIT 1'
    ).get(PLATFORM);
    return row ? String(row.uid) : null;
  } catch (e) {
    return null;
  }
}

/**
 * 选定当前账号（多开时用）。传 null 清除选择，回到"自动跟随唯一在线账号"。
 * 全表先清再置一行 —— 用唯一索引保证"只能有一个"也行，但那样清除时要额外处理。
 */
function setCurrent(uid) {
  try {
    const db = getDb();
    db.prepare('UPDATE accounts SET is_current = 0 WHERE platform = ?').run(PLATFORM);
    if (uid == null || uid === '') return true;
    const info = db.prepare(
      'UPDATE accounts SET is_current = 1 WHERE platform = ? AND uid = ?'
    ).run(PLATFORM, String(uid));
    // 选一个名册里没有的号是调用方的错，如实返回 false，而不是静默什么都没发生
    return info.changes > 0;
  } catch (e) {
    return false;
  }
}

/**
 * 从桥接状态里取出"在线且认得账号"的那些 uid。
 *
 * 只取 `alive` 的连接：断开的页面还留着最后上报的账号，那是历史而不是现状，
 * 拿它当"当前账号"会让界面显示一个已经关掉的页面所属的账号。
 *
 * 形状不假设：`status.connections` 可能是服务端 `/api/status` 原样的"按 site 分组
 * 的对象"，也可能是主进程快照里的数组 —— 交给 `flattenConnections` 一处判定。
 * 这里曾经直接 `for…of` 遍历，遇到对象抛 TypeError，被调用方的 catch 吞掉，
 * 结果"自动跟随在线账号"在 CLI 侧永远不成立（界面却一切正常，因为主进程摊平过）。
 *
 * @param {object} status - bridge.getStatus() 或 BridgeClient.status() 的返回
 * @returns {string[]} 去重后的 uid，按连接顺序
 */
function aliveUids(status) {
  const out = [];
  for (const c of flattenConnections(status)) {
    if (!c || c.alive === false) continue;
    const uid = c.account && c.account.uid != null ? String(c.account.uid) : null;
    if (uid && !out.includes(uid)) out.push(uid);
  }
  return out;
}

/**
 * 解析"本次操作以哪个账号的身份"。
 *
 * @param {object} [ctx] - 命令上下文（有 bridge 才能自动跟随）
 * @param {object} [opts]
 * @param {string} [opts.accountUid] - 显式指定，优先级最高
 * @returns {Promise<{uid:string|null, source:string, candidates:string[]}>}
 *   source: 'explicit' | 'bridge' | 'picked' | 'stored' | 'none'
 *   candidates: 在线账号（界面据此决定要不要显示切换器）
 */
async function resolveCurrent(ctx, opts = {}) {
  const explicit = (opts.accountUid != null && opts.accountUid !== '')
    ? String(opts.accountUid)
    : (ctx && ctx.accountUid != null && ctx.accountUid !== '' ? String(ctx.accountUid) : null);

  const stored = currentUid();

  let online = [];
  if (ctx && ctx.bridge && typeof ctx.bridge.status === 'function') {
    let status = null;
    try {
      status = await ctx.bridge.status();
    } catch (e) {
      // 桥接不可用（服务没起/网络问题）不是错误 —— 退回持久化的选择，
      // 让"看本地数据"这类只读操作照常可用。但要说一声：以前这里连
      // `aliveUids` 抛出的 TypeError 一起吞了，于是"跟随在线账号"永远不生效
      // 而没有任何痕迹（见 aliveUids 的注释）。
      logger.warn(`[accounts] 取桥接状态失败，退回持久化选择: ${e.message}`);
    }
    // 形状解析刻意放在 try 外面：它出错是代码 bug，不是"桥接没起"
    if (status) online = aliveUids(status);
  }

  if (explicit) return { uid: explicit, source: 'explicit', candidates: online };
  // 只有一个号在线 —— 自动跟随，这正是"在浏览器里换号之后数据要跟着变"
  if (online.length === 1) return { uid: online[0], source: 'bridge', candidates: online };
  // 多开：用用户选过的那个，但必须还在线（否则那个页面已经被关了）
  if (online.length > 1) {
    if (stored && online.includes(stored)) return { uid: stored, source: 'picked', candidates: online };
    return { uid: online[0], source: 'bridge', candidates: online };
  }
  // 没有任何在线连接（CLI 场景 / 页面关掉了）：退回持久化选择
  if (stored) return { uid: stored, source: 'stored', candidates: online };
  return { uid: null, source: 'none', candidates: online };
}

/**
 * 本次**实际执行**的账号 —— 以浏览器登录的为准，不受"我在看哪个号"影响。
 *
 * 与 `resolveCurrent` 的分工：
 *   resolveCurrent  —— 界面用。"我现在在看哪个号的数据"，允许被显式选择覆盖。
 *   resolveExecutor —— 命令用。"这次请求会以谁的身份发出去"，只能看浏览器。
 *
 * 两者必须分开，因为它们回答的是两个问题。读操作（拉评论）按执行者归属才对
 * （是它真的去拉了那些数据）；写操作（发回复）则要求两者一致 —— 不一致时
 * 界面显示的是 A 的作品，实际会以 B 的身份发出去。
 *
 * @param {object} ctx
 * @returns {Promise<{uid:string|null, candidates:string[]}>}
 */
async function resolveExecutor(ctx) {
  const r = await resolveCurrent({ bridge: ctx && ctx.bridge }, {});
  // 顺手记一份。"谁在执行"这件事在**同步**代码里也要用（比如 policy 的判定树
  // 拿不到 ctx），而那里没法 await。这个应用是单用户 + 串行队列，
  // 最近一次解析出的执行者就是当下的事实 —— 比原来那个"作品数最多的号"
  // 的全局猜测准得多。
  if (r.uid) _lastExecutor = String(r.uid);
  return r;
}

/** 最近一次解析出的执行账号（同步读；没解析过返回 null） */
function lastExecutorUid() {
  return _lastExecutor;
}

/**
 * 写操作前的守卫：确认"要操作的数据属于谁"与"浏览器当前登录的是谁"一致。
 *
 * 三种结果：
 *   ok      —— 一致，或者浏览器那边查不到账号（此时命令本身也会失败，不在这里拦）
 *   mismatch—— 浏览器登录的是别的号 → **必须拦下**，否则会以错误的号发出去
 *   unclear —— 两个以上账号同时在线，无法确定这次会落到哪个页面
 *
 * @returns {{ok:boolean, reason?:string, expected:string|null, actual:string|null, candidates:string[]}}
 */
async function checkWriteAccount(ctx, expectedUid) {
  const r = await resolveExecutor(ctx);
  const actual = r.uid;
  const candidates = r.candidates || [];

  // 浏览器侧拿不到账号（没连上 / 旧版脚本）—— 不在这里拦：
  // 命令随后会因为发不出去而失败，报"没连上"比报"账号不一致"更准确
  if (!actual) return { ok: true, expected: expectedUid || null, actual: null, candidates };

  if (expectedUid && String(expectedUid) !== String(actual)) {
    return {
      ok: false,
      reason: 'mismatch',
      expected: String(expectedUid),
      actual: String(actual),
      candidates,
    };
  }
  if (candidates.length > 1) {
    // 多个号同时在线：registry 取的是"第一个活着的连接"，我们无法保证
    // 它就是这个账号的页面 —— 与其赌一把，不如让用户先只留一个页面
    return { ok: false, reason: 'unclear', expected: expectedUid || null, actual: String(actual), candidates };
  }
  return { ok: true, expected: expectedUid || null, actual: String(actual), candidates };
}

module.exports = {
  upsert, get, nicknameOf, list,
  currentUid, setCurrent, aliveUids, resolveCurrent, resolveExecutor, checkWriteAccount,
  lastExecutorUid,
};
