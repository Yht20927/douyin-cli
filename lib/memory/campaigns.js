// lib/memory/campaigns.js — P4 推广引擎记忆层
//
// campaigns 表：一次推广活动（目标视频/模板/配额/状态机）
// campaign_tasks 表：活动下待执行的回复任务（cid 唯一去重，outcome 状态机）
//
// 状态机：campaign.status = draft → running ⇄ paused → done
//         task.outcome = pending → posted / failed / skipped

const { getDb } = require('./db');

const VALID_STATUS = ['draft', 'running', 'paused', 'done'];
const VALID_OUTCOME = ['pending', 'posted', 'failed', 'skipped'];

function safeParse(s) {
  try { return s ? JSON.parse(s) : null; } catch (e) { return null; }
}

function rowToCampaign(r) {
  if (!r) return null;
  return {
    id: r.id,
    platform: r.platform,
    name: r.name,
    goal: r.goal,
    template: safeParse(r.template_json),
    videos: safeParse(r.videos_json),
    filters: safeParse(r.filters_json),
    dailyQuota: r.daily_quota,
    perUserQuota: r.per_user_quota,
    status: r.status,
    account: r.account || null,
    startedAt: r.started_at,
    stats: safeParse(r.stats_json),
  };
}

function rowToTask(r) {
  if (!r) return null;
  return {
    id: r.id,
    campaignId: r.campaign_id,
    cid: r.cid,
    awemeId: r.aweme_id,
    replyText: r.reply_text,
    scheduledAt: r.scheduled_at,
    executedAt: r.executed_at,
    outcome: r.outcome,
    failureReason: r.failure_reason,
  };
}

/**
 * 创建活动。
 * @param {object} c - { name, goal?, template?, videos?, filters?, dailyQuota?, perUserQuota?, account? }
 *   account: 该活动用哪个账号发布。daemon 是独立子进程，靠这一列恢复身份。
 */
function create(c) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO campaigns (platform, name, goal, template_json, videos_json, filters_json, daily_quota, per_user_quota, status, account)
    VALUES ('douyin', @name, @goal, @templateJson, @videosJson, @filtersJson, @dailyQuota, @perUserQuota, 'draft', @account)
  `).run({
    name: c.name,
    goal: c.goal || null,
    templateJson: c.template != null ? JSON.stringify(c.template) : null,
    videosJson: c.videos != null ? JSON.stringify(c.videos) : null,
    filtersJson: c.filters != null ? JSON.stringify(c.filters) : null,
    dailyQuota: c.dailyQuota ?? 50,
    perUserQuota: c.perUserQuota ?? 1,
    account: c.account || null,
  });
  return get(info.lastInsertRowid);
}

function get(id) {
  const db = getDb();
  return rowToCampaign(db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(id));
}

function list(opts = {}) {
  const db = getDb();
  const where = ['platform = ?'];
  const params = ['douyin'];
  if (opts.status) { where.push('status = ?'); params.push(opts.status); }
  const rows = db.prepare(`SELECT * FROM campaigns WHERE ${where.join(' AND ')} ORDER BY id DESC`).all(...params);
  return rows.map(rowToCampaign);
}

function updateStatus(id, status) {
  if (!VALID_STATUS.includes(status)) throw new Error(`invalid status: ${status}`);
  const db = getDb();
  if (status === 'running') {
    db.prepare(`UPDATE campaigns SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`).run(Date.now(), id);
  } else {
    db.prepare(`UPDATE campaigns SET status = ? WHERE id = ?`).run(status, id);
  }
  if (status === 'done') {
    // 完成时刷新 stats 快照
    setStats(id, countByOutcome(id));
  }
  return get(id);
}

function setStats(id, stats) {
  const db = getDb();
  db.prepare(`UPDATE campaigns SET stats_json = ? WHERE id = ?`).run(JSON.stringify(stats), id);
  return get(id);
}

/**
 * upsert 任务。UNIQUE(campaign_id, cid) 命中时 IGNORE（幂等，重复 plan 不重复入）。
 * @returns {boolean} 是否新插入
 */
function taskUpsert(t) {
  const db = getDb();
  const info = db.prepare(`
    INSERT OR IGNORE INTO campaign_tasks (campaign_id, cid, aweme_id, reply_text, scheduled_at, outcome)
    VALUES (@campaignId, @cid, @awemeId, @replyText, @scheduledAt, 'pending')
  `).run({
    campaignId: t.campaignId,
    cid: t.cid,
    awemeId: t.awemeId || null,
    replyText: t.replyText || null,
    scheduledAt: t.scheduledAt ?? null,
  });
  return info.changes > 0;
}

function taskUpsertMany(tasks) {
  const db = getDb();
  let inserted = 0;
  const tx = db.transaction((ts) => {
    for (const t of ts) if (taskUpsert(t)) inserted++;
  });
  tx(tasks);
  return { total: tasks.length, inserted };
}

function getDue(campaignId, opts = {}) {
  const db = getDb();
  const limit = Math.max(1, Math.min(opts.limit || 50, 500));
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM campaign_tasks
    WHERE campaign_id = ? AND outcome = 'pending'
      AND (scheduled_at IS NULL OR scheduled_at <= ?)
    ORDER BY COALESCE(scheduled_at, 0) ASC
    LIMIT ?
  `).all(campaignId, now, limit);
  return rows.map(rowToTask);
}

function listTasks(campaignId, opts = {}) {
  const db = getDb();
  const where = ['campaign_id = ?'];
  const params = [campaignId];
  if (opts.outcome) { where.push('outcome = ?'); params.push(opts.outcome); }
  const rows = db.prepare(`SELECT * FROM campaign_tasks WHERE ${where.join(' AND ')} ORDER BY id ASC`).all(...params);
  return rows.map(rowToTask);
}

function markExecuted(taskId, outcome, failureReason = null) {
  if (!VALID_OUTCOME.includes(outcome)) throw new Error(`invalid outcome: ${outcome}`);
  const db = getDb();
  db.prepare(`
    UPDATE campaign_tasks
    SET executed_at = ?, outcome = ?, failure_reason = ?
    WHERE id = ?
  `).run(Date.now(), outcome, failureReason, taskId);
  return getTask(taskId);
}

function getTask(taskId) {
  const db = getDb();
  return rowToTask(db.prepare(`SELECT * FROM campaign_tasks WHERE id = ?`).get(taskId));
}

function countByOutcome(campaignId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT outcome, count(*) AS n FROM campaign_tasks
    WHERE campaign_id = ? GROUP BY outcome
  `).all(campaignId);
  const out = { pending: 0, posted: 0, failed: 0, skipped: 0 };
  for (const r of rows) out[r.outcome] = r.n;
  out.total = out.pending + out.posted + out.failed + out.skipped;
  return out;
}

module.exports = {
  create, get, list, updateStatus, setStats,
  taskUpsert, taskUpsertMany, getDue, listTasks, markExecuted, getTask, countByOutcome,
  VALID_STATUS, VALID_OUTCOME,
};
