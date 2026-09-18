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

/** 写操作命令族（与 risk-control 的 WRITE_COMMANDS 保持一致） */
const WRITE_COMMANDS = ['post', 'like', 'unlike', 'delete_comment'];
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
   * @param {object} [o]
   * @param {number} [o.since]  - 起始时间戳
   * @param {'success'|'error'} [o.status]
   * @param {string} [o.uid]
   * @param {string} [o.awemeId]
   * @returns {Array<{ts:number}>}
   */
  function queryWrites(o = {}) {
    try {
      const f = { commands: o.commands || WRITE_COMMANDS, platform: 'douyin' };
      if (o.since !== undefined) f.since = o.since;
      if (o.status) f.status = o.status;
      if (o.uid) f.uid = String(o.uid);
      if (o.awemeId) f.awemeId = String(o.awemeId);
      return eventsModule().query(f, { limit: MAX_ROWS, order: 'asc' });
    } catch (e) {
      // events 读不到不该让整个应用不能用 —— 降级为"没有记录"
      logger.debug('[policy] 读取写操作记录失败: ' + e.message);
      return [];
    }
  }

  function p() { return config.get('policy'); }

  // ═══════════════════════════════════════════════════════════
  // 统计
  // ═══════════════════════════════════════════════════════════

  /**
   * 当前策略全景。界面与 IPC 都用它，保证只有一处算账。
   */
  function stats() {
    const cfg = p();
    const t0 = todayStart();
    const ts = now();

    const todayWrites = queryWrites({ since: t0, status: 'success' });
    const timeline = todayWrites.map(r => r.ts);
    const rounds = summarizeRounds(timeline, cfg.roundCooldownSec * 1000);

    // 熔断：窗口内失败的写操作次数
    const cb = cfg.circuitBreaker || {};
    const windowMs = cb.windowMs || 600000;
    const recentFails = queryWrites({ since: ts - windowMs, status: 'error' });
    const circuitOpen = recentFails.length >= (cb.failThreshold || 3);

    // 风控熔断：窗口内是否出现过风控码
    const riskWindowMs = (cfg.riskCooldownMin || 30) * 60 * 1000;
    const riskBlocked = riskControl.hasRecentRiskBlock(riskWindowMs);

    // 单轮触顶后的冷却剩余时间
    const cooldownMs = cfg.roundCooldownSec * 1000;
    const roundFull = rounds.currentSize >= cfg.roundMaxWrites;
    const cooldownRemainingMs = roundFull && rounds.lastTs
      ? Math.max(0, rounds.lastTs + cooldownMs - ts)
      : 0;

    // 节奏下限的剩余等待（来自 risk-control，与 intervals.write 同源）
    let nextWriteAllowedInMs = 0;
    try { nextWriteAllowedInMs = riskControl.msUntilNext('write'); } catch (e) { /* 忽略 */ }

    const roundsUsed = rounds.count;
    const startingNewRound = roundFull || rounds.count === 0;

    let warning = null;
    if (roundsUsed > (cfg.riskEscalateAfterRounds || 2)) {
      warning = `本日已进行 ${roundsUsed} 轮，风控概率显著上升，建议今天不再写`;
    } else if (roundFull && roundsUsed >= (cfg.dailyRounds || 3)) {
      warning = `本日轮次已用尽（${roundsUsed}/${cfg.dailyRounds}）`;
    }

    return {
      // 每日总量
      dailyWriteQuota: cfg.dailyWriteQuota,
      writesToday: todayWrites.length,
      writesRemaining: Math.max(0, cfg.dailyWriteQuota - todayWrites.length),
      // 轮次
      dailyRounds: cfg.dailyRounds,
      roundsToday: roundsUsed,
      roundsRemaining: Math.max(0, cfg.dailyRounds - roundsUsed),
      roundMaxWrites: cfg.roundMaxWrites,
      roundWrites: rounds.currentSize,
      roundWritesRemaining: Math.max(0, cfg.roundMaxWrites - rounds.currentSize),
      roundCooldownSec: cfg.roundCooldownSec,
      /** 单轮触顶后还需冷却多久（毫秒，0 表示不需要） */
      cooldownRemainingMs,
      /** 距下次可写还需等待（毫秒，节奏下限，0 表示可立即写） */
      nextWriteAllowedInMs,
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
   * @param {object} [meta] - { uid?, awemeId?, text?, cid? }
   * @returns {{ok:boolean, blockers:Array<{reason:string,action:'stop'|'wait'|'rewrite'}>, warnings:string[], waitMs:number, stats:object}}
   */
  function beforeWrite(meta = {}) {
    const s = stats();
    const cfg = p();
    const blockers = [];
    const warnings = [];
    let cooldownWaitMs = 0;   // 轮次冷却（assertWritable 负责等）
    let cadenceWaitMs = 0;    // 写操作最小间隔（risk-control.enforceDelay 负责等）
    let waitMs = 0;           // 两者取大，保持对既有调用方的兼容

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

    // ── 轮次与冷却 ──
    if (s.startingNewRound && s.roundsToday >= s.dailyRounds) {
      blockers.push({
        reason: `今日轮次已用尽 ${s.roundsToday}/${s.dailyRounds}，且当前轮已满 — 明天再继续`,
        action: 'stop',
      });
    } else if (s.cooldownRemainingMs > 0) {
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

    // ── 单轮内细分的配额 ──
    if (meta.uid) {
      const used = queryWrites({ since: s.roundsToday ? currentRoundStart() : todayStart(), status: 'success', uid: meta.uid }).length;
      if (used >= cfg.maxPerUidPerRound) {
        blockers.push({
          reason: `本轮已回复过该用户 ${used} 次（上限 ${cfg.maxPerUidPerRound}）`,
          action: 'stop',
        });
      }
    }
    if (meta.awemeId) {
      // 只数**回复类**写操作。改造前把整个写命令族（含 like/unlike/delete-comment）
      // 都算进来，而 like 也带 aweme_id —— 于是在同一个视频上反复点赞 30 次之后，
      // 发任何一条回复都会被拦下，提示"本轮在该视频下已回复 30 条"，
      // 而实际上一条回复都没发过。
      const used = queryWrites({
        since: s.roundsToday ? currentRoundStart() : todayStart(),
        status: 'success',
        awemeId: meta.awemeId,
        commands: REPLY_COMMANDS,
      }).length;
      if (used >= cfg.maxPerVideoPerRound) {
        blockers.push({
          reason: `本轮在该视频下已回复 ${used} 条（上限 ${cfg.maxPerVideoPerRound}）`,
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
          blockers.push({
            reason: `这句话之前已经发过（${hit.replyCid ? 'cid ' + hit.replyCid : '语料库去重'}），换一句`,
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

  /** 当前轮次的起始时间（无轮次时退化为今日零点） */
  function currentRoundStart() {
    const cfg = p();
    const timeline = queryWrites({ since: todayStart(), status: 'success' }).map(r => r.ts);
    const rounds = summarizeRounds(timeline, cfg.roundCooldownSec * 1000);
    return rounds.currentStartedAt || todayStart();
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
   * @param {(info:object)=>void} [opts.onWait] - 等待开始时的回调（CLI 打日志 / GUI 画倒计时）
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
      if (opts.onWait) opts.onWait({ waitMs: r.cooldownWaitMs, reason });
      const { sleepAbortable } = require('../runtime/abort');
      await sleepAbortable(r.cooldownWaitMs, opts.signal);
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
   * @param {object} comment - { cid, text, uid, is_sticker? }
   */
  function classify(comment) {
    let myUid = null;
    try { myUid = require('../memory/videos').myUid(); } catch (e) { /* 拿不到就跳过该判断 */ }
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
    _currentRoundStart: currentRoundStart,
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
};
