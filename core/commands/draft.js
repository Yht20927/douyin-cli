// lib/commands/draft.js — 回复草稿管理
//
// 用法：
//   node cli.js draft list [--video <aweme_id>]           列出草稿
//   node cli.js draft save <aweme_id> "文本" [--reply-to <cid>] [--persona <id>]
//   node cli.js draft show <draft_id>               查看草稿
//   node cli.js draft post <draft_id>               发布草稿
//   node cli.js draft delete <draft_id>             删除草稿

const drafts = require('../memory/drafts');
const { getFlag } = require('./helpers');

async function cmdDraft(ctx, args) {
  const sub = args[0];
  if (!sub) throw new Error('用法: node cli.js draft <list|save|show|post|delete> [...]');

  switch (sub) {
    case 'list': {
      const awemeId = getFlag(args, '--video', null);
      const items = drafts.list({ awemeId, posted: false });
      if (items.length === 0) {
        console.error('没有待发布的草稿');
        return [];
      }
      for (const d of items) {
        const ts = new Date(d.created_at).toISOString().substring(0, 16);
        console.error(`#${d.id} [${ts}] ${d.aweme_id}${d.reply_to_cid ? ' → ' + d.reply_to_cid : ''}: ${d.text.substring(0, 50)}`);
      }
      return items.map(d => ({ id: d.id, aweme_id: d.aweme_id, reply_to_cid: d.reply_to_cid, text: d.text, persona_id: d.persona_id, created_at: d.created_at, posted: d.posted }));
    }

    case 'save': {
      const awemeId = args[1];
      const text = args[2];
      if (!awemeId || !text) throw new Error('用法: node cli.js draft save <aweme_id> "文本" [--reply-to <cid>] [--persona <id>]');
      const id = drafts.save({
        awemeId,
        text,
        replyToCid: getFlag(args, '--reply-to', null),
        personaId: getFlag(args, '--persona', null),
      });
      console.error(`草稿已保存 #${id}`);
      return { id };
    }

    case 'show': {
      const id = args[1];
      if (!id) throw new Error('用法: node cli.js draft show <draft_id>');
      const d = drafts.get(Number(id));
      if (!d) throw new Error(`草稿 #${id} 不存在`);
      console.error(JSON.stringify(d, null, 2));
      return { id: d.id, aweme_id: d.aweme_id, reply_to_cid: d.reply_to_cid, text: d.text, persona_id: d.persona_id, created_at: d.created_at, posted: d.posted };
    }

    case 'post': {
      const id = args[1];
      if (!id) throw new Error('用法: node cli.js draft post <draft_id>');
      const d = drafts.get(Number(id));
      if (!d) throw new Error(`草稿 #${id} 不存在`);
      if (d.posted) throw new Error(`草稿 #${id} 已发布过`);

      const postArgs = [d.aweme_id, d.text];
      if (d.reply_to_cid) postArgs.push('--reply-to', d.reply_to_cid);
      const result = await ctx.cmdPost(postArgs);
      drafts.markPosted(Number(id));
      console.error(`草稿 #${id} 已发布`);
      return result;
    }

    case 'delete': {
      const id = args[1];
      if (!id) throw new Error('用法: node cli.js draft delete <draft_id>');
      drafts.remove(Number(id));
      console.error(`草稿 #${id} 已删除`);
      return { deleted: true };
    }

    default:
      throw new Error(`未知子命令: ${sub}。可用: list, save, show, post, delete`);
  }
}

module.exports = cmdDraft;
