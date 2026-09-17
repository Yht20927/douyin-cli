// lib/commands/getReply.js — 生成评论/回复（LLM 驱动）
//
// 调用 ReplyEngine 生成评论文本并输出。
// 默认模式：仅生成文本，不执行任何平台操作（用户审核后自行 post）。
// --interactive 模式：交互式审核后可选择发布。
//
// 用法：
//   node cli.js getReply <aweme_id>                    生成视频的顶级评论
//   node cli.js getReply <aweme_id> <cid>              生成对特定评论的回复
//   node cli.js getReply <aweme_id> --count 3          生成多条候选评论
//   node cli.js getReply <aweme_id> --persona casual_friend  指定人格
//   node cli.js getReply <aweme_id> --batch             批量生成回复（对视频下所有未回复评论）

const fs = require('fs');
const path = require('path');
const { getFlag } = require('./helpers');

let memComments = null;
function commentsModule() {
  if (memComments === null) {
    try { memComments = require('../memory/comments'); }
    catch (_) { memComments = false; }
  }
  return memComments || null;
}

let memUsers = null;
function usersModule() {
  if (memUsers === null) {
    try { memUsers = require('../memory/users'); }
    catch (_) { memUsers = false; }
  }
  return memUsers || null;
}

/** 从 users 表加载用户标签，用于个性化回复 */
function _loadUserTags(uid) {
  if (!uid) return [];
  try {
    const um = usersModule();
    if (!um) return [];
    const u = um.get(uid);
    return u?.tags || [];
  } catch (_) { return []; }
}

/** 从 ReplyEngine 结果中剥离内部调试上下文 */
function stripContext(result) {
  if (!result || typeof result !== 'object') return result;
  if (process.env.DOUYIN_DEBUG === '1') return result;
  const { context, scopedContext, ...clean } = result;
  for (const key of ['replies', 'comments']) {
    if (Array.isArray(clean[key])) {
      clean[key] = clean[key].map(item => {
        if (typeof item !== 'object' || !item) return item;
        const { context: _c, ...rest } = item;
        return rest;
      });
    }
  }
  if (clean.reply && typeof clean.reply === 'object') {
    const { context: _c, ...rest } = clean.reply;
    clean.reply = rest;
  }
  return clean;
}

/** 读取策略文件 */
function readStrategy() {
  try {
    return fs.readFileSync(path.join(process.cwd(), 'reply-strategy.md'), 'utf8');
  } catch (_) { return ''; }
}

/** 从 SQLite 加载评论 */
function loadComment(cid) {
  const cm = commentsModule();
  if (!cm) return null;
  try { return cm.get(cid); } catch (_) { return null; }
}

/** 从 SQLite 加载视频的未回复评论（过滤作者自己的评论和已回复的） */
function loadUnrepliedComments(awemeId, limit = 20) {
  const cm = commentsModule();
  if (!cm) return [];
  try {
    const all = cm.listByVideo(awemeId, { replied: false });
    // 获取作者 uid：通过 videos 表的 isMine + authorUid 或评论频率推断
    let authorUid = null;
    try {
      const videos = require('../memory/videos');
      const v = videos.get(awemeId);
      if (v && v.isMine) {
        // 优先用已存储的 authorUid
        if (v.authorUid) {
          authorUid = v.authorUid;
        } else {
          // 启发式：作者是该视频下评论最多的 uid
          const allComments = cm.listByVideo(awemeId, { limit: 200 });
          const uidCounts = {};
          for (const c of allComments) {
            if (c.uid) uidCounts[c.uid] = (uidCounts[c.uid] || 0) + 1;
          }
          let maxUid = null, maxCount = 0;
          for (const [uid, cnt] of Object.entries(uidCounts)) {
            if (cnt > maxCount) { maxCount = cnt; maxUid = uid; }
          }
          // 只有显著多于第二名（≥5倍）才认为是作者
          if (maxUid && maxCount >= 5) {
            authorUid = maxUid;
            // 回写 videos 表
            try { videos.upsert({ awemeId, authorUid: maxUid }); } catch (_) {}
          }
        }
      }
    } catch (_) {}
    // 过滤：去除作者自己的评论（避免自己回复自己）
    const filtered = authorUid
      ? all.filter(c => c.uid !== authorUid)
      : all;
    return filtered.slice(0, limit);
  }
  catch (_) { return []; }
}

/** 提取位置参数（跳过 --flag 及其值） */
function positionalArgs(args) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) i++;
      continue;
    }
    result.push(args[i]);
  }
  return result;
}

/** 交互式审核 */
async function interactiveReply(engine, opts, ctx) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

  const ask = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

  let result = await engine.generateReply(opts);
  let attempt = 0;
  const maxAttempts = 3;

  while (true) {
    console.error(`\n→ ${result.reply.text}`);
    const answer = await ask('\n[y]发布 [e]编辑 [r]重生成 [n]跳过: ');

    if (answer === 'y') {
      rl.close();
      return { action: 'post', reply: result.reply };
    } else if (answer === 'e') {
      const edited = await ask('输入新文本: ');
      if (edited.trim()) {
        result.reply.text = edited.trim();
        console.error('已更新为:', result.reply.text);
      }
      const confirm = await ask('[y]发布编辑后的文本 [n]取消: ');
      if (confirm === 'y') {
        rl.close();
        return { action: 'post', reply: result.reply };
      }
    } else if (answer === 'r') {
      attempt++;
      if (attempt >= maxAttempts) {
        console.error('已达到最大重试次数');
        rl.close();
        return { action: 'skip', reply: result.reply };
      }
      console.error('重新生成中...');
      const currentPersona = result.reply?.persona?.id;
      if (currentPersona) {
        const { pickPersona } = require('../personas');
        const newPersona = pickPersona({ excludeId: currentPersona });
        opts.persona = newPersona;
      }
      result = await engine.generateReply(opts);
    } else {
      rl.close();
      return { action: 'skip', reply: result.reply };
    }
  }
}

async function cmdGetReply(ctx, args) {
  const posArgs = positionalArgs(args);
  const awemeId = posArgs[0];
  if (!awemeId) {
    throw new Error(
      '用法:\n' +
      '  node cli.js getReply <aweme_id>                    生成视频的顶级评论\n' +
      '  node cli.js getReply <aweme_id> <cid>              生成对特定评论的回复\n' +
      '  node cli.js getReply <aweme_id> --count N           生成多条候选\n' +
      '  node cli.js getReply <aweme_id> --persona <id>      指定人格\n' +
      '  node cli.js getReply <aweme_id> --batch             批量生成回复\n' +
      '  node cli.js getReply <aweme_id> <cid> --interactive  交互式审核（生成→编辑→发布）'
    );
  }

  const cid = posArgs[1] || null;
  const rawCount = getFlag(args, '--count', 1);
  const count = Number.isFinite(rawCount) && rawCount >= 1 ? rawCount : 1;
  const persona = getFlag(args, '--persona', 'auto');
  const batch = args.includes('--batch');
  const interactive = args.includes('--interactive');
  const strategy = readStrategy();

  ctx.audit.startOperation('getReply', { aweme_id: awemeId, cid, count, persona, batch });

  const { ReplyEngine } = require('../reply-engine');
  const engine = new ReplyEngine({
    llm: ctx.config.llm || {},
    bridgeCall: ctx.bridgeCall ? (expr) => ctx.bridgeCall(expr) : null,
  });

  if (batch) {
    // ── 批量模式：对视频下所有未回复评论生成回复 ──
    const unreplied = loadUnrepliedComments(awemeId, 20);
    if (!unreplied.length) {
      console.error('[getReply] 没有需要回复的评论（所有评论已回复或缓存为空）。');
      console.error('[getReply] 提示：先运行 node cli.js get <aweme_id> 拉取评论。');
      ctx.audit.endOperation('success', { replies: 0, awemeId });
      return [];
    }

    console.error(`[getReply] 批量生成 ${unreplied.length} 条回复...`);
    const result = await engine.generateReplies({
      awemeId,
      comments: unreplied.map(c => ({ cid: c.cid, text: c.text || '', userTags: _loadUserTags(c.uid) })),
      persona, strategy,
    });

    for (const r of result.replies) {
      console.error(`[${r.persona?.name || 'default'}] ${r.text}`);
    }

    ctx.audit.endOperation('success', { replies: result.replies.length, awemeId });
    return stripContext(result);
  } else if (cid) {
    // ── 单条回复模式：对指定评论生成回复 ──
    const comment = loadComment(cid);
    if (!comment) {
      throw new Error(`评论 ${cid} 未在缓存中。请先运行: node cli.js get ${awemeId}`);
    }

    console.error(`[getReply] 生成对 ${cid} 的回复...`);
    // 构建线程上下文（父评论链）
    let parentComment = null;
    if (comment.parentCid) {
      const cm = commentsModule();
      if (cm) {
        const parent = cm.get(comment.parentCid);
        if (parent?.text) parentComment = String(parent.text).substring(0, 150);
      }
    }
    const replyOpts = {
      awemeId,
      comment: { cid, text: comment.text || '', userTags: _loadUserTags(comment.uid), parentComment, uid: comment.uid },
      persona, strategy,
    };

    if (interactive) {
      const decision = await interactiveReply(engine, replyOpts, ctx);
      if (decision.action === 'post') {
        try {
          const postArgs = [awemeId, decision.reply.text, '--reply-to', String(cid)];
          const postResult = await ctx.cmdPost(postArgs);
          console.error(`[getReply] 已发布: ${decision.reply.text?.substring(0, 30)}...`);
          ctx.audit.endOperation('success', { awemeId, cid, posted: true, persona: decision.reply.persona?.name });
          return { ...decision, posted: true, postCid: postResult.cid };
        } catch (e) {
          console.error(`[getReply] 发布失败: ${e.message}`);
          ctx.audit.endOperation('error', { awemeId, cid }, null, e.message);
          return { ...decision, posted: false, error: e.message };
        }
      }
      ctx.audit.endOperation('success', { awemeId, cid, posted: false, action: decision.action });
      return decision;
    }

    const result = await engine.generateReply(replyOpts);
    console.log(result.reply.text);
    ctx.audit.endOperation('success', { awemeId, cid, persona: result.reply.persona?.name });
    return stripContext(result);
  } else {
    // ── 评论模式：生成视频的顶级评论 ──
    console.error(`[getReply] 生成 ${count} 条视频评论...`);
    const result = await engine.generateComment({
      awemeId, persona, count, strategy,
    });

    for (const c of result.comments) {
      console.error(`[${c.persona?.name || 'default'}] ${c.text}`);
    }

    ctx.audit.endOperation('success', { awemeId, count: result.comments.length });
    return stripContext(result);
  }
}

module.exports = cmdGetReply;
