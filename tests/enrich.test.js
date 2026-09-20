// tests/enrich.test.js — 补全视频信息（标题 / 封面 / 互动数据）
//
// 不变量：
// 1. 默认只补**没有标题的**那些（`get`/`post` 建出来的壳），已有标题的不动
// 2. `--all` 才重抓已有标题的（用于刷新互动数据）
// 3. 单条失败不拖垮整批：失败的那条单独报出来，其余照补
// 4. 全部失败时审计收尾是 error，队列页才会显示"未完成"而不是"已完成 · 0 条"
// 5. 补全绝不能改动归属判断（is_mine 不会被写成 0）
// 6. 没有可补的时候正常返回，不报错

const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../core/config');

/**
 * 在临时数据目录 + 临时配置上跑一个用例。
 * @param {object|Function} userCfg - 写进临时 config.json 的用户配置；
 *   直接传函数 = 用 `{}`（旧写法，下面大部分用例都是这种）
 * @param {Function} [fn]
 */
function withTempEnv(userCfg, fn) {
  if (typeof userCfg === 'function') { fn = userCfg; userCfg = {}; }
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-enrich-'));
    const saved = {
      cfg: process.env.DOUYIN_CONFIG,
      storage: process.env.DOUYIN_STORAGE_DIR,
      log: process.env.DOUYIN_LOG_DIR,
    };
    process.env.DOUYIN_CONFIG = path.join(tmp, 'config.json');
    fs.writeFileSync(process.env.DOUYIN_CONFIG, JSON.stringify(userCfg || {}));
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    process.env.DOUYIN_LOG_DIR = path.join(tmp, 'logs');

    // enrich 依赖的模块都要清 —— 任何一个在模块级缓存过 db 实例，
    // 都会让下一个用例读到上一个用例的库（这个坑 getReply 已经踩过）
    const purge = () => {
      for (const m of ['../core/memory/db', '../core/memory/videos', '../core/memory/comments',
        '../core/memory/failures', '../core/data/views', '../core/commands/enrich',
        '../core/risk-control']) {
        try { delete require.cache[require.resolve(m)]; } catch (_) { /* 未加载过 */ }
      }
    };
    config.reset();
    purge();

    try {
      const videos = require('../core/memory/videos');
      const failures = require('../core/memory/failures');
      const cmdEnrich = require('../core/commands/enrich');
      const { getDb } = require('../core/memory/db');
      await fn({ tmp, videos, failures, cmdEnrich, getDb });
    } finally {
      try { require('../core/memory/db').closeDb(); } catch (_) { /* */ }
      purge();
      try { config.reset(); } catch (_) { /* */ }
      if (saved.cfg == null) delete process.env.DOUYIN_CONFIG; else process.env.DOUYIN_CONFIG = saved.cfg;
      if (saved.storage == null) delete process.env.DOUYIN_STORAGE_DIR; else process.env.DOUYIN_STORAGE_DIR = saved.storage;
      if (saved.log == null) delete process.env.DOUYIN_LOG_DIR; else process.env.DOUYIN_LOG_DIR = saved.log;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

/**
 * 假的 ctx。
 *
 * `detailFor` 是 awemeId → aweme_detail（或 null / Error）的映射，
 * 用来分别模拟"拿到了""接口说没有这个视频""请求本身炸了"三种情况。
 */
function makeCtx(detailFor = {}) {
  const events = [];
  const calls = [];
  const ctx = {
    audit: {
      startOperation: (name, meta) => events.push(['start', name, meta]),
      endOperation: (status, summary, result, error) =>
        events.push(['end', status, summary, result, error]),
    },
    loggedCall: async (command, payload, expr) => {
      const awemeId = String(payload.aweme_id);
      calls.push({ command, awemeId, expr });
      const v = detailFor[awemeId];
      if (v instanceof Error) throw v;
      if (v === null || v === undefined) return {};
      return { aweme_detail: v };
    },
  };
  return { ctx, events, calls };
}

/** 一份视频详情的形状（只保留 enrich 会读的字段） */
function detail(desc, stats = {}) {
  return {
    desc,
    create_time: 1781827200,
    author: { uid: 'author999' },
    video: { origin_cover: { url_list: ['https://cdn/cover.jpg'] } },
    statistics: stats,
  };
}

describe('补全视频信息', () => {
  it('把没有标题的视频补上，字段与统计数一起落库', withTempEnv(async ({ videos, cmdEnrich }) => {
    videos.upsert({ awemeId: 'v1' });   // get/post 建出来的壳：只有 id

    const { ctx, calls } = makeCtx({
      v1: detail('一个视频的标题', { play_count: 1234, digg_count: 56, comment_count: 7, share_count: 8 }),
    });
    const r = await cmdEnrich(ctx, ['--no-throttle']);

    expect(r.requested).toBe(1);
    expect(r.updatedCount).toBe(1);
    expect(r.failed).toEqual([]);
    expect(calls.map(c => c.awemeId)).toEqual(['v1']);

    const v = videos.get('v1');
    expect(v.title).toBe('一个视频的标题');
    expect(v.coverUrl).toBe('https://cdn/cover.jpg');
    expect(v.authorUid).toBe('author999');
    expect(v.createTime).toBe(1781827200);
    expect(v.stats).toMatchObject({ plays: 1234, likes: 56, comments: 7, shares: 8 });
  }));

  it('默认只挑没标题的，已有标题的不动（不浪费请求）', withTempEnv(async ({ videos, cmdEnrich }) => {
    videos.upsert({ awemeId: 'has-title', title: '早就有了' });
    videos.upsert({ awemeId: 'no-title' });

    const { ctx, calls } = makeCtx({ 'no-title': detail('补上的') });
    const r = await cmdEnrich(ctx, ['--no-throttle']);

    expect(calls.map(c => c.awemeId)).toEqual(['no-title']);
    expect(r.requested).toBe(1);
    expect(videos.get('has-title').title).toBe('早就有了');
  }));

  it('--all 会重抓已有标题的（刷新互动数据用）', withTempEnv(async ({ videos, cmdEnrich }) => {
    videos.upsert({ awemeId: 'a', title: '旧标题', playCount: 1 });
    videos.upsert({ awemeId: 'b', title: '标题二' });

    const { ctx, calls } = makeCtx({
      a: detail('新标题', { play_count: 999 }),
      b: detail('标题二', { play_count: 5 }),
    });
    await cmdEnrich(ctx, ['--all', '--no-throttle']);

    expect(calls.map(c => c.awemeId).sort()).toEqual(['a', 'b']);
    expect(videos.get('a').title).toBe('新标题');
    expect(videos.get('a').stats.plays).toBe(999);
  }));

  it('指定一个 awemeId 就只补那一条（库里没有也能补出来）', withTempEnv(async ({ videos, cmdEnrich }) => {
    const { ctx, calls } = makeCtx({ fresh: detail('新视频') });
    const r = await cmdEnrich(ctx, ['fresh', '--no-throttle']);

    expect(calls.map(c => c.awemeId)).toEqual(['fresh']);
    expect(r.updatedCount).toBe(1);
    expect(videos.get('fresh').title).toBe('新视频');
  }));

  it('单条失败不拖垮整批，失败原因逐条报出来', withTempEnv(async ({ videos, cmdEnrich, failures }) => {
    videos.upsert({ awemeId: 'ok1' });
    videos.upsert({ awemeId: 'boom' });
    videos.upsert({ awemeId: 'ok2' });
    videos.upsert({ awemeId: 'gone' });

    const { ctx } = makeCtx({
      ok1: detail('甲'),
      boom: new Error('bridge 超时'),
      ok2: detail('乙'),
      gone: null,                       // 接口连 aweme_detail 都没回
    });
    const r = await cmdEnrich(ctx, ['--no-throttle']);

    expect(r.updatedCount).toBe(2);
    expect(r.failed.map(f => f.awemeId).sort()).toEqual(['boom', 'gone']);
    expect(r.failed.find(f => f.awemeId === 'gone').error).toContain('aweme_detail');
    expect(videos.get('ok1').title).toBe('甲');
    expect(videos.get('ok2').title).toBe('乙');

    // 传输层失败要进失败模式库 —— "2055 又出现了"这类判断靠的就是这张表
    expect(failures.top(10).map(f => f.signature)).toContain('msg:bridge 超时');
  }));

  it('全部失败时审计收尾是 error，而不是"已完成 · 0 条"', withTempEnv(async ({ videos, cmdEnrich }) => {
    videos.upsert({ awemeId: 'a' });
    const { ctx, events } = makeCtx({ a: new Error('bridge 挂了') });
    await cmdEnrich(ctx, ['--no-throttle']);

    const end = events.find(e => e[0] === 'end');
    expect(end[1]).toBe('error');
    expect(end[4]).toContain('bridge 挂了');
  }));

  it('部分成功时收尾是 success（有产出就不该报成失败）', withTempEnv(async ({ videos, cmdEnrich }) => {
    videos.upsert({ awemeId: 'a' });
    videos.upsert({ awemeId: 'b' });
    const { ctx, events } = makeCtx({ a: detail('甲'), b: new Error('挂了') });
    await cmdEnrich(ctx, ['--no-throttle']);

    expect(events.find(e => e[0] === 'end')[1]).toBe('success');
  }));

  it('没有需要补的时候正常返回，不发任何请求', withTempEnv(async ({ videos, cmdEnrich }) => {
    videos.upsert({ awemeId: 'a', title: '已有标题' });
    const { ctx, calls, events } = makeCtx({});
    const r = await cmdEnrich(ctx, ['--no-throttle']);

    expect(calls).toEqual([]);
    expect(r).toMatchObject({ requested: 0, updatedCount: 0, failedCount: 0 });
    expect(events.find(e => e[0] === 'end')[1]).toBe('success');
  }));

  it('补全不会改动归属：别人的视频补完仍是别人的', withTempEnv(async ({ videos, cmdEnrich }) => {
    // user.js 抓来的他人作品：isMine=false + authorUid
    videos.upsert({ awemeId: 'other', isMine: false, authorUid: 'author999' });
    videos.upsert({ awemeId: 'mine', isMine: true, authorUid: 'me123' });

    const { ctx } = makeCtx({
      other: detail('别人的', { play_count: 1 }),
      mine: detail('我的', { play_count: 2 }),
    });
    await cmdEnrich(ctx, ['--no-throttle']);

    expect(videos.get('other').isMine).toBe(false);
    expect(videos.get('mine').isMine).toBe(true);
  }));

  it('一次最多补 MAX_BATCH 条（界面先拦，core 兜底）', withTempEnv(async ({ videos, cmdEnrich }) => {
    for (let i = 0; i < 5; i++) videos.upsert({ awemeId: `v${i}` });
    const { ctx, calls } = makeCtx({});
    // 传一个远大于上限的 limit，实际请求数必须被夹住
    const r = await cmdEnrich(ctx, ['--limit', '9999', '--no-throttle']);
    expect(r.requested).toBeLessThanOrEqual(200);
    expect(calls.length).toBe(r.requested);
  }));

  // ── 以下是第十五轮补的三条：都是"跑过成功路径才看得见"的问题 ──

  it('不写文案的作品：补一次就算补完，不会每点一次都重抓', withTempEnv(async ({ videos, cmdEnrich }) => {
    // 抖音上大量作品 desc 就是空串，而 upsert 里 `title: fields.title || null`
    // —— 只看标题的旧判定会让这类视频永远留在"待补全"里：
    // 按钮上的数字不降，每点一次都把同一批重抓一遍。
    videos.upsert({ awemeId: 'no-desc' });

    const { ctx, calls } = makeCtx({ 'no-desc': detail('') });   // desc 为空，但有封面
    await cmdEnrich(ctx, ['--no-throttle']);

    expect(videos.get('no-desc').coverUrl).toBe('https://cdn/cover.jpg');
    expect(videos.countMissingInfo()).toBe(0);        // 界面上的数字必须掉下来

    await cmdEnrich(ctx, ['--no-throttle']);
    expect(calls.length).toBe(1);                     // 第二次点它不该再发请求
  }));

  it('批内逐条之间有间隔（enforceDelay 只管批次之间）', withTempEnv({
    intervals: { commentPage: [0.05, 0.06] },
  }, async ({ videos, cmdEnrich }) => {
    // 一次跑三条：条与条之间必须有两次页间隔。
    // 旧写法是在循环里调 enforceDelay —— 而 events 一行要到 endOperation 才写，
    // 于是整批算出来的"距上次读"都是同一个值，三条是连发出去的。
    for (const id of ['a', 'b', 'c']) videos.upsert({ awemeId: id });
    const { ctx } = makeCtx({ a: detail('甲'), b: detail('乙'), c: detail('丙') });

    const t0 = Date.now();
    await cmdEnrich(ctx, []);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);

    // --no-throttle 时这一层也要跳过（否则"跳过等待"是个半生效的开关）
    videos.upsert({ awemeId: 'd' });
    const { ctx: ctx2 } = makeCtx({ d: detail('丁') });
    const t1 = Date.now();
    await cmdEnrich(ctx2, ['--no-throttle']);
    expect(Date.now() - t1).toBeLessThan(90);
  }), 20000);

  it('候选集读不出来时命令失败，而不是报"没有需要补全的视频"', withTempEnv(async ({ videos, cmdEnrich, getDb }) => {
    videos.upsert({ awemeId: 'a' });
    // 模拟库出问题：把表挪走。旧写法是 catch 掉返回空数组，
    // 于是命令对用户说"没有需要补全的视频"，界面显示成功 —— 一句假话。
    getDb().exec('ALTER TABLE videos RENAME TO videos_gone');
    try {
      expect(() => videos.listMissingInfo()).toThrow();
      await expect(cmdEnrich(makeCtx({}).ctx, ['--no-throttle'])).rejects.toThrow();
      // 而角标用的那个计数只降级、不炸整页
      expect(videos.countMissingInfo()).toBe(0);
    } finally {
      getDb().exec('ALTER TABLE videos_gone RENAME TO videos');
    }
  }));
});
