// lib/commands/post.js — 发表评论/回复

const { escapeExpression, getFlag, throttleOpts } = require('./helpers');
const users = require('../memory/users');
const comments = require('../memory/comments');
const videos = require('../memory/videos');
const accounts = require('../memory/accounts');
const corpus = require('../memory/corpus');
const failures = require('../memory/failures');
const riskControl = require('../risk-control');
const policy = require('../policy').getPolicy();
const { collectImageArgs, uploadImageViaBridge } = require('../comment-image');
const logger = require('../runtime/logger');

/**
 * 发表评论或回复
 * @param {object} ctx - { bridge, audit, loggedCall }
 * @param {string[]} args - [aweme_id, text, --reply-to <cid>, --reply-to-reply <rrid>, --at <uid> <sec_uid>, --no-throttle]
 */
async function cmdPost(ctx, args) {
  const awemeId = args[0];
  // 纯图回复（reply.image.withText = false）时 text 参数为空串。
  // 用 ?? 而不是 ||，是为了区分"没传"与"传了空串"——两者在这里都要走到
  // 下面的图片判断，真正的合法性由 "文字与图片至少有一个" 决定。
  //
  // 若正文位置收到的是一个**已知 flag**（`post 73xxx --reply-to 73yyy` 这种
  // 漏写正文的写法），当成"没有正文"处理。
  // 不这么做的话 args[1] 就是字符串 '--reply-to'，它会通过全部文本校验，
  // 然后**真的作为一条评论发到线上评论区**（内容就是 "--reply-to"）。
  // 只认白名单里的 flag，所以以 `--` 开头的正常评论仍然发得出去。
  const KNOWN_FLAGS = new Set(['--reply-to', '--reply-to-reply', '--image', '--no-throttle', '--at', '--no-log', '--json']);
  const rawText = args[1];
  const text = (rawText == null || KNOWN_FLAGS.has(String(rawText))) ? '' : String(rawText);
  const replyTo = getFlag(args, '--reply-to', null);
  const rrid = getFlag(args, '--reply-to-reply', null);

  // 图片参数在参数守卫之前解析：判断"这条是不是纯图回复"需要知道有没有附图。
  // collectImageArgs 是纯参数解析、没有副作用，提前调用不会多花任何东西。
  const imagePaths = collectImageArgs(args);

  if (!awemeId || (!text && !imagePaths.length)) {
    throw new Error('用法: node cli.js post <aweme_id> "内容" [--reply-to <cid>] [--image <路径>]\n（内容与图片至少要有一个）');
  }

  // 被回复对象的 uid —— 「同一用户每轮最多回复 N 条」这条红线靠它生效。
  //
  // 这里从本地 SQLite 查（不发请求），所以能放在节奏等待之前。
  // 查不到就传 null：闸门在那条规则上放行，而不是把 uid 猜一个 ——
  // 猜错会拦下本来该发的回复，比不拦更糟。
  //
  // 注：改造前这里从来不传 uid，于是 policy 里那段判定（`if (meta.uid)`）
  // 是死代码，配置项在界面上能改、能显示、运行时不生效。
  let targetUid = null;
  if (replyTo) {
    try {
      const target = comments.get(String(replyTo));
      if (target && target.uid) targetUid = String(target.uid);
    } catch (e) {
      logger.debug('[cmdPost] 查被回复评论的 uid 失败: ' + e.message);
    }
  }

  // ① 运营策略闸门（快，不等待）：配额 / 轮次 / 熔断 / 去重 / 内容校验。
  //    必须放在节奏等待之前 —— 否则用户要等满 40 秒才被告知"今天额度用完了"。
  //    --no-throttle 只跳过节奏等待，**跳过不了策略闸门**（否则规则形同虚设）。
  //    纯图回复 text 为空串，闸门里的 `if (meta.text)` 自然跳过文本校验。
  // await：冷却类的拦截（单轮触顶 300s、每日轮次）以前被静默忽略，
  // 现在会真的等。等的时候打印一行，别让命令行看起来像卡住了。
  await policy.assertWritable(
    { awemeId, cid: replyTo, text, uid: targetUid },
    { signal: ctx.signal, onWait: ({ waitMs, reason }) => logger.info(`[post] ${reason}，等待 ${Math.ceil(waitMs / 1000)}s…`) }
  );

  // ② 请求节奏守卫：距上次写不足间隔则阻塞（--no-throttle 旁路，供内部调用与调试）
  await riskControl.enforceDelay('write', throttleOpts(ctx, args));

  // @ 提及支持
  let atUid = null, atSecUid = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--at') { atUid = args[++i]; atSecUid = args[++i]; }
  }

  let mentions = 'null';
  if (atUid && atSecUid) {
    const atPos = text.indexOf('@');
    if (atPos >= 0) {
      let charEnd = atPos + 1;
      while (charEnd < text.length && text[charEnd] !== ' ') charEnd++;
      const byteStart = Buffer.byteLength(text.substring(0, atPos), 'utf8');
      const byteEnd = Buffer.byteLength(text.substring(0, charEnd), 'utf8');
      mentions = JSON.stringify([{
        start: byteStart, end: byteEnd,
        user_id: atUid, sec_uid: atSecUid, type: 0,
      }]);
    }
  }

  // 图片评论：先把本地图片传到 ImageX 换 uri，再随 publish 一起提交
  const images = [];
  for (const p of imagePaths) {
    images.push(await uploadImageViaBridge(ctx.bridgeCall, p));
  }
  // ImageX 返回的 uri/width/height/format 都是纯 token，JSON 字面量可安全内联
  const imagesArg = images.length
    ? JSON.stringify(images.map(i => ({ uri: i.uri, width: i.width, height: i.height, format: i.format })))
    : 'null';

  // ②.5 账号归属校验：确认"浏览器里登录的号"就是"这条视频的号"。
  //
  // 这里的失败模式是所有隔离措施里后果最重的：A 号的视频、B 号的浏览器
  // ——发布照样成功，内容以 B 号的身份出现在 A 号的视频评论区，
  // 且没有任何报错。所以必须在真正点"发布"前问一次页面（whoami 走页面
  // cookie，返回的就是当前登录账号）。
  //
  // 判定基准分两种，**必须分开** —— 这里此前只看 author_uid，于是别人的视频
  // 用的是"那个视频的作者"，而不是"我在用哪个号运营它"：
  //   - 我自己的作品：author_uid 就是"这条视频的号"（`my` 落库时写死）
  //   - 别人的视频：author_uid 是**视频作者**（`user` 命令抓来时写入），拿它
  //     当基准会**误拦** —— 明明是以自己的号去评论别人的视频，却被判成
  //     "这条视频属于账号 X，你登录的是 Y"。这条路径上真会踩到（库里已有 8 个
  //     视频带 author_uid + isMine:false），所以改用 ops_uid（最近一次是谁在运营）。
  //
  // 两个都查不到（旧数据 / 视频不是本工具拉的）或拿不到当前账号（旧版脚本、
  // 瞬时失败）时**放行**：拦不住的校验不能变成拦住正常发布的砖头，但要留痕。
  const videoRow = videos.get(awemeId);
  const ownerUid = videoRow
    ? (videoRow.isMine && videoRow.authorUid
      ? String(videoRow.authorUid)
      : (videoRow.opsUid ? String(videoRow.opsUid) : null))
    : null;
  if (ownerUid) {
    let who = null;
    try {
      who = await ctx.bridgeCall(
        '(window.__bridge && window.__bridge.whoami) ? window.__bridge.whoami() : Promise.resolve(null)'
      );
    } catch (e) {
      logger.warn(`[post] 账号校验请求失败（放行并留痕）: ${e.message}`);
    }
    if (who && who.uid) {
      const currentUid = String(who.uid);
      if (currentUid !== ownerUid) {
        const nameOf = (uid) => (accounts.nicknameOf(uid) ? `${uid}（${accounts.nicknameOf(uid)}）` : uid);
        throw new Error(
          `账号不匹配，已阻止发布：这条视频是「${nameOf(ownerUid)}」在运营的，`
          + `而浏览器当前登录的是 ${nameOf(currentUid)}。`
          + '请在浏览器里切回对应的号，或到「连接」页确认当前账号。'
        );
      }
    } else {
      logger.warn('[post] 无法确认浏览器当前登录账号（旧版脚本或未登录），跳过账号归属校验');
    }
  }

  ctx.audit.startOperation('post', {
    aweme_id: awemeId, text, reply_to: replyTo,
    // uid 是「同一用户每轮最多回复 N 条」的数据来源：events.uid（core/audit.js:145）
    // 写进这张表、policy 再从这张表按 uid 计数。少了它，上面的闸门拿到 uid
    // 也永远数出 0，那条红线照样不生效 —— 传参和数据落库是**两处都要有**的。
    uid: targetUid,
    images: images.map(i => i.uri),
  });
  const expr = `window.__bridge.publish('${escapeExpression(awemeId)}', '${escapeExpression(text)}', ${replyTo ? `'${escapeExpression(replyTo)}'` : 'null'}, ${rrid ? `'${escapeExpression(rrid)}'` : 'null'}, ${mentions}, ${imagesArg})`;
  let data;
  try {
    data = await ctx.loggedCall('post', { aweme_id: awemeId, text }, expr);
  } catch (e) {
    // transport/bridge 错误也落 failure_patterns（闭环避雷，对齐 xhs post.js）
    try { failures.record(e, { exampleText: text.slice(0, 200) }); } catch (_) {}
    ctx.audit.endOperation('error', {}, null, e.message);
    throw e;
  }

  // 检查 status_code（非 0 即为失败）
  if (data.status_code !== undefined && data.status_code !== 0) {
    const err = new Error(`status_code=${data.status_code} — 评论可能被拦截，请更换内容重试`);
    try { failures.record({ status_code: data.status_code }, { exampleText: text }); } catch (_) {}
    ctx.audit.endOperation('error', { status_code: data.status_code }, null, err.message);
    throw err;
  }

  if (!data.comment) {
    const err = new Error('发布失败 — 服务器未返回评论数据');
    try { failures.record(err.message, { exampleText: text }); } catch (_) {}
    ctx.audit.endOperation('error', {}, null, err.message);
    throw err;
  }

  const result = {
    cid: data.comment?.cid || '',
    text: data.comment?.text || text,
    time: data.comment?.create_time || 0,
    status: 'published',
  };
  if (images.length) {
    result.images = images.map(i => ({ uri: i.uri, width: i.width, height: i.height, format: i.format }));
    // 用服务端回包校验图片确实挂上了，避免"发了条纯文本还以为带了图"
    const attached = data.comment?.image_list?.length || 0;
    result.image_count = attached;
    if (attached < images.length) {
      result.warning = `服务端仅回传 ${attached}/${images.length} 张图片，请人工确认`;
    }
  }

  // ── 实体表落库（旁路写，失败不影响主流程）──
  try {
    const myUid = data.comment?.user?.uid || data.comment?.user?.uid_str || null;
    const mySecUid = data.comment?.user?.sec_uid || null;
    const myNickname = data.comment?.user?.nickname || null;
    // 自己（publisher）upsert：仅记录身份，不动 reply_count（reply_count 表示「我回复了该用户多少次」）
    if (myUid) {
      users.upsert({
        uid: String(myUid),
        secUid: mySecUid,
        nickname: myNickname,
      });
    }
    // 自己发的这条评论本身也落库
    if (result.cid) {
      comments.upsert({
        cid: String(result.cid),
        awemeId: String(awemeId),
        uid: myUid ? String(myUid) : null,
        text: result.text,
        createdAt: result.time || null,
        parentCid: replyTo || null,
      });
    }
    // 标记被回复的源评论 + 源评论作者的 reply_count++
    if (replyTo && result.cid) {
      comments.markReplied(String(replyTo), String(awemeId), String(result.cid));
      const src = comments.get(String(replyTo));
      if (src && src.uid) {
        users.upsert({ uid: String(src.uid), replyDelta: 1 });
      }
    }
    // 记下"这个视频是哪个账号在运营"。用**实际发出去的那个 uid**（响应里的
    // author uid），不是界面以为的那个 —— 归属永远以执行者为准
    videos.markPost(String(awemeId), { accountUid: myUid ? String(myUid) : null });

    // 成功则把这条回复入语料库（reply_to 才算"回复语料"，对原帖的纯评论不入库）。
    // 纯图回复没有文本：空字符串的 reply_hash 每条都一样，入语料库会互相顶掉，
    // 也会污染查重判断，因此跳过。
    if (replyTo && result.text) {
      const src = comments.get(String(replyTo));
      corpus.append({
        srcCid: String(replyTo),
        srcText: src ? src.text : null,
        replyText: result.text,
        replyCid: result.cid || null,
        awemeId: String(awemeId),
        postedAt: (result.time && result.time > 1e10) ? Number(result.time) : Date.now(),
        outcome: 'published',
      });
    }
  } catch (e) {
    logger.debug('[cmdPost.persist] failed: ' + e.message);
  }

  ctx.audit.endOperation('success', { cid: result.cid }, { result });
  return result;
}

module.exports = cmdPost;
