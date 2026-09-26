// core/policy/index.js — 运营规则的代码强制
//
// 这个模块存在的全部理由
// ----------------------
// 改造前有十几条硬性红线只写在 md 里 —— 每日 ≤3 轮 ≤30 条、
// 单轮 ≤10 条后强制冷却 3-5 分钟、同一 cid 一生只回一次、超 2 轮风控概率显著上升、
// 命中风控码停写 30 分钟……改造前**这些没有一条写在代码里**。
// risk-control.js 的注释自己都承认过："过去间隔只写在 7 份 .md 里，
// 且漂移出 40-55s / 45-180s / 60s 三套数字"。
//
// 现在这些规则在这里落地，并且：
//   - 计数从 events 表派生 → 跨进程、跨重启都成立，不依赖内存状态
//   - 违规时返回**可读的原因**，界面直接展示，不必再维护一份文案
//   - 命令入口也会调用（见 assertWritable），裸调 `node cli.js post` 同样跳不掉
//   - 每条规则的**生效状态**是明确的（硬强制 / 只提示，见 运营规则说明.md §1）：
//     轮次上限 `dailyRounds` 只提示、不管量；真正管量的是 `dailyWriteQuota`
//     与触顶冷却。别把"提示"当成闸门，也别指望"闸门"会提示。
//
// 会话内状态（连续跳过次数）不持久化，因为它描述的是"当前这一轮正在做什么"，
// 进程重启后本来就该重新计。

const config = require('../config');
const logger = require('../runtime/logger');
const riskControl = require('../risk-control');
const filters = require('./filters');
const { summarizeRounds } = require('./rounds');

// 注意：events / comments / users 一律**在调用时** require，不在模块顶层捕获。
// 顶层 require 会把模块加载那一刻的实例永久钉住 —— 测试切换数据目录（清缓存重建）
// 后，这里仍指向旧库，表现为"明明写了记录却统计为 0"。
// 同类问题在 run-command 的命令注册表上也踩过一次。
function eventsModule() { return require('../memory/events'); }
// 发布前要查的三类对象。都在调用时才 require —— 这些模块会碰数据库，
// 顶层 require 会把实例钉死在旧的 dataDir 上（见开发进度.md 的陷阱 2.4）。
function commentsModule() { return require('../memory/comments'); }
function usersModule() { return require('../memory/users'); }
function corpusModule() { return require('../memory/corpus'); }
// 写操作的账号归属要查它（见 scopeByAccount）—— 同样必须延迟 require
function videosModule() { return require('../memory/videos'); }

/**
 * 毫秒时间戳 → "35 分钟" / "3 天"这样的短语，用于拦截理由里指代"什么时候"。
 *
 * 纯文案函数：运营规则只返回可读原因（见文件头"违规时返回可读的原因"），
 * 而直接把 `posted_at` 那个 13 位数字端上界面，等于让运营者自己心算日期。
 */
function agoWords(ts) {
  const ms = Number(ts);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/**
 * 写操作命令族（口径必须与 core/risk-control 的同名集合一致 ——
 * 那一份管节奏间隔，这一份管配额与"要不要排轮次"，两边漏一个就是
 * "间隔看不见、配额也看不见"）
 *
 * 私信在这里占**两个**名字，因为这个列表同时被用在两件事上：
 *   - `'dm'`      —— 命令注册表里的名字，`isWriteCommand('dm')` 靠它。
 *                    缺它的后果：桌面队列不给私信排轮次、界面上不显示倒计时、
 *                    也不补 --no-throttle，等待全部跑到命令内部去。
 *   - `'dm.send'` —— events 表里的名字（审计操作名带点）。
 *                    缺它的后果：`writesToday` 数不到私信，
 *                    "当日 30 条写操作"对私信等于不存在（实测确实如此）。
 */
const WRITE_COMMANDS = ['post', 'like', 'unlike', 'delete_comment', 'dm', 'dm.send'];

/**
 * "这个命令算不算写操作"。
 *
 * ⚠️ 存在的理由：命令注册表里叫 `delete-comment`（连字符，命令行风格），
 * 而 events 表里记的是 `delete_comment`（下划线，与 core/audit.js 的约定一致）。
 * 两套拼写并存，于是 `WRITE_COMMANDS.includes(task.command)` 对删除**恒为 false**
 * —— 队列不会给删除排轮次、也不会补 --no-throttle，删除的等待跑到命令内部去了，
 * 与其他写操作**不再协调**（两个写操作可能几乎同时发出去）。
 * 这类"名字差一个字符、判定恒为假"的毛病在这个项目里出现过好几次，
 * 所以这里统一成一处归一化，而不是在各调用点各写一遍 `includes(a) || includes(b)`。
 *
 * @param {string} name
 * @returns {boolean}
 */
function isWriteCommand(name) {
  if (!name) return false;
  const normalized = String(name).replace(/-/g, '_');
  return WRITE_COMMANDS.includes(normalized);
}
/** 真正算作"回复"的写命令。maxPerVideoPerRound / maxPerUidPerRound 只数这些 */
const REPLY_COMMANDS = ['post'];

/** 一次统计最多取多少行 —— 今日写操作不可能超过这个量级 */
const MAX_ROWS = 5000;

/**
 * 创建策略引擎。
 *
 * @param {object} [opts]
 * @param {Function} [opts.now]      - 时间源（测试注入）
 * @param {Function} [opts.isReplied]- (cid)=>boolean，缺省查 comments 表
 * @param {Function} [opts.userTier] - (uid)=>string|null，缺省查 users 表
 */
function createPolicyEngine(opts = {}) {
  const now = opts.now || (() => Date.now());

  // ── 会话内状态 ──
  /** 连续多少条评论被判为"不回复"。达到阈值应停止本轮，避免无意义空转 */
  let consecutiveSkips = 0;

  // ── 默认的库查询（延迟 require，避免测试环境无 DB 时加载失败）──
  const isReplied = opts.isReplied || ((cid) => {
    if (!cid) return false;
    try {
      const comments = require('../memory/comments');
      const c = comments.get(String(cid));
      return !!(c && c.replied);
    } catch (e) {
      logger.debug('[policy] isReplied 查询失败: ' + e.message);
      return false;
    }
  });

  const userTier = opts.userTier || ((uid) => {
    if (!uid) return null;
    try {
      const users = require('../memory/users');
      const u = users.get(String(uid));
      return (u && u.tier) || null;
    } catch (e) {
      logger.debug('[policy] userTier 查询失败: ' + e.message);
      return null;
    }
  });

  /** 今日零点（本地时区） */
  function todayStart() {
    const d = new Date(now());
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  /**
   * 读写操作时间线。
   *
   * ⚠️ 读不到时**抛出**，不返回 []。
   * 原先这里 catch 成 []，于是"数据库坏了"与"今天一条都没发"得出同一个结果 ——
   * beforeWrite 据此判定配额全空、enforceDelay 判定距上次写 0 秒，整套限流静默失效。
   * 降级成 [] 在这个模块里是**危险方向**，所以留给调用方显式决定（见 queryWritesSafe）。
   *
   * @param {object} [o]
   * @param {number} [o.since]  - 起始时间戳
   * @param {'success'|'error'} [o.status]
   * @param {string} [o.uid]
   * @param {string} [o.awemeId]
   * @returns {Array<{ts:number}>}
   */
  function queryWrites(o = {}) {
    const f = { commands: o.commands || WRITE_COMMANDS, platform: 'douyin' };
    if (o.since !== undefined) f.since = o.since;
    if (o.status) f.status = o.status;
    if (o.uid) f.uid = String(o.uid);
    if (o.awemeId) f.awemeId = String(o.awemeId);
    return eventsModule().queryStrict(f, { limit: MAX_ROWS, order: 'asc' });
  }

  /**
   * queryWrites 的安全版：把"读不到"如实报成 failed=true，交调用方决定拦还是放。
   * rows 恒为数组，failed 时**不得**拿它的长度当配额依据。
   */
  function queryWritesSafe(o = {}) {
    try {
      return { rows: queryWrites(o), failed: false };
    } catch (e) {
      logger.warn('[policy] 读不到写操作记录: ' + e.message);
      return { rows: [], failed: true };
    }
  }

  function p() { return config.get('policy'); }

  // ═══════════════════════════════════════════════════════════
  // 统计
  // ═══════════════════════════════════════════════════════════

  /**
   * 一笔写操作是**哪个执行账号**做的。
   *
   * ⚠️ **不能看 `events.uid`** —— 那个字段装的是**被回复的评论者**
   * （`core/commands/post.js` 把 targetUid 传进 audit，`core/audit.js` 原样落进
   * `events.uid`；「同一用户每轮 ≤1 条」正是靠它）。拿它跟执行账号比，
   * 结果恒为"不相等"→ 你自己回复的每一条都不计入配额，只剩点赞/删除那些
   * uid 为空的行被算上 —— 配额被大幅放松，是危险的方向。
   *
   * 正确的归属是**这个事件操作的那个视频是谁在运营**：`videos.ops_uid`
   * （"本机以哪个号拉取/运营过这个视频"）。这也是全仓统一的口径 ——
   * 运营对象的账号隔离用的就是它（见 `core/data/views.js` 的"按 ops_uid 隔离"），
   * v14 给 drafts 回填 account_uid 也用它，理由都是同一句：
   * 别人的视频没有归属账号，只能靠"是哪次操作、哪个账号"。
   *
   * @param {object} row
   * @param {Map<string,string|null>} cache - awemeId → ops_uid，同一个视频只查一次
   * @returns {string|null} 查不到归属时返回 null，由调用方决定并入谁
   */
  function ownerOfRow(row, cache) {
    const awemeId = row && row.awemeId != null ? String(row.awemeId) : '';
    if (!awemeId) return null;
    if (cache.has(awemeId)) return cache.get(awemeId);
    let owner = null;
    try {
      const v = videosModule().get(awemeId);
      owner = v && v.opsUid != null ? String(v.opsUid) : null;
    } catch (e) {
      // 查不到就当作"归属不明"（并入当前账号，宁可多算）。这里**不抛**：
      // 归属查不动不该让整个 stats() 失败，那会让界面上一片空白，
      // 而空白会被读成"今天还没写"——比多算危险得多。
      logger.debug('[policy] 查视频归属账号失败: ' + e.message);
    }
    cache.set(awemeId, owner);
    return owner;
  }

  /**
   * 把写操作行按"执行账号"分区。
   *
   * ⚠️ 不在 SQL 里过滤，而是取全量在 JS 里分 —— 有一批行**查不到归属**
   * （点赞不带 aweme_id、视频不在库里、ops_uid 为空，实测都出现过）。
   * SQL 过滤会把它们整批丢掉，于是"按账号统计"变成"少算几条"= 配额被放松，
   * 那是危险的方向。所以：**归属不明的行并入当前账号**（宁可多算），
   * 只排除明确归属着别的账号的行。
   *
   * @param {Array<{awemeId?:string}>} rows
   * @param {string|null} [accountUid] - 空 = 不分区（CLI 与未知账号时最严）
   */
  function scopeByAccount(rows, accountUid) {
    if (!accountUid) return { mine: rows, unattributed: 0 };
    const key = String(accountUid);
    const mine = [];
    let unattributed = 0;
    const cache = new Map();
    for (const r of rows) {
      const owner = ownerOfRow(r, cache);
      if (!owner) { unattributed++; mine.push(r); continue; }
      if (owner === key) mine.push(r);
    }
    return { mine, unattributed };
  }

  /**
   * 当前策略全景。界面与 IPC 都用它，保证只有一处算账。
   *
   * @param {object} [opts]
   * @param {string|null} [opts.accountUid] - 执行账号。传了就只算这个号
   *   （加上那些没登记账号的行），不传 = 全账号合算，是最严的方向。
   */
  function stats(opts = {}) {
    const accountUid = opts.accountUid == null || opts.accountUid === '' ? null : String(opts.accountUid);
    const cfg = p();
    const t0 = todayStart();
    const ts = now();

    // 三处计数都来自 events 表。任何一处读不到，就把原因记进 readError：
    // 下面的数字会变成"0 条 / 没熔断 / 没风控"，那是假的绿灯 ——
    // 真正的判定在 beforeWrite 里，见到 readError 就直接拒绝写入。
    let readError = null;

    const todayRead = queryWritesSafe({ since: t0, status: 'success' });
    if (todayRead.failed) readError = readError || '今日写操作记录';
    const scoped = scopeByAccount(todayRead.rows, accountUid);
    const todayWrites = scoped.mine;
    const timeline = todayWrites.map(r => r.ts);
    // 轮 = 一批连续写操作：写满 roundMaxWrites 条这一轮就结束，冷却 roundCooldownSec
    // 秒后的第一笔开启新一轮。空闲不断轮 —— 见 rounds.js 文件头那两次改错的记录。
    const rounds = summarizeRounds(timeline, {
      maxPerRound: cfg.roundMaxWrites,
      cooldownMs: cfg.roundCooldownSec * 1000,
      now: ts,
    });

    // 熔断：窗口内失败的写操作次数
    const cb = cfg.circuitBreaker || {};
    const windowMs = cb.windowMs || 600000;
    const failRead = queryWritesSafe({ since: ts - windowMs, status: 'error' });
    if (failRead.failed) readError = readError || '近期失败记录';
    const recentFails = failRead.rows;
    const circuitOpen = recentFails.length >= (cb.failThreshold || 3);

    // 风控熔断：窗口内是否出现过风控码
    const riskWindowMs = (cfg.riskCooldownMin || 30) * 60 * 1000;
    let riskBlocked = false;
    try {
      riskBlocked = riskControl.hasRecentRiskBlock(riskWindowMs);
    } catch (e) {
      readError = readError || '风控拦截记录';
    }

    // 单轮触顶后的冷却剩余时间 —— 由 rounds.js 一处算出（只有它知道"这一批写满没有"）
    const cooldownRemainingMs = rounds.cooldownRemainingMs;

    // 节奏下限的剩余等待（来自 risk-control，与 intervals.write 同源）
    let nextWriteAllowedInMs = 0;
    try { nextWriteAllowedInMs = riskControl.msUntilNext('write'); } catch (e) { /* 忽略 */ }

    const roundsUsed = rounds.count;
    const startingNewRound = rounds.startingNewRound;

    // 轮次是**告警**不是闸门：超过阈值只出黄条，不拦写操作。
    // 真正硬拦量的是 dailyWriteQuota、触顶冷却，以及下面两道熔断。
    let warning = null;
    if (readError) {
      warning = `策略数据不可读（${readError}），已停止写操作`;
    } else if (roundsUsed > (cfg.riskEscalateAfterRounds || 2)) {
      warning = `本日已进行 ${roundsUsed} 轮，风控概率显著上升，建议今天不再写`;
    } else if (roundsUsed >= (cfg.dailyRounds || 3)) {
      // 这条只有在"风控升级"那条没先命中时才会走到（两条都只是提示）。
      // 它让 dailyRounds 这个数字仍然有含义 —— 它是个提示阈值，不是上限闸门。
      //
      // 刻意**不**加 `startingNewRound` 这个条件（曾经加过）：那样只有"下一笔
      // 恰好要开新一轮"时才提示，用户在一个批次中途反而看不到已达阈值的黄条。
      // 提示要及时，闸门才需要精确。
      warning = `本日轮次已达 ${roundsUsed}/${cfg.dailyRounds}，建议明天再继续`;
    }
    if (scoped.unattributed > 0) {
      warning = warning
        ? `${warning}（另有 ${scoped.unattributed} 条写操作查不到归属账号，已并入本账号统计）`
        : `${scoped.unattributed} 条写操作查不到归属账号，已并入本账号统计（宁可多算，避免漏掉配额）`;
    }

    return {
      /**
       * 计数读不到时的原因（null = 正常）。
       * 非空时下面那些数字**不可信**（都是 0），且 beforeWrite 会拒绝一切写操作。
       */
      readError,
      // 每日总量
      dailyWriteQuota: cfg.dailyWriteQuota,
      writesToday: todayWrites.length,
      writesRemaining: Math.max(0, cfg.dailyWriteQuota - todayWrites.length),
      // 轮次（口径见 rounds.js：一轮 = 一批连续写操作，写满 roundMaxWrites 条即结束）
      dailyRounds: cfg.dailyRounds,
      roundsToday: roundsUsed,
      roundsRemaining: Math.max(0, cfg.dailyRounds - roundsUsed),
      roundMaxWrites: cfg.roundMaxWrites,
      /**
       * 「本轮已写几条」—— 当前这一批的条数。
       *
       * 写满 roundMaxWrites 条这一轮就结束，冷却 roundCooldownSec 秒后下一笔开启
       * 新一轮。所以**冷却期间这个数会停在满值不归零**，那是对的：冷却结束前它仍是
       * 本轮的第 N 条。界面别再把它当"近 N 分钟的滑窗"。
       */
      roundWrites: rounds.currentSize,
      roundWritesRemaining: Math.max(0, cfg.roundMaxWrites - rounds.currentSize),
      /** 本次统计的执行账号（null = 全账号合算） */
      accountUid,
      /** 今日有多少条写操作查不到归属账号（已被并入本账号统计，不静默丢） */
      unattributedWrites: scoped.unattributed,
      roundCooldownSec: cfg.roundCooldownSec,
      /** 单轮触顶后还需冷却多久（毫秒，0 表示不需要） */
      cooldownRemainingMs,
      /**
       * 冷却结束的**绝对时刻**（epoch ms，0 = 不需要冷却）。
       *
       * 界面上的倒计时必须用"绝对时刻 - 本地 now"，不能用上面那个"还剩多久"：
       * 后者是 stats() 被调用那一刻的快照，而主进程只在队列边界推一次
       * （入队/开始/等待/恢复/结束），于是倒计时会冻在推送时的数字上 ——
       * 队列页那个全页最大的数字曾经就是这样不动的。
       */
      cooldownUntil: cooldownRemainingMs > 0 ? ts + cooldownRemainingMs : 0,
      /** 距下次可写还需等待（毫秒，节奏下限，0 表示可立即写） */
      nextWriteAllowedInMs,
      /** 同上：节奏下限到点的绝对时刻（epoch ms），给界面倒计时用 */
      nextWriteAllowedAt: nextWriteAllowedInMs > 0 ? ts + nextWriteAllowedInMs : 0,
      /** 连过又断的轮次判定：是否即将开启新一轮 */
      startingNewRound,
      // 熔断
      circuit: {
        open: circuitOpen,
        recentFailures: recentFails.length,
        threshold: cb.failThreshold || 3,
        windowMs,
      },
      risk: {
        blocked: riskBlocked,
        windowMs: riskWindowMs,
        codes: cfg.riskCodeStopList || [],
      },
      // 会话
      consecutiveSkips,
      stopAfterConsecutiveSkips: cfg.stopAfterConsecutiveSkips,
      warning,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // 写操作准入
  // ═══════════════════════════════════════════════════════════

  /**
   * 判断现在能不能写。不等待、不抛错，只报告。
   *
   * @param {object} [meta] - { uid?, awemeId?, text?, cid?, accountUid? }
   *   ⚠️ `uid` 是**被回复的那个评论者**，`accountUid` 才是**本机正在执行的抖音账号** ——
   *   两者搞混会让"按账号统计配额"变成"按陌生人统计"。
   * @returns {{ok:boolean, blockers:Array<{reason:string,action:'stop'|'wait'|'rewrite'}>, warnings:string[], waitMs:number, stats:object}}
   */
  function beforeWrite(meta = {}) {
    const s = stats({ accountUid: meta.accountUid });
    const cfg = p();
    const blockers = [];
    const warnings = [];
    let cooldownWaitMs = 0;   // 轮次冷却（assertWritable 负责等）
    let cadenceWaitMs = 0;    // 写操作最小间隔（risk-control.enforceDelay 负责等）
    let waitMs = 0;           // 两者取大，保持对既有调用方的兼容

    // ── 计数读不到：状态未知本身就是最硬的下线理由 ──
    //
    // 放在最前面，且下面两处"单轮内细分配额"在状态未知时不再尝试统计 ——
    // 读不到记录时那些数必然全是 0，继续判下去等于自己给自己发通行证。
    // 宁可让用户看见一句"读不到运营记录"去修数据库，也不要他在不自知的情况下超限连发。
    const stateUnknown = !!s.readError;
    if (stateUnknown) {
      blockers.push({
        reason: `读不到运营记录（${s.readError}），无法确认今日配额与轮次 —— 为避免超限发布，已停止写操作。请检查 storage/douyin.db 能否正常读写`,
        action: 'stop',
      });
    }

    // ── 风控熔断：优先级最高，命中就是全局停写 ──
    if (s.risk.blocked) {
      blockers.push({
        reason: `近 ${cfg.riskCooldownMin} 分钟内出现过风控拦截（错误码 ${(cfg.riskCodeStopList || []).join('/')}），已全局停止写操作`,
        action: 'stop',
      });
    }

    // ── 连续失败断路器 ──
    if (s.circuit.open) {
      blockers.push({
        reason: `最近 ${Math.round(s.circuit.windowMs / 60000)} 分钟内失败了 ${s.circuit.recentFailures} 次（阈值 ${s.circuit.threshold}），已暂停自动发布`,
        action: 'stop',
      });
    }

    // ── 每日总量 ──
    if (s.writesToday >= s.dailyWriteQuota) {
      blockers.push({
        reason: `今日写操作已达上限 ${s.writesToday}/${s.dailyWriteQuota}`,
        action: 'stop',
      });
    }

    // ── 单轮触顶与冷却 ──
    // ⚠️ 这里**刻意没有**"每日轮次用尽就停写"这一条。`dailyRounds` 是告警不是闸门
    // （见 stats() 的 warning 与 运营规则说明.md §1）。改造前它在这里硬拦，而拦的
    // 依据（空闲断轮）本身就是错的 —— 结果是想干活的人被拦、想绕的人拦不住。
    // 真正硬拦量的是 dailyWriteQuota、下面这条触顶冷却，以及两道熔断。
    if (s.cooldownRemainingMs > 0) {
      // 分两个数记：cooldownWaitMs 是"轮次冷却"，cadenceWaitMs 是"写操作最小间隔"。
      // 两者由不同的层负责等待 —— 冷却由命令入口的 assertWritable 等，
      // 最小间隔由 risk-control.enforceDelay 等。混成一个数会让 assertWritable
      // 把该由 enforceDelay 干的活也干一遍，变成双重等待（实测多等 40 秒）。
      cooldownWaitMs = Math.max(cooldownWaitMs, s.cooldownRemainingMs);
      blockers.push({
        reason: `本轮已写 ${s.roundWrites}/${s.roundMaxWrites} 条，需冷却 ${Math.ceil(s.cooldownRemainingMs / 1000)}s 后开启新一轮`,
        action: 'wait',
      });
    }

    // ── 节奏下限（与 intervals.write 同源）──
    if (s.nextWriteAllowedInMs > 0) {
      // 这个是"距上次写不足最小间隔"，由 risk-control.enforceDelay 负责等。
      //
      // 用**含随机量**的版本（msUntilNextWriteJittered）而不是 stats 里的
      // nextWriteAllowedInMs（只算硬下限）：桌面队列等完这个数之后会给命令补
      // --no-throttle 跳过 enforceDelay，如果这里只等 40s，每一笔写操作就会是
      // 精确的 40.0 秒 —— 比命令行还机械，而两边的文档都写着 40–55s 随机。
      try {
        const rc = require('../risk-control');
        cadenceWaitMs = Math.max(cadenceWaitMs, rc.msUntilNextWriteJittered());
      } catch (e) {
        cadenceWaitMs = Math.max(cadenceWaitMs, s.nextWriteAllowedInMs);
      }
    }
    waitMs = Math.max(cooldownWaitMs, cadenceWaitMs);

    // ── 单条对象上的细分配额 ──
    //
    // 窗口是**今日**，不是"本轮"。这两个上限曾经挂在"本轮起点"上，而"轮"的定义
    // 改过两次（见 rounds.js 文件头）—— 上限的口径跟着轮一起漂，同一份数据能得出
    // 三种不同的"本轮已回几条"。按天算之后它不再随轮的定义变化，行为可预测。
    if (!stateUnknown && meta.uid) {
      const r = queryWritesSafe({ since: todayStart(), status: 'success', uid: meta.uid });
      if (r.failed) {
        blockers.push({ reason: '无法确认该用户今日已被回复几次，已拒绝本次写入', action: 'stop' });
      } else if (r.rows.length >= cfg.maxPerUidPerRound) {
        blockers.push({
          reason: `今日已回复过该用户 ${r.rows.length} 次（上限 ${cfg.maxPerUidPerRound}）`,
          action: 'stop',
        });
      }
    }
    if (!stateUnknown && meta.awemeId) {
      // 只数**回复类**写操作。改造前把整个写命令族（含 like/unlike/delete-comment）
      // 都算进来，而 like 也带 aweme_id —— 于是在同一个视频上反复点赞 30 次之后，
      // 发任何一条回复都会被拦下，提示"在该视频下已回复 30 条"，
      // 而实际上一条回复都没发过。
      const r = queryWritesSafe({
        since: todayStart(),
        status: 'success',
        awemeId: meta.awemeId,
        commands: REPLY_COMMANDS,
      });
      if (r.failed) {
        blockers.push({ reason: '无法确认该视频今日已被回复几条，已拒绝本次写入', action: 'stop' });
      } else if (r.rows.length >= cfg.maxPerVideoPerRound) {
        blockers.push({
          reason: `今日在该视频下已回复 ${r.rows.length} 条（上限 ${cfg.maxPerVideoPerRound}）`,
          action: 'stop',
        });
      }
    }

    // ── 内容与去重 ──
    if (meta.cid && cfg.skipReplied !== false && isReplied(meta.cid)) {
      blockers.push({ reason: '这条评论已经回复过了', action: 'stop' });
    }

    // ── 发布对象检查：贴纸评论 / 黑名单用户 ──
    //
    // 这三条（含下面的语料查重）原先写在 risk-control 的 preflightPublish 里，
    // 而那个函数**全仓没有任何调用方** —— 于是"发布前检查重复、黑名单、贴纸"
    // 这条改造计划明确承诺过的护栏，实际上一条都没生效：
    // 同一句话可以重复发出去，被拉黑的人照样回。
    // 现在接在真正的发布闸门 beforeWrite 上。
    if (meta.cid) {
      try {
        const c = commentsModule().get(String(meta.cid));
        if (c && c.isSticker && cfg.skipSticker !== false) {
          // 注意字段名：comments.get 返回的是驼峰 isSticker。
          // preflightPublish 里读的是 c.is_sticker（永远 undefined），
          // 所以即便接上调用方那条判断也是恒假的。
          blockers.push({ reason: '这是一条贴纸评论，按规则跳过', action: 'stop' });
        }
      } catch (e) { logger.debug('[policy] 查贴纸标记失败: ' + e.message); }
    }
    if (meta.uid) {
      try {
        const u = usersModule().get(String(meta.uid));
        if (u && (u.tier === 'blacklist' || u.tier === 'spam')) {
          blockers.push({ reason: `该用户被标记为 ${u.tier}，不回复`, action: 'stop' });
        }
      } catch (e) { logger.debug('[policy] 查用户分级失败: ' + e.message); }
    }

    if (meta.text) {
      // 语料库查重：同一句话之前发过就改写。
      // 这是「不使用同一份固定模板连发」那条规则的运行时兜底。
      try {
        const hit = corpusModule().findByText(meta.text);
        if (hit) {
          // ⚠️ 这里原本写的是 `hit.replyCid ? 'cid ' + hit.replyCid : '语料库去重'`，
          // 而 findByText 只 SELECT 了 id / reply_text / posted_at / outcome / aweme_id，
          // 返回对象里**没有 replyCid** —— 那个三元恒走右边，界面上看到的永远是
          // "（语料库去重）"这句内部术语。与 §2.25 的 events.uid、§2.22 的闸门名单同源：
          // 字段名看着像、实际没有，于是分支永远不成立而且不报错。
          // 运营者真正需要的是"上次那句发于何时、发到哪个视频"，这两个字段是取得到的。
          const where = hit.awemeId ? `视频 ····${String(hit.awemeId).slice(-6)}` : '另一个视频';
          blockers.push({
            reason: `这句话之前已经发给过${where}（${agoWords(hit.postedAt) || '时间不详'}）`
              + ' —— 同一句话只用一次，改几个字再发',
            action: 'rewrite',
          });
        }
      } catch (e) { logger.debug('[policy] 语料查重失败: ' + e.message); }
    }

    if (meta.text) {
      const v = filters.validateReply(meta.text);
      for (const x of v.violations) {
        blockers.push({ reason: `${x.rule}：${x.hint}`, action: 'rewrite' });
      }
    }

    // ── 告警（不拦，但要说）──
    if (s.roundsToday > (cfg.riskEscalateAfterRounds || 2)) {
      warnings.push(`本日已进行 ${s.roundsToday} 轮，超过 ${cfg.riskEscalateAfterRounds} 轮后风控概率显著上升`);
    }
    if (consecutiveSkips >= cfg.stopAfterConsecutiveSkips) {
      warnings.push(`连续 ${consecutiveSkips} 条未匹配回复条件，建议停止本轮`);
    }
    if (s.writesRemaining <= 5 && s.writesRemaining > 0) {
      warnings.push(`今日写操作只剩 ${s.writesRemaining} 条额度`);
    }

    // wait 类 blocker 不阻塞（只是要等），stop/rewrite 才算拦下
    const hardBlockers = blockers.filter(b => b.action !== 'wait');
    return {
      ok: hardBlockers.length === 0,
      blockers,
      hardBlockers,
      warnings,
      waitMs,
      // 分开的等待时长，供调用方各取所需（见上面的注释）
      cooldownWaitMs,
      cadenceWaitMs,
      stats: s,
    };
  }

  /**
   * 命令入口用的强制闸门：不允许写就直接抛错。
   *
   * 这样即使有人裸调 `node cli.js post ...`，规则也一样生效 ——
   * 与 risk-control 在命令入口阻塞等待是同一个思路（跳不掉）。
   *
   * @param {object} meta
   * @throws {Error} 被拦下时抛出，message 即界面可直接展示的原因
   */
  /**
   * 命令入口的发布闸门。
   *
   * ⚠️ 这是 **async** 的，调用方必须 await。
   *
   * 为什么需要 async：beforeWrite 有两类拦截 —— `stop`/`rewrite` 是"不能发"，
   * 而 `wait` 是"现在还不能发，等一会儿"。改造前这个函数只看 hardBlockers
   * （stop/rewrite），**wait 被直接忽略** —— 于是"单轮触顶后冷却 300 秒"和
   * "每日 ≤3 轮"这两条在命令行下完全没有约束力：
   * 连续 post 时每轮间隔由 risk-control 控在 40-55s，远小于 300s 的冷却，
   * 所以永远算同一轮，roundsToday 一整天恒为 1，`每日轮次上限` 那条分支不可达。
   * 只有走桌面队列时才有人等（task-queue 里读 waitMs）。
   *
   * 那两个数字在 运营规则说明.md 里被标为「硬强制」，那就得真的强制。
   *
   * @param {object} meta
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @param {(info:object)=>void} [opts.onWait] - 等待上报，契约与 `risk-control.enforceDelay`、
   *   `commands/helpers.pace` 完全一致：`{phase, waitMs, deadline, reason, type}`，
   *   冷却那段报 `phase:'cooldown'`，睡完补报一次 `phase:'end'`（CLI 打日志 / GUI 画倒计时）
   */
  async function assertWritable(meta = {}, opts = {}) {
    // 可能要多轮：等完冷却之后策略会随时间变化（比如刚好跨到新一轮）
    for (let round = 0; round < 20; round++) {
      const r = beforeWrite(meta);
      if (!r.ok) {
        const reasons = r.hardBlockers.map(b => b.reason).join('；');
        const err = new Error(`运营策略拦下本次操作：${reasons}`);
        err.code = 'POLICY_BLOCKED';
        err.blockers = r.hardBlockers;
        throw err;
      }
      // 只等「轮次冷却」。写操作的最小间隔由 risk-control.enforceDelay 负责，
      // 那里还会叠加随机抖动；在这里再等一遍就是双重等待（而且等的是没有抖动的那份）。
      if (r.cooldownWaitMs <= 0) return r;

      const reason = (r.blockers.find(b => b.action === 'wait') || {}).reason
        || `轮次冷却 ${Math.ceil(r.cooldownWaitMs / 1000)}s`;
      const waitMs = r.cooldownWaitMs;
      // ⚠️ 这里的上报必须与 risk-control.enforceDelay、helpers.pace **同一个契约**：
      // `{phase, waitMs, deadline, reason, type}`，并且睡完要补报一次 `phase:'end'`。
      // 缺 `deadline` 界面起不了倒计时表（队列只能现算一次，之后没人告诉它截止在哪），
      // 缺补报的 `end` 更糟：00:00 之后屏幕还在往下数（见 §2.35 同一条教训）。
      if (opts.onWait) {
        opts.onWait({ phase: 'cooldown', waitMs, deadline: Date.now() + waitMs, reason, type: 'write' });
      }
      const { sleepAbortable } = require('../runtime/abort');
      await sleepAbortable(waitMs, opts.signal);
      // 被打断时不补报 end：AbortError 会一路出命令入口，队列的 finally 负责清 task.wait
      if (opts.onWait) {
        opts.onWait({ phase: 'end', waitMs: 0, deadline: Date.now(), reason: '', type: 'write' });
      }
    }
    const err = new Error('运营策略反复要求等待，已放弃本次操作');
    err.code = 'POLICY_BLOCKED';
    throw err;
  }

  // ═══════════════════════════════════════════════════════════
  // 记账
  // ═══════════════════════════════════════════════════════════

  /** 写完一条后调用。成功会重置"连续跳过"计数 */
  function afterWrite(outcome = {}) {
    if (outcome.ok) {
      consecutiveSkips = 0;
    }
    return stats();
  }

  /** 判定一条评论"不回复"时调用，用于"连续 N 条不匹配就停轮" */
  function recordSkip() {
    consecutiveSkips += 1;
    return consecutiveSkips;
  }

  /** 收尾一条评论的处理（无论回不回），供 TaskQueue 在每轮结束后调用 */
  function recordReply() {
    consecutiveSkips = 0;
  }

  /** 清空会话内状态（新一轮开始时 / 测试用） */
  function resetSession() {
    consecutiveSkips = 0;
  }

  // ═══════════════════════════════════════════════════════════
  // 内容侧（转发给 filters，但把库查询接上）
  // ═══════════════════════════════════════════════════════════

  /**
   * 判定一条评论该怎么处理（已自动接上"是否已回复过"、用户分级、"是不是我自己发的"）。
   * @param {object} comment - { cid, text, uid, isSticker? }（字段名与 comments.get() 的返回一致）
   */
  function classify(comment, opts = {}) {
    // 「我」的判定基准，优先级：调用方给的（命令层能拿到执行账号）→
    // 最近一次解析出的执行账号 → 旧的全局猜测。
    // 这里没法 await（判定树是同步的），所以用 accounts 记的那一份缓存 ——
    // 全局猜测（"作品数最多的号"）在两个账号时必然有一个是错的。
    let myUid = opts.myUid || null;
    if (!myUid) { try { myUid = require('../memory/accounts').lastExecutorUid(); } catch (e) { /* 忽略 */ } }
    if (!myUid) { try { myUid = require('../memory/videos').myUid(); } catch (e) { /* 拿不到就跳过该判断 */ } }
    return filters.classify(comment, { isReplied, userTier, myUid });
  }

  /** 校验待发布的回复文本 */
  function checkReply(text) {
    return filters.validateReply(text);
  }

  /**
   * 批量判定并按结果分桶，同时维护"连续跳过"计数。
   *
   * @param {Array<object>} comments
   * @returns {{reply:Array, emojiReply:Array, skipped:Array, stopRecommended:boolean, consecutiveSkips:number}}
   */
  function classifyBatch(comments) {
    const cfg = p();
    const out = { reply: [], emojiReply: [], skipped: [], stopRecommended: false, consecutiveSkips: 0 };

    for (const c of (comments || [])) {
      const r = classify(c);
      const entry = { ...c, decision: r };

      if (r.action === 'reply') {
        recordReply();
        out.reply.push(entry);
      } else if (r.action === 'emoji_reply') {
        // 表情回复也是一次回复，不算跳过
        recordReply();
        out.emojiReply.push(entry);
      } else {
        recordSkip();
        out.skipped.push(entry);
      }

      if (consecutiveSkips >= cfg.stopAfterConsecutiveSkips) {
        out.stopRecommended = true;
        break;
      }
    }

    out.consecutiveSkips = consecutiveSkips;
    return out;
  }

  return {
    // 查询
    stats,
    beforeWrite,
    classify,
    classifyBatch,
    checkReply,
    // 强制
    assertWritable,
    // 记账
    afterWrite,
    recordSkip,
    recordReply,
    resetSession,
    // 测试用
    _todayStart: todayStart,
  };
}

// ── 默认单例 ──
// 命令入口（post/like/delete-comment）用的是这一个；界面侧也用同一个，
// 保证"能不能发"的判断只有一处。
let _default = null;
function getPolicy() {
  if (!_default) _default = createPolicyEngine();
  return _default;
}
function resetPolicy() { _default = null; }

module.exports = {
  createPolicyEngine,
  getPolicy,
  resetPolicy,
  WRITE_COMMANDS,
  isWriteCommand,
};
