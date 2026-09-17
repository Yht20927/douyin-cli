// lib/commands/log.js — 操作日志查看（v3：SQLite events 优先 + audit.json 回退）

const { getFlag } = require('./helpers');
const events = require('../memory/events');

/**
 * 查看操作日志
 * @param {object} ctx - { audit }
 * @param {string[]} args - [--tail N, --video <id>, --uid <uid>, --command <cmd>, --failed]
 *
 * v3 起优先从 SQLite events 表读取（毫秒级响应，无 50 session 截断）；
 * 若 SQL 路径失败或返回空，回退到 audit.json 全表扫，保持 v2 兼容。
 */
async function cmdLog(ctx, args) {
  const tail = getFlag(args, '--tail', 10);
  const videoId = getFlag(args, '--video', null);
  const uid = getFlag(args, '--uid', null);
  const command = getFlag(args, '--command', null);
  const failedOnly = args.includes('--failed');

  // SQL 路径：events 表存在且至少有一行匹配（即使 0 命中也算 SQL 在工作 → 不回退）
  // 但当**整个 events 表为空**时，应回退到 audit.json（兼容 v3 之前的存量历史）
  const events_module = require('../memory/events');
  const totalEvents = events_module.count();
  const useSql = totalEvents > 0;

  const ops = useSql
    ? readEvents({ videoId, uid, command, failedOnly, tail }) || readAuditJson(ctx, { videoId, uid, command, failedOnly })
    : readAuditJson(ctx, { videoId, uid, command, failedOnly });

  const recent = ops.slice(-tail);

  for (const op of recent) {
    const icon = op.status === 'success' ? '✅' : (op.status === 'error' ? '❌' : '⚙️');
    const dur = op.durationMs != null ? `${(op.durationMs / 1000).toFixed(1)}s` : '—';
    const startStr = op.started ? op.started.substring(0, 19) : (op.ts ? new Date(op.ts).toISOString().substring(0, 19) : '?');
    // args 缺失时合成一个最小可见对象，包含 awemeId / uid / cid 用于过滤验证
    const argsView = op.args && Object.keys(op.args).length
      ? op.args
      : pickIds(op);
    console.log(`${icon} [${startStr}] ${op.command} ${JSON.stringify(argsView)} ${dur}`);
    if (op.summary && Object.keys(op.summary).length) {
      console.log(`   summary: ${JSON.stringify(op.summary)}`);
    }
    if (op.error) console.log(`   error: ${op.error}`);
    if (op.resultPath || op.resultFile) console.log(`   result: ${op.resultPath || op.resultFile}`);
  }
  if (recent.length === 0) console.log('No matching operations found.');
}

/** 当 args 为空但行级有 awemeId/uid/cid 时合成显示，便于人眼和过滤验证 */
function pickIds(op) {
  const o = {};
  if (op.awemeId) o.aweme_id = op.awemeId;
  if (op.uid) o.uid = op.uid;
  if (op.cid) o.cid = op.cid;
  return o;
}

/** 从 events 表读取并归一化为 cmdLog 需要的形状。返回 null 表示路径不可用，由 caller 回退。 */
function readEvents({ videoId, uid, command, failedOnly, tail }) {
  try {
    const filters = {};
    if (videoId) filters.awemeId = videoId;
    if (uid) filters.uid = uid;
    if (command) filters.command = command;
    if (failedOnly) filters.status = 'error';
    // 先按 desc 取 tail 行（确保拿到最新），再 reverse 成升序方便 .slice(-tail)
    const rows = events.query(filters, { limit: Math.max(tail * 4, 100), order: 'desc' });
    if (!rows) return null;
    if (rows.length === 0) return [];
    return rows
      .map(r => ({
        command: r.command,
        status: r.status,
        durationMs: r.durationMs,
        args: r.args,
        summary: r.summary,
        error: r.error,
        resultPath: r.resultPath,
        ts: r.ts,
        started: new Date(r.ts).toISOString(),
        awemeId: r.awemeId,
        uid: r.uid,
        cid: r.cid,
      }))
      .reverse(); // 升序：旧 → 新，匹配 v2 的输出顺序
  } catch (e) {
    return null;
  }
}

/** 兼容 v2：audit.json 全表扫 */
function readAuditJson(ctx, { videoId, uid, command, failedOnly }) {
  const a = ctx.audit.load();
  const ops = [];
  for (const s of (a.sessions || [])) {
    for (const op of (s.operations || [])) {
      if (videoId && op.args?.aweme_id !== videoId) continue;
      if (uid && op.args?.uid !== uid) continue;
      if (command && op.command !== command) continue;
      if (failedOnly && op.status !== 'error') continue;
      ops.push(op);
    }
  }
  return ops;
}

module.exports = cmdLog;
