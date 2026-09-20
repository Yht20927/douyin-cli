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
//   node cli.js getReply <aweme_id> --batch             批量生成回复（视频下未回复的，最多 20 条）
//   node cli.js getReply <aweme_id> --cids a,b,c        只处理指定的评论（桌面端勾选用这个）
//   node cli.js getReply <aweme_id> --cids a,b --to-draft   批量生成并存进草稿箱

const { getFlag } = require('./helpers');
const logger = require('../runtime/logger');
const replySource = require('../reply-source');
const accounts = require('../memory/accounts');

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

/**
 * 把 reply-source 的结果整理成对外的返回形状。
 *
 * 向后兼容是硬要求：改造前这里返回的是 ReplyEngine 的原始结果
 * （`{ reply: { text, persona, ... } }`），界面与测试都按这个形状取值。
 * 所以 AI 成功时原样吐出 engine 的结果（顺带剥掉内部的调试上下文），
 * 固定内容时补一个等价的最小形状，调用方不需要区分来源。
 *
 * 两种形状都会带上 `source` / `imagePath` / `degraded`，供界面标注来源与附图。
 *
 * @param {object} picked - core/reply-source next() 的成功结果
 */
function shapeReplyResult(picked) {
  const base = picked.source === 'ai' && picked.raw
    ? stripContext(picked.raw)
    : { reply: { text: picked.text, persona: null } };

  const out = {
    ...base,
    source: picked.source,
    personaId: picked.personaId,
  };
  if (picked.imagePath) out.imagePath = picked.imagePath;
  // 没带图时也把原因带上：界面要能解释"为什么这条没配图"，
  // 否则用户只会看到图片开关是开的、图却没出现。
  if (picked.imageReason) out.imageReason = picked.imageReason;
  if (picked.degraded) {
    out.degraded = true;
    out.aiError = picked.aiError;
  }
  // 固定内容模式下 base.reply.text 就是 picked.text；AI 模式下两者也一致，
  // 但 AI 返回可能自带首尾空白，统一以 picked.text 为准，避免"生成的"与
  // "被发布的"两份文本不一致（发布用的是界面编辑框里的 picked.text）。
  if (out.reply && typeof out.reply === 'object') out.reply.text = picked.text;
  return out;
}

// 注：改造前这里有个 readStrategy()，从 process.cwd() 读根目录的 reply-strategy.md，
// 读不到就静默返回 ''（打包后必然读不到，AI 会悄悄退化成没有策略指导）。
// 现按 D20 统一到 prompts/partial-reply-strategy.md 单一真源，由各模板的
// {{STRATEGY_BLOCK}} 注入，故此处不再需要读取。

/** 从 SQLite 加载评论 */
function loadComment(cid) {
  const cm = commentsModule();
  if (!cm) return null;
  try { return cm.get(cid); } catch (_) { return null; }
}

/**
 * 批量生成的条数上限。
 *
 * 改造前这是一次 LLM 调用返回 N 条；现在改成逐条生成（每条一次调用），
 * 所以这个数直接决定耗时 —— 20 条按每条约 10 秒算就是三分多钟。
 * 它只是**默认值**，命令行可以用 --count 覆盖。
 */
const BATCH_LIMIT = 20;

/**
 * 一次批量最多处理几条（硬上限）。
 * 与 BATCH_LIMIT 的区别：那个是「不指定时取多少」，这个是「指定了也不许超过」。
 * 逐条生成是一条一次 LLM 调用，几百条会变成一个几小时、中途看不到进度的任务。
 */
const MAX_BATCH = 50;

/** 从 SQLite 加载视频的未回复评论（过滤作者自己的评论和已回复的） */
function loadUnrepliedComments(awemeId, limit = BATCH_LIMIT, accountUid = null) {
  const cm = commentsModule();
  if (!cm) return [];
  try {
    const all = cm.listByVideo(awemeId, { replied: false });

    // 排掉"我自己发的评论"。
    //
    // 改造前这里靠一个启发式猜作者 uid（"该视频下评论最多的 uid 且 ≥5 倍于第二名"），
    // 还把猜出来的结果**回写进 videos 表**。这个猜测在"某个粉丝很活跃"的视频上会猜错，
    // 一旦猜错就永久写进库，之后所有依赖 authorUid 的地方都跟着错。
    // 拿不到账号时不猜 —— 宁可多列出几条自己发的，也不误删别人的评论。
    // 优先用**这条视频自己的归属账号**：我自己的作品里，author_uid 就是那个号。
    // 别人的视频没有归属（author_uid 是视频作者的，不是我的），
    // 这时用**当前执行的账号**（由 cmdGetReply 解析后传进来）——
    // 全局 videos.myUid() 是"作品最多的号"的猜测，两个号时必然有一个是错的。
    let myUid = accountUid || null;
    try {
      const videos = require('../memory/videos');
      const v = videos.get(awemeId);
      if (v && v.isMine && v.authorUid) myUid = String(v.authorUid);
    } catch (_) {}
    const filtered = myUid ? all.filter(c => String(c.uid) !== String(myUid)) : all;

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
    logger.info(`\n→ ${result.reply.text}`);
    const answer = await ask('\n[y]发布 [e]编辑 [r]重生成 [n]跳过: ');

    if (answer === 'y') {
      rl.close();
      return { action: 'post', reply: result.reply };
    } else if (answer === 'e') {
      const edited = await ask('输入新文本: ');
      if (edited.trim()) {
        result.reply.text = edited.trim();
        logger.info('已更新为: ' + result.reply.text);
      }
      const confirm = await ask('[y]发布编辑后的文本 [n]取消: ');
      if (confirm === 'y') {
        rl.close();
        return { action: 'post', reply: result.reply };
      }
    } else if (answer === 'r') {
      attempt++;
      if (attempt >= maxAttempts) {
        logger.warn('已达到最大重试次数');
        rl.close();
        return { action: 'skip', reply: result.reply };
      }
      logger.info('重新生成中...');
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
      '  node cli.js getReply <aweme_id> --batch             批量生成回复（最多 20 条未回复的）\n' +
      '  node cli.js getReply <aweme_id> --cids a,b,c        只处理指定的这几条评论\n' +
      '  node cli.js getReply <aweme_id> --batch --to-draft   批量生成并存进草稿箱\n' +
      '  node cli.js getReply <aweme_id> <cid> --interactive  交互式审核（生成→编辑→发布）\n' +
      '\n批量说明：逐条生成，每条都按 reply.mode（ai / fixed / hybrid）走，\n' +
      '所以固定内容和随机循环在批量里同样生效。加 --to-draft 才会落进草稿箱，\n' +
      '发布始终由人在草稿箱里确认。'
    );
  }

  const cid = posArgs[1] || null;
  const rawCount = getFlag(args, '--count', 1);
  const count = Number.isFinite(rawCount) && rawCount >= 1 ? rawCount : 1;
  const persona = getFlag(args, '--persona', 'auto');
  const batch = args.includes('--batch');
  const interactive = args.includes('--interactive');
  /** 指定要处理哪几条评论（逗号分隔）。界面勾选后用这个 */
  const cidsFlag = getFlag(args, '--cids', null);
  /** 批量结果是否落进草稿箱。不传则只生成、不落库（CLI 看结果用） */
  const toDraft = args.includes('--to-draft');

  // 这次以哪个号的身份在生成。用**执行者** —— 归属判定（哪些评论是我自己发的）
  // 必须跟着真正在执行的那个号走，而不是界面以为的那个
  const accountUid = (await accounts.resolveExecutor(ctx)).uid || null;

  ctx.audit.startOperation('getReply', { aweme_id: awemeId, cid, count, persona, batch });

  const { ReplyEngine } = require('../reply-engine');
  const engine = new ReplyEngine({
    llm: ctx.config.llm || {},
    bridgeCall: ctx.bridgeCall ? (expr) => ctx.bridgeCall(expr) : null,
  });

  if (batch || cidsFlag) {
    // ── 批量模式 ──
    // 两个入口共用这一条实现：
    //   --cids a,b,c   只处理指定的这几条（界面勾选后用这个）
    //   --batch        处理该视频下最多 BATCH_LIMIT 条未回复评论（CLI 用法）
    //
    // **逐条**走 replySource，而不是调一次引擎的批量接口。这一个选择解决三件事：
    //   ① 固定内容 / 随机循环在批量里能用上 —— 改造前批量恒走 AI，
    //      reply.mode 设成 fixed 也不生效，用户配了随机内容却发现批量完全不用；
    //   ② 一条失败不拖垮整批，失败的那条单独报出来；
    //   ③ 每条的图片策略、人格微调、AI 降级与单条生成走的是同一段代码，
    //      不会出现"批量发的和单条发的风格不一样"。
    // --count 在批量模式下表示"最多处理几条"。不传时用 BATCH_LIMIT，
    // 而不是单条模式的默认值 1 —— 否则 `--batch` 一次只处理一条，
    // 和它的名字完全不符。
    const wanted = cidsFlag
      ? String(cidsFlag).split(',').map(s => s.trim()).filter(Boolean)
      : loadUnrepliedComments(awemeId, args.includes('--count') ? count : BATCH_LIMIT, accountUid).map(c => c.cid);

    // 硬上限：逐条生成是一条一次 LLM 调用，误传几百个 cid 会变成几小时的队列任务，
    // 而且中途没法看进度（队列只显示一条任务）。截断并**明说**截断了，
    // 而不是默默少做几条。
    let requested = wanted;
    if (requested.length > MAX_BATCH) {
      logger.warn(`[getReply] 一次最多处理 ${MAX_BATCH} 条，已截断（你给了 ${requested.length} 条）`);
      requested = requested.slice(0, MAX_BATCH);
    }

    if (!requested.length) {
      logger.info('[getReply] 没有需要处理的评论（都被回复过、都是我自己发的，或本地缓存为空）。');
      logger.info('[getReply] 提示：先运行 node cli.js get <aweme_id> 拉取评论。');
      ctx.audit.endOperation('success', { replies: 0, awemeId, batch: true });
      return { awemeId, requested: 0, toDraft, generated: [], skipped: [], failed: [] };
    }

    const mode = replySource.resolveMode(getFlag(args, '--mode', null));

    // 固定内容模式下如果一条可用的都没有，下面会逐条报同一个错 —— 20 条刷 20 行
    // 一样的日志，真正的原因反而被淹掉。开工前就说清楚。
    if (mode === 'fixed') {
      const d = replySource.describe();
      if (!d.fixed.usable) {
        const err = `固定回复列表里没有可用内容（共 ${d.fixed.total} 条），批量生成无法进行。`
          + '请到设置页的「回复策略」里添加内容，或把回复模式改回 AI。';
        ctx.audit.endOperation('error', { awemeId, batch: true }, null, err);
        throw new Error(err);
      }
    }

    logger.info(`[getReply] 批量生成 ${requested.length} 条回复（模式：${mode}）...`);

    const draftsModule = require('../memory/drafts');
    const generated = [];
    const skipped = [];
    const failed = [];

    for (let i = 0; i < requested.length; i++) {
      const cid = requested[i];
      const at = `第 ${i + 1}/${requested.length} 条`;

      const comment = loadComment(cid);
      if (!comment) {
        failed.push({ cid, error: '这条评论不在本地库里，请先拉取评论' });
        logger.warn(`[getReply] ${at} 失败：评论 ${cid} 不在本地库里`);
        continue;
      }
      if (comment.replied) {
        skipped.push({ cid, reason: '已经回复过了' });
        logger.info(`[getReply] ${at} 跳过：已经回复过了`);
        continue;
      }

      logger.progress({ text: `${at}：正在生成`, current: i + 1, total: requested.length });

      let parentComment = null;
      if (comment.parentCid) {
        const parent = loadComment(comment.parentCid);
        if (parent?.text) parentComment = String(parent.text).substring(0, 150);
      }
      const replyOpts = {
        awemeId,
        comment: {
          cid,
          text: comment.text || '',
          userTags: _loadUserTags(comment.uid),
          parentComment,
          uid: comment.uid,
        },
        persona,
      };

      let picked;
      try {
        picked = await replySource.next(ctx, {
          awemeId,
          comment: replyOpts.comment,
          persona,
          mode: getFlag(args, '--mode', null),
          generateAI: () => engine.generateReply(replyOpts),
        });
      } catch (e) {
        // replySource.next 内部已经把异常收敛成结果对象，这里只兜住意外，
        // 保证单条出错不会把整批带下去
        picked = { ok: false, error: e.message };
      }

      if (!picked.ok) {
        failed.push({ cid, error: picked.error });
        logger.warn(`[getReply] ${at} 失败：${picked.error}`);
        continue;
      }

      const item = {
        cid,
        text: picked.text,
        source: picked.source,
        personaId: picked.personaId,
        imagePath: picked.imagePath || null,
        imageReason: picked.imageReason || null,
        degraded: !!picked.degraded,
        aiError: picked.aiError || null,
        draftId: null,
        draftError: null,
      };

      if (toDraft) {
        const id = draftsModule.save({
          awemeId,
          text: picked.text,
          replyToCid: cid,
          personaId: picked.personaId,
          imagePath: picked.imagePath || null,
        });
        if (id) item.draftId = id;
        else {
          // 内容和图都为空时 drafts.save 会拒绝入库。这不是生成失败 ——
          // 内容生成出来了，只是没地方存，如实说清楚而不是报"失败"。
          item.draftError = '内容为空（既没有文字也没带图），没有存入草稿箱';
          logger.warn(`[getReply] ${at} 内容为空，未存草稿`);
        }
      }

      generated.push(item);
      logger.info(`[${picked.source === 'fixed' ? '固定内容' : 'AI'}] ${picked.text}`);
    }

    ctx.audit.endOperation('success', {
      awemeId, batch: true, requested: requested.length,
      generated: generated.length, skipped: skipped.length, failed: failed.length,
    });

    logger.info(`[getReply] 批量完成：生成 ${generated.length} 条`
      + (toDraft ? '（已存入草稿箱）' : '')
      + `，跳过 ${skipped.length} 条，失败 ${failed.length} 条`);

    return { awemeId, requested: requested.length, toDraft, mode, generated, skipped, failed };
  } else if (cid) {
    // ── 单条回复模式：对指定评论生成回复 ──
    const comment = loadComment(cid);
    if (!comment) {
      throw new Error(`评论 ${cid} 未在缓存中。请先运行: node cli.js get ${awemeId}`);
    }

    logger.info(`[getReply] 生成对 ${cid} 的回复...`);
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
      persona,
    };

    if (interactive) {
      // --interactive 的整个流程就是「生成 → 人审 → 发布」，重试还会轮换人格，
      // 因此它固定走 AI。若当前配置不是 ai，明说一句而不是默默改行为。
      const configured = replySource.resolveMode(null);
      if (configured !== 'ai') {
        logger.warn(`[getReply] --interactive 固定使用 AI 生成，本次忽略配置的 reply.mode="${configured}"`);
      }
      const decision = await interactiveReply(engine, replyOpts, ctx);
      if (decision.action === 'post') {
        try {
          const postArgs = [awemeId, decision.reply.text, '--reply-to', String(cid)];
          const postResult = await ctx.cmdPost(postArgs);
          logger.info(`[getReply] 已发布: ${decision.reply.text?.substring(0, 30)}...`);
          ctx.audit.endOperation('success', { awemeId, cid, posted: true, persona: decision.reply.persona?.name });
          return { ...decision, posted: true, postCid: postResult.cid };
        } catch (e) {
          logger.error(`[getReply] 发布失败: ${e.message}`);
          ctx.audit.endOperation('error', { awemeId, cid }, null, e.message);
          return { ...decision, posted: false, error: e.message };
        }
      }
      ctx.audit.endOperation('success', { awemeId, cid, posted: false, action: decision.action });
      return decision;
    }

    // ── 按 reply.mode 分发：ai / fixed / hybrid（--mode 可临时覆盖）──
    // 分发放在命令内部而不是界面另开一条路径，于是 CLI 与桌面应用共用同一条链路，
    // P5 定时生成草稿也直接调这条命令。
    const picked = await replySource.next(ctx, {
      awemeId,
      comment: replyOpts.comment,
      persona,
      mode: getFlag(args, '--mode', null),
      generateAI: () => engine.generateReply(replyOpts),
    });

    if (!picked.ok) {
      ctx.audit.endOperation('error', { awemeId, cid }, null, picked.error);
      throw new Error(picked.error);
    }

    logger.output(picked.text);
    if (picked.degraded) {
      logger.warn(`[getReply] AI 失败已降级为固定内容：${picked.aiError}`);
    }

    ctx.audit.endOperation('success', {
      awemeId, cid, source: picked.source, persona: picked.personaId,
      image: picked.imagePath || undefined,
    });

    return shapeReplyResult(picked);
  } else {
    // ── 评论模式：生成视频的顶级评论 ──
    logger.info(`[getReply] 生成 ${count} 条视频评论...`);
    const result = await engine.generateComment({
      awemeId, persona, count,
    });

    for (const c of result.comments) {
      logger.info(`[${c.persona?.name || 'default'}] ${c.text}`);
    }

    ctx.audit.endOperation('success', { awemeId, count: result.comments.length });
    return stripContext(result);
  }
}

module.exports = cmdGetReply;
