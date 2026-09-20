// tests/risk-control.test.js — 节奏守卫的可观测与可取消
//
// 不变量：
// 1. sleepAbortable 可被 AbortSignal 立刻打断（GUI 的"取消"按钮靠它）
// 2. enforceDelay 的等待通过 onWait 上报（GUI 画倒计时），缺省时退回 stderr 打印
// 3. 取消时抛 AbortError，上层能区分"被取消"与"真的失败"
// 4. CLI 语义不变：readEnforce 默认 false 时读操作仍是 advisory，不阻塞

const fs = require('fs');
const path = require('path');
const os = require('os');

const { AbortError, isAbortError, sleepAbortable, throwIfAborted } = require('../core/runtime/abort');
const config = require('../core/config');

// 注意：vitest.config.js 为让其余测试不被节奏守卫卡住，全局设了 DOUYIN_NO_THROTTLE=1。
// 本文件恰恰要验证节奏逻辑本身，所以必须把它临时关掉，否则 shouldBypass() 会直接短路。
const ENV_KEYS = ['DOUYIN_STORAGE_DIR', 'DOUYIN_LOG_DIR', 'DOUYIN_CONFIG', 'DOUYIN_NO_THROTTLE'];

/**
 * 在独立的临时数据目录 + 临时配置上跑。
 * @param {object} cfg - 写入临时 config.json 的用户配置
 * @param {Function} fn - (helpers) => void，helpers 提供 append / riskControl 等
 */
function withTempEnv(cfg, fn) {
  return async () => {
    const saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-rc-'));
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    process.env.DOUYIN_LOG_DIR = path.join(tmp, 'logs');
    const cfgFile = path.join(tmp, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify(cfg || {}));
    process.env.DOUYIN_CONFIG = cfgFile;
    // 关掉全局旁路，让 enforceDelay 真正按规则走
    delete process.env.DOUYIN_NO_THROTTLE;
    config.reset();

    // 清掉相关模块缓存，让它们按新环境重新解析路径
    for (const m of ['../core/memory/db', '../core/memory/events', '../core/risk-control']) {
      delete require.cache[require.resolve(m)];
    }

    const events = require('../core/memory/events');
    const riskControl = require('../core/risk-control');

    try {
      await fn({ tmp, events, riskControl });
    } finally {
      try { require('../core/memory/db').closeDb(); } catch (e) { /* ignore */ }
      for (const m of ['../core/memory/db', '../core/memory/events', '../core/risk-control']) {
        delete require.cache[require.resolve(m)];
      }
      config.reset();
      for (const k of ENV_KEYS) {
        if (saved[k] == null) delete process.env[k];
        else process.env[k] = saved[k];
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

// ═══════════════════════════════════════════════════════════
// abort 工具
// ═══════════════════════════════════════════════════════════

describe('sleepAbortable', () => {
  it('正常等待到点后 resolve', async () => {
    const t0 = Date.now();
    await sleepAbortable(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(20);
  });

  it('等待途中 abort → 立刻 reject AbortError（不必等满）', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = sleepAbortable(10000, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow(AbortError);
    // 关键：是立刻返回，而不是等满 10 秒
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('signal 已经 aborted → 立即 reject', async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    await expect(sleepAbortable(10000, ac.signal)).rejects.toThrow(AbortError);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('abort 后不会因为定时器仍在而误 resolve（无未处理拒绝）', async () => {
    const ac = new AbortController();
    const p = sleepAbortable(50, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow(AbortError);
    // 再等一段，确认没有二次 reject 造成的 unhandledRejection
    await new Promise(r => setTimeout(r, 80));
  });

  it('负数毫秒被钳制为 0，不抛错', async () => {
    await expect(sleepAbortable(-100)).resolves.toBeUndefined();
  });
});

describe('AbortError 判定', () => {
  it('isAbortError 认 AbortError 实例', () => {
    expect(isAbortError(new AbortError())).toBe(true);
  });

  it('isAbortError 认 code=ABORTED 的普通错误（跨模块边界）', () => {
    const e = new Error('x');
    e.code = 'ABORTED';
    expect(isAbortError(e)).toBe(true);
  });

  it('isAbortError 对普通错误返回 false', () => {
    expect(isAbortError(new Error('普通错误'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });

  it('throwIfAborted 只在已取消时抛', () => {
    expect(() => throwIfAborted()).not.toThrow();
    expect(() => throwIfAborted(null)).not.toThrow();
    const ac = new AbortController();
    expect(() => throwIfAborted(ac.signal)).not.toThrow();
    ac.abort();
    expect(() => throwIfAborted(ac.signal)).toThrow(AbortError);
  });
});

// ═══════════════════════════════════════════════════════════
// enforceDelay
// ═══════════════════════════════════════════════════════════

describe('enforceDelay: 旁路与读操作语义', () => {
  it('force=true 时直接跳过，不等待也不回调', withTempEnv({}, async ({ riskControl }) => {
    let called = false;
    const r = await riskControl.enforceDelay('write', { force: true, onWait: () => { called = true; } });
    expect(r.skipped).toBe(true);
    expect(called).toBe(false);
  }));

  it('readEnforce 默认 false → 读操作 advisory，不等待、不回调（CLI 行为不变）', withTempEnv({
    intervals: { read: [30, 50] },
  }, async ({ riskControl, events }) => {
    // 造一条刚发生的读事件：若真阻塞，这里会等 30 秒
    events.append({ ts: Date.now(), command: 'get', status: 'success' });

    let called = false;
    const t0 = Date.now();
    const r = await riskControl.enforceDelay('read', { onWait: () => { called = true; } });

    expect(r.advisory).toBe(true);
    expect(r.skipped).toBe(false);
    expect(called).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  }));

  it('readEnforce=true → 读操作真的阻塞，且 onWait 被调用', withTempEnv({
    intervals: { read: [30, 50], readEnforce: true },
  }, async ({ riskControl, events }) => {
    events.append({ ts: Date.now(), command: 'get', status: 'success' });

    const waits = [];
    const ac = new AbortController();
    const p = riskControl.enforceDelay('read', {
      signal: ac.signal,
      onWait: (info) => { waits.push(info); ac.abort(); },
    });

    await expect(p).rejects.toThrow(AbortError);
    expect(waits).toHaveLength(1);
    expect(waits[0].type).toBe('read');
    expect(waits[0].phase).toBe('min_interval');
  }));
});

describe('enforceDelay: 等待上报', () => {
  it('写操作距上次不足下限 → onWait 收到正确的倒计时信息', withTempEnv({
    intervals: { write: [40, 55] },
  }, async ({ riskControl, events }) => {
    events.append({ ts: Date.now(), command: 'post', status: 'success' });

    const waits = [];
    const ac = new AbortController();
    const p = riskControl.enforceDelay('write', {
      signal: ac.signal,
      onWait: (info) => { waits.push(info); ac.abort(); },
    });

    await expect(p).rejects.toThrow(AbortError);

    expect(waits).toHaveLength(1);
    const w = waits[0];
    expect(w.type).toBe('write');
    expect(w.phase).toBe('min_interval');
    // 下限 40s，刚发过 → 需等待接近 40s
    expect(w.waitMs).toBeGreaterThan(35000);
    expect(w.waitMs).toBeLessThanOrEqual(40000);
    expect(w.deadline).toBeGreaterThan(Date.now());
    expect(w.reason).toContain('下限 40s');
  }));

  it('距上次已超过下限时，进入叠加随机节奏阶段（phase=jitter）', withTempEnv({
    intervals: { write: [40, 55] },
  }, async ({ riskControl, events }) => {
    // 41 秒前发过：已过 40s 下限，但还在 55s 上限内 → 应进入 jitter 阶段。
    // 随机目标间隔可能抽到 ≤41s 导致 extra=0，故把 Math.random 固定成 0.999
    // （randomInt(40,55) → 40 + floor(0.999*16) = 55），让本用例确定性等待。
    events.append({ ts: Date.now() - 41_000, command: 'post', status: 'success' });

    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const waits = [];
    const ac = new AbortController();
    try {
      const p = riskControl.enforceDelay('write', {
        signal: ac.signal,
        onWait: (info) => { waits.push(info); ac.abort(); },
      });

      await expect(p).rejects.toThrow(AbortError);
      expect(waits).toHaveLength(1);
      expect(waits[0].phase).toBe('jitter');
      // 目标总间隔 55s，已过 41s → 还需约 14s
      expect(waits[0].waitMs).toBeGreaterThan(10000);
      expect(waits[0].waitMs).toBeLessThanOrEqual(15000);
      expect(waits[0].reason).toContain('目标总间隔 55s');
    } finally {
      randSpy.mockRestore();
    }
  }));

  it('无任何历史写记录 → 不等待（快速路径）', withTempEnv({}, async ({ riskControl }) => {
    let called = false;
    const t0 = Date.now();
    const r = await riskControl.enforceDelay('write', { onWait: () => { called = true; } });
    expect(called).toBe(false);
    expect(r.skipped).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  }));

  it('未传 onWait 时不抛错（CLI 走默认 stderr 打印）', withTempEnv({}, async ({ riskControl }) => {
    await expect(riskControl.enforceDelay('write', {})).resolves.toBeTruthy();
  }));
});

describe('enforceDelay: 失败的命令不计入节奏', () => {
  it('只有 status=success 的记录才影响等待判断', withTempEnv({}, async ({ riskControl, events }) => {
    events.append({ ts: Date.now(), command: 'post', status: 'error', error: 'status_code=8' });
    // 失败不计入 → lastWriteTs 为 0 → 不等待
    expect(riskControl.lastWriteTs()).toBe(0);
    const t0 = Date.now();
    await riskControl.enforceDelay('write', {});
    expect(Date.now() - t0).toBeLessThan(500);
  }));
});

describe('lastOpTs / msUntilNext', () => {
  it('lastOpTs 按命令集合取最近时间', withTempEnv({}, async ({ riskControl, events }) => {
    events.append({ ts: 1000, command: 'post', status: 'success' });
    events.append({ ts: 2000, command: 'get', status: 'success' });
    events.append({ ts: 3000, command: 'like', status: 'success' });

    expect(riskControl.lastWriteTs()).toBe(3000);
    expect(riskControl.lastReadTs()).toBe(2000);
    expect(riskControl.lastOpTs(['post', 'get'])).toBe(2000);
  }));

  it('lastOpTs 空集合返回 0（不生成非法 SQL）', withTempEnv({}, async ({ riskControl }) => {
    expect(riskControl.lastOpTs([])).toBe(0);
  }));

  it('msUntilNext 区分读写窗口', withTempEnv({
    intervals: { write: [40, 55], read: [30, 50] },
  }, async ({ riskControl, events }) => {
    events.append({ ts: Date.now() - 10_000, command: 'post', status: 'success' });
    events.append({ ts: Date.now() - 5_000, command: 'get', status: 'success' });

    // 写：下限 40s，已过 10s → 还需约 30s
    expect(riskControl.msUntilNext('write')).toBeGreaterThan(29000);
    expect(riskControl.msUntilNext('write')).toBeLessThanOrEqual(30000);
    // 读：下限 30s，已过 5s → 还需约 25s
    expect(riskControl.msUntilNext('read')).toBeGreaterThan(24000);
    expect(riskControl.msUntilNext('read')).toBeLessThanOrEqual(25000);
  }));

  it('无记录时 msUntilNext 返回 0', withTempEnv({}, async ({ riskControl }) => {
    expect(riskControl.msUntilNext('write')).toBe(0);
    expect(riskControl.msUntilNext('read')).toBe(0);
  }));
});

// ═══════════════════════════════════════════════════════════
// 读操作必须按**读间隔**等，不是写间隔
//
// 回归背景：`enforceDelay` 第 2 步（叠加随机量）无条件用
// `jitteredWriteTargetSec()`，于是 `intervals.read` 被整个跳过 ——
// 用户把读间隔设成 [3,5]，实际等的是写间隔 [40,55]。
//
// 症状特别难查：配置项**看起来是生效的**（第 1 步确实按读间隔的下限等了），
// 只是"怎么调都快不了"。而且日志里印的"目标总间隔 40s"是写间隔的值，
// 用户没理由把它和读操作联系起来。
// ═══════════════════════════════════════════════════════════
describe('读写各用各的间隔', () => {
  // 故意把两者拉开：[1,2] 与 [3,4]，一次读等待超过 2.5 秒就说明用错了间隔。
  // 写间隔没有再往上调 —— vitest 默认单测超时是 5 秒，[4,5] 会正好撞上。
  // 下面每个 it 仍显式给了 15 秒超时，防止机器慢时误报。
  const CFG = { intervals: { read: [1, 2], write: [3, 4], readEnforce: true } };
  const T = 15000;

  it('读操作等的是读间隔（不是写间隔）', withTempEnv(CFG, async ({ riskControl, events }) => {
    events.append({ ts: Date.now(), command: 'get', status: 'success' });
    const t0 = Date.now();
    await riskControl.enforceDelay('read', { onWait: () => {} });
    const waited = (Date.now() - t0) / 1000;
    // 读间隔上界 2s。留一点调度余量，但绝不能接近写间隔的下界 4s
    expect(waited).toBeLessThan(2.5);
  }), T);

  it('写操作仍按写间隔等（别把修复做成了"全都按读间隔"）', withTempEnv(CFG, async ({ riskControl, events }) => {
    events.append({ ts: Date.now(), command: 'post', status: 'success' });
    const t0 = Date.now();
    await riskControl.enforceDelay('write', { onWait: () => {} });
    const waited = (Date.now() - t0) / 1000;
    expect(waited).toBeGreaterThanOrEqual(2.5);
  }), T);

  it('目标值读写分开抽，且同一个"上次时刻"抽出来的值稳定', withTempEnv(CFG, async ({ riskControl, events }) => {
    events.append({ ts: Date.now(), command: 'get', status: 'success' });
    const r1 = riskControl.jitteredReadTargetSec();
    const r2 = riskControl.jitteredReadTargetSec();
    const w = riskControl.jitteredWriteTargetSec();
    // 同一个"上次读时刻"下反复取，必须得到同一个值 ——
    // 否则界面上的倒计时会来回跳（42s → 51s → 44s），看起来像坏了
    expect(r2).toBe(r1);
    expect(r1).toBeGreaterThanOrEqual(1);
    expect(r1).toBeLessThanOrEqual(2);
    expect(w).toBeGreaterThanOrEqual(3);
    expect(w).toBeLessThanOrEqual(4);
    // 读的目标不能落进写的区间 —— 那说明两份缓存又被合并了
    expect(w).toBeGreaterThan(r1);
  }), T);
});
