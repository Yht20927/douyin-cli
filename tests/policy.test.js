// tests/policy.test.js — 运营规则的代码强制
//
// 这是整个改造里价值最集中的一块：全局规则.md 与 评论区运营.md 里那十几条
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
      for (const m of ['../core/memory/db', '../core/memory/events', '../core/memory/comments', '../core/memory/users']) {
        delete require.cache[require.resolve(m)];
      }
    };
    purge();

    try {
      const events = require('../core/memory/events');
      const engine = createPolicyEngine({});
      await fn({ events, engine, tmp });
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
 */
function seedRounds(events, rounds, opts = {}) {
  const { gapSec = 45, cooldownMin = 6, endAgoMs = 0 } = opts;
  const total = rounds.reduce((a, b) => a + b, 0);
  const spanMs = total * gapSec * 1000 + (rounds.length - 1) * cooldownMin * MIN;

  let t = Date.now() - endAgoMs - spanMs;
  rounds.forEach((n, r) => {
    for (let i = 0; i < n; i++) {
      events.append({ ts: t, command: 'post', status: 'success', uid: 'u1', awemeId: 'v1' });
      t += gapSec * 1000;
    }
    if (r < rounds.length - 1) t += cooldownMin * MIN;
  });
}

// ═══════════════════════════════════════════════════════════
// 轮次切分（纯函数）
// ═══════════════════════════════════════════════════════════

describe('轮次切分', () => {
  const COOLDOWN = 5 * MIN;

  it('空输入 → 无轮次', () => {
    expect(splitRounds([], COOLDOWN)).toEqual([]);
    expect(splitRounds(null, COOLDOWN)).toEqual([]);
  });

  it('连续小间隔算同一轮', () => {
    const base = 1_700_000_000_000;
    const ts = [base, base + 45_000, base + 90_000, base + 135_000];
    expect(splitRounds(ts, COOLDOWN)).toHaveLength(1);
    expect(splitRounds(ts, COOLDOWN)[0]).toHaveLength(4);
  });

  it('超过冷却间隙开新轮', () => {
    const base = 1_700_000_000_000;
    const ts = [base, base + 45_000, base + 10 * MIN, base + 10 * MIN + 45_000];
    const rounds = splitRounds(ts, COOLDOWN);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toHaveLength(2);
    expect(rounds[1]).toHaveLength(2);
  });

  it('间隙恰好等于冷却 → 仍算同一轮（判定用「大于」）', () => {
    const base = 1_700_000_000_000;
    expect(splitRounds([base, base + COOLDOWN], COOLDOWN)).toHaveLength(1);
    expect(splitRounds([base, base + COOLDOWN + 1], COOLDOWN)).toHaveLength(2);
  });

  it('乱序输入先排序，不影响结果', () => {
    const base = 1_700_000_000_000;
    const rounds = splitRounds([base + 90_000, base, base + 45_000], COOLDOWN);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toEqual([base, base + 45_000, base + 90_000]);
  });

  it('过滤非法时间戳', () => {
    const base = 1_700_000_000_000;
    expect(splitRounds([base, NaN, null, undefined, base + 1000], COOLDOWN)[0]).toHaveLength(2);
  });

  it('summarizeRounds 给出当前轮信息', () => {
    const base = 1_700_000_000_000;
    const s = summarizeRounds([base, base + 45_000, base + 10 * MIN], COOLDOWN);
    expect(s.count).toBe(2);
    expect(s.currentSize).toBe(1);
    expect(s.currentStartedAt).toBe(base + 10 * MIN);
    expect(s.lastTs).toBe(base + 10 * MIN);
  });

  it('无记录时最后写入时间为 0', () => {
    expect(summarizeRounds([], COOLDOWN).lastTs).toBe(0);
    expect(summarizeRounds([], COOLDOWN).currentStartedAt).toBeNull();
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
    seedRounds(events, [5, 3]);
    const s = engine.stats();
    expect(s.writesToday).toBe(8);
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

  it('每日轮次用尽且当前轮已满 → 拦下并说明是轮次问题', withTempEnv({
    policy: { dailyRounds: 2, roundMaxWrites: 3, dailyWriteQuota: 100 },
  }, async ({ events, engine }) => {
    seedRounds(events, [3, 3]);
    const r = engine.beforeWrite({});
    expect(r.ok).toBe(false);
    expect(r.hardBlockers.some(b => b.reason.includes('轮次已用尽'))).toBe(true);
  }));

  it('轮次用尽但当前轮还有余量 → 仍可继续写', withTempEnv({
    policy: { dailyRounds: 2, roundMaxWrites: 10, dailyWriteQuota: 100 },
  }, async ({ events, engine }) => {
    seedRounds(events, [3, 2]); // 第 2 轮只写了 2 条，还有余量
    const r = engine.beforeWrite({});
    expect(r.ok).toBe(true);
  }));

  it('超过风险升级轮次 → 给出告警但不拦', withTempEnv({
    policy: { dailyRounds: 10, dailyWriteQuota: 100, riskEscalateAfterRounds: 2 },
  }, async ({ events, engine }) => {
    seedRounds(events, [2, 2, 2]);
    const r = engine.beforeWrite({});
    expect(r.ok).toBe(true);
    expect(r.warnings.some(w => w.includes('风控概率显著上升'))).toBe(true);
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

describe('单轮内细分配额', () => {
  it('同一用户本轮回复达上限 → 拦下', withTempEnv({
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

  it('同一视频本轮回复达上限 → 拦下', withTempEnv({
    policy: { maxPerVideoPerRound: 2, dailyWriteQuota: 100 },
  }, async ({ events, engine }) => {
    seedRounds(events, [2], { gapSec: 45, cooldownMin: 1 });
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
    try { engine.assertWritable({}); } catch (e) { caught = e; }
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
    try { engine.assertWritable({}); } catch (e) { caught = e; }
    expect(caught.blockers.length).toBeGreaterThanOrEqual(2);
  }));

  it('合规时返回判定结果而不抛错', withTempEnv({}, async ({ engine }) => {
    const r = engine.assertWritable({});
    expect(r.ok).toBe(true);
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
