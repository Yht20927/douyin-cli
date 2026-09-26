// tests/policy.test.js — 运营规则的代码强制
//
// 这是整个改造里价值最集中的一块：改造前那十几条
// 硬性红线，改造前**没有一条写在代码里**。本文件把它们逐条固化成断言。

const fs = require('fs');
const path = require('path');
const os = require('os');

const { splitRounds, summarizeRounds } = require('../core/policy/rounds');
const { createPolicyEngine } = require('../core/policy');
const config = require('../core/config');

const MIN = 60 * 1000;

const ENV_KEYS = ['DOUYIN_STORAGE_DIR', 'DOUYIN_LOG_DIR', 'DOUYIN_CONFIG'];

/**
 * 在临时库上跑。cfg 里可以覆盖 policy 配置。
 * fn 拿到 { events, engine, tmp }。
 */
function withTempEnv(cfg, fn) {
  return async () => {
    const saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-policy-'));
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    process.env.DOUYIN_LOG_DIR = path.join(tmp, 'logs');
    const cfgFile = path.join(tmp, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify(cfg || {}));
    process.env.DOUYIN_CONFIG = cfgFile;
    config.reset();

    const purge = () => {
      for (const m of [
        '../core/memory/db', '../core/memory/events', '../core/memory/comments',
        '../core/memory/users', '../core/memory/videos',
      ]) {
        delete require.cache[require.resolve(m)];
      }
    };
    purge();

    try {
      const events = require('../core/memory/events');
      // videos 也要进清缓存名单：写操作的账号归属靠 videos.ops_uid 查
      // （见 policy 的 scopeByAccount）。漏了它，第二个用例会读到上一个用例的库
      const videos = require('../core/memory/videos');
      const engine = createPolicyEngine({});
      await fn({ events, engine, videos, tmp });
    } finally {
      try { require('../core/memory/db').closeDb(); } catch (e) { /* ignore */ }
      purge();
      config.reset();
      for (const k of ENV_KEYS) {
        if (saved[k] == null) delete process.env[k];
        else process.env[k] = saved[k];
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

/**
 * 造一串写记录：rounds 里每项是该轮的条数。
 *
 * 冷却只加在**轮与轮之间** —— 首版在最后一轮之后也加了一段，
 * 导致"最后一次写发生在 405 秒前"，与用例名（刚写满、应需冷却）不符。
 *
 * ⚠️ 「轮 = 一批连续写操作」之后，**只有写满的那一批才会闭合**：
 * 一批没写满就永远不算结束，下一组会并进来。所以除了最后一轮，每一项都必须
 * 正好等于 `roundMaxWrites`，否则用例会静默得到**比预期少的轮次**。
 * 这条约束是隐形的（`[2,2,2]` 在默认 cap=10 下会变成 1 轮），所以下面直接抛错 ——
 * 把"语义悄悄变松"变成测试期的爆响，而不是一条还在跑绿、断言对象却已经变了的用例。
 *
 * 批间停顿取 `roundCooldownSec + 60` 秒：必须**严格大于**冷却，因为边界判定是
 * `>=`（与闸门放行条件同源，见 rounds.js）。
 *
 * cap 与冷却默认从当前用例的 policy 配置读（withTempEnv 里已 config.reset()），
 * 于是 `roundMaxWrites: 3` 的用例直接写 `[3, 3]` 即可。
 */
function seedRounds(events, rounds, opts = {}) {
  const cfg = config.get('policy');
  const {
    gapSec = 45,
    cap = cfg.roundMaxWrites,
    cooldownSec = cfg.roundCooldownSec + 60,
    endAgoMs = 0,
  } = opts;

  const total = rounds.reduce((a, b) => a + b, 0);
  const spanMs = total * gapSec * 1000 + (rounds.length - 1) * cooldownSec * 1000;

  let t = Date.now() - endAgoMs - spanMs;
  rounds.forEach((n, r) => {
    const isLast = r === rounds.length - 1;
    if (!isLast && n !== cap) {
      throw new Error(
        `seedRounds: 第 ${r + 1} 轮给了 ${n} 条，而 roundMaxWrites=${cap} —— `
        + '没写满的那一批不会闭合，会和下一组合成一轮，用例将得到比预期少的轮次。'
        + '要么写满该批，要么在 policy 覆盖里调小 roundMaxWrites',
      );
    }
    for (let i = 0; i < n; i++) {
      events.append({ ts: t, command: 'post', status: 'success', uid: 'u1', awemeId: 'v1' });
      t += gapSec * 1000;
    }
    if (!isLast) t += cooldownSec * 1000;
  });
}

// ═══════════════════════════════════════════════════════════
// 轮次切分（纯函数）
// ═══════════════════════════════════════════════════════════

describe('轮次切分（轮 = 一批连续写操作）', () => {
  const CAP = 3;                  // 一轮 3 条就满
  const O = { maxPerRound: CAP, cooldownMs: 5 * MIN };

  it('空输入 → 无轮次', () => {
    expect(splitRounds([], O)).toEqual([]);
    expect(splitRounds(null, O)).toEqual([]);
  });

  it('连续小间隔、没写满 → 同一批', () => {
    const base = 1_700_000_000_000;
    const ts = [base, base + 45_000, base + 90_000];
    expect(splitRounds(ts, O)).toHaveLength(1);
    expect(splitRounds(ts, O)[0]).toHaveLength(3);
  });

  it('写满之后歇够冷却 → 下一笔开新一轮', () => {
    const base = 1_700_000_000_000;
    const ts = [base, base + 45_000, base + 90_000, base + 90_000 + O.cooldownMs];
    const rounds = splitRounds(ts, O);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toHaveLength(CAP);
    expect(rounds[1]).toHaveLength(1);
  });

  // ↓↓↓ 这是本次重构的核心：空闲不是一轮
  it('没写满就一直算同一批 —— 隔多久都不断轮', () => {
    const base = 1_700_000_000_000;
    // 三笔各隔 1 小时（旧口径下这是 3 轮，正是真库里误报的形状），
    // 但一轮要 3 条才满 —— 所以它们始终是同一批
    const ts = [base, base + 60 * MIN, base + 120 * MIN];
    const rounds = splitRounds(ts, O);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toHaveLength(3);
  });

  it('写满但没歇够 → 后面那笔并入本批，不凭空多算一轮', () => {
    const base = 1_700_000_000_000;
    // 第 4 笔距第 3 笔只有 45 秒（远小于冷却）：这是一次绕过闸门的超额写。
    // 若它开新轮，本轮立刻变"没写满"→ 冷却归零 → 绕闸门反而被奖励，方向就反了。
    const ts = [base, base + 45_000, base + 90_000, base + 135_000];
    const rounds = splitRounds(ts, O);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toHaveLength(4);
  });

  it('间隙恰好等于冷却 → 开新一轮（判定用「大于等于」，与闸门同源）', () => {
    const base = 1_700_000_000_000;
    const full = [base, base + 45_000, base + 90_000];
    // 闸门在 "距上一笔 >= 冷却" 时放行；切分必须用同一个边界，否则会出现
    // 1 毫秒宽的缝：放行了的这笔又被并回满轮 → 冷却重新计 → 白等一遍
    expect(splitRounds([...full, base + 90_000 + O.cooldownMs], O)).toHaveLength(2);
    expect(splitRounds([...full, base + 90_000 + O.cooldownMs - 1], O)).toHaveLength(1);
  });

  it('乱序输入先排序，不影响结果', () => {
    const base = 1_700_000_000_000;
    const rounds = splitRounds([base + 90_000, base, base + 45_000], O);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toEqual([base, base + 45_000, base + 90_000]);
  });

  it('过滤非法时间戳', () => {
    const base = 1_700_000_000_000;
    expect(splitRounds([base, NaN, null, undefined, base + 1000], O)[0]).toHaveLength(2);
  });

  it('summarizeRounds 给出当前这一批的信息', () => {
    const base = 1_700_000_000_000;
    const s = summarizeRounds([base, base + 45_000, base + 10 * MIN], O);
    expect(s.count).toBe(1);
    expect(s.currentSize).toBe(3);
    expect(s.currentStartedAt).toBe(base);
    expect(s.lastTs).toBe(base + 10 * MIN);
    expect(s.currentFull).toBe(true);
  });

  it('无记录时最后写入时间为 0，且"下一笔会开新一轮"为真', () => {
    const s = summarizeRounds([], O);
    expect(s.lastTs).toBe(0);
    expect(s.currentStartedAt).toBeNull();
    expect(s.startingNewRound).toBe(true);
  });

  it('没写满时 startingNewRound 为假（这一笔仍在本轮里）', () => {
    const base = 1_700_000_000_000;
    const s = summarizeRounds([base, base + 45_000], { ...O, now: base + 999_000_000 });
    expect(s.currentFull).toBe(false);
    expect(s.startingNewRound).toBe(false);
    expect(s.cooldownRemainingMs).toBe(0);
  });

  it('时钟回拨时冷却剩余不会超过冷却时长本身', () => {
    const base = 1_700_000_000_000;
    const full = [base, base + 45_000, base + 90_000];
    // now 早于最后一笔（改系统时间）—— 裸减法会得出"还要等一天"，
    // 而 assertWritable 会真的睡满它
    const s = summarizeRounds(full, { ...O, now: base - 24 * 60 * MIN });
    expect(s.cooldownRemainingMs).toBeLessThanOrEqual(O.cooldownMs);
  });

  it('maxPerRound 配成 0 不会退化成"笔笔成轮"之外的怪状态', () => {
    const base = 1_700_000_000_000;
    const s = summarizeRounds([base, base + 1000], { maxPerRound: 0, cooldownMs: 5 * MIN, now: base + 2000 });
    expect(s.count).toBe(1);   // 0 与 1 等价：第二笔距第一笔不足冷却，仍并入
    expect(s.currentFull).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// stats 与准入判定
// ═══════════════════════════════════════════════════════════

describe('配额与轮次', () => {
  it('空库时可写', withTempEnv({}, async ({ engine }) => {
    const s = engine.stats();
    expect(s.writesToday).toBe(0);
    expect(s.roundsToday).toBe(0);
    expect(engine.beforeWrite({}).ok).toBe(true);
  }));

  it('统计今日写操作与轮次（轮次由时间分布推出，无需额外记录）', withTempEnv({}, async ({ events, engine }) => {
    seedRounds(events, [10, 3]);   // 首轮写满 10 条才会闭合，第 2 轮 3 条
    const s = engine.stats();
    expect(s.writesToday).toBe(13);
    expect(s.roundsToday).toBe(2);
    expect(s.roundWrites).toBe(3);
  }));

  it('单轮写满 → 需要冷却，给出明确的等待时长', withTempEnv({}, async ({ events, engine }) => {
    seedRounds(events, [10], { endAgoMs: 0 });
    const r = engine.beforeWrite({});
    expect(r.waitMs).toBeGreaterThan(0);
    expect(r.blockers.some(b => b.action === 'wait')).toBe(true);
    expect(r.ok).toBe(true); // wait 不算拦下
  }));

  it('冷却已过 → 无需再等', withTempEnv({}, async ({ events, engine }) => {
    // 最后一轮写完后已过去 10 分钟（> 默认 5 分钟冷却）
    seedRounds(events, [10], { endAgoMs: 10 * MIN });
    const r = engine.beforeWrite({});
    expect(r.stats.cooldownRemainingMs).toBe(0);
  }));

  it('每日总量用尽 → 拦下', withTempEnv({ policy: { dailyWriteQuota: 6 } }, async ({ events, engine }) => {
    seedRounds(events, [6]);
    const r = engine.beforeWrite({});
    expect(r.ok).toBe(false);
    expect(r.hardBlockers.some(b => b.reason.includes('上限 6/6'))).toBe(true);
  }));

  // ⚠️ 轮次**不再是闸门**：`dailyRounds` 是提示阈值，达到后只出黄条。
  // 真正硬拦量的是 dailyWriteQuota 与触顶冷却。这条钉住这个决定 ——
  // 曾经它在这里硬拦，而拦的依据（空闲断轮）本身是错的，拦的是想干活的人。
  it('每日轮次已到阈值 → 只告警，不拦写操作', withTempEnv({
    policy: { dailyRounds: 2, roundMaxWrites: 3, dailyWriteQuota: 100 },
  }, async ({ events, engine }) => {
    seedRounds(events, [3, 3]);
    const r = engine.beforeWrite({});
    expect(r.ok).toBe(true);                                   // 不拦
    expect(r.hardBlockers.some(b => b.reason.includes('轮次'))).toBe(false);
    expect(r.stats.roundsToday).toBe(2);
    expect(r.stats.warning).toContain('轮次');                  // 但要说话
  }));

  it('轮次还有余量 → 照常可写', withTempEnv({
    policy: { dailyRounds: 5, roundMaxWrites: 10, dailyWriteQuota: 100 },
  }, async ({ events, engine }) => {
    seedRounds(events, [10, 2]); // 第 2 轮只写了 2 条
    const r = engine.beforeWrite({});
    expect(r.ok).toBe(true);
    expect(r.stats.roundsToday).toBe(2);
  }));

  it('超过风险升级轮次 → 给出告警但不拦', withTempEnv({
    // roundMaxWrites 必须调小：否则 [2,2,2] 每批都没写满，会并成 1 轮，告警永不触发
    policy: { dailyRounds: 10, dailyWriteQuota: 100, riskEscalateAfterRounds: 2, roundMaxWrites: 2 },
  }, async ({ events, engine }) => {
    seedRounds(events, [2, 2, 2]);
    const r = engine.beforeWrite({});
    expect(r.ok).toBe(true);
    expect(r.stats.roundsToday).toBe(3);
    expect(r.warnings.some(w => w.includes('风控概率显著上升'))).toBe(true);
  }));

  // ↓↓↓ 下面三条是这次重构要钉住的**真实形状**（真库里实测到的两组数据），
  // 旧口径（按空闲间隙切轮）在它们上面两个方向都错。

  it('散写一天（各隔一小时的单发）始终是同一轮 —— 旧口径误报成"3 轮用尽"', withTempEnv({
    policy: { dailyRounds: 3, roundMaxWrites: 10, dailyWriteQuota: 100 },
  }, async ({ events, engine }) => {
    // 真库 2026-09-20 的形状：19:12 post、19:15 like、20:16 post、21:02 post、21:05 delete。
    // 旧口径按"间隔超过 30 分钟"切成 3 簇 → 界面「轮次 3/3」+「建议今天不再写」，
    // 而实际只写了 5 条。按批次算：一轮要 10 条才满，它们始终是同一批。
    const t0 = Date.now() - 4 * 60 * 60 * 1000;
    const gaps = [0, 2.52, 63.97, 109.6, 112.65];   // 分钟，按真库时间戳折算
    for (const g of gaps) {
      events.append({ ts: t0 + g * MIN, command: 'post', status: 'success', uid: 'u1', awemeId: 'v1' });
    }
    const s = engine.stats();
    expect(s.writesToday).toBe(5);
    expect(s.roundsToday).toBe(1);
    expect(s.roundWrites).toBe(5);
    // warning 为 null 时 `not.toContain` 会直接抛（vitest 不接受 null），兜一下
    expect(s.warning || '').not.toContain('轮次');
    expect(engine.beforeWrite({}).ok).toBe(true);
  }));

  it('守规矩的连续作业：写满 10 条 + 冷却 = 一轮，轮数随批次增长', withTempEnv({
    policy: { dailyRounds: 10, roundMaxWrites: 10, dailyWriteQuota: 100, roundCooldownSec: 300 },
  }, async ({ events, engine }) => {
    // 旧口径下这是"永远第 1 轮"（冷却 300 秒撑不出 1800 秒的分界空隙），
    // 于是「每日 ≤3 轮」与「超 2 轮风控升级」在任何一天都不可达
    seedRounds(events, [10, 10, 10]);
    const s = engine.stats();
    expect(s.writesToday).toBe(30);
    expect(s.roundsToday).toBe(3);
    expect(s.warning).toContain('风控概率显著上升');
  }));

  it('隔 6 分钟各发一条 = 还在同一轮（未写满就不分轮）', withTempEnv({
    policy: { dailyRounds: 3, roundMaxWrites: 10, dailyWriteQuota: 100 },
  }, async ({ events, engine }) => {
    const t = Date.now() - 40 * 1000;
    events.append({ ts: t, command: 'post', status: 'success', uid: 'u1', awemeId: 'v1' });
    events.append({ ts: t + 6 * 60 * 1000, command: 'post', status: 'success', uid: 'u2', awemeId: 'v2' });
    const s = engine.stats();
    expect(s.roundsToday).toBe(1);
    expect(s.roundWrites).toBe(2);
    expect(s.warning || '').not.toContain('轮次');
  }));

  it('慢速连写不再被拆成一堆轮', withTempEnv({
    policy: { dailyRounds: 3, roundMaxWrites: 10, dailyWriteQuota: 100 },
  }, async ({ events, engine }) => {
    // 每条间隔 301 秒 —— 旧口径（间隙 > 300 秒即断轮）会切成 10 轮、本轮恒为 1 条。
    // 新口径下"没写满就不分轮"，所以是 1 轮、本轮 10 条。
    const t0 = Date.now() - 10 * 301 * 1000;
    for (let i = 0; i < 10; i++) {
      events.append({ ts: t0 + i * 301 * 1000, command: 'post', status: 'success', uid: 'u1', awemeId: 'v1' });
    }
    const s = engine.stats();
    expect(s.roundsToday).toBe(1);
    expect(s.roundWrites).toBe(10);
  }));

  it('单轮写满后越过闸门继续写 → 并入本轮，冷却从最后一笔重新计时', withTempEnv({
    policy: { dailyRounds: 10, roundMaxWrites: 10, dailyWriteQuota: 100, roundCooldownSec: 300 },
  }, async ({ events, engine }) => {
    // 150 秒一条写 12 条：第 10 条时本轮已满，但第 11、12 条距上一笔都不足 300 秒，
    // 属于绕过闸门的超额写。它们**并入本轮**而不是开新轮 —— 否则本轮会立刻变回
    // "没写满"、冷却归零，绕闸门反而被奖励。
    const t0 = Date.now() - 12 * 150 * 1000;
    for (let i = 0; i < 12; i++) {
      events.append({ ts: t0 + i * 150 * 1000, command: 'post', status: 'success', uid: 'u1', awemeId: 'v1' });
    }
    const s = engine.stats();
    expect(s.roundsToday).toBe(1);
    expect(s.roundWrites).toBe(12);              // 超额部分看得见，不是被抹平
    expect(s.cooldownRemainingMs).toBeGreaterThan(0);
    const r = engine.beforeWrite({});
    expect(r.blockers.some(b => b.action === 'wait' && b.reason.includes('本轮已写 12/10'))).toBe(true);
  }));
});

describe('按执行账号统计（配额与轮次属于"这个号今天干了多少"）', () => {
  // ⚠️ 归属看的是**视频的 ops_uid**，不是 events.uid —— 后者装的是**被回复的评论者**
  // （post.js 传 targetUid）。所以这些用例必须先把视频登记好归属，
  // 光给事件写个 uid 是造不出"这个号干的"的。
  it('A 号用如今日配额时，B 号照样能写', withTempEnv({
    policy: { dailyWriteQuota: 3, dailyRounds: 10, roundMaxWrites: 10 },
  }, async ({ events, engine, videos }) => {
    videos.upsert({ awemeId: 'v1', opsUid: 'acct-a' });   // v1 是 acct-a 在运营的
    const t = Date.now() - 20 * 1000;
    for (let i = 0; i < 3; i++) {
      // uid 是三位不同的评论者 —— 这正是真库的形状，也是"uid 当账号"会算错的原因
      events.append({ ts: t + i * 1000, command: 'post', status: 'success', uid: 'commenter' + i, awemeId: 'v1' });
    }
    // 不区分账号（CLI / 未知账号）时是全部合算 —— 最严的方向
    expect(engine.stats().writesToday).toBe(3);
    expect(engine.beforeWrite({}).hardBlockers.some(b => b.reason.includes('今日写操作已达上限 3/3'))).toBe(true);
    // 归属账号对得上 → 三条都算它的
    expect(engine.stats({ accountUid: 'acct-a' }).writesToday).toBe(3);
    // 另一个号来统计时，这三条与它无关
    expect(engine.stats({ accountUid: 'acct-b' }).writesToday).toBe(0);
    expect(engine.beforeWrite({ accountUid: 'acct-b' }).ok).toBe(true);
  }));

  it('查不到归属账号的行并入每个号（不能被当成"免费额度"）', withTempEnv({
    policy: { dailyWriteQuota: 3, dailyRounds: 10, roundMaxWrites: 10 },
  }, async ({ events, engine, videos }) => {
    const t = Date.now() - 20 * 1000;
    videos.upsert({ awemeId: 'v-known', opsUid: 'acct-a' });
    // ① 归属明确：它操作的那个视频登记着 acct-a
    events.append({ ts: t, command: 'post', status: 'success', uid: 'c1', awemeId: 'v-known' });
    // ② 归属不明：视频不在库里（点赞这条路径也确实不带 aweme_id，真库实测存在）。
    //    用 SQL 过滤会把它整批丢掉 → "按账号统计"变成"少算几条" → 配额被放松
    events.append({ ts: t + 1000, command: 'like', status: 'success', uid: null, awemeId: 'v-unknown' });

    // acct-a：自己那条 + 归属不明那条
    expect(engine.stats({ accountUid: 'acct-a' }).writesToday).toBe(2);
    expect(engine.stats({ accountUid: 'acct-a' }).unattributedWrites).toBe(1);
    // acct-b：只有归属不明那条 —— 不能因为查不到就当它不存在
    expect(engine.stats({ accountUid: 'acct-b' }).writesToday).toBe(1);
    expect(engine.stats({ accountUid: 'acct-b' }).unattributedWrites).toBe(1);
  }));

  it('stats 把轮次口径连同账号一起交出去（界面画配额条要用）', withTempEnv({},
    async ({ engine }) => {
      const s = engine.stats({ accountUid: 'u1' });
      expect(s.roundMaxWrites).toBeGreaterThan(0);
      expect(s.roundCooldownSec).toBeGreaterThan(0);
      expect(s.accountUid).toBe('u1');
      // roundGapSec 已随"空闲断轮"一起删掉：轮的边界现在只有冷却时长一个数
      expect(s.roundGapSec).toBeUndefined();
    }));
});

describe('给界面倒计时用的绝对时刻（policy.stats 的 *At）', () => {
  // 为什么要有这两个字段：cooldownRemainingMs / nextWriteAllowedInMs 是
  // stats() 那一刻的**快照**，而主进程只在队列边界推一次。界面拿快照渲染倒计时
  // 就等于把表针钉住 —— 队列页顶部那个全页最大的数字曾经就是这样一动不动。
  it('要冷却时给出未来时刻，且与"还剩多久"同源', withTempEnv({}, async ({ events, engine }) => {
    seedRounds(events, [10], { endAgoMs: 0 });

    const before = Date.now();
    const s = engine.stats();
    const after = Date.now();

    expect(s.cooldownRemainingMs).toBeGreaterThan(0);
    expect(s.cooldownUntil).toBeGreaterThan(after);
    // 时刻 = 采样那一刻 + 当时的剩余。夹在 before/after 之间，允许 stats() 内部那点耗时
    expect(s.cooldownUntil - after).toBeLessThanOrEqual(s.cooldownRemainingMs);
    expect(s.cooldownUntil - before).toBeGreaterThanOrEqual(s.cooldownRemainingMs);
  }));

  it('刚写过一条 → 节奏下限的截止时刻也在未来', withTempEnv({}, async ({ events, engine }) => {
    events.append({ ts: Date.now(), command: 'post', status: 'success', uid: 'u1', awemeId: 'v1' });
    const s = engine.stats();

    expect(s.nextWriteAllowedInMs).toBeGreaterThan(0);
    expect(s.nextWriteAllowedAt).toBeGreaterThan(Date.now());
    // msUntilNext 在 stats() 内部另取一次时钟，差几毫秒是常态，给 2 秒容差
    expect(Math.abs((s.nextWriteAllowedAt - Date.now()) - s.nextWriteAllowedInMs)).toBeLessThan(2000);
  }));

  it('不用等时两个时刻都是 0（界面不会算出负数）', withTempEnv({}, async ({ events, engine }) => {
    seedRounds(events, [10], { endAgoMs: 10 * MIN });
    const s = engine.stats();
    expect(s.cooldownUntil).toBe(0);
    expect(s.nextWriteAllowedAt).toBe(0);
  }));

  it('同一个截止时刻，晚一点采样剩下的就更少 —— 这才叫走表', withTempEnv({}, async ({ events, engine }) => {
    seedRounds(events, [10], { endAgoMs: 0 });
    const first = engine.stats();
    // 冷却由"最后一写 + 冷却时长"决定，与采样时刻无关：所以截止时刻稳定、
    // 而剩余会随时间变小。界面只要拿截止时刻减自己的 now 就能倒着走。
    const later = new Promise(r => setTimeout(r, 30));
    await later;
    const second = engine.stats();

    expect(second.cooldownUntil).toBe(first.cooldownUntil);
    expect(second.cooldownRemainingMs).toBeLessThan(first.cooldownRemainingMs);
  }));
});

describe('熔断', () => {
  it('窗口内失败次数达阈值 → 暂停自动发布', withTempEnv({
    policy: { circuitBreaker: { windowMs: 10 * MIN, failThreshold: 3 } },
  }, async ({ events, engine }) => {
    for (let i = 0; i < 3; i++) {
      events.append({ ts: Date.now() - 1000, command: 'post', status: 'error', error: 'boom' });
    }
    const r = engine.beforeWrite({});
    expect(r.ok).toBe(false);
    expect(r.hardBlockers.some(b => b.reason.includes('失败'))).toBe(true);
  }));

  it('失败发生在窗口之外 → 不影响', withTempEnv({
    policy: { circuitBreaker: { windowMs: 5 * MIN, failThreshold: 2 } },
  }, async ({ events, engine }) => {
    for (let i = 0; i < 5; i++) {
      events.append({ ts: Date.now() - 30 * MIN, command: 'post', status: 'error', error: 'boom' });
    }
    expect(engine.beforeWrite({}).ok).toBe(true);
  }));

  it('风控错误码 → 全局停写（优先级最高）', withTempEnv({
    policy: { riskCooldownMin: 30, riskCodeStopList: [8, 2053] },
  }, async ({ events, engine }) => {
    events.append({
      ts: Date.now() - 1000, command: 'post', status: 'error',
      error: '发布失败 status_code=8',
    });
    const r = engine.beforeWrite({});
    expect(r.ok).toBe(false);
    expect(r.hardBlockers[0].reason).toContain('风控');
  }));

  it('普通错误（非风控码）不触发风控熔断', withTempEnv({}, async ({ events, engine }) => {
    events.append({ ts: Date.now() - 1000, command: 'post', status: 'error', error: '网络超时' });
    expect(engine.beforeWrite({}).stats.risk.blocked).toBe(false);
  }));
});

describe('单条对象上的细分配额（窗口是"今日"，不随轮次漂）', () => {
  it('同一用户回复达上限 → 拦下', withTempEnv({
    policy: { maxPerUidPerRound: 1, dailyWriteQuota: 100, dailyRounds: 10 },
  }, async ({ events, engine }) => {
    events.append({ ts: Date.now() - 1000, command: 'post', status: 'success', uid: 'u9', awemeId: 'v1' });
    const r = engine.beforeWrite({ uid: 'u9' });
    expect(r.ok).toBe(false);
    expect(r.hardBlockers.some(b => b.reason.includes('该用户'))).toBe(true);
  }));

  it('别的用户不受影响', withTempEnv({
    policy: { maxPerUidPerRound: 1, dailyWriteQuota: 100 },
  }, async ({ events, engine }) => {
    events.append({ ts: Date.now() - 1000, command: 'post', status: 'success', uid: 'u9', awemeId: 'v1' });
    expect(engine.beforeWrite({ uid: 'u-other' }).ok).toBe(true);
  }));

  // ↓↓↓ 窗口从"本轮"改成"今日"的守卫。
  // 旧口径下"本轮"由轮次切分决定，而轮的定义改过两次 —— 同一份数据能得出好几种
  // "本轮已回几条"，于是同一个人能不能被回第二次取决于那天的写操作怎么分布。
  it('上一轮回复过的人，这一轮照样不能重复回复（窗口不随轮次重置）', withTempEnv({
    policy: { maxPerUidPerRound: 1, dailyWriteQuota: 100, dailyRounds: 10, roundMaxWrites: 2 },
  }, async ({ events, engine }) => {
    const t = Date.now() - 30 * MIN;
    events.append({ ts: t, command: 'post', status: 'success', uid: 'u9', awemeId: 'v1' });
    events.append({ ts: t + 60_000, command: 'post', status: 'success', uid: 'u-other', awemeId: 'v2' });
    // 写满 2 条后歇够冷却，再写一笔 —— "本轮"已经翻到下一批
    events.append({ ts: t + 60_000 + 400_000, command: 'post', status: 'success', uid: 'u-other2', awemeId: 'v3' });
    expect(engine.stats().roundsToday).toBe(2);      // 确认确实翻轮了
    const r = engine.beforeWrite({ uid: 'u9' });
    expect(r.ok).toBe(false);
    expect(r.hardBlockers.some(b => b.reason.includes('该用户'))).toBe(true);
  }));

  it('同一视频回复达上限 → 拦下', withTempEnv({
    policy: { maxPerVideoPerRound: 2, dailyWriteQuota: 100 },
  }, async ({ events, engine }) => {
    seedRounds(events, [2]);
    const r = engine.beforeWrite({ awemeId: 'v1' });
    expect(r.ok).toBe(false);
    expect(r.hardBlockers.some(b => b.reason.includes('该视频'))).toBe(true);
  }));
});

describe('内容与去重闸门', () => {
  it('已回复过的 cid → 拦下', withTempEnv({}, async ({ engine }) => {
    const e = createPolicyEngine({ isReplied: (cid) => cid === 'done' });
    const r = e.beforeWrite({ cid: 'done', text: '这是一条正常的回复内容' });
    expect(r.ok).toBe(false);
    expect(r.hardBlockers.some(b => b.reason.includes('已经回复过'))).toBe(true);
  }));

  it('回复文本违规 → 以 rewrite 形式拦下（不是 stop）', withTempEnv({}, async ({ engine }) => {
    const r = engine.beforeWrite({ text: '值得注意的是，这个方案不错' });
    expect(r.ok).toBe(false);
    expect(r.hardBlockers.every(b => b.action === 'rewrite')).toBe(true);
  }));

  it('合规文本不拦', withTempEnv({}, async ({ engine }) => {
    expect(engine.beforeWrite({ text: '这个词我也踩过坑，后来发现是缓存的问题' }).ok).toBe(true);
  }));
});

describe('assertWritable：命令入口的强制闸门', () => {
  it('违规时抛错，message 可直接展示给用户', withTempEnv({
    policy: { dailyWriteQuota: 1 },
  }, async ({ events, engine }) => {
    events.append({ ts: Date.now(), command: 'post', status: 'success' });
    let caught = null;
    try { await engine.assertWritable({}); } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe('POLICY_BLOCKED');
    expect(caught.message).toContain('运营策略拦下');
    expect(caught.blockers.length).toBeGreaterThan(0);
  }));

  it('多条违规时全部列出（不让人改一个试一次）', withTempEnv({
    policy: { dailyWriteQuota: 1, circuitBreaker: { windowMs: 10 * MIN, failThreshold: 1 } },
  }, async ({ events, engine }) => {
    events.append({ ts: Date.now(), command: 'post', status: 'success' });
    events.append({ ts: Date.now(), command: 'post', status: 'error', error: 'x' });
    let caught = null;
    try { await engine.assertWritable({}); } catch (e) { caught = e; }
    expect(caught.blockers.length).toBeGreaterThanOrEqual(2);
  }));

  it('合规时返回判定结果而不抛错', withTempEnv({}, async ({ engine }) => {
    // assertWritable 现在是 async：它要处理 wait 类拦截（单轮冷却 / 每日轮次），
    // 改造前那类拦截被静默忽略，等于两条标着"硬强制"的红线在命令行下不存在
    const r = await engine.assertWritable({});
    expect(r.ok).toBe(true);
  }));

  it('冷却期内会等待而不是直接放行', withTempEnv({
    policy: { roundMaxWrites: 1, roundCooldownSec: 2 },
  }, async ({ events, engine }) => {
    // 先写满一轮
    events.append({ ts: Date.now(), command: 'post', status: 'success' });

    const checked = engine.beforeWrite({});
    expect(checked.ok).toBe(true);          // 不是"不能发"
    expect(checked.waitMs).toBeGreaterThan(0);  // 而是"要等"

    // assertWritable 必须真的等，而不是像改造前那样直接返回。
    // ⚠️ 收集**全部**上报而不是只记最后一个：睡完补报的那一次 `phase:'end'`
    // 带的是 waitMs=0（用来清倒计时），只记最后一个就变成"没等"。
    const reports = [];
    const t0 = Date.now();
    await engine.assertWritable({}, { onWait: (i) => reports.push({ ...i, at: Date.now() }) });

    const start = reports.find(r => r.phase === 'cooldown');
    expect(start, '开始等待必须报一次').toBeDefined();
    expect(start.waitMs).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(start.waitMs - 50);

    // 契约与 enforceDelay / pace 同一份 —— 界面只认这一份，缺一个字段就起不了表
    expect(start.type).toBe('write');
    expect(typeof start.deadline).toBe('number');
    expect(start.deadline - start.at).toBeGreaterThanOrEqual(start.waitMs - 50);
    expect(start.reason).toMatch(/本轮已写/);

    const end = reports.find(r => r.phase === 'end');
    expect(end, '等完必须补报一次 end，否则倒计时停在 00:00 之后还在数').toBeDefined();
    expect(end.waitMs).toBe(0);
    expect(end.at).toBeGreaterThanOrEqual(start.deadline - 50);
  }));

  it('等待期间被 abort：不许补报 end（task.wait 由队列的 finally 清）', withTempEnv({
    policy: { roundMaxWrites: 1, roundCooldownSec: 30 },
  }, async ({ events, engine }) => {
    events.append({ ts: Date.now(), command: 'post', status: 'success' });
    const ac = new AbortController();
    const reports = [];
    const p = engine.assertWritable({}, { signal: ac.signal, onWait: (i) => reports.push(i) });
    // 等它真的进入等待（报了开始），再取消
    for (let i = 0; i < 200 && !reports.length; i++) await new Promise(r => setTimeout(r, 10));
    expect(reports.some(r => r.phase === 'cooldown')).toBe(true);
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(reports.some(r => r.phase === 'end'), '打断后补报 end 会把队列清成"没在等"，'
      + '而此刻抛错正一路出命令入口 —— 清 task.wait 是 finally 的活').toBe(false);
  }));
});

describe('会话内的连续跳过计数', () => {
  it('连续跳过累加，回复后清零', withTempEnv({}, async ({ engine }) => {
    engine.recordSkip(); engine.recordSkip();
    expect(engine.stats().consecutiveSkips).toBe(2);
    engine.recordReply();
    expect(engine.stats().consecutiveSkips).toBe(0);
  }));

  it('达到阈值 → 给出"建议停止本轮"的告警', withTempEnv({
    policy: { stopAfterConsecutiveSkips: 3 },
  }, async ({ engine }) => {
    engine.recordSkip(); engine.recordSkip(); engine.recordSkip();
    const r = engine.beforeWrite({});
    expect(r.warnings.some(w => w.includes('未匹配'))).toBe(true);
  }));

  it('批量判定时到达阈值就停下，不再空转后续评论', withTempEnv({
    policy: { stopAfterConsecutiveSkips: 2 },
  }, async ({ engine }) => {
    const comments = [
      { cid: 'a', uid: 'u', text: '666' },
      { cid: 'b', uid: 'u', text: '来了' },
      { cid: 'c', uid: 'u', text: '这个怎么做的' },  // 本该命中，但因已停轮不再处理
      { cid: 'd', uid: 'u', text: '又一条无意义的评论内容' },
    ];
    const r = engine.classifyBatch(comments);
    expect(r.stopRecommended).toBe(true);
    expect(r.skipped).toHaveLength(2);
    expect(r.reply).toHaveLength(0);
  }));

  it('批量判定会分桶', withTempEnv({}, async ({ engine }) => {
    const r = engine.classifyBatch([
      { cid: 'a', uid: 'u', text: '这个怎么做的？' },
      { cid: 'b', uid: 'u', text: '😊' },
      { cid: 'c', uid: 'u', text: '666' },
    ]);
    expect(r.reply).toHaveLength(1);
    expect(r.emojiReply).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
  }));
});

describe('classify 接上了库查询', () => {
  it('已回复的 cid 在 classify 里也会被拦', withTempEnv({}, async ({ engine }) => {
    const e = createPolicyEngine({ isReplied: () => true });
    expect(e.classify({ cid: 'x', text: '这个怎么做的' }).action).toBe('skip');
  }));

  it('黑名单用户在 classify 里被拦', withTempEnv({}, async ({ engine }) => {
    const e = createPolicyEngine({ userTier: () => 'blacklist' });
    expect(e.classify({ cid: 'x', uid: 'bad', text: '这个怎么做的' }).action).toBe('skip');
  }));
});
