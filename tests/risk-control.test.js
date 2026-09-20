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

// ═══════════════════════════════════════════════════════════
// 闸门"看得见哪些操作"
//
// 回归背景（第十五轮）：私信与补全都不在这两份名单里。实测：
//   - 发完一条私信（events 里记的是 `dm.send`）→ `lastWriteTs()` 仍是 0
//     → 下一条私信**零间隔**；`writesToday` 也数不到它，
//       "当日 30 条写操作"对私信等于不存在。而私信恰恰最经不起连点。
//   - 补完 200 个视频（`enrich`）→ `lastReadTs()` 看到的还是几小时前的 get
//     → 紧跟着的「拉取评论」一次都不等。
// 名单漏一个名字不报错、不抛异常，只会安静地变成"这里没有闸门"，
// 所以除了下面的逐条断言，还加了一条静态护栏：凡是会向抖音发请求的命令，
// 它的审计操作名必须登记在读或写某一侧。
// ═══════════════════════════════════════════════════════════

describe('闸门名单：私信与补全', () => {
  it('发完一条私信，写间隔看得见它', withTempEnv({ intervals: { write: [40, 55] } },
    async ({ riskControl, events }) => {
      events.append({ ts: Date.now(), command: 'dm.send', status: 'success' });
      expect(riskControl.lastWriteTs()).toBeGreaterThan(0);
      expect(riskControl.msUntilNext('write')).toBeGreaterThan(35000);
    }));

  it('补完一批视频，读间隔看得见它', withTempEnv({ intervals: { read: [30, 50] } },
    async ({ riskControl, events }) => {
      events.append({ ts: Date.now(), command: 'enrich', status: 'success' });
      expect(riskControl.lastReadTs()).toBeGreaterThan(0);
      expect(riskControl.msUntilNext('read')).toBeGreaterThan(25000);
    }));

  it('私信在桌面队列里算写操作（要排轮次、要显示倒计时、要计入配额）', () => {
    const { isWriteCommand } = require('../core/policy');
    // 注册表里的名字（界面入队时用的那个）
    expect(isWriteCommand('dm')).toBe(true);
    expect(isWriteCommand('delete-comment')).toBe(true);   // 连字形的另一套拼写
    expect(isWriteCommand('enrich')).toBe(false);          // 补全始终是读操作
  });
});

describe('护栏：碰抖音的命令必须登记在节奏名单里', () => {
  const CMD_DIR = path.join(__dirname, '..', 'core', 'commands');

  /**
   * 操作名是变量、静态取不出来的文件 —— 在这里写死。
   * like.js 用的是 `startOperation(action)`，action 只可能是 like / unlike。
   */
  const DYNAMIC_NAMES = { 'like.js': ['like', 'unlike'] };

  /**
   * 文件里确实有发请求的调用、但这个**操作本身**不登记，以及理由。
   * 写在这里等于把它变成一个显式的待决问题（见 开发进度.md §3），
   * 而不是让它像这两轮之前那样安静地躺着。
   */
  const NOT_REGISTERED_ON_PURPOSE = {
    // 只是把页面内存里的 window.__dmQueue 倒出来，一个抖音请求都不发。
    // 登记进去的副作用是"看一眼已收到的私信"会把下一条读操作卡住 30 秒。
    'dm.list': '不发请求：读的是浏览器页面内存里的队列',
    // 一次运行只打一次详情（批量模式也是同一个视频）。
    // 登记成读操作当然更严 —— 但后果是界面上每点一次「生成回复」都要先等
    // 30–50 秒，而那一步大头本来就是等 AI。这条收不收是产品决定，不是接线疏漏。
    'getReply': '一次运行只有一次详情请求；登记会让每次生成都先等读间隔（待决）',
  };

  /** 从源码里取出字面量写法的审计操作名：startOperation('x' / withAudit(ctx, 'x' */
  function literalOpNames(src) {
    const names = new Set();
    for (const re of [
      /startOperation\(\s*'([\w.-]+)'/g,
      /withAudit\(\s*ctx\s*,\s*'([\w.-]+)'/g,
    ]) {
      let m;
      while ((m = re.exec(src)) !== null) names.add(m[1]);
    }
    return [...names];
  }

  const riskControl = require('../core/risk-control');
  const registered = new Set([...riskControl.READ_COMMANDS, ...riskControl.WRITE_COMMANDS]);

  const files = fs.readdirSync(CMD_DIR).filter(f => f.endsWith('.js'));
  const checked = [];
  const missing = [];
  const usedExceptions = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(CMD_DIR, f), 'utf8');
    // 只管真的会发请求的那些：`analyze` / `note` / `draft` 这些纯本地命令
    // 一次抖音请求都不发，登记进去只会让读间隔莫名其妙地卡住下一条命令
    const hitsDouyin = /ctx\.loggedCall\(|ctx\.bridgeCall\(|bridgeCall\(/.test(src);
    if (!hitsDouyin) continue;
    const names = [...literalOpNames(src), ...(DYNAMIC_NAMES[f] || [])];
    for (const n of names) {
      checked.push(`${f}:${n}`);
      if (registered.has(n)) continue;
      if (Object.prototype.hasOwnProperty.call(NOT_REGISTERED_ON_PURPOSE, n)) {
        usedExceptions.add(n);
        continue;
      }
      missing.push(`${f} → ${n}`);
    }
  }

  it('解析器确实取到了操作名（护栏本身要有效）', () => {
    expect(checked.length).toBeGreaterThan(5);
    // 这两条就是本轮新登记的：它们必须真的在名单里
    expect(registered.has('enrich')).toBe(true);
    expect(registered.has('dm.send')).toBe(true);
  });

  it('每个会发请求的命令都登记了读或写某一侧', () => {
    expect(missing).toEqual([]);
  });

  it('例外表里不留已经不存在或已经登记的名字', () => {
    // 例外写死了不管就会一直留在表上 —— 那正是本轮那两个坑被埋没的方式。
    expect([...usedExceptions].sort()).toEqual(Object.keys(NOT_REGISTERED_ON_PURPOSE).sort());
  });
});
