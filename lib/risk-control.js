// lib/risk-control.js — 请求节奏守卫（rate-limit pacing）
//
// 设计动机
// --------
// 把"命令间随机间隔"从 prose 规则变成代码强制。
// 过去间隔只写在 7 份 .md 里（且漂移出 40-55s / 45-180s / 60s 三套数字），
// agent 受 harness 默认（并行、避免长 sleep）影响会跳过。现在写命令入口直接 enforceDelay，
// 即便 agent 裸调 `node cli.js post`，命令自己也阻塞到达标 —— 跳不掉。
//
// 间隔的单一事实源 = config.json:intervals。
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

const path = require('path');

// 默认间隔（秒）。与 config.example.json:intervals 保持一致。
const DEFAULT_INTERVALS = {
  write: [40, 55],
  read:  [30, 50],
};

// 写操作命令名（对应 events.command 列；like 与 unlike 分开记录）
const WRITE_COMMANDS = new Set(['post', 'like', 'unlike', 'delete_comment']);

let _config = null;

function loadConfig() {
  if (_config) return _config;
  try {
    _config = require('../config.json');
  } catch (e) {
    _config = {};
  }
  return _config;
}

/** 读取间隔配置，缺省回退默认。 */
function getIntervals() {
  const cfg = loadConfig();
  const iv = cfg && cfg.intervals ? cfg.intervals : {};
  return {
    write: normalizeRange(iv.write, DEFAULT_INTERVALS.write),
    read:  normalizeRange(iv.read,  DEFAULT_INTERVALS.read),
  };
}

function normalizeRange(v, fallback) {
  if (Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'number' && x > 0)) {
    return v[0] <= v[1] ? [v[0], v[1]] : [v[1], v[0]];
  }
  return fallback;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, Math.max(0, ms)));
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * 查 events 表最近一次写操作（post/like/unlike/delete_comment）的成功时间戳（ms）。
 *
 * 多账号下按账号分桶：每个账号有自己的节奏下限，A 号刚发完不该让 B 号跟着一起等。
 * 未指定账号时（account 为 null）只看未归属的历史记录。
 * 无记录或 SQL 失败返回 0。
 * @param {string|null} [account] 平台 uid
 */
function lastWriteTs(account = null) {
  try {
    const { getDb } = require('./memory/db');
    const db = getDb();
    const row = account
      ? db.prepare(`
          SELECT max(ts) AS ms FROM events
          WHERE platform = 'douyin'
            AND command IN ('post', 'like', 'unlike', 'delete_comment')
            AND status = 'success'
            AND account = ?
        `).get(account)
      : db.prepare(`
          SELECT max(ts) AS ms FROM events
          WHERE platform = 'douyin'
            AND command IN ('post', 'like', 'unlike', 'delete_comment')
            AND status = 'success'
            AND account IS NULL
        `).get();
    return (row && row.ms) || 0;
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[risk-control.lastWriteTs] failed:', e.message);
    return 0;
  }
}

/**
 * 返回距下次允许写操作还需等待的毫秒数（0 = 可立即执行）。
 * @param {string|null} [account]
 */
function msUntilNextWrite(account = null) {
  const [minSec] = getIntervals().write;
  const minMs = minSec * 1000;
  const last = lastWriteTs(account);
  if (!last) return 0;
  const elapsed = Date.now() - last;
  return Math.max(0, minMs - elapsed);
}

function shouldBypass(opts = {}) {
  return opts.force === true || process.env.DOUYIN_NO_THROTTLE === '1';
}

/**
 * 强制等待到下次写操作允许。被写命令入口 await 调用。
 * @param {'write'|'read'} type
 * @param {object} opts - { force: boolean 跳过节流, account: string|null 按账号分桶 }
 * @returns {Promise<{skipped:boolean, waitedMs:number, lastWriteTs:number, intervals:number[]}>}
 */
async function enforceDelay(type = 'write', opts = {}) {
  const intervals = getIntervals()[type] || DEFAULT_INTERVALS.write;
  const account = opts.account || null;

  if (shouldBypass(opts)) {
    return { skipped: true, waitedMs: 0, lastWriteTs: lastWriteTs(account), intervals };
  }

  // 读操作：advisory，不阻塞（见文件头说明）
  if (type !== 'write') {
    return { skipped: false, waitedMs: 0, advisory: true, intervals };
  }

  // 写操作：硬强制
  const t0 = Date.now();
  const last = lastWriteTs(account);

  // 1) 硬性下限：该账号距上次写至少 minSec 秒
  const need = msUntilNextWrite(account);
  if (need > 0) {
    const sinceLast = last ? Math.round((Date.now() - last) / 1000) : 0;
    const who = account ? `账号 ${account} ` : '';
    console.error(`⏳ [risk-control] ${who}距上次写仅 ${sinceLast}s，强制等待 ${Math.ceil(need / 1000)}s（下限 ${intervals[0]}s）...`);
    await sleep(need);
  }

  // 2) 叠加随机量，让总间隔落在 [min, max]
  const lastAfterFloor = lastWriteTs(account);
  const elapsedSec = lastAfterFloor ? (Date.now() - lastAfterFloor) / 1000 : intervals[1];
  if (elapsedSec < intervals[1]) {
    const targetTotal = randomInt(intervals[0], intervals[1]);
    const extra = Math.max(0, Math.round(targetTotal - elapsedSec));
    if (extra > 0) {
      console.error(`⏳ [risk-control] 叠加随机节奏，再等 ${extra}s（目标总间隔 ${targetTotal}s）...`);
      await sleep(extra * 1000);
    }
  }

  return { skipped: false, waitedMs: Date.now() - t0, lastWriteTs: last || lastAfterFloor, intervals };
}

/**
 * preflight 自检：不阻塞，只报告状态。供 `node cli.js preflight <cmd>` 与 agent 自检用。
 * @param {string} command
 */
function preflight(command, account = null) {
  const isWrite = ['post', 'like', 'unlike', 'delete-comment', 'delete_comment'].includes(command);
  const intervals = getIntervals();

  if (!isWrite) {
    return {
      command, type: 'read', ok: true,
      message: `读操作，建议命令间间隔 ${intervals.read[0]}-${intervals.read[1]}s（advisory，由 agent 自行遵守）`,
      intervals: intervals.read,
    };
  }

  const need = msUntilNextWrite(account);
  const last = lastWriteTs(account);
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
// P4 自适应风控（Campaign 推广引擎用）
// ═══════════════════════════════════════════════════════════

/**
 * 近 windowMs 内是否有 post 失败且错误码为风控拦截（status_code=8/2053）。
 */
function hasRecentRiskBlock(windowMs = 300000, account = null) {
  try {
    const { getDb } = require('./memory/db');
    const db = getDb();
    const since = Date.now() - windowMs;
    // 风控拦截是账号级的：A 号被拦不该把 B 号也一起停掉
    const row = account
      ? db.prepare(`
          SELECT 1 AS hit FROM events
          WHERE platform = 'douyin' AND command = 'post' AND status = 'error'
            AND (error LIKE '%status_code=8%' OR error LIKE '%status_code=2053%')
            AND ts >= ? AND account = ?
          LIMIT 1
        `).get(since, account)
      : db.prepare(`
          SELECT 1 AS hit FROM events
          WHERE platform = 'douyin' AND command = 'post' AND status = 'error'
            AND (error LIKE '%status_code=8%' OR error LIKE '%status_code=2053%')
            AND ts >= ? AND account IS NULL
          LIMIT 1
        `).get(since);
    return !!row;
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[risk-control.hasRecentRiskBlock] failed:', e.message);
    return false;
  }
}

/**
 * 某活动当日的发布配额使用情况。
 * @returns {{postedToday:number, dailyQuota:number}}
 */
function dailyQuotaUsage(campaignId) {
  try {
    const { getDb } = require('./memory/db');
    const db = getDb();
    const camp = db.prepare('SELECT daily_quota FROM campaigns WHERE id = ?').get(campaignId);
    if (!camp) return { postedToday: 0, dailyQuota: 0 };
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const r = db.prepare(`
      SELECT count(*) AS n FROM campaign_tasks
      WHERE campaign_id = ? AND outcome = 'posted' AND executed_at >= ?
    `).get(campaignId, startToday);
    return { postedToday: r.n, dailyQuota: camp.daily_quota };
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[risk-control.dailyQuotaUsage] failed:', e.message);
    return { postedToday: 0, dailyQuota: 0 };
  }
}

/**
 * 自适应发布间隔（roadmap §6.3）：
 *   base(60s) × 1.5（近 5min 有 status_code=8）× 2.0（当日已发 ≥ daily_quota*0.7）+ jitter(±15%)
 * @returns {{intervalMs:number, baseMs:number, multiplier:number, reasons:string[]}}
 */
function adaptiveInterval(campaignId, opts = {}) {
  const base = opts.baseMs || 60000;
  let mult = 1.0;
  const reasons = [];

  if (hasRecentRiskBlock(opts.riskWindowMs || 300000, opts.account || null)) {
    mult *= 1.5;
    reasons.push('recent_status_code_8 ×1.5');
  }
  if (campaignId) {
    const u = dailyQuotaUsage(campaignId);
    if (u.dailyQuota > 0 && u.postedToday >= u.dailyQuota * 0.7) {
      mult *= 2.0;
      reasons.push(`daily_quota ${u.postedToday}/${u.dailyQuota} ≥70% ×2.0`);
    }
  }
  const jittered = base * mult * (1 + (Math.random() * 2 - 1) * 0.15);
  return { intervalMs: Math.round(jittered), baseMs: base, multiplier: mult, reasons };
}

/**
 * 发布前预检（roadmap §6.3 发布前查询）。
 * @param {object} o - { cid?, uid?, replyText?, account? }
 * @returns {{ok:boolean, blockers:Array<{reason:string, action:'skip'|'rewrite'|'postpone'}>}}
 */
function preflightPublish({ cid, uid, replyText, account } = {}) {
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
    if (hasRecentRiskBlock(300000, account || null)) blockers.push({ reason: 'recent_status_block_5min', action: 'postpone' });
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[risk-control.preflightPublish] failed:', e.message);
  }
  return { ok: blockers.length === 0, blockers };
}

module.exports = {
  enforceDelay,
  preflight,
  msUntilNextWrite,
  lastWriteTs,
  getIntervals,
  DEFAULT_INTERVALS,
  WRITE_COMMANDS,
  // P4 自适应风控
  hasRecentRiskBlock,
  dailyQuotaUsage,
  adaptiveInterval,
  preflightPublish,
};
