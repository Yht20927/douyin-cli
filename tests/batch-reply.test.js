// tests/batch-reply.test.js — 批量生成（需求(2)）
//
// 不变量：
// 1. 逐条走 replySource —— 固定内容 / 随机循环在批量里同样生效（改造前批量恒走 AI）
// 2. --to-draft 才落草稿；不传时只生成，不碰草稿箱
// 3. 单条失败不拖垮整批，失败的那条单独报出来
// 4. 已回复的跳过并说明原因，而不是生成一份注定发不出去的草稿
// 5. 一次处理条数有硬上限，且**明说**截断了
// 6. 固定内容模式下列表为空时，开工前就报错，而不是刷 20 行同样的日志
//
// 发布不在这里做：批量只产出草稿，发布仍由人在草稿箱逐条确认（D7）。

const fs = require('fs');
const path = require('path');
const os = require('os');

function withTempEnv(fn) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-batch-'));
    const saved = {
      cfg: process.env.DOUYIN_CONFIG,
      data: process.env.DOUYIN_DATA_DIR,
      storage: process.env.DOUYIN_STORAGE_DIR,
    };
    process.env.DOUYIN_CONFIG = path.join(tmp, 'config.json');
    process.env.DOUYIN_DATA_DIR = tmp;
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');

    // getReply 必须在清理名单里：它在模块级缓存了 comments 模块
    // （`let memComments = null; if (memComments === null) require(...)`），
    // 于是即使把 db/comments 从 require 缓存里删掉，命令读的仍是**上一个测试**
    // 那个数据库文件。表现是"单独跑过、一起跑挂"，而且数据看起来像是随机串的。
    const purge = () => {
      for (const m of ['../core/memory/db', '../core/memory/comments', '../core/memory/drafts',
        '../core/memory/videos', '../core/data/views', '../core/reply-source',
        '../core/reply-source/state', '../core/commands/getReply']) {
        try { delete require.cache[require.resolve(m)]; } catch (_) { /* 未加载过 */ }
      }
    };
    config.reset();
    purge();

    try {
      const comments = require('../core/memory/comments');
      const drafts = require('../core/memory/drafts');
      const views = require('../core/data/views');
      await fn({ tmp, comments, drafts, views });
    } finally {
      try { require('../core/memory/db').closeDb(); } catch (_) { /* */ }
      purge();
      try { config.reset(); } catch (_) { /* */ }
      if (saved.cfg == null) delete process.env.DOUYIN_CONFIG; else process.env.DOUYIN_CONFIG = saved.cfg;
      if (saved.data == null) delete process.env.DOUYIN_DATA_DIR; else process.env.DOUYIN_DATA_DIR = saved.data;
      if (saved.storage == null) delete process.env.DOUYIN_STORAGE_DIR; else process.env.DOUYIN_STORAGE_DIR = saved.storage;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

const config = require('../core/config');

/** 一个不碰网络、不碰 bridge 的 ctx —— 批量路径只需要 audit 和 config */
function makeCtx() {
  const events = [];
  return {
    events,
    ctx: {
      config: { llm: {} },
      bridgeCall: null,
      audit: {
        startOperation: (name, meta) => events.push(['start', name, meta]),
        endOperation: (status, meta, err) => events.push(['end', status, meta, err]),
      },
    },
  };
}

/** 塞一条评论进去 */
function seed(comments, cid, text, extra = {}) {
  comments.upsert({ cid, awemeId: 'v1', uid: extra.uid || 'u1', text, createdAt: 1700000000 });
  if (extra.replied) comments.markReplied(cid, 'v1', extra.replyCid || `r-${cid}`);
}

describe('批量生成 / --cids 指定评论', () => {
  it('固定内容模式下逐条生成，且每条存进草稿箱', withTempEnv(async ({ comments, views }) => {
    seed(comments, 'c1', '怎么做的？');
    seed(comments, 'c2', '求教程');
    config.set({ reply: { mode: 'fixed', fixed: { cycle: 'sequential', items: [{ text: '回复甲' }, { text: '回复乙' }] } } });

    const { ctx } = makeCtx();
    const cmdGetReply = require('../core/commands/getReply');
    const r = await cmdGetReply(ctx, ['v1', '--cids', 'c1,c2', '--to-draft']);

    expect(r.mode).toBe('fixed');
    expect(r.generated.map(g => g.cid)).toEqual(['c1', 'c2']);
    // 改造前批量恒走 AI 的批量接口，reply.mode=fixed 完全被忽略
    expect(r.generated.map(g => g.text)).toEqual(['回复甲', '回复乙']);
    expect(r.generated.every(g => g.source === 'fixed' && g.draftId > 0)).toBe(true);

    const list = views.listDrafts().items;
    expect(list).toHaveLength(2);
    // 草稿要记住回的是哪条评论，否则发布时不知道发给谁
    expect(list.map(d => d.replyToCid).sort()).toEqual(['c1', 'c2']);
  }));

  it('随机循环在批量里同样生效（这就是「随机挑选回复内容」）', withTempEnv(async ({ comments }) => {
    for (let i = 0; i < 12; i++) seed(comments, `c${i}`, `评论${i}`);
    config.set({
      reply: {
        mode: 'fixed',
        fixed: { cycle: 'random', items: [{ text: 'A' }, { text: 'B' }, { text: 'C' }] },
      },
    });

    const { ctx } = makeCtx();
    const cmdGetReply = require('../core/commands/getReply');
    const cids = Array.from({ length: 12 }, (_, i) => `c${i}`).join(',');
    const r = await cmdGetReply(ctx, ['v1', '--cids', cids]);

    expect(r.generated).toHaveLength(12);
    // 每条都取自那份列表
    expect(r.generated.every(g => ['A', 'B', 'C'].includes(g.text))).toBe(true);
  }));

  it('已回复的跳过并说明原因', withTempEnv(async ({ comments, views }) => {
    seed(comments, 'c1', '未回复的');
    seed(comments, 'c2', '已回复的', { replied: true });
    config.set({ reply: { mode: 'fixed', fixed: { items: [{ text: '回复' }] } } });

    const { ctx } = makeCtx();
    const cmdGetReply = require('../core/commands/getReply');
    const r = await cmdGetReply(ctx, ['v1', '--cids', 'c1,c2', '--to-draft']);

    expect(r.generated.map(g => g.cid)).toEqual(['c1']);
    expect(r.skipped).toEqual([{ cid: 'c2', reason: '已经回复过了' }]);
    // 关键：跳过的那条**不该**留下草稿 —— 它注定会被发布闸门拦下
    expect(views.listDrafts().items).toHaveLength(1);
  }));

  it('本地没有的评论报失败，但不影响其余几条', withTempEnv(async ({ comments }) => {
    seed(comments, 'c1', '有的');
    config.set({ reply: { mode: 'fixed', fixed: { items: [{ text: '回复' }] } } });

    const { ctx } = makeCtx();
    const cmdGetReply = require('../core/commands/getReply');
    const r = await cmdGetReply(ctx, ['v1', '--cids', 'c1,nope', '--to-draft']);

    expect(r.generated.map(g => g.cid)).toEqual(['c1']);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].cid).toBe('nope');
  }));

  it('一次处理条数有硬上限，且明说截断了', withTempEnv(async ({ comments }) => {
    const cids = [];
    for (let i = 0; i < 60; i++) { seed(comments, `c${i}`, `评论${i}`); cids.push(`c${i}`); }
    config.set({ reply: { mode: 'fixed', fixed: { items: [{ text: '回复' }] } } });

    const { ctx } = makeCtx();
    const cmdGetReply = require('../core/commands/getReply');
    const r = await cmdGetReply(ctx, ['v1', '--cids', cids.join(',')]);

    // 静默少做几条 = 用户以为全做了；必须让 requested 反映真实处理条数
    expect(r.requested).toBe(50);
    expect(r.generated).toHaveLength(50);
  }));

  it('固定内容列表为空时开工前就报错，而不是刷一堆重复日志', withTempEnv(async ({ comments, views }) => {
    seed(comments, 'c1', 'x');
    config.set({ reply: { mode: 'fixed', fixed: { items: [] } } });

    const made = makeCtx();
    const cmdGetReply = require('../core/commands/getReply');
    await expect(cmdGetReply(made.ctx, ['v1', '--cids', 'c1', '--to-draft']))
      .rejects.toThrow(/固定回复列表里没有可用内容/);

    // 整体失败，且没有留下半份草稿
    expect(views.listDrafts().items).toHaveLength(0);
    const end = made.events.find(e => e[0] === 'end');
    expect(end[1]).toBe('error');
  }));
});

describe('批量生成 / --mode 覆盖（界面那颗「用固定回复存草稿」）', () => {
  // 界面不能靠"把 reply.mode 改成 fixed"来实现这颗按钮 —— 那是全局设置，
  // 会把用户后面所有批量的行为一起改掉。它走的是 --mode 这个**本次**覆盖。
  // 真实配置里 reply.mode 就是 'ai'（新库压根没有 reply 段），所以这个用例
  // 断言两件事：这一批用的是固定内容，以及一次 AI 都没调。
  it('--mode fixed 覆盖配置里的 reply.mode="ai"，且不调用 LLM', withTempEnv(async ({ comments, views }) => {
    seed(comments, 'c1', '怎么做的？');
    seed(comments, 'c2', '求教程');
    config.set({
      reply: {
        mode: 'ai',
        fixed: { cycle: 'sequential', items: [{ text: '回复甲' }, { text: '回复乙' }] },
      },
    });

    // 间谍打在原型上：reply-engine 在模块顶层就解构了 LLMClient，
    // 换 llmModule.LLMClient 对它无效（p3-corpus 那种写法只对**命令内部才 require**
    // 的调用方管用）。原型是所有实例共享的，怎么加载都拦得住。
    const { LLMClient } = require('../core/llm');
    const origComplete = LLMClient.prototype.complete;
    let aiCalls = 0;
    LLMClient.prototype.complete = async () => {
      aiCalls++;
      throw new Error('这条用例里不该出现 AI 调用');
    };

    try {
      const { ctx } = makeCtx();
      const cmdGetReply = require('../core/commands/getReply');
      const r = await cmdGetReply(ctx, ['v1', '--cids', 'c1,c2', '--to-draft', '--mode', 'fixed']);

      expect(r.mode).toBe('fixed');
      expect(r.failed).toEqual([]);
      expect(r.generated.map(g => g.text)).toEqual(['回复甲', '回复乙']);
      expect(r.generated.every(g => g.source === 'fixed' && g.draftId > 0)).toBe(true);
      expect(views.listDrafts().items).toHaveLength(2);
      expect(aiCalls).toBe(0);
    } finally {
      LLMClient.prototype.complete = origComplete;
    }
  }));

  it('--mode 拼错时不静默变成 AI 批量，回退到配置值', withTempEnv(async ({ comments }) => {
    seed(comments, 'c1', 'x');
    config.set({ reply: { mode: 'fixed', fixed: { items: [{ text: '回复甲' }] } } });

    const { ctx } = makeCtx();
    const cmdGetReply = require('../core/commands/getReply');
    const r = await cmdGetReply(ctx, ['v1', '--cids', 'c1', '--mode', 'fixd']);

    expect(r.mode).toBe('fixed');
    expect(r.generated.map(g => g.text)).toEqual(['回复甲']);
  }));

  it('固定内容为空 + --mode fixed 时，不再建议一件没用的事', withTempEnv(async ({ comments }) => {
    seed(comments, 'c1', 'x');
    // 这颗按钮的处境：全局模式是 ai，这一批用 --mode 强制走固定内容，而列表是空的。
    // 此时"把回复模式改回 AI"完全没用 —— 它已经是 ai 了，改回去也不会影响这一批。
    config.set({ reply: { mode: 'ai', fixed: { items: [] } } });

    const { ctx } = makeCtx();
    const cmdGetReply = require('../core/commands/getReply');
    await expect(cmdGetReply(ctx, ['v1', '--cids', 'c1', '--to-draft', '--mode', 'fixed']))
      .rejects.toThrow(/固定回复列表里没有可用内容[\s\S]*改用「批量生成」/);
  }));
});

describe('批量生成 / --batch', () => {
  it('不传 --to-draft 时只生成，不碰草稿箱', withTempEnv(async ({ comments, views }) => {
    seed(comments, 'c1', 'a');
    seed(comments, 'c2', 'b');
    config.set({ reply: { mode: 'fixed', fixed: { items: [{ text: '回复' }] } } });

    const { ctx } = makeCtx();
    const cmdGetReply = require('../core/commands/getReply');
    const r = await cmdGetReply(ctx, ['v1', '--batch']);

    expect(r.toDraft).toBe(false);
    expect(r.generated).toHaveLength(2);
    expect(views.listDrafts().items).toHaveLength(0);
  }));

  it('排掉我自己发的评论（用 myUid，不再靠猜）', withTempEnv(async ({ comments, vids }) => {
    const videos = require('../core/memory/videos');
    videos.upsert({ awemeId: 'v1', title: 'T', isMine: true, authorUid: 'me' });
    seed(comments, 'c1', '别人发的', { uid: 'u1' });
    seed(comments, 'c2', '我自己发的', { uid: 'me' });
    config.set({ reply: { mode: 'fixed', fixed: { items: [{ text: '回复' }] } } });

    const { ctx } = makeCtx();
    const cmdGetReply = require('../core/commands/getReply');
    const r = await cmdGetReply(ctx, ['v1', '--batch']);

    expect(r.generated.map(g => g.cid)).toEqual(['c1']);
  }));

  it('没有可处理的评论时返回空结果而不是抛错', withTempEnv(async () => {
    config.set({ reply: { mode: 'fixed', fixed: { items: [{ text: '回复' }] } } });
    const { ctx } = makeCtx();
    const cmdGetReply = require('../core/commands/getReply');
    const r = await cmdGetReply(ctx, ['v1', '--batch']);
    expect(r.requested).toBe(0);
    expect(r.generated).toEqual([]);
  }));
});
