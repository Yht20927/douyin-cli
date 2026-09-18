// tests/p4-guards-account.test.js — P4.4 核对清单暴露出的两处失效
//
// 这个文件测的不是新功能，而是**两条以为生效、其实没生效的运营红线**：
//
// 1. 「同一用户每轮最多回复 N 条」——
//    policy 里的判定写在 `if (meta.uid)` 里，但全仓没有任何调用方传 uid；
//    而且 events 表里也没写 uid，于是即便传了也永远数出 0。
//    两处都要有才成立，所以这里两处都测。
//
// 2. 「桌面端读操作强制间隔」（改造计划 §5.4 / R6）——
//    risk-control 的注释写着"GUI 下会打开"，但没有任何地方打开它。
//    现在由主进程用运行时覆盖打开，而运行时覆盖必须**尊重用户的显式设置**。

const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../core/config');

function withTempEnv(fn) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-p44-'));
    const origCfg = process.env.DOUYIN_CONFIG;
    const origData = process.env.DOUYIN_DATA_DIR;
    const origStorage = process.env.DOUYIN_STORAGE_DIR;
    process.env.DOUYIN_CONFIG = path.join(tmp, 'config.json');
    process.env.DOUYIN_DATA_DIR = tmp;
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    config.reset();

    try {
      await fn(tmp);
    } finally {
      try { require('../core/memory/db').closeDb(); } catch (_) { /* */ }
      try { config.reset(); } catch (_) { /* */ }
      if (origCfg == null) delete process.env.DOUYIN_CONFIG; else process.env.DOUYIN_CONFIG = origCfg;
      if (origData == null) delete process.env.DOUYIN_DATA_DIR; else process.env.DOUYIN_DATA_DIR = origData;
      if (origStorage == null) delete process.env.DOUYIN_STORAGE_DIR; else process.env.DOUYIN_STORAGE_DIR = origStorage;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

describe('同一用户每轮上限：传参与落库两处都要有', () => {
  it('post 把被回复评论的 uid 传进闸门，并写进 events', withTempEnv(async () => {
    const comments = require('../core/memory/comments');
    const events = require('../core/memory/events');
    const cmdPost = require('../core/commands/post');

    comments.upsert({ cid: 'c1', awemeId: 'v1', uid: 'u-target', text: '你好', createdAt: 1700000000 });

    const seen = [];
    const policy = require('../core/policy').getPolicy();
    const origAssert = policy.assertWritable;
    policy.assertWritable = (meta) => { seen.push(meta); return { ok: true }; };

    // 用**真实的** AuditLogger。桩掉它就只能证明"参数传进去了"，
    // 而这条红线的失效恰恰是"传参"与"落库"两处都要有 —— 桩掉一侧就测不到另一侧。
    const { AuditLogger } = require('../core/audit');
    const audit = new AuditLogger();

    const ctx = {
      config: { llm: {} },
      bridgeCall: async () => ({}),
      audit,
      loggedCall: async () => { throw new Error('测试不真的发请求'); },
    };

    try {
      await cmdPost(ctx, ['v1', '回复内容', '--reply-to', 'c1', '--no-throttle']);
    } catch (_) { /* 到不了浏览器，预期会抛 */ } finally {
      policy.assertWritable = origAssert;
    }

    // ① 闸门拿到了 uid —— 改造前这里永远是 undefined，那条件分支是死代码
    expect(seen[0].uid).toBe('u-target');

    // ② events 表里也落了 uid —— 少了这个，queryWrites({uid}) 永远数出 0，
    //    闸门拿到 uid 也白搭
    const rows = events.query({ commands: ['post'], limit: 10 });
    const started = rows.find(r => r.command === 'post');
    expect(started).toBeTruthy();
    expect(started.uid).toBe('u-target');
  }));

  it('查不到被回复评论时传 null，而不是瞎猜一个 uid', withTempEnv(async () => {
    const cmdPost = require('../core/commands/post');
    const seen = [];
    const policy = require('../core/policy').getPolicy();
    const origAssert = policy.assertWritable;
    policy.assertWritable = (meta) => { seen.push(meta); return { ok: true }; };

    const { AuditLogger } = require('../core/audit');
    const ctx = {
      config: { llm: {} }, bridgeCall: async () => ({}),
      audit: new AuditLogger(),
      loggedCall: async () => { throw new Error('不真的发请求'); },
    };
    try {
      await cmdPost(ctx, ['v1', '内容', '--reply-to', '不存在的cid', '--no-throttle']);
    } catch (_) { /* */ } finally {
      policy.assertWritable = origAssert;
    }

    // 猜一个 uid 会拦下本来该发的回复，比不拦更糟
    expect(seen[0].uid).toBeNull();
  }));
});

describe('运行时覆盖：给形态定默认，但不覆盖用户的显式选择', () => {
  it('用户没设过 → 覆盖生效；且不写盘', withTempEnv(async (tmp) => {
    expect(config.get('intervals.readEnforce')).toBe(false);   // CLI 形态的默认

    config.setRuntimeOverrides({ intervals: { readEnforce: true } });
    expect(config.get('intervals.readEnforce')).toBe(true);    // 桌面形态

    // 没写盘 —— 写盘的话，这个"形态默认"就会固化成用户的配置，
    // 以后想把 CLI 与桌面的默认值分开调就不可能了
    expect(fs.existsSync(path.join(tmp, 'config.json'))).toBe(false);
  }));

  it('用户显式设过 → 用户说了算，重启后依然是用户的值', withTempEnv(async (tmp) => {
    config.setRuntimeOverrides({ intervals: { readEnforce: true } });
    config.set({ intervals: { readEnforce: false } });
    expect(config.get('intervals.readEnforce')).toBe(false);

    // 模拟重启：清掉内存缓存与运行时覆盖，重新按磁盘加载
    config.reset();
    config.setRuntimeOverrides({ intervals: { readEnforce: true } });
    expect(config.get('intervals.readEnforce')).toBe(false);

    // 磁盘上留下的也只有用户那一份
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
    expect(raw.intervals.readEnforce).toBe(false);
  }));

  it('清除覆盖后回到磁盘上的值', withTempEnv(async () => {
    config.setRuntimeOverrides({ intervals: { readEnforce: true } });
    expect(config.get('intervals.readEnforce')).toBe(true);

    config.setRuntimeOverrides(null);
    expect(config.get('intervals.readEnforce')).toBe(false);
  }));

  it('覆盖只影响它声明的那些键', withTempEnv(async () => {
    config.setRuntimeOverrides({ intervals: { readEnforce: true } });
    expect(config.get('intervals.read')).toEqual([30, 50]);
    expect(config.get('intervals.write')).toEqual([40, 55]);
  }));
});
