// lib/risk-control.js — 请求节奏守卫（rate-limit pacing）
//
// 设计动机
// --------
// 把"命令间随机间隔"从 prose 规则变成代码强制。
// 过去间隔只写在 7 份 .md 里（且漂移出 40-55s / 45-180s / 60s 三套数字），
// agent 受 harness 默认（并行、避免长 sleep）影响会跳过。现在写命令入口直接 enforceDelay，
// 即便 agent 裸调 `node cli.js post`，命令自己也阻塞到达标 —— 跳不掉。
//
// 间隔的单一事实源 = config.json:intervals（经 core/config 读取，支持热重载）。
//
// 语义边界（重要）
// ----------------
// 这是 rate-limit pacing：尊重接口频控、维护账号健康，**不是"逃避检测"**。
// 内容真实性 / 反刷量 由 内容禁令 + corpus 去重 + factcheck 保证，节奏守卫只管"多快发一次"。
//
// 强制范围
// --------
// - 写操作（post / like / unlike / delete-comment）：硬强制，入口阻塞。
// - 读操作（get / search / my / replies / download）：仅 advisory，不阻塞。
//   原因：读操作的风控敏感度远低于写操作，且机械阻塞会让交互式查询每次卡 30s，得不偿失。
//   读间隔仍由 agent 在命令间自行遵守（preflight 会给出建议）。

const config = require('./config');
const logger = require('./runtime/logger');
const { sleepAbortable } = require('./runtime/abort');

// 默认间隔（秒）。单一真源已迁到 core/config 的 DEFAULTS.intervals，
// 这里保留同名导出仅为向后兼容（外部无引用，见 grep DEFAULT_INTERVALS）。
const DEFAULT_INTERVALS = config.DEFAULTS.intervals;

// 写操作命令名（对应 events.command 列；like 与 unlike 分开记录）
const WRITE_COMMANDS = new Set(['post', 'like', 'unlike', 'delete_comment']);

/**
 * 读取间隔配置。
 *
 * 改造前这里有模块级 `_config` 缓存（原 :35-45），导致改完 config.json 不重启进程
 * 永远读不到新值。现在每次从 config 单一真源取值，设置页改完立即生效。
 * 取值/纠正顺序/非法值回退都在 config.validate() 里完成，此处不再重复处理。
 */
function getIntervals() {
  return {
    write: config.get('intervals.write'),
    read: config.get('intervals.read'),
  };
}


function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** 读操作命令名（对应 events.command 列） */
const READ_COMMANDS = new Set(['get', 'search', 'my', 'replies', 'user', 'analyze']);

/**
 * 查 events 表最近一次指定命令集合的成功时间戳（ms）。
 * 无记录或 SQL 失败返回 0。
 * @param {Set<string>|string[]} commands
 */
function lastOpTs(commands) {
  const list = Array.from(commands);
  if (list.length === 0) return 0;
  try {
    const { getDb } = require('./memory/db');
    const db = getDb();
    const placeholders = list.map(() => '?').join(',');
    const row = db.prepare(`
      SELECT max(ts) AS ms FROM events
      WHERE platform = 'douyin'
        AND command IN (${placeholders})
        AND status = 'success'
    `).get(...list);
    return (row && row.ms) || 0;
  } catch (e) {
    logger.debug('[risk-control.lastOpTs] failed: ' + e.message);
    return 0;
  }
}

/** 最近一次写操作（post/like/unlike/delete_comment）的成功时间戳（ms） */
function lastWriteTs() {
  return lastOpTs(WRITE_COMMANDS);
}

/** 最近一次读操作的成功时间戳（ms） */
function lastReadTs() {
  return lastOpTs(READ_COMMANDS);
}

/**
 * 返回距下次允许某类操作还需等待的毫秒数（0 = 可立即执行）。
 * @param {'write'|'read'} type
 */
function msUntilNext(type = 'write') {
  const [minSec] = getIntervals()[type] || DEFAULT_INTERVALS.write;
  const last = type === 'read' ? lastReadTs() : lastWriteTs();
  if (!last) return 0;
  return Math.max(0, minSec * 1000 - (Date.now() - last));
}

/** 距下次允许写还需等待的毫秒数（0 = 可立即执行） */
function msUntilNextWrite() {
  return msUntilNext('write');
}

function shouldBypass(opts = {}) {
  return opts.force === true || process.env.DOUYIN_NO_THROTTLE === '1';
}

/**
 * 强制等待到下次同类操作允许。被命令入口 await 调用。
 *
 * 可观测 / 可取消（GUI 需要）
 * -------------------------
 * 改造前这里是裸 `await sleep(need)`：CLI 下没问题，但 GUI 里既看不到还要等多久，
 * 也无法取消。现在等待过程通过 onWait 回调上报，并支持 AbortSignal 打断：
 *
 *   onWait({ phase, waitMs, deadline, reason })   等待开始/更新时调用一次
 *   opts.signal                                   取消时抛 AbortError
 *
 * onWait 缺省时按原样打印到 stderr —— **CLI 输出与改造前逐字节一致**。
 *
 * 读操作是否强制
 * --------------
 * 默认仍为 advisory（不阻塞），保持 CLI 交互式查询不被卡 30s 的既有语义。
 * 但 config.intervals.readEnforce 置 true 时读操作也强制 —— GUI 下会打开，
 * 因为那里没有 agent 自觉遵守间隔，必须由代码兜住。
 *
 * @param {'write'|'read'} type
 * @param {object} opts - { force, signal, onWait }
 * @returns {Promise<{skipped:boolean, waitedMs:number, lastWriteTs:number, intervals:number[]}>}
 * @throws {AbortError} signal 在等待期间被 abort
 */
async function enforceDelay(type = 'write', opts = {}) {
  const intervals = getIntervals()[type] || DEFAULT_INTERVALS.write;
  const { signal, onWait } = opts;

  if (shouldBypass(opts)) {
    return { skipped: true, waitedMs: 0, lastWriteTs: lastWriteTs(), intervals };
  }

  // 读操作：默认 advisory，不阻塞（见文件头说明）
  const readEnforced = type === 'read' && config.get('intervals.readEnforce') === true;
  if (type !== 'write' && !readEnforced) {
    return { skipped: false, waitedMs: 0, advisory: true, intervals };
  }

  const label = type === 'read' ? '读' : '写';
  const lastOf = () => (type === 'read' ? lastReadTs() : lastWriteTs());

  // 上报一次等待信息：CLI 走默认打印，GUI 走回调画倒计时
  const reportWait = (phase, waitMs, reason) => {
    if (onWait) {
      onWait({ phase, waitMs, deadline: Date.now() + waitMs, reason, type });
    } else {
      logger.info(`⏳ [risk-control] ${reason}...`);
    }
  };

  const t0 = Date.now();
  const last = lastOf();

  // 1) 硬性下限：距上次同类操作至少 minSec 秒
  const need = msUntilNext(type);
  if (need > 0) {
    const sinceLast = last ? Math.round((Date.now() - last) / 1000) : 0;
    reportWait(
      'min_interval',
      need,
      `距上次${label}仅 ${sinceLast}s，强制等待 ${Math.ceil(need / 1000)}s（下限 ${intervals[0]}s）`
    );
    await sleepAbortable(need, signal);
  }

  // 2) 叠加随机量，让总间隔落在 [min, max]
  const lastAfterFloor = lastOf();
  const elapsedSec = lastAfterFloor ? (Date.now() - lastAfterFloor) / 1000 : intervals[1];
  if (elapsedSec < intervals[1]) {
    const targetTotal = randomInt(intervals[0], intervals[1]);
    const extra = Math.max(0, Math.round(targetTotal - elapsedSec));
    if (extra > 0) {
      reportWait('jitter', extra * 1000, `叠加随机节奏，再等 ${extra}s（目标总间隔 ${targetTotal}s）`);
      await sleepAbortable(extra * 1000, signal);
    }
  }

  return { skipped: false, waitedMs: Date.now() - t0, lastWriteTs: last || lastAfterFloor, intervals };
}

/**
 * preflight 自检：不阻塞，只报告状态。供 `node cli.js preflight <cmd>` 与 agent 自检用。
 * @param {string} command
 */
function preflight(command) {
  const isWrite = ['post', 'like', 'unlike', 'delete-comment', 'delete_comment'].includes(command);
  const intervals = getIntervals();

  if (!isWrite) {
    return {
      command, type: 'read', ok: true,
      message: `读操作，建议命令间间隔 ${intervals.read[0]}-${intervals.read[1]}s（advisory，由 agent 自行遵守）`,
      intervals: intervals.read,
    };
  }

  const need = msUntilNextWrite();
  const last = lastWriteTs();
  const sinceLast = last ? Math.round((Date.now() - last) / 1000) : null;

  if (need === 0) {
    return {
      command, type: 'write', ok: true,
      message: `可执行（距上次写 ${sinceLast === null ? '无记录' : sinceLast + 's'}）`,
      intervals: intervals.write,
    };
  }
  return {
    command, type: 'write', ok: false,
    message: `需等待 ${Math.ceil(need / 1000)}s（距上次写 ${sinceLast}s，下限 ${intervals.write[0]}s）`,
    waitMs: need,
    intervals: intervals.write,
  };
}

// ═══════════════════════════════════════════════════════════
// 风控信号与发布前预检
//
// 注：原 P4 的 dailyQuotaUsage / adaptiveInterval 依赖 campaigns.campaign_tasks，
// 已随推广引擎一并移除。发布节奏的配额判断改由 PolicyEngine 用全局计数（events 表）实现。
// hasRecentRiskBlock 与 preflightPublish 是通用能力，保留。
// ═══════════════════════════════════════════════════════════

/**
 * 近 windowMs 内是否有 post 失败且错误码为风控拦截（status_code=8/2053）。
 */
function hasRecentRiskBlock(windowMs = 300000) {
  try {
    const { getDb } = require('./memory/db');
    const db = getDb();
    const since = Date.now() - windowMs;
    const row = db.prepare(`
      SELECT 1 AS hit FROM events
      WHERE platform = 'douyin' AND command = 'post' AND status = 'error'
        AND (error LIKE '%status_code=8%' OR error LIKE '%status_code=2053%')
        AND ts >= ?
      LIMIT 1
    `).get(since);
    return !!row;
  } catch (e) {
    logger.debug('[risk-control.hasRecentRiskBlock] failed: ' + e.message);
    return false;
  }
}

/**
 * 发布前预检（GUI 发布二次确认时调用）。
 * @param {object} o - { cid?, uid?, replyText? }
 * @returns {{ok:boolean, blockers:Array<{reason:string, action:'skip'|'rewrite'|'postpone'}>}}
 */
function preflightPublish({ cid, uid, replyText } = {}) {
  const blockers = [];
  try {
    if (cid) {
      const comments = require('./memory/comments');
      const c = comments.get(String(cid));
      if (c) {
        if (c.is_sticker) blockers.push({ reason: 'sticker_comment', action: 'skip' });
        if (!uid && c.uid) uid = c.uid; // 从评论反查 uid（campaign_tasks 无 uid 列）
      }
    }
    if (uid) {
      const users = require('./memory/users');
      const u = users.get(String(uid));
      if (u && u.tier === 'blacklist') blockers.push({ reason: 'user_blacklist', action: 'skip' });
    }
    if (replyText) {
      const corpus = require('./memory/corpus');
      if (corpus.findByText(replyText)) blockers.push({ reason: 'dup_reply_hash', action: 'rewrite' });
    }
    if (hasRecentRiskBlock()) blockers.push({ reason: 'recent_status_block_5min', action: 'postpone' });
  } catch (e) {
    logger.debug('[risk-control.preflightPublish] failed: ' + e.message);
  }
  return { ok: blockers.length === 0, blockers };
}

module.exports = {
  enforceDelay,
  preflight,
  msUntilNext,
  msUntilNextWrite,
  lastWriteTs,
  lastReadTs,
  lastOpTs,
  getIntervals,
  DEFAULT_INTERVALS,
  WRITE_COMMANDS,
  READ_COMMANDS,
  // 风控信号与发布前预检
  hasRecentRiskBlock,
  preflightPublish,
};
