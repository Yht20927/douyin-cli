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
   * 当前策略全景。界面与 IPC 都用它，保证只有一处算账。
   */
  function stats() {
    const cfg = p();
    const t0 = todayStart();
    const ts = now();

    // 三处计数都来自 events 表。任何一处读不到，就把原因记进 readError：
    // 下面的数字会变成"0 条 / 没熔断 / 没风控"，那是假的绿灯 ——
    // 真正的判定在 beforeWrite 里，见到 readError 就直接拒绝写入。
    let readError = null;

    const todayRead = queryWritesSafe({ since: t0, status: 'success' });
    if (todayRead.failed) readError = readError || '今日写操作记录';
    const todayWrites = todayRead.rows;
    const timeline = todayWrites.map(r => r.ts);
    const rounds = summarizeRounds(timeline, cfg.roundCooldownSec * 1000);

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
    if (readError) {
      warning = `策略数据不可读（${readError}），已停止写操作`;
    } else if (roundsUsed > (cfg.riskEscalateAfterRounds || 2)) {
      warning = `本日已进行 ${roundsUsed} 轮，风控概率显著上升，建议今天不再写`;
    } else if (roundFull && roundsUsed >= (cfg.dailyRounds || 3)) {
      warning = `本日轮次已用尽（${roundsUsed}/${cfg.dailyRounds}）`;
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
    if (!stateUnknown && meta.uid) {
      const r = queryWritesSafe({ since: s.roundsToday ? currentRoundStart() : todayStart(), status: 'success', uid: meta.uid });
      if (r.failed) {
        blockers.push({ reason: '无法确认该用户本轮已被回复几次，已拒绝本次写入', action: 'stop' });
      } else if (r.rows.length >= cfg.maxPerUidPerRound) {
        blockers.push({
          reason: `本轮已回复过该用户 ${r.rows.length} 次（上限 ${cfg.maxPerUidPerRound}）`,
          action: 'stop',
        });
      }
    }
    if (!stateUnknown && meta.awemeId) {
      // 只数**回复类**写操作。改造前把整个写命令族（含 like/unlike/delete-comment）
      // 都算进来，而 like 也带 aweme_id —— 于是在同一个视频上反复点赞 30 次之后，
      // 发任何一条回复都会被拦下，提示"本轮在该视频下已回复 30 条"，
      // 而实际上一条回复都没发过。
      const r = queryWritesSafe({
        since: s.roundsToday ? currentRoundStart() : todayStart(),
        status: 'success',
        awemeId: meta.awemeId,
        commands: REPLY_COMMANDS,
      });
      if (r.failed) {
        blockers.push({ reason: '无法确认该视频本轮已被回复几条，已拒绝本次写入', action: 'stop' });
      } else if (r.rows.length >= cfg.maxPerVideoPerRound) {
        blockers.push({
          reason: `本轮在该视频下已回复 ${r.rows.length} 条（上限 ${cfg.maxPerVideoPerRound}）`,
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
    // 读不到就退化成今日零点：窗口**变宽** → 数出来的条数只多不少 → 拦得更严。
    // 反过来（退化成"刚才"、窗口近乎为空）会把配额判成 0，那是危险的方向。
    const { rows, failed } = queryWritesSafe({ since: todayStart(), status: 'success' });
    if (failed) return todayStart();
    const rounds = summarizeRounds(rows.map(r => r.ts), cfg.roundCooldownSec * 1000);
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
  isWriteCommand,
};
