// lib/commands/events.js — 原始事件流查看（v3 调试 / 运维入口）
//
// 与 cmdLog 的区别：
// - cmdLog 偏向"操作日志可读视图"，输出格式紧凑
// - cmdEvents 直接 dump SQLite 行（含 ts / sessionId / id 等内部字段），便于诊断
//
// 用法：
//   node cli.js events                              最近 20 条
//   node cli.js events --tail 100
//   node cli.js events --video <id>
//   node cli.js events --uid <uid>
//   node cli.js events --cmd post --status error    所有失败的发表操作
//   node cli.js events --since <ms-or-iso>          时间下界
//   node cli.js events --json                       原始 JSON（便于管道）

const { getFlag } = require('./helpers');
const events = require('../memory/events');

async function cmdEvents(ctx, args) {
  const tail = getFlag(args, '--tail', 20);
  const videoId = getFlag(args, '--video', null);
  const uid = getFlag(args, '--uid', null);
  const command = getFlag(args, '--cmd', null);
  const status = getFlag(args, '--status', null);
  const sinceArg = getFlag(args, '--since', null);
  const asJson = args.includes('--json');

  const filters = {};
  if (videoId) filters.awemeId = videoId;
  if (uid) filters.uid = uid;
  if (command) filters.command = command;
  if (status) filters.status = status;
  if (sinceArg != null) filters.since = parseSince(sinceArg);

  // 拿 desc 再 reverse 成升序展示
  const rows = events.query(filters, { limit: Math.max(tail, 1), order: 'desc' }).reverse();

  if (asJson) {
    return rows;
  }

  if (rows.length === 0) {
    console.log('No matching events.');
    return;
  }

  for (const r of rows) {
    const icon = r.status === 'success' ? '✅' : (r.status === 'error' ? '❌' : '⚙️');
    const time = new Date(r.ts).toISOString().substring(0, 19);
    const dur = r.durationMs != null ? `${r.durationMs}ms` : '—';
    const tags = [];
    if (r.awemeId) tags.push(`v=${r.awemeId}`);
    if (r.uid) tags.push(`u=${r.uid}`);
    if (r.cid) tags.push(`c=${r.cid}`);
    console.log(`#${r.id} ${icon} [${time}] ${r.command} (${dur}) ${tags.join(' ')}`);
    if (r.summary && Object.keys(r.summary).length) console.log(`   summary: ${JSON.stringify(r.summary)}`);
    if (r.error) console.log(`   error:   ${r.error}`);
    if (r.resultPath) console.log(`   result:  ${r.resultPath}`);
  }
}

function parseSince(s) {
  // 数字 → ms 时间戳；ISO 字符串 → Date.parse；纯数字十位 → 视作秒
  if (typeof s === 'number') return s;
  const numeric = Number(s);
  if (!Number.isNaN(numeric)) {
    return s.length <= 10 ? numeric * 1000 : numeric;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

module.exports = cmdEvents;
