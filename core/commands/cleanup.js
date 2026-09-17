// lib/commands/cleanup.js — 清理过期记忆（TTL）
//
// events / comments / reply_corpus 表无界增长的兜底：按 last_seen / posted_at / ts
// 清理早于 cutoff 的行。默认保留 90 天，--dry-run 只计数不删。

const events = require('../memory/events');
const comments = require('../memory/comments');
const corpus = require('../memory/corpus');
const { withAudit } = require('./helpers');

async function cmdCleanup(ctx, args) {
  const daysIdx = args.indexOf('--days');
  const days = daysIdx >= 0 && args[daysIdx + 1] && !args[daysIdx + 1].startsWith('--')
    ? Number(args[daysIdx + 1]) : 90;
  const dryRun = args.includes('--dry-run');
  const cutoff = Date.now() - days * 86400000;

  return withAudit(ctx, 'cleanup', { days, dry_run: dryRun, cutoff }, async () => {
    const tasks = [
      { name: 'events', mod: events },
      { name: 'comments', mod: comments },
      { name: 'corpus', mod: corpus },
    ];
    const result = {};
    for (const t of tasks) {
      if (typeof t.mod.cleanupBefore !== 'function') { result[t.name] = { skipped: true }; continue; }
      const n = t.mod.cleanupBefore(cutoff, { dryRun, limit: 1000 });
      result[t.name] = dryRun ? { would_delete: n } : { deleted: n };
      console.error(`[cleanup] ${t.name}: ${dryRun ? 'would delete' : 'deleted'} ${n}`);
    }

    return { summary: result, result: { result }, output: result };
  });
}

module.exports = cmdCleanup;
