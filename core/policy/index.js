// core/policy/index.js — 运营规则的代码强制
//
// 这个模块存在的全部理由
// ----------------------
// 全局规则.md 与 评论区运营.md 里写着十几条硬性红线 —— 每日 ≤3 轮 ≤30 条、
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

/** 写操作命令族（与 risk-control 的 WRITE_COMMANDS 保持一致） */
const WRITE_COMMANDS = ['post', 'like', 'unlike', 'delete_comment'];

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
      const f = { commands: WRITE_COMMANDS, platform: 'douyin' };
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
    let waitMs = 0;

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
      waitMs = Math.max(waitMs, s.cooldownRemainingMs);
      blockers.push({
        reason: `本轮已写 ${s.roundWrites}/${s.roundMaxWrites} 条，需冷却 ${Math.ceil(s.cooldownRemainingMs / 1000)}s 后开启新一轮`,
        action: 'wait',
      });
    }

    // ── 节奏下限（与 intervals.write 同源）──
    if (s.nextWriteAllowedInMs > 0) {
      waitMs = Math.max(waitMs, s.nextWriteAllowedInMs);
    }

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
      const used = queryWrites({ since: s.roundsToday ? currentRoundStart() : todayStart(), status: 'success', awemeId: meta.awemeId }).length;
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
  function assertWritable(meta = {}) {
    const r = beforeWrite(meta);
    if (!r.ok) {
      const reasons = r.hardBlockers.map(b => b.reason).join('；');
      const err = new Error(`运营策略拦下本次操作：${reasons}`);
      err.code = 'POLICY_BLOCKED';
      err.blockers = r.hardBlockers;
      throw err;
    }
    return r;
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
   * 判定一条评论该怎么处理（已自动接上"是否已回复过"与用户分级）。
   * @param {object} comment - { cid, text, uid, is_sticker? }
   */
  function classify(comment) {
    return filters.classify(comment, { isReplied, userTier });
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
