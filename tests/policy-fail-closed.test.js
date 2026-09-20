// tests/policy-fail-closed.test.js — 读不到数据时必须拒绝，而不是放行
//
// 这个文件固化的是风控闸门唯一重要的一条不变量：
//   **"状态未知"和"一切正常"永远不能得出同一个结果。**
//
// 改造前两处都是同一个降级方向：
//   - core/memory/db.js 把迁移失败前就缓存下来的半迁移连接交出去
//   - core/policy 把 events 读不到当成 [] 、core/risk-control 当成 0
// 合起来的效果是：数据库一坏，"今日 0 条 / 距上次写 0 秒 / 没有风控"三件事同时成立，
// 于是 40 条连发畅通无阻，而且只记 debug 日志（默认级别直接丢弃）。
// 用户以为有保护，实际没有 —— 比没有界面更糟。
//
// 所以这里既测"坏了要拦住"，也测"没坏要放行"：后者保证 fail-closed 没被做成永远写不出去。

const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../core/config');

// vitest.config.js 全局设了 DOUYIN_NO_THROTTLE=1，本文件要验证真实的等待行为，必须临时关掉。
const ENV_KEYS = ['DOUYIN_STORAGE_DIR', 'DOUYIN_LOG_DIR', 'DOUYIN_CONFIG', 'DOUYIN_NO_THROTTLE'];

function purgeModules() {
  for (const m of [
    '../core/memory/db', '../core/memory/events', '../core/memory/comments', '../core/memory/users',
    '../core/policy', '../core/policy/index', '../core/risk-control',
  ]) {
    try { delete require.cache[require.resolve(m)]; } catch (e) { /* 未加载过 */ }
  }
}

/**
 * 独立临时数据目录 + 临时配置。fn 拿到 { tmp, dbPath, getDb, events }。
 */
function withTempEnv(cfg, fn) {
  return async () => {
    const saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-failclosed-'));
    const dbPath = path.join(tmp, 'storage', 'douyin.db');
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    process.env.DOUYIN_LOG_DIR = path.join(tmp, 'logs');
    const cfgFile = path.join(tmp, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify(cfg || {}));
    process.env.DOUYIN_CONFIG = cfgFile;
    delete process.env.DOUYIN_NO_THROTTLE;
    config.reset();
    purgeModules();

    try {
      const { getDb } = require('../core/memory/db');
      const events = require('../core/memory/events');
      await fn({ tmp, dbPath, getDb, events });
    } finally {
      try { require('../core/memory/db').closeDb(); } catch (e) { /* ignore */ }
      purgeModules();
      config.reset();
      for (const k of ENV_KEYS) {
        if (saved[k] == null) delete process.env[k];
        else process.env[k] = saved[k];
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

/** 模拟"库读不动"：events 表没了 → 任何按时间线的统计都抛错（而不是返回 0 行） */
function breakEventsTable(getDb) {
  getDb();                       // 先把 schema 建起来
  getDb().exec('DROP TABLE events');
}

describe('db: 迁移失败不得留下坏连接', () => {
  // v3 → v4 是唯一一条没做列存在性检查的 ALTER，撞在已有 reply_cid 的库上必然抛错。
  // 用它当"迁移中途失败"的确定性触发器。
  it('每次 getDb() 都抛，不会把半迁移的连接缓存成单例', withTempEnv({}, async ({ dbPath }) => {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const { Database } = require('../core/memory/sqlite-driver');
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE reply_corpus (
      id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT, reply_hash TEXT, reply_cid TEXT
    )`);
    raw.pragma('user_version = 3');
    raw.close();

    const { getDb } = require('../core/memory/db');
    expect(() => getDb()).toThrow();
    // 重点在第二句：旧代码里这里走 `if (_db) return _db` 短路，返回一个表都没建全的库，
    // 从此所有 memory 层读静默变成 []/null/0，日志里一个字都没有。
    expect(() => getDb()).toThrow();
    // 抛的还必须是原始原因，而不是"关连接时又出一个错"把真因盖掉
    expect(() => getDb()).toThrow(/duplicate column|reply_cid/i);

    const check = new Database(dbPath);
    expect(check.pragma('user_version', { simple: true })).toBe(3);   // 失败不该推进版本号
    check.close();
  }));
});

describe('policy: 计数读不到 = 拒绝写入', () => {
  it('events 不可读时 beforeWrite 硬拦、assertWritable 抛错', withTempEnv({}, async ({ getDb }) => {
    const { createPolicyEngine } = require('../core/policy');
    breakEventsTable(getDb);
    const engine = createPolicyEngine({});

    const s = engine.stats();
    expect(s.readError).toBeTruthy();
    // 数字仍然是假的 0 —— 这正是"只看数字"看不出问题的地方，必须有 readError 这个字段
    expect(s.writesToday).toBe(0);
    expect(s.warning).toMatch(/策略数据不可读/);

    const r = engine.beforeWrite({ uid: 'u1', awemeId: 'v1' });
    expect(r.ok).toBe(false);
    expect(r.hardBlockers.some(b => /读不到运营记录/.test(b.reason))).toBe(true);

    await expect(engine.assertWritable({})).rejects.toThrow(/读不到运营记录/);
  }));

  // 上面那条只把 hasRecentRiskBlock 恢复成"抛错"就能过，时间线那条腿没被单独证明。
  // 这里把 riskCodeStopList 置空让风控探测根本不去碰 events 表（它提前 return false），
  // 于是拦下写作的只可能是 queryWrites 一条腿。
  // （空列表会关掉全局风控停写，本身是另一条待修的缺陷，这里只是借它做隔离。）
  it('仅时间线读取失败（风控探测被短路）同样必须拦下', withTempEnv(
    { policy: { riskCodeStopList: [] } },
    async ({ getDb }) => {
      const { createPolicyEngine } = require('../core/policy');
      const riskControl = require('../core/risk-control');
      breakEventsTable(getDb);
      // 确认隔离成立：风控探测这条腿现在是"正常返回 false"，不是抛错
      expect(riskControl.hasRecentRiskBlock(60000)).toBe(false);

      const engine = createPolicyEngine({});
      const r = engine.beforeWrite({});
      expect(r.ok).toBe(false);
      expect(r.hardBlockers.some(b => /读不到运营记录/.test(b.reason))).toBe(true);
    }));

  it('健康空库照样放行（别把 fail-closed 做成永远发不出去）', withTempEnv({}, async () => {
    const { createPolicyEngine } = require('../core/policy');
    const engine = createPolicyEngine({});
    expect(engine.stats().readError).toBe(null);
    expect(engine.beforeWrite({}).ok).toBe(true);
    await expect(engine.assertWritable({})).resolves.toBeTruthy();
  }));
});

describe('risk-control: 上次操作时间的三态', () => {
  it('0 = 确实没记录（可立刻写）；null = 读不到（等满间隔上限）', withTempEnv(
    { intervals: { write: [40, 55] } },
    async ({ getDb }) => {
      const riskControl = require('../core/risk-control');

      expect(riskControl.lastWriteTs()).toBe(0);
      expect(riskControl.msUntilNext('write')).toBe(0);
      expect(riskControl.msUntilNextWriteJittered()).toBe(0);

      breakEventsTable(getDb);
      expect(riskControl.lastWriteTs()).toBe(null);
      expect(riskControl.msUntilNext('write')).toBe(55 * 1000);      // 上限，不是下限
      // 随机目标落在 [40,55] 之内（含两端）—— 抽到 40 也是对的，别写成严格大于
      const jittered = riskControl.msUntilNextWriteJittered();
      expect(jittered).toBeGreaterThanOrEqual(40 * 1000);
      expect(jittered).toBeLessThanOrEqual(55 * 1000);
    }));

  it('状态未知时 enforceDelay 真的在等（不是打个日志就过）', withTempEnv(
    { intervals: { write: [1, 2] } },
    async ({ getDb }) => {
      const riskControl = require('../core/risk-control');
      breakEventsTable(getDb);

      const ac = new AbortController();
      let reported = null;
      const p = riskControl.enforceDelay('write', {
        signal: ac.signal,
        onWait: (info) => { reported = info; ac.abort(); },   // 确认它要等之后再打断，免得拖慢测试
      });
      let err = null;
      try { await p; } catch (e) { err = e; }
      expect(err).toBeTruthy();                               // 没等完就抛，说明确实在阻塞
      expect(reported).toBeTruthy();
      expect(reported.waitMs).toBe(2000);
      expect(reported.reason).toMatch(/读不到/);
    }));

  it('风控记录读不到时 hasRecentRiskBlock 抛出，而不是回一句"没被拦过"', withTempEnv({}, async ({ getDb }) => {
    const riskControl = require('../core/risk-control');
    getDb();
    expect(riskControl.hasRecentRiskBlock(60000)).toBe(false);   // 健康库、确实没被拦

    breakEventsTable(getDb);
    expect(() => riskControl.hasRecentRiskBlock(60000)).toThrow();
  }));
});

describe('events: 两种读法各有其主', () => {
  it('query 降级为 []，queryStrict 抛出 —— 风控计数只准用后者', withTempEnv({}, async ({ getDb, events }) => {
    events.append({ command: 'post', status: 'success', ts: Date.now() });
    expect(events.query({ command: 'post' }).length).toBe(1);

    getDb().exec('DROP TABLE events');
    expect(events.query({ command: 'post' })).toEqual([]);
    expect(() => events.queryStrict({ command: 'post' })).toThrow();
  }));
});
