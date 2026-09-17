// lib/commands/failures.js — 失败模式查看（v3 P3）
//
// 用法：
//   node cli.js failures                      # top 10
//   node cli.js failures --limit N
//   node cli.js failures --recent             # 按 last_hit DESC
//   node cli.js failures --mitigate <signature> "<text>"   # 设置缓解措施

const failures = require('../memory/failures');
const { getFlag } = require('./helpers');

async function cmdFailures(ctx, args) {
  const limit = getFlag(args, '--limit', 10);
  const wantRecent = args.includes('--recent');
  const mitigateIdx = args.indexOf('--mitigate');

  ctx.audit.startOperation('failures', {
    limit, recent: wantRecent, mitigate: mitigateIdx >= 0,
  });

  if (mitigateIdx >= 0) {
    const sig = args[mitigateIdx + 1];
    const text = args[mitigateIdx + 2];
    if (!sig || !text) {
      const err = new Error('用法: node cli.js failures --mitigate <signature> "<缓解措施>"');
      ctx.audit.endOperation('error', {}, null, err.message);
      throw err;
    }
    const ok = failures.setMitigation(sig, text);
    ctx.audit.endOperation('success', { signature: sig, ok }, null);
    return { signature: sig, mitigation: text, ok };
  }

  const list = wantRecent ? failures.recent(limit) : failures.top(limit);
  ctx.audit.endOperation('success', { count: list.length }, null);
  return list;
}

module.exports = cmdFailures;
