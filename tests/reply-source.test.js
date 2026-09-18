// tests/reply-source.test.js — P4.1 回复来源分发
//
// 不变量：
// 1. 四种循环方式各自的行为（D14 全做），且循环状态能跨调用延续
// 2. 固定内容为空/条目全被禁用时，报的是"为什么没有"而不是静默返回空文本
// 3. hybrid 在 AI 失败时按 fallbackToFixed 降级，降级目标也没有时透出 AI 的原始错误
// 4. 图片只在配置允许、且文件确实可用时才被选中
// 5. 循环状态不写进用户配置（config.json 只保留用户手写的项）

const fs = require('fs');
const path = require('path');
const os = require('os');

/** 每例一个独立的临时 dataDir + config.json，避免污染真实配置与状态文件 */
function withTempEnv(fn) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-replysrc-'));
    const origCfg = process.env.DOUYIN_CONFIG;
    const origData = process.env.DOUYIN_DATA_DIR;
    process.env.DOUYIN_CONFIG = path.join(tmp, 'config.json');
    process.env.DOUYIN_DATA_DIR = tmp;

    // 这些模块都按调用时的环境解析路径，但 config 有内存缓存，必须显式 reset
    const config = require('../core/config');
    const replySource = require('../core/reply-source');
    config.reset();
    replySource.state.reset();

    try {
      await fn({ tmp, config, replySource });
    } finally {
      try { config.reset(); } catch (_) { /* */ }
      if (origCfg == null) delete process.env.DOUYIN_CONFIG; else process.env.DOUYIN_CONFIG = origCfg;
      if (origData == null) delete process.env.DOUYIN_DATA_DIR; else process.env.DOUYIN_DATA_DIR = origData;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

const { cycles } = require('../core/reply-source');

/** 只要一个确定序列的假随机源 */
function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

function freshState() {
  return cycles.emptyState();
}

describe('reply-source / cycles（四种循环方式）', () => {
  it('sequential 按顺序取，取完回到第一条', () => {
    const state = freshState();
    const pick = () => cycles.pickIndex({ len: 3, cycle: 'sequential', state });
    expect([pick(), pick(), pick(), pick()]).toEqual([0, 1, 2, 0]);
  });

  it('random 用随机源选，且可能重复', () => {
    const state = freshState();
    const rng = seqRng([0, 0, 0.99]);
    const pick = () => cycles.pickIndex({ len: 3, cycle: 'random', state, rng });
    expect([pick(), pick(), pick()]).toEqual([0, 0, 2]);
  });

  it('shuffle-no-repeat 把整副牌用完才重洗', () => {
    const state = freshState();
    // 确定性洗牌：固定随机源让洗牌结果可预期
    const rng = () => 0;
    const picks = [];
    for (let i = 0; i < 6; i++) {
      picks.push(cycles.pickIndex({ len: 3, cycle: 'shuffle-no-repeat', state, rng }));
    }
    // 前 3 次必须互不相同（一副牌用完），后 3 次同理
    expect(new Set(picks.slice(0, 3)).size).toBe(3);
    expect(new Set(picks.slice(3, 6)).size).toBe(3);
  });

  it('weighted 按权重抽样：权重大的明显更容易被抽中', () => {
    const state = freshState();
    const hits = [];
    const weights = [9, 1];
    for (let i = 0; i < 100; i++) {
      // 均匀覆盖 [0,1)，权重 9:1 使得下标 0 大约占九成
      hits.push(cycles.pickIndex({ len: 2, cycle: 'weighted', state, weights, rng: () => i / 100 }));
    }
    expect(hits.filter(h => h === 0).length).toBe(90);
    expect(hits.filter(h => h === 1).length).toBe(10);
  });

  it('weighted 下权重为 0 的条目被排除（由 usableItems 完成过滤）', () => {
    const items = [
      { text: '常用', weight: 3 },
      { text: '停用', weight: 0 },
      { text: '缺省权重' },
    ];
    const usable = require('../core/reply-source/fixed').usableItems(items, 'weighted');
    expect(usable.map(u => u.text)).toEqual(['常用', '缺省权重']);

    // 非 weighted 模式下权重 0 不影响取样，只是权重为 0
    const all = require('../core/reply-source/fixed').usableItems(items, 'sequential');
    expect(all.map(u => u.text)).toEqual(['常用', '停用', '缺省权重']);
  });

  it('weighted 下候选权重全为 0 时退回等概率，不返回空', () => {
    const state = freshState();
    const idx = cycles.pickIndex({ len: 2, cycle: 'weighted', state, weights: [0, 0], rng: () => 0 });
    expect(idx).toBe(0);
  });

  it('minGapBetweenReuse 让同一句至少间隔 N 次才复用', () => {
    const state = freshState();
    const picks = [];
    // 列表 3 条、间隔 2：抽到的必须与前两次都不同，于是被迫走出 0,1,2,0,1,2 的循环
    for (let i = 0; i < 9; i++) {
      picks.push(cycles.pickIndex({ len: 3, cycle: 'random', state, minGap: 2, rng: () => 0 }));
    }
    expect(picks).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2]);
  });

  it('间隔大于列表长度时放开约束，仍然取得到值', () => {
    // 列表 3 条却要求"间隔 3 次"：数学上无解（只有 2 条别的可选）。
    // 此时放开约束比返回空更有用 —— 配置本身合法，只是在这份列表上做不到。
    const state = freshState();
    for (let i = 0; i < 5; i++) {
      const idx = cycles.pickIndex({ len: 3, cycle: 'random', state, minGap: 3, rng: () => 0 });
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(3);
    }
  });

  it('列表变短后越界的历史状态被丢弃，不会取到不存在的位置', () => {
    const state = { cursor: 9, deck: [8, 1], drain: [7], recent: [6] };
    const idx = cycles.pickIndex({ len: 2, cycle: 'shuffle-no-repeat', state, rng: () => 0 });
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(2);
  });

  it('空列表返回 -1', () => {
    const state = freshState();
    expect(cycles.pickIndex({ len: 0, cycle: 'sequential', state })).toBe(-1);
  });
});

describe('reply-source / 固定内容', () => {
  it('跳过被禁用与内容为空的条目', withTempEnv(async ({ replySource }) => {
    const r = replySource.fixed.nextFixed({
      config: {
        cycle: 'sequential',
        items: [
          { text: '可用一', enabled: true },
          { text: '被禁用', enabled: false },
          { text: '   ', enabled: true },
          { text: '可用二', enabled: true },
        ],
      },
      state: freshState(),
    });
    expect(r.text).toBe('可用一');
    expect(r.itemIndex).toBe(0);

    const d = replySource.fixed.describeItems([
      { text: '可用一', enabled: true },
      { text: '被禁用', enabled: false },
      { text: '   ', enabled: true },
    ]);
    expect(d).toEqual({ total: 3, usable: 1, disabled: 1, blank: 1, zeroWeight: 0 });
  }));

  it('weighted 模式下把"权重为 0 被排除"的条数单独报出来', withTempEnv(async ({ replySource }) => {
    const items = [
      { text: '在用A', weight: 2 },
      { text: '停用', weight: 0 },
      { text: '在用B' },
    ];
    expect(replySource.fixed.describeItems(items, 'sequential').zeroWeight).toBe(0);
    const w = replySource.fixed.describeItems(items, 'weighted');
    expect(w.usable).toBe(2);
    expect(w.zeroWeight).toBe(1);
  }));

  it('全部条目权重为 0 时报的是"权重为 0"而不是"列表是空的"', withTempEnv(async ({ config, replySource }) => {
    config.set({ reply: { mode: 'fixed', fixed: { cycle: 'weighted', items: [{ text: 'A', weight: 0 }] } } });
    const r = await replySource.next(null, { comment: { cid: 'c1', text: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('1 条权重为 0');
  }));

  it('列表为空时返回 null，由上层给出可读原因', withTempEnv(async ({ config, replySource }) => {
    config.set({ reply: { mode: 'fixed', fixed: { items: [] } } });
    const r = await replySource.next(null, {
      comment: { cid: 'c1', text: 'hi' },
      generateAI: async () => { throw new Error('固定模式不该调用 AI'); },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('固定回复列表是空的');
  }));

  it('循环进度跨调用延续，且落在独立的 reply-state.json 而不是 config.json', withTempEnv(async ({ tmp, config, replySource }) => {
    config.set({
      reply: {
        mode: 'fixed',
        fixed: { cycle: 'sequential', items: [{ text: 'A' }, { text: 'B' }] },
      },
    });

    const call = async () => {
      const r = await replySource.next(null, { comment: { cid: 'c1', text: 'x' } });
      return r.text;
    };
    expect(await call()).toBe('A');
    expect(await call()).toBe('B');
    expect(await call()).toBe('A');

    // 状态落在独立文件
    const stateFile = path.join(tmp, 'reply-state.json');
    expect(fs.existsSync(stateFile)).toBe(true);

    // 用户配置里不能出现机器状态
    const raw = JSON.parse(fs.readFileSync(process.env.DOUYIN_CONFIG, 'utf8'));
    expect(raw.reply.fixed.cursor).toBeUndefined();
    expect(raw.reply.fixed.deck).toBeUndefined();
  }));

  it('状态文件损坏时从空状态开始，不抛错', withTempEnv(async ({ tmp, config, replySource }) => {
    fs.writeFileSync(path.join(tmp, 'reply-state.json'), '{ 这不是 JSON');
    config.set({ reply: { mode: 'fixed', fixed: { items: [{ text: '能出结果' }] } } });
    const r = await replySource.next(null, { comment: { cid: 'c1', text: 'x' } });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('能出结果');
  }));
});

describe('reply-source / 模式分发', () => {
  it('ai 模式走 generateAI，并保留原始结果形状', withTempEnv(async ({ config, replySource }) => {
    config.set({ reply: { mode: 'ai' } });
    const raw = { reply: { text: 'AI 生成的内容', persona: { id: 'p1', name: 'P' } } };
    const r = await replySource.next(null, {
      awemeId: 'v1',
      comment: { cid: 'c1', text: 'x' },
      generateAI: async () => raw,
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('ai');
    expect(r.personaId).toBe('p1');
    expect(r.text).toBe('AI 生成的内容');
    expect(r.raw).toBe(raw);
  }));

  it('ai 失败时直接失败，不静默降级', withTempEnv(async ({ config, replySource }) => {
    config.set({ reply: { mode: 'ai' } });
    const r = await replySource.next(null, {
      comment: { cid: 'c1', text: 'x' },
      generateAI: async () => { throw new Error('模型超时'); },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('模型超时');
  }));

  it('hybrid 按比例选源；aiRatio=0 时完全不碰 AI', withTempEnv(async ({ config, replySource }) => {
    config.set({
      reply: { mode: 'hybrid', hybrid: { aiRatio: 0 }, fixed: { items: [{ text: '固定内容' }] } },
    });
    let aiCalled = false;
    const r = await replySource.next(null, {
      comment: { cid: 'c1', text: 'x' },
      generateAI: async () => { aiCalled = true; return { reply: { text: 'ai' } }; },
    });
    expect(aiCalled).toBe(false);
    expect(r.source).toBe('fixed');
    expect(r.text).toBe('固定内容');
  }));

  it('hybrid 在 AI 失败时降级到固定内容，并标记 degraded', withTempEnv(async ({ config, replySource }) => {
    config.set({
      reply: { mode: 'hybrid', hybrid: { aiRatio: 1, fallbackToFixed: true }, fixed: { items: [{ text: '兜底内容' }] } },
    });
    const r = await replySource.next(null, {
      comment: { cid: 'c1', text: 'x' },
      generateAI: async () => { throw new Error('503'); },
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('fixed');
    expect(r.text).toBe('兜底内容');
    expect(r.degraded).toBe(true);
    expect(r.aiError).toContain('503');
  }));

  it('hybrid 关闭降级时，AI 失败即整体失败', withTempEnv(async ({ config, replySource }) => {
    config.set({
      reply: { mode: 'hybrid', hybrid: { aiRatio: 1, fallbackToFixed: false }, fixed: { items: [{ text: '兜底内容' }] } },
    });
    const r = await replySource.next(null, {
      comment: { cid: 'c1', text: 'x' },
      generateAI: async () => { throw new Error('505'); },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('505');
  }));

  it('降级目标也没有时，报的是 AI 的原始错误（那才是要修的东西）', withTempEnv(async ({ config, replySource }) => {
    config.set({ reply: { mode: 'hybrid', hybrid: { aiRatio: 1 }, fixed: { items: [] } } });
    const r = await replySource.next(null, {
      comment: { cid: 'c1', text: 'x' },
      generateAI: async () => { throw new Error('连接被重置'); },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('连接被重置');
    expect(r.error).toContain('固定回复列表是空的');
  }));

  it('--mode 显式覆盖优先于配置', withTempEnv(async ({ config, replySource }) => {
    config.set({ reply: { mode: 'ai', fixed: { items: [{ text: '固定内容' }] } } });
    const r = await replySource.next(null, {
      comment: { cid: 'c1', text: 'x' },
      mode: 'fixed',
      generateAI: async () => { throw new Error('不该走 AI'); },
    });
    expect(r.text).toBe('固定内容');
    expect(r.meta.mode).toBe('fixed');
  }));

  it('--mode 拼错时忽略该参数、回到配置的值，而不是让命令失败', withTempEnv(async ({ config, replySource }) => {
    config.set({ reply: { mode: 'fixed', fixed: { items: [{ text: '固定' }] } } });
    const r = await replySource.next(null, {
      comment: { cid: 'c1', text: 'x' },
      mode: 'aifixed', // 拼错
      generateAI: async () => ({ reply: { text: 'AI 结果' } }),
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('fixed');
    expect(r.text).toBe('固定');
  }));
});

describe('reply-source / 图片附加', () => {
  /** 造一个真实存在的小 png（内容不重要，只走 stat 校验） */
  function makePng(dir, name) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    return p;
  }

  it('未启用时不选图', withTempEnv(async ({ config, replySource }) => {
    config.set({ reply: { mode: 'fixed', fixed: { items: [{ text: 'A' }] }, image: { enabled: false } } });
    const r = await replySource.next(null, { comment: { cid: 'c1', text: 'x' } });
    expect(r.imagePath).toBeNull();
  }));

  it('always 模式选中一张可用图片', withTempEnv(async ({ tmp, config, replySource }) => {
    const p = makePng(tmp, 'a.png');
    config.set({
      reply: {
        mode: 'fixed',
        fixed: { items: [{ text: 'A' }] },
        image: { enabled: true, mode: 'always', paths: [p] },
      },
    });
    const r = await replySource.next(null, { comment: { cid: 'c1', text: 'x' } });
    expect(r.imagePath).toBe(p);
    expect(r.text).toBe('A');
  }));

  it('不可用的路径（不存在 / 格式不支持）被跳过，且不影响文字正常返回', withTempEnv(async ({ tmp, config, replySource }) => {
    const good = makePng(tmp, 'ok.png');
    const bad = path.join(tmp, 'missing.png');
    const weird = path.join(tmp, 'note.txt');
    fs.writeFileSync(weird, 'hi');
    config.set({
      reply: {
        mode: 'fixed',
        fixed: { items: [{ text: '正文' }] },
        image: { enabled: true, mode: 'always', paths: [bad, weird, good] },
      },
    });
    const r = await replySource.next(null, { comment: { cid: 'c1', text: 'x' } });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('正文');
    expect(r.imagePath).toBe(good);
    expect(r.imageReason).toContain('2 张不可用已跳过');
  }));

  it('一张可用图都没有时不带图，但仍返回文字', withTempEnv(async ({ tmp, config, replySource }) => {
    config.set({
      reply: {
        mode: 'fixed',
        fixed: { items: [{ text: '正文' }] },
        image: { enabled: true, mode: 'always', paths: [path.join(tmp, 'nope.png')] },
      },
    });
    const r = await replySource.next(null, { comment: { cid: 'c1', text: 'x' } });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('正文');
    expect(r.imagePath).toBeNull();
    expect(r.imageReason).toContain('都不可用');
  }));

  it('keyword 模式只在评论命中关键词时带图', withTempEnv(async ({ tmp, config, replySource }) => {
    const p = makePng(tmp, 'k.png');
    config.set({
      reply: {
        mode: 'fixed',
        fixed: { items: [{ text: '正文' }] },
        image: { enabled: true, mode: 'keyword', keywords: ['教程'], paths: [p] },
      },
    });
    const hit = await replySource.next(null, { comment: { cid: 'c1', text: '求个教程' } });
    expect(hit.imagePath).toBe(p);

    const miss = await replySource.next(null, { comment: { cid: 'c2', text: '随便看看' } });
    expect(miss.imagePath).toBeNull();
  }));

  it('withText=false 时只留图片，文字清空', withTempEnv(async ({ tmp, config, replySource }) => {
    const p = makePng(tmp, 'only.png');
    config.set({
      reply: {
        mode: 'fixed',
        fixed: { items: [{ text: '这段文字不该出现' }] },
        image: { enabled: true, mode: 'always', paths: [p], withText: false },
      },
    });
    const r = await replySource.next(null, { comment: { cid: 'c1', text: 'x' } });
    expect(r.imagePath).toBe(p);
    expect(r.text).toBe('');
  }));
});

describe('getReply 命令按 reply.mode 分发', () => {
  /**
   * 走一遍真实的 getReply 命令（不是只测 reply-source 模块），
   * 覆盖"分发点接在命令内部"这条约定本身：
   * 结果形状、stdout 输出、审计记录是否都对得上。
   */
  function withCommentInDb(fn) {
    return withTempEnv(async (env) => {
      // getReply 从 SQLite 读评论，先把目标评论塞进去
      const comments = require('../core/memory/comments');
      comments.upsert({ cid: 'c1', awemeId: 'v1', uid: 'u1', text: '这条怎么做的？', createdAt: 1700000000 });

      const auditCalls = [];
      const ctx = {
        config: { llm: {} },
        bridgeCall: null,
        audit: {
          startOperation: (name, meta) => auditCalls.push(['start', name, meta]),
          endOperation: (status, meta, result, err) => auditCalls.push(['end', status, meta, err]),
        },
      };
      return fn({ ...env, ctx, auditCalls, comments });
    });
  }

  /** logger.output 走 console.log，收集起来当 stdout 看 */
  async function captureOutput(fn) {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.map(String).join(' '));
    try {
      const result = await fn();
      return { result, output: lines.join('\n') };
    } finally {
      console.log = orig;
    }
  }

  it('fixed 模式下不调用 LLM，直接吐固定内容', withCommentInDb(async ({ config, ctx, auditCalls }) => {
    config.set({ reply: { mode: 'fixed', fixed: { items: [{ text: '固定回复内容' }] } } });
    const cmdGetReply = require('../core/commands/getReply');

    const { result, output } = await captureOutput(() => cmdGetReply(ctx, ['v1', 'c1']));

    expect(output).toBe('固定回复内容');
    expect(result.source).toBe('fixed');
    expect(result.reply.text).toBe('固定回复内容');
    // 审计里要能看出这条是固定内容来的，而不只是一条"成功"
    const end = auditCalls.find(c => c[0] === 'end');
    expect(end[1]).toBe('success');
    expect(end[2].source).toBe('fixed');
  }));

  it('fixed 模式但列表为空时命令失败，错误信息说清为什么', withCommentInDb(async ({ config, ctx, auditCalls }) => {
    config.set({ reply: { mode: 'fixed', fixed: { items: [] } } });
    const cmdGetReply = require('../core/commands/getReply');

    await expect(cmdGetReply(ctx, ['v1', 'c1'])).rejects.toThrow(/固定回复列表是空的/);
    const end = auditCalls.find(c => c[0] === 'end');
    expect(end[1]).toBe('error');
  }));

  it('--mode 可以临时覆盖配置的模式', withCommentInDb(async ({ config, ctx }) => {
    config.set({ reply: { mode: 'ai', fixed: { items: [{ text: '临时切过来的固定内容' }] } } });
    const cmdGetReply = require('../core/commands/getReply');

    const { result, output } = await captureOutput(() => cmdGetReply(ctx, ['v1', 'c1', '--mode', 'fixed']));
    expect(output).toBe('临时切过来的固定内容');
    expect(result.source).toBe('fixed');
  }));

  it('结果里带上附图路径，界面据此把 --image 传给发布', withCommentInDb(async ({ tmp, config, ctx }) => {
    const p = path.join(tmp, 'reply.png');
    fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    config.set({
      reply: {
        mode: 'fixed',
        fixed: { items: [{ text: '带图的回复' }] },
        image: { enabled: true, mode: 'always', paths: [p] },
      },
    });
    const cmdGetReply = require('../core/commands/getReply');

    const { result } = await captureOutput(() => cmdGetReply(ctx, ['v1', 'c1']));
    expect(result.imagePath).toBe(p);
    expect(result.reply.text).toBe('带图的回复');
  }));
});

describe('草稿箱保留附图', () => {
  it('image_path 能存能取；编辑草稿时附图不会丢', withTempEnv(async ({ tmp }) => {
    const drafts = require('../core/memory/drafts');
    const p = path.join(tmp, 'a.png');

    const id = drafts.save({ awemeId: 'v1', text: '带图草稿', imagePath: p });
    expect(id).toBeGreaterThan(0);
    expect(drafts.get(id).image_path).toBe(p);

    const views = require('../core/data/views');
    const listed = views.listDrafts().find(d => d.id === id);
    expect(listed.imagePath).toBe(p);
  }));

  it('纯图草稿（无文字）可以保存；文字与图片都没有才拒绝', withTempEnv(async ({ tmp }) => {
    const drafts = require('../core/memory/drafts');
    const p = path.join(tmp, 'only.png');

    expect(drafts.save({ awemeId: 'v1', text: '', imagePath: p })).toBeGreaterThan(0);
    expect(drafts.save({ awemeId: 'v1', text: '', imagePath: null })).toBeNull();
    expect(drafts.save({ awemeId: 'v1', text: '   ' })).toBeNull();
  }));
});

describe('reply-source / 配置校验', () => {
  it('默认配置本身合法（不产生任何告警）', withTempEnv(async ({ config }) => {
    expect(config.getWarnings()).toEqual([]);
    const reply = config.get('reply');
    expect(reply.mode).toBe('ai');
    expect(reply.fixed.items).toEqual([]);
    expect(reply.image.enabled).toBe(false);
  }));

  it('非法 mode / cycle 回退默认并告警', withTempEnv(async ({ config }) => {
    const r = config.set({ reply: { mode: 'aii', fixed: { cycle: '乱写' } } });
    const keys = r.warnings.map(w => w.key);
    expect(keys).toContain('reply.mode');
    expect(keys).toContain('reply.fixed.cycle');
    expect(config.get('reply.mode')).toBe('ai');
    expect(config.get('reply.fixed.cycle')).toBe('shuffle-no-repeat');
  }));

  it('写坏的固定条目被逐条丢弃，其余照常保留', withTempEnv(async ({ config }) => {
    const r = config.set({
      reply: {
        fixed: {
          items: [
            { text: '正常的' },
            { text: '' },              // 无内容
            '不是对象',
            { text: '权重非法', weight: -1 },
            { text: '权重缺省应该补 1' },
          ],
        },
      },
    });
    expect(r.warnings.map(w => w.key)).toContain('reply.fixed.items');
    const items = config.get('reply.fixed.items');
    expect(items.map(i => i.text)).toEqual(['正常的', '权重缺省应该补 1']);
    // 缺省的 weight / enabled 被补齐，避免下游到处写 `|| 1`
    expect(items[1]).toEqual({ text: '权重缺省应该补 1', weight: 1, enabled: true });
  }));

  it('aiRatio / ratio 超出 0-1 被判非法', withTempEnv(async ({ config }) => {
    const r = config.set({ reply: { hybrid: { aiRatio: 1.5 }, image: { ratio: -0.2 } } });
    const keys = r.warnings.map(w => w.key);
    expect(keys).toContain('reply.hybrid.aiRatio');
    expect(keys).toContain('reply.image.ratio');
  }));

  it('配置校验认的循环名与取样器实现的名字是同一份', withTempEnv(async ({ config }) => {
    expect(config._internal).toBeDefined();
    const d = config.DEFAULTS.reply;
    expect(cycles.CYCLE_NAMES).toContain(d.fixed.cycle);
    expect(cycles.CYCLE_NAMES).toContain(d.image.pick);
    expect(config.REPLY_MODES).toContain(d.mode);
  }));
});
