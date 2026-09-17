// lib/commands/corpus.js — 回复语料库管理（v3 P3）
//
// 用法：
//   node cli.js corpus search <keyword> [--limit N]
//   node cli.js corpus recent [--limit N] [--video <aweme_id>]
//   node cli.js corpus stats                 # 总数 / 各 outcome 计数
//
// 暂不支持人工录入：reply_corpus 由 cmdPost 成功后自动写入。
// 后续 P4 可加 set-outcome / set-effectiveness 子命令。

const corpus = require('../memory/corpus');
const { getFlag } = require('./helpers');

async function cmdCorpus(ctx, args) {
  const sub = args[0];
  if (!sub) {
    throw new Error('用法: node cli.js corpus <search|recent|stats> [...]');
  }

  ctx.audit.startOperation('corpus', { sub });

  let result;
  switch (sub) {
    case 'search': {
      const kw = args[1];
      if (!kw || kw.startsWith('--')) {
        throw new Error('用法: node cli.js corpus search <keyword> [--limit N]');
      }
      const limit = getFlag(args, '--limit', 50);
      result = corpus.search(kw, { limit });
      break;
    }
    case 'recent': {
      const limit = getFlag(args, '--limit', 20);
      const video = getFlag(args, '--video', null);
      result = corpus.recent({ limit, awemeId: video || undefined });
      break;
    }
    case 'stats': {
      result = {
        total: corpus.count(),
        published: corpus.count({ outcome: 'published' }),
        risk_blocked: corpus.count({ outcome: 'risk_blocked' }),
        deleted: corpus.count({ outcome: 'deleted' }),
      };
      break;
    }
    default:
      throw new Error(`未知子命令: corpus ${sub}（可选: search / recent / stats）`);
  }

  ctx.audit.endOperation('success', {
    sub,
    count: Array.isArray(result) ? result.length : undefined,
  }, null);
  return result;
}

module.exports = cmdCorpus;
