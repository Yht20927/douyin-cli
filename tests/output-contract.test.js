// tests/output-contract.test.js — 命令返回值的双重职责
//
// 背景：命令的返回值同时服务于两个消费者
//   - CLI：cli.js 把它 JSON.stringify 打到 stdout
//   - GUI：经 runCommand 直接消费，用来渲染界面
//
// 有些命令在人类可读模式下已经自己输出过了（`replied` 逐行打印 cid、
// `events` 打印可读行）。如果它们为了 GUI 而返回数据，cli.js 就会**多打印一遍
// JSON**，破坏原有输出格式。
//
// 解法：logger 记录本次运行产生过多少条 output；cli.js 仅在为 0 时打印返回值。
// 这样命令可以无条件返回结构化数据，而 CLI 行为保持不变。
//
// 本文件分两层验证：logger 计数语义（单元）+ cli.js 的真实 stdout（子进程集成）。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const loggerModule = require('../core/runtime/logger');
const { createContext, bindCommands } = require('../core/runtime/context');
const config = require('../core/config');

const ROOT = path.resolve(__dirname, '..');
const ENV_KEYS = ['DOUYIN_STORAGE_DIR', 'DOUYIN_LOG_DIR', 'DOUYIN_CONFIG'];

/** 建立带真实 sqlite 的临时环境，返回可用的 ctx 与 env */
function withTempEnv(fn) {
  return async () => {
    const saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-out-'));
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    process.env.DOUYIN_LOG_DIR = path.join(tmp, 'logs');
    const cfgFile = path.join(tmp, 'config.json');
    fs.writeFileSync(cfgFile, '{}');
    process.env.DOUYIN_CONFIG = cfgFile;
    config.reset();

    // 必须连命令注册表与调度器一起清掉：
    // run-command.js 在模块加载时就 require('../commands') 并永久持有那份注册表，
    // 而注册表持有各命令模块 → 命令模块持有 memory/events → 后者持有 db 实例。
    // 只清 db 是没用的，注册表里仍是指向**上一个临时目录**的旧连接。
    const PURGE = [
      '../core/memory/db', '../core/memory/events',
      '../core/commands', '../core/commands/replied', '../core/commands/events',
      '../core/runtime/run-command',
    ];
    const purge = () => {
      for (const m of PURGE) {
        delete require.cache[require.resolve(m)];
      }
    };
    purge();

    try {
      const db = require('../core/memory/db');
      const runCommand = require('../core/runtime/run-command').runCommand;
      const ctx = createContext({
        bridge: { async call() { return { ok: true, value: null }; } },
        audit: { startOperation() {}, endOperation() {}, logApiCall() {}, setNoLog() {}, _currentOp: null },
      });
      bindCommands(ctx, require('../core/commands'));
      await fn({ tmp, ctx, db, runCommand, configFile: cfgFile, env: { DOUYIN_STORAGE_DIR: process.env.DOUYIN_STORAGE_DIR, DOUYIN_LOG_DIR: process.env.DOUYIN_LOG_DIR, DOUYIN_CONFIG: cfgFile } });
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

/** 在临时环境里跑一次真实 CLI 子进程，返回 {stdout, stderr, code} */
function runCli(args, env) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(ROOT, 'cli.js'), ...args], {
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

afterEach(() => {
  loggerModule.reset();
});

// ═══════════════════════════════════════════════════════════
// logger 计数语义
// ═══════════════════════════════════════════════════════════

describe('outputCount 计数', () => {
  beforeEach(() => {
    loggerModule.configure({ sinks: [loggerModule.collectorSink()], level: 'debug' });
    loggerModule.resetOutputCount();
  });

  it('只有 output() 递增，其他级别不计入', () => {
    const l = loggerModule.getLogger();
    l.debug('d'); l.info('i'); l.warn('w'); l.error('e'); l.phase('p');
    l.progress({ text: 'pr' });
    expect(loggerModule.outputCount()).toBe(0);

    l.output('一');
    l.output('二');
    expect(loggerModule.outputCount()).toBe(2);
  });

  it('child logger 的 output 计入同一计数（sink 共享）', () => {
    loggerModule.getLogger().child({ command: 'x' }).output('来自 child');
    expect(loggerModule.outputCount()).toBe(1);
  });

  it('resetOutputCount 归零', () => {
    loggerModule.getLogger().output('x');
    expect(loggerModule.outputCount()).toBe(1);
    loggerModule.resetOutputCount();
    expect(loggerModule.outputCount()).toBe(0);
  });

  it('被 level 过滤掉的 output 不计入', () => {
    loggerModule.configure({ sinks: [loggerModule.collectorSink()], level: 'error' });
    loggerModule.resetOutputCount();
    loggerModule.getLogger().output('x');
    expect(loggerModule.outputCount()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 命令返回值（GUI 侧消费）
// ═══════════════════════════════════════════════════════════

describe('命令对 GUI 返回结构化数据', () => {
  it('replied 默认模式：既产生可读输出，也返回结构化行', withTempEnv(async ({ ctx, db, runCommand }) => {
    db.getDb().prepare(
      `INSERT INTO comments (cid, platform, aweme_id, uid, text, replied)
       VALUES ('c1', 'douyin', 'v1', 'u1', 'hi', 1)`
    ).run();

    loggerModule.resetOutputCount();
    const rows = await runCommand(ctx, 'replied', []);

    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].cid).toBe('c1');
    // 关键：确实产生过可读输出，故 cli.js 不会再打印一遍 JSON
    expect(loggerModule.outputCount()).toBeGreaterThan(0);
  }));

  it('events 空结果返回空数组而非 undefined', withTempEnv(async ({ ctx, runCommand }) => {
    loggerModule.resetOutputCount();
    const rows = await runCommand(ctx, 'events', ['--tail', '5']);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(0);
  }));

  it('events 有数据时：可读输出 + 结构化行并存', withTempEnv(async ({ ctx, db, runCommand }) => {
    db.getDb().prepare(
      `INSERT INTO events (ts, command, status, platform) VALUES (?, 'post', 'success', 'douyin')`
    ).run(Date.now());

    loggerModule.resetOutputCount();
    const rows = await runCommand(ctx, 'events', ['--tail', '5']);
    expect(rows).toHaveLength(1);
    expect(rows[0].command).toBe('post');
    expect(loggerModule.outputCount()).toBeGreaterThan(0);
  }));
});

// ═══════════════════════════════════════════════════════════
// cli.js 真实 stdout（子进程集成）
// ═══════════════════════════════════════════════════════════

describe('cli.js 的 stdout 契约', () => {
  it('replied 默认模式输出逐行 cid，不掺 JSON', withTempEnv(async ({ db, env }) => {
    db.getDb().prepare(
      `INSERT INTO comments (cid, platform, aweme_id, uid, text, replied)
       VALUES ('cid-abc', 'douyin', 'v1', 'u1', 'hi', 1)`
    ).run();
    db.closeDb();

    const r = runCli(['replied'], env);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('cid-abc');
    // 关键回归：不能把返回值再打印一遍（否则这里会出现 '['）
    expect(r.stdout).not.toContain('[');
    expect(r.stdout).not.toContain('"cid"');
  }));

  it('replied --json 仍输出 JSON 数组', withTempEnv(async ({ db, env }) => {
    db.getDb().prepare(
      `INSERT INTO comments (cid, platform, aweme_id, uid, text, replied)
       VALUES ('cid-xyz', 'douyin', 'v1', 'u1', 'hi', 1)`
    ).run();
    db.closeDb();

    const r = runCli(['replied', '--json'], env);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].cid).toBe('cid-xyz');
  }));

  it('events 默认模式输出可读行，不掺 JSON', withTempEnv(async ({ db, env }) => {
    db.getDb().prepare(
      `INSERT INTO events (ts, command, status, platform) VALUES (?, 'post', 'success', 'douyin')`
    ).run(Date.now());
    db.closeDb();

    const r = runCli(['events', '--tail', '5'], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('post');
    expect(r.stdout).not.toContain('"command"');
  }));

  it('无人类可读输出的命令仍打印 JSON（如 preflight）', withTempEnv(async ({ env }) => {
    const r = runCli(['preflight'], env);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toHaveProperty('intervals');
  }));

  it('诊断信息一律进 stderr，stdout 保持纯净', withTempEnv(async ({ db, env }) => {
    db.getDb().prepare(
      `INSERT INTO comments (cid, platform, aweme_id, uid, text, replied)
       VALUES ('c-clean', 'douyin', 'v1', 'u1', 'hi', 1)`
    ).run();
    db.closeDb();

    const r = runCli(['replied'], env);
    // stdout 只有数据，没有任何诊断行
    expect(r.stdout.trim().split('\n')).toEqual(['c-clean']);
  }));
});
