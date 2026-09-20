// tests/get-full-pull.test.js — 全量拉取的翻页循环
//
// 为什么单独一个文件：在这之前**没有任何测试跑过 cmdGet 的分页循环**
// （tests/runtime.test.js 里那个 fakeBridge 没导出、只喂给 context 单测）。
// 于是"翻页"这块唯一的验证手段就是拿真账号去抖音上撞 —— 而它恰恰是最贵的一类代码：
// 拉重了浪费请求、拉漏了用户以为拉全了。
//
// 下面每条不变量都对应一次真实接口实测（2026-09，comments/list），注释里写明来源。

const fs = require('fs');
const os = require('os');
const path = require('path');

const { fetchAllPages, MAX_PAGE_SIZE } = require('../core/commands/get');

/**
 * 在临时数据目录里跑，避免碰真实 storage/。
 * 与 tests/p2-entities.test.js 的 withTempProject 同构 —— 那是本仓跑"命令 + 落库"
 * 类测试的既有做法（清 require.cache 让模块级连接重新指向临时库）。
 */
function withTempProject(fn) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-fullpull-'));
    const origStorage = process.env.DOUYIN_STORAGE_DIR;
    const origLog = process.env.DOUYIN_LOG_DIR;
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    process.env.DOUYIN_LOG_DIR = path.join(tmp, 'logs');
    ['../core/memory/db', '../core/memory/users', '../core/memory/comments',
      '../core/memory/videos', '../core/memory/accounts', '../core/commands/get'].forEach((m) => {
      try { delete require.cache[require.resolve(m)]; } catch (e) { /* 首次加载时不存在 */ }
    });
    try {
      await fn(tmp);
    } finally {
      try { require('../core/memory/db').closeDb(); } catch (e) { /* 未打开 */ }
      if (origStorage == null) delete process.env.DOUYIN_STORAGE_DIR;
      else process.env.DOUYIN_STORAGE_DIR = origStorage;
      if (origLog == null) delete process.env.DOUYIN_LOG_DIR;
      else process.env.DOUYIN_LOG_DIR = origLog;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

/** 造一个按 cursor 顺序吐页的假 ctx。pages 里的元素可以是对象或函数。 */
function fakeCtx(pages) {
  let i = 0;
  const calls = [];
  return {
    calls,
    loggedCall: async (endpoint, params) => {
      calls.push({ endpoint, ...params });
      if (i >= pages.length) throw new Error(`假 bridge 被多要了一页（第 ${i + 1} 页）`);
      const p = pages[i++];
      return typeof p === 'function' ? p(params) : p;
    },
  };
}

/** 一页评论。cid 直接用序号，读起来清楚。 */
function page(from, to, extra = {}) {
  const comments = [];
  for (let i = from; i <= to; i++) comments.push({ cid: String(i), text: `c${i}` });
  return { comments, ...extra };
}

describe('fetchAllPages 正常翻页', () => {
  it('翻到 has_more=0 为止，页数与条数都对得上', async () => {
    const ctx = fakeCtx([
      page(1, 20, { has_more: 1, cursor: 20 }),
      page(21, 40, { has_more: 1, cursor: 40 }),
      page(41, 45, { has_more: 0, cursor: 60 }),
    ]);
    const r = await fetchAllPages(ctx, '123', { perPage: 20 });

    expect(r.comments).toHaveLength(45);
    expect(r.pages).toBe(3);
    expect(r.unique).toBe(45);
    expect(r.duplicates).toBe(0);
    expect(r.stoppedBy).toBe('end');
  });

  it('cursor 按服务端回传值推进，不是自己累加', async () => {
    // 实测：服务端回传的 cursor 恒为「请求 cursor + 请求 count」，但那是服务端的行为，
    // 客户端必须认它回传的那个值 —— 万一以后它改成别的步进方式，累加就错了
    const ctx = fakeCtx([
      page(1, 20, { has_more: 1, cursor: 999 }),
      page(21, 30, { has_more: 0, cursor: 1030 }),
    ]);
    await fetchAllPages(ctx, '123', { perPage: 20 });

    expect(ctx.calls[0].cursor).toBe(0);
    expect(ctx.calls[1].cursor).toBe(999);
  });

  it('服务端不回传 cursor 时退化为 cursor + perPage（不让循环原地打转）', async () => {
    const ctx = fakeCtx([
      page(1, 20, { has_more: 1 }),
      page(21, 30, { has_more: 0 }),
    ]);
    await fetchAllPages(ctx, '123', { perPage: 20 });

    expect(ctx.calls[1].cursor).toBe(20);
  });
});

describe('fetchAllPages 越界（偏移量大于实际评论数）', () => {
  // 实测：cursor=1180/1200/5000/50000 打同一个视频，服务端一律回
  // `comments: []` + `has_more: 0` + `status_code: 0`，不报错。
  // 所以空页是**正常**的终止信号，不能当成失败抛出去。
  it('空数组页 → stoppedBy=empty，不抛错', async () => {
    const ctx = fakeCtx([
      page(1, 20, { has_more: 1, cursor: 20 }),
      { comments: [], has_more: 0, cursor: 40, status_code: 0 },
    ]);
    const r = await fetchAllPages(ctx, '123', { perPage: 20 });

    expect(r.comments).toHaveLength(20);
    expect(r.stoppedBy).toBe('empty');
  });

  it('空页即使 has_more 仍为 1 也停（不信任一个空页后面还有内容）', async () => {
    const ctx = fakeCtx([
      page(1, 20, { has_more: 1, cursor: 20 }),
      { comments: [], has_more: 1, cursor: 40 },
    ]);
    const r = await fetchAllPages(ctx, '123', { perPage: 20 });

    expect(r.stoppedBy).toBe('empty');
    expect(ctx.calls).toHaveLength(2);
  });
});

describe('fetchAllPages 去重', () => {
  // 实测：1180 条那个作品顺序翻完拿到 1093 条，去重后只有 903 条 —— 17% 重复。
  // offset 翻页踩在一个会变动的列表上，重复是常态，不是异常。
  it('跨页重复的 cid 只保留一份，并计入 duplicates', async () => {
    const ctx = fakeCtx([
      page(1, 20, { has_more: 1, cursor: 20 }),
      // 第 2 页把 15-20 又吐了一遍（实测里就是这个形态）
      { comments: [15, 16, 17, 18, 19, 20, 21, 22, 23, 24].map(n => ({ cid: String(n) })), has_more: 1, cursor: 40 },
      page(25, 30, { has_more: 0, cursor: 60 }),
    ]);
    const r = await fetchAllPages(ctx, '123', { perPage: 20 });

    expect(r.unique).toBe(30);          // 1..30，一条不多一条不少
    expect(r.comments).toHaveLength(30);
    expect(r.duplicates).toBe(6);       // 15-20 重复
    expect(new Set(r.comments.map(c => c.cid)).size).toBe(30);
  });

  it('同一页内部的重复也要去掉', async () => {
    const ctx = fakeCtx([
      { comments: [{ cid: 'a' }, { cid: 'a' }, { cid: 'b' }], has_more: 0, cursor: 3 },
    ]);
    const r = await fetchAllPages(ctx, '123', { perPage: 20 });

    expect(r.unique).toBe(2);
    expect(r.duplicates).toBe(1);
  });

  it('没有 cid 的脏数据被跳过，不会污染去重集合', async () => {
    const ctx = fakeCtx([
      { comments: [{ cid: 'a' }, { text: '没有 cid' }, null], has_more: 0, cursor: 3 },
    ]);
    const r = await fetchAllPages(ctx, '123', { perPage: 20 });

    expect(r.unique).toBe(1);
  });
});

describe('fetchAllPages 保险丝', () => {
  it('连续 3 页无新增 → stoppedBy=stale', async () => {
    // has_more 中途一直是 1（实测如此），所以"原地打转"只能靠新增数识别
    const same = { comments: [{ cid: 'a' }], has_more: 1, cursor: 1 };
    const ctx = fakeCtx([
      { comments: [{ cid: 'a' }], has_more: 1, cursor: 1 },
      { ...same, cursor: 2 },
      { ...same, cursor: 3 },
      { ...same, cursor: 4 },
    ]);
    const r = await fetchAllPages(ctx, '123', { perPage: 20 });

    expect(r.stoppedBy).toBe('stale');
    expect(r.unique).toBe(1);
    expect(ctx.calls).toHaveLength(4);   // 第 1 页有新增，第 2-4 页凑满 3 页无新增
  });

  it('中途又有新增就把 stale 计数清零', async () => {
    const ctx = fakeCtx([
      { comments: [{ cid: 'a' }], has_more: 1, cursor: 1 },
      { comments: [{ cid: 'a' }], has_more: 1, cursor: 2 },   // 无新增 ×1
      { comments: [{ cid: 'b' }], has_more: 1, cursor: 3 },   // 有新增 → 清零
      { comments: [{ cid: 'b' }], has_more: 1, cursor: 4 },   // 无新增 ×1
      { comments: [{ cid: 'c' }], has_more: 0, cursor: 5 },
    ]);
    const r = await fetchAllPages(ctx, '123', { perPage: 20 });

    expect(r.stoppedBy).toBe('end');
    expect(r.unique).toBe(3);
  });

  it('页数达到 maxPages → stoppedBy=maxPages', async () => {
    const ctx = fakeCtx([
      page(1, 20, { has_more: 1, cursor: 20 }),
      page(21, 40, { has_more: 1, cursor: 40 }),
      page(41, 60, { has_more: 1, cursor: 60 }),
    ]);
    const r = await fetchAllPages(ctx, '123', { perPage: 20, maxPages: 2 });

    expect(r.stoppedBy).toBe('maxPages');
    expect(r.pages).toBe(2);
    expect(r.unique).toBe(40);
    expect(ctx.calls).toHaveLength(2);   // 没有多打第三页
  });
});

describe('fetchAllPages 页大小', () => {
  // 实测：服务端每页硬顶 50 条。要 60 条时它仍只回 48-50 条，
  // 但 cursor 按 60 步进 → 每页静默丢 10 条（226 条只拿到 196 条）。
  // 所以这是硬夹取，不是建议值。
  it(`perPage 超过 ${MAX_PAGE_SIZE} 被夹到 ${MAX_PAGE_SIZE}`, async () => {
    const ctx = fakeCtx([{ comments: [], has_more: 0, cursor: 100 }]);
    await fetchAllPages(ctx, '123', { perPage: 999 });

    expect(ctx.calls[0].count).toBe(MAX_PAGE_SIZE);
  });

  it('perPage 非法值回落到 20', async () => {
    const ctx = fakeCtx([{ comments: [], has_more: 0, cursor: 100 }]);
    await fetchAllPages(ctx, '123', { perPage: 0 });

    expect(ctx.calls[0].count).toBe(20);
  });

  it('aweme_id 会做表达式转义（不炸字符串字面量）', async () => {
    const ctx = fakeCtx([{ comments: [], has_more: 0, cursor: 100 }]);
    await fetchAllPages(ctx, "a'b", { perPage: 20 });

    expect(ctx.calls[0].aweme_id).toBe("a'b");
  });
});

describe('fetchAllPages 增量过滤（--new / --since）', () => {
  it('某页出现旧评论 → 立刻停，stoppedBy=cutoff', async () => {
    const ctx = fakeCtx([
      { comments: [{ cid: '1', create_time: 300 }, { cid: '2', create_time: 250 }], has_more: 1, cursor: 20 },
      { comments: [{ cid: '3', create_time: 150 }], has_more: 1, cursor: 40 },
    ]);
    const r = await fetchAllPages(ctx, '123', {
      perPage: 20,
      filterPage: raw => raw.filter(c => (c.create_time || 0) > 200),
    });

    expect(r.stoppedBy).toBe('cutoff');
    expect(r.comments.map(c => c.cid)).toEqual(['1', '2']);
    expect(ctx.calls).toHaveLength(2);
  });
});

describe('fetchAllPages 取消与进度', () => {
  it('翻页途中 abort → 抛 AbortError', async () => {
    const ac = new AbortController();
    const ctx = fakeCtx([
      page(1, 20, { has_more: 1, cursor: 20 }),
      page(21, 40, { has_more: 1, cursor: 40 }),
    ]);
    ctx.signal = ac.signal;

    await expect(fetchAllPages(ctx, '123', {
      perPage: 20,
      onPage: ({ pages }) => { if (pages === 1) ac.abort(); },
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(ctx.calls).toHaveLength(1);   // 第二页没发出去
  });

  it('已经 abort 的 signal 在第一页之前就抛', async () => {
    const ac = new AbortController();
    ac.abort();
    const ctx = fakeCtx([page(1, 20, { has_more: 0 })]);
    ctx.signal = ac.signal;

    await expect(fetchAllPages(ctx, '123', { perPage: 20 })).rejects.toMatchObject({ name: 'AbortError' });
    expect(ctx.calls).toHaveLength(0);
  });

  it('onPage 每页回调一次，带上累计数', async () => {
    const seen = [];
    const ctx = fakeCtx([
      page(1, 20, { has_more: 1, cursor: 20 }),
      { comments: [{ cid: '15' }, { cid: '21' }], has_more: 0, cursor: 40 },
    ]);
    await fetchAllPages(ctx, '123', {
      perPage: 20,
      onPage: p => seen.push(p),
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ pages: 1, returned: 20, fresh: 20, unique: 20, duplicates: 0 });
    expect(seen[1]).toMatchObject({ pages: 2, returned: 2, fresh: 1, unique: 21, duplicates: 1 });
  });
});

describe('fetchAllPages 页间延迟', () => {
  it('delayRange 缺省时不等待（测试跑得快的前提）', async () => {
    const t0 = Date.now();
    const ctx = fakeCtx([
      page(1, 20, { has_more: 1, cursor: 20 }),
      page(21, 40, { has_more: 0, cursor: 40 }),
    ]);
    await fetchAllPages(ctx, '123', { perPage: 20 });

    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('delayRange=[0,0] 等价于不等待', async () => {
    const t0 = Date.now();
    const ctx = fakeCtx([
      page(1, 20, { has_more: 1, cursor: 20 }),
      page(21, 40, { has_more: 0, cursor: 40 }),
    ]);
    await fetchAllPages(ctx, '123', { perPage: 20, delayRange: [0, 0] });

    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('页间真的会等 —— 但只在页与页之间，第一页不等', async () => {
    const marks = [];
    const ctx = fakeCtx([
      page(1, 20, { has_more: 1, cursor: 20 }),
      page(21, 40, { has_more: 0, cursor: 40 }),
    ]);
    const t0 = Date.now();
    const real = ctx.loggedCall;
    ctx.loggedCall = async (...a) => { marks.push(Date.now() - t0); return real(...a); };

    await fetchAllPages(ctx, '123', { perPage: 20, delayRange: [0.2, 0.2] });

    expect(marks[0]).toBeLessThan(100);          // 第一页没等
    expect(marks[1]).toBeGreaterThanOrEqual(180); // 第二页等了 ~200ms
  });
});

describe('cmdGet 的进度上报（走 ctx.logger，不是全局 logger）', () => {
  // 这条不变量踩过一次：任务级进度 sink 是当作 extraSinks 挂在 **ctx 的 child logger**
  // 上的（context.js:59-68），而模块级的 `logger.progress` 属于全局单例，记录到不了那个 sink。
  // 症状是 CLI 里进度照常打印（全局 sink 有 console），界面上却一条都没有 ——
  // 只在 GUI 下复现，命令行怎么试都是好的。
  //
  // 同一个坑 enrich.js:107 与 getReply.js:345 也踩着，所以这里显式钉住 get 这边。
  it('--all 时每页都往 ctx.logger 报进度，且带 pages/unique/duplicates', withTempProject(async () => {
    const cmdGet = require('../core/commands/get');
    const accounts = require('../core/memory/accounts');
    const origResolve = accounts.resolveExecutor;
    accounts.resolveExecutor = async () => ({ uid: 'u1', candidates: ['u1'] });

    const reported = [];
    const pages = [
      { comments: [{ cid: '1', text: 'a' }, { cid: '2', text: 'b' }], has_more: 1, cursor: 2 },
      { comments: [{ cid: '2', text: 'b' }, { cid: '3', text: 'c' }], has_more: 0, cursor: 4 },
    ];
    let i = 0;
    const ctx = {
      loggedCall: async () => pages[i++],
      audit: {
        findLastFetchTime: () => null,
        startOperation: () => {},
        endOperation: () => {},
      },
      logger: { progress: p => reported.push(p), info: () => {}, warn: () => {}, debug: () => {} },
    };

    try {
      const out = await cmdGet(ctx, ['v1', '--all', '--no-throttle', '--count', '2']);

      expect(out.map(c => c.cid)).toEqual(['1', '2', '3']);   // 去重后两条页合成三条
      expect(reported).toHaveLength(2);                        // 每页一次
      expect(reported[0]).toMatchObject({ pages: 1, unique: 2, duplicates: 0 });
      expect(reported[1]).toMatchObject({ pages: 2, unique: 3, duplicates: 1 });
      expect(reported[1].text).toContain('重复跳过 1 条');
    } finally {
      accounts.resolveExecutor = origResolve;
    }
  }));

  it('单页拉取（不带 --all）不报进度，CLI 输出契约维持原样', withTempProject(async () => {
    const cmdGet = require('../core/commands/get');
    const accounts = require('../core/memory/accounts');
    const origResolve = accounts.resolveExecutor;
    accounts.resolveExecutor = async () => ({ uid: 'u1', candidates: ['u1'] });

    const reported = [];
    const ctx = {
      loggedCall: async () => ({ comments: [{ cid: '1', text: 'a' }], has_more: 1, cursor: 20 }),
      audit: { findLastFetchTime: () => null, startOperation: () => {}, endOperation: () => {} },
      logger: { progress: p => reported.push(p), info: () => {}, warn: () => {}, debug: () => {} },
    };

    try {
      await cmdGet(ctx, ['v1', '--no-throttle']);
      expect(reported).toHaveLength(0);
    } finally {
      accounts.resolveExecutor = origResolve;
    }
  }));
});
