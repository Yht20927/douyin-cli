// tests/runtime.test.js — 运行时三层：logger / context / run-command
//
// 不变量：
// 1. CLI 输出契约不被破坏：诊断一律 stderr，stdout 只留命令返回的 JSON
// 2. 单例 logger 可被 configure() 替换（CLI 用 console、GUI 用 IPC），且 sink 异常不影响业务
// 3. ctx 的组装与改造前 cli.js 一致，并新增 logger/signal/taskId/profileId
// 4. 命令调度与错误文案由 core 提供，CLI 与 GUI 共用同一份

const fs = require('fs');
const path = require('path');
const os = require('os');

const loggerModule = require('../core/runtime/logger');
const { createContext, bindCommands, DEFAULT_PROFILE } = require('../core/runtime/context');
const { listCommands, hasCommand, runCommand, describeError } = require('../core/runtime/run-command');

/** 抓取 console.log / console.error 的输出 */
function captureConsole(fn) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => out.push(a.map(String).join(' '));
  console.error = (...a) => err.push(a.map(String).join(' '));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out, err };
}

afterEach(() => {
  loggerModule.reset();
});

// ═══════════════════════════════════════════════════════════
// logger
// ═══════════════════════════════════════════════════════════

describe('logger: console sink 的流分离', () => {
  it('诊断类（info/warn/error/debug）一律走 stderr，不污染 stdout', () => {
    loggerModule.configure({ sinks: [loggerModule.consoleSink()], level: 'debug' });
    const log = loggerModule.getLogger();
    const { out, err } = captureConsole(() => {
      log.info('i');
      log.warn('w');
      log.error('e');
      log.debug('d');
    });
    expect(out).toEqual([]);
    expect(err).toEqual(['i', 'w', 'e', 'd']);
  });

  it('output() 走 stdout（log/events/replied 的文本模式依赖这一点）', () => {
    loggerModule.configure({ sinks: [loggerModule.consoleSink()], level: 'debug' });
    const { out, err } = captureConsole(() => {
      loggerModule.getLogger().output('人类可读文本');
    });
    expect(out).toEqual(['人类可读文本']);
    expect(err).toEqual([]);
  });

  it('progress() 在 CLI 下按诊断走 stderr', () => {
    loggerModule.configure({ sinks: [loggerModule.consoleSink()], level: 'debug' });
    const { out, err } = captureConsole(() => {
      loggerModule.getLogger().progress({ taskId: 't1', pct: 40, text: '正在拉取 2/5' });
    });
    expect(out).toEqual([]);
    expect(err).toEqual(['正在拉取 2/5']);
  });

  it('phase() 走 stderr', () => {
    loggerModule.configure({ sinks: [loggerModule.consoleSink()], level: 'debug' });
    const { out, err } = captureConsole(() => loggerModule.getLogger().phase('阶段一'));
    expect(out).toEqual([]);
    expect(err).toEqual(['阶段一']);
  });
});

describe('logger: 级别过滤', () => {
  it('level=warn 时 info/debug 被丢弃，warn/error 保留', () => {
    loggerModule.configure({ sinks: [loggerModule.consoleSink()], level: 'warn' });
    const { err } = captureConsole(() => {
      const l = loggerModule.getLogger();
      l.debug('d');
      l.info('i');
      l.warn('w');
      l.error('e');
    });
    expect(err).toEqual(['w', 'e']);
  });

  it('level=debug 时全部保留', () => {
    loggerModule.configure({ sinks: [loggerModule.consoleSink()], level: 'debug' });
    const { err } = captureConsole(() => {
      const l = loggerModule.getLogger();
      l.debug('d');
      l.info('i');
    });
    expect(err).toEqual(['d', 'i']);
  });
});

describe('logger: 记录结构与上下文', () => {
  it('collector sink 收到结构化记录', () => {
    const sink = loggerModule.collectorSink();
    loggerModule.configure({ sinks: [sink], level: 'debug' });
    loggerModule.getLogger().info('hello', { a: 1 });

    expect(sink.records).toHaveLength(1);
    const rec = sink.records[0];
    expect(rec.level).toBe('info');
    expect(rec.kind).toBe('diagnostic');
    expect(rec.msg).toBe('hello');
    expect(rec.meta).toEqual({ a: 1 });
    expect(typeof rec.ts).toBe('string');
  });

  it('child() 继承 sink 并合并上下文', () => {
    const sink = loggerModule.collectorSink();
    loggerModule.configure({ sinks: [sink], level: 'debug', context: { profileId: 'default' } });
    const child = loggerModule.getLogger().child({ command: 'post', taskId: 't9' });
    child.info('x');

    expect(sink.records[0].context).toEqual({ profileId: 'default', command: 'post', taskId: 't9' });
  });

  it('无上下文时 context 为 null（不产生空对象噪音）', () => {
    const sink = loggerModule.collectorSink();
    loggerModule.configure({ sinks: [sink], level: 'debug' });
    loggerModule.getLogger().info('x');
    expect(sink.records[0].context).toBeNull();
  });

  it('progress 记录的 meta 带上结构化字段', () => {
    const sink = loggerModule.collectorSink();
    loggerModule.configure({ sinks: [sink], level: 'debug' });
    loggerModule.getLogger().progress({ taskId: 't1', pct: 30, text: '进行中', deadline: 123 });
    const rec = sink.records[0];
    expect(rec.kind).toBe('progress');
    expect(rec.msg).toBe('进行中');
    expect(rec.meta).toEqual({ taskId: 't1', pct: 30, deadline: 123 });
  });
});

describe('logger: sink 健壮性', () => {
  it('某个 sink 抛错不影响其他 sink，也不影响调用方', () => {
    const good = loggerModule.collectorSink();
    const bad = loggerModule.customSink(() => { throw new Error('sink boom'); }, 'bad');
    loggerModule.configure({ sinks: [bad, good], level: 'debug' });

    expect(() => loggerModule.getLogger().info('still works')).not.toThrow();
    expect(good.records).toHaveLength(1);
  });

  it('meta 有循环引用时不抛错（文件 sink 会丢弃该条）', () => {
    const sink = loggerModule.collectorSink();
    loggerModule.configure({ sinks: [sink], level: 'debug' });
    const circular = {};
    circular.self = circular;
    expect(() => loggerModule.getLogger().info('x', circular)).not.toThrow();
  });
});

describe('logger: file sink', () => {
  it('写入 JSON Lines，可逐行解析', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-log-'));
    const file = path.join(tmp, 'app.log');
    try {
      const sink = loggerModule.fileSink({ file });
      const l = new loggerModule.Logger({ sinks: [sink], level: 'debug' });
      l.info('第一行', { n: 1 });
      l.warn('第二行');
      sink.close();

      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).msg).toBe('第一行');
      expect(JSON.parse(lines[0]).meta).toEqual({ n: 1 });
      expect(JSON.parse(lines[1]).level).toBe('warn');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('目录不存在时自动创建', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-log-'));
    const file = path.join(tmp, 'deep', 'nested', 'app.log');
    try {
      const sink = loggerModule.fileSink({ file });
      new loggerModule.Logger({ sinks: [sink] }).info('x');
      sink.close();
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('路径不可写时静默降级，不抛错', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-log-'));
    // 用一个普通文件当"父目录"，mkdirSync 会立刻抛 ENOTDIR。
    // 刻意不用 /proc 这类特殊挂载点：实测在那上面 mkdirSync 会**阻塞**而非抛错。
    const notADir = path.join(tmp, 'regular-file');
    fs.writeFileSync(notADir, 'x');
    try {
      const sink = loggerModule.fileSink({ file: path.join(notADir, 'nested', 'app.log') });
      const l = new loggerModule.Logger({ sinks: [sink], level: 'debug' });
      expect(() => l.info('x')).not.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('目录准备失败后永久停用，后续写入不再重试（也绝不阻塞）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-log-'));
    const notADir = path.join(tmp, 'regular-file');
    fs.writeFileSync(notADir, 'x');
    try {
      const sink = loggerModule.fileSink({ file: path.join(notADir, 'app.log') });
      const l = new loggerModule.Logger({ sinks: [sink], level: 'debug' });
      // 连续写多条不应抛错、也不应重复尝试创建目录
      expect(() => { for (let i = 0; i < 50; i++) l.info(`line ${i}`); }).not.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('logger: 单例管理', () => {
  it('configure() 替换单例，getLogger() 随之变化', () => {
    const sinkA = loggerModule.collectorSink();
    loggerModule.configure({ sinks: [sinkA] });
    loggerModule.getLogger().info('a');

    const sinkB = loggerModule.collectorSink();
    loggerModule.configure({ sinks: [sinkB] });
    loggerModule.getLogger().info('b');

    expect(sinkA.records.map(r => r.msg)).toEqual(['a']);
    expect(sinkB.records.map(r => r.msg)).toEqual(['b']);
  });

  it('模块级便捷函数走当前单例', () => {
    const sink = loggerModule.collectorSink();
    loggerModule.configure({ sinks: [sink], level: 'debug' });
    loggerModule.info('via-helper');
    loggerModule.error('err-helper');
    expect(sink.records.map(r => r.msg)).toEqual(['via-helper', 'err-helper']);
  });

  it('reset() 恢复默认 console sink', () => {
    const sink = loggerModule.collectorSink();
    loggerModule.configure({ sinks: [sink] });
    loggerModule.reset();
    const { err } = captureConsole(() => loggerModule.getLogger().info('after-reset'));
    expect(err).toEqual(['after-reset']);
    expect(sink.records).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// context
// ═══════════════════════════════════════════════════════════

/** 造一个假的 bridge，记录调用并返回预设响应 */
function fakeBridge(responses = []) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async call(req) {
      calls.push(req);
      const r = responses[i++];
      if (r instanceof Error) throw r;
      return r === undefined ? { ok: true, value: null } : r;
    },
  };
}

function fakeAudit() {
  const ops = { started: [], api: [] };
  return {
    ops,
    startOperation: (name, meta) => ops.started.push({ name, meta }),
    endOperation: (...a) => ops.started.push({ ended: a }),
    logApiCall: (endpoint, params, ms, status, sum) => ops.api.push({ endpoint, status, sum }),
    setNoLog: () => {},
    _currentOp: null,
  };
}

describe('context: 结构', () => {
  it('包含改造前的全部字段（向后兼容）', () => {
    const ctx = createContext({ bridge: fakeBridge(), audit: fakeAudit() });
    for (const k of ['bridge', 'audit', 'config', 'bridgeCall', 'loggedCall', 'cmdGet', 'cmdPost', 'cmdAnalyze', 'cmdSearch', 'cmdLike']) {
      expect(ctx).toHaveProperty(k);
    }
  });

  it('包含 P0 新增字段', () => {
    const ctx = createContext({ bridge: fakeBridge(), audit: fakeAudit(), command: 'get', taskId: 't1' });
    expect(ctx.logger).toBeTruthy();
    expect(typeof ctx.logger.info).toBe('function');
    expect(ctx.taskId).toBe('t1');
    expect(ctx.profileId).toBe(DEFAULT_PROFILE);
    expect(ctx.signal).toBeNull();
    expect(ctx.events).toBeNull();
  });

  it('logger 带上命令与任务上下文', () => {
    const sink = loggerModule.collectorSink();
    loggerModule.configure({ sinks: [sink], level: 'debug' });
    const ctx = createContext({ bridge: fakeBridge(), audit: fakeAudit(), command: 'post', taskId: 't7', profileId: 'acc1' });
    ctx.logger.info('hi');
    expect(sink.records[0].context).toEqual({ profileId: 'acc1', command: 'post', taskId: 't7' });
  });

  it('signal 与 events 可注入（供 GUI 做取消与进度）', () => {
    const ac = new AbortController();
    const events = { on: () => {} };
    const ctx = createContext({ bridge: fakeBridge(), audit: fakeAudit(), signal: ac.signal, events });
    expect(ctx.signal).toBe(ac.signal);
    expect(ctx.events).toBe(events);
  });
});

describe('context: bridgeCall / loggedCall', () => {
  it('bridgeCall 成功时返回 value', async () => {
    const ctx = createContext({ bridge: fakeBridge([{ ok: true, value: { x: 1 } }]), audit: fakeAudit() });
    await expect(ctx.bridgeCall('expr')).resolves.toEqual({ x: 1 });
  });

  it('bridgeCall 失败时抛出服务端 error 文案', async () => {
    const ctx = createContext({ bridge: fakeBridge([{ ok: false, error: '服务端说不行' }]), audit: fakeAudit() });
    await expect(ctx.bridgeCall('expr')).rejects.toThrow('服务端说不行');
  });

  it('bridgeCall 用 site 常量发起请求', async () => {
    const bridge = fakeBridge([{ ok: true, value: 1 }]);
    const ctx = createContext({ bridge, audit: fakeAudit() });
    await ctx.bridgeCall('expr');
    expect(bridge.calls[0]).toMatchObject({ site: 'douyin.com', expression: 'expr' });
  });

  it('loggedCall 成功时写审计摘要', async () => {
    const audit = fakeAudit();
    const ctx = createContext({
      bridge: fakeBridge([{ ok: true, value: { comments: [1, 2, 3], has_more: 1 } }]),
      audit,
    });
    const r = await ctx.loggedCall('/comment/list', { aweme_id: '1' }, 'expr');
    expect(r.comments).toHaveLength(3);
    expect(audit.ops.api[0]).toMatchObject({ endpoint: '/comment/list', status: 'success' });
    expect(audit.ops.api[0].sum).toMatchObject({ count: 3, has_more: 1 });
  });

  it('loggedCall 失败时写 error 审计并原样抛出', async () => {
    const audit = fakeAudit();
    const ctx = createContext({ bridge: fakeBridge([{ ok: false, error: 'boom' }]), audit });
    await expect(ctx.loggedCall('/x', {}, 'expr')).rejects.toThrow('boom');
    expect(audit.ops.api[0].status).toBe('error');
  });
});

describe('context: bindCommands', () => {
  it('绑定后 cmdXxx 转发到对应命令并透传 ctx', async () => {
    const seen = [];
    const registry = {
      get: (ctx, args) => { seen.push(['get', args, ctx]); return Promise.resolve('r-get'); },
      post: (ctx, args) => { seen.push(['post', args]); return Promise.resolve('r-post'); },
      analyze: () => Promise.resolve('r-analyze'),
      search: () => Promise.resolve('r-search'),
      like: () => Promise.resolve('r-like'),
    };
    const ctx = createContext({ bridge: fakeBridge(), audit: fakeAudit() });
    bindCommands(ctx, registry);

    await expect(ctx.cmdGet(['a', '--all'])).resolves.toBe('r-get');
    await expect(ctx.cmdPost(['b'])).resolves.toBe('r-post');
    expect(seen[0][0]).toBe('get');
    expect(seen[0][1]).toEqual(['a', '--all']);
    expect(seen[0][2]).toBe(ctx);
  });

  it('返回同一个 ctx（便于链式）', () => {
    const ctx = createContext({ bridge: fakeBridge(), audit: fakeAudit() });
    expect(bindCommands(ctx, {})).toBe(ctx);
  });
});

// ═══════════════════════════════════════════════════════════
// run-command
// ═══════════════════════════════════════════════════════════

describe('run-command: 调度', () => {
  it('listCommands 返回全部已注册命令', () => {
    const cmds = listCommands();
    expect(cmds).toContain('get');
    expect(cmds).toContain('post');
    expect(cmds).toContain('getReply');
    // 已随 D8/D13 移除的命令不应再出现
    for (const gone of ['campaign', 'download', 'browse', 'repo-info', 'factcheck', 'dashboard']) {
      expect(cmds).not.toContain(gone);
    }
  });

  it('hasCommand 判定正确', () => {
    expect(hasCommand('get')).toBe(true);
    expect(hasCommand('nope')).toBe(false);
    // 不能误判原型链上的属性
    expect(hasCommand('toString')).toBe(false);
    expect(hasCommand('constructor')).toBe(false);
  });

  it('未知命令抛出 code=UNKNOWN_COMMAND 的错误', async () => {
    await expect(runCommand({}, 'nope', [])).rejects.toMatchObject({ code: 'UNKNOWN_COMMAND' });
  });

  it('缺少 ctx 时立即抛错', async () => {
    await expect(runCommand(null, 'get', [])).rejects.toThrow(/ctx/);
  });

  it('正常命令被分发且返回值透传', async () => {
    const calls = [];
    const stub = { get: async (ctx, argv) => { calls.push(argv); return { ok: 1 }; } };
    // 直接临时替换注册表里的 get
    const registry = require('../core/commands');
    const orig = registry.get;
    registry.get = stub.get;
    try {
      await expect(runCommand({}, 'get', ['x'])).resolves.toEqual({ ok: 1 });
      expect(calls).toEqual([['x']]);
    } finally {
      registry.get = orig;
    }
  });
});

describe('run-command: describeError 文案归一化', () => {
  it('未知命令 → 附带 help 提示', () => {
    const e = new Error('未知命令: x');
    e.code = 'UNKNOWN_COMMAND';
    const lines = describeError(e);
    expect(lines[0]).toContain('未知命令');
    expect(lines[1]).toContain('help');
  });

  it('ECONNREFUSED → 提示先启动 server', () => {
    expect(describeError(new Error('connect ECONNREFUSED 127.0.0.1:19422'))).toEqual([
      '错误: Bridge Server 未启动，请先运行:',
      '  node server.js',
    ]);
  });

  it('“Bridge Server 未启动”中文文案也走同一分支', () => {
    expect(describeError(new Error('Bridge Server 未启动 (127.0.0.1:19422)'))[0]).toContain('请先运行');
  });

  it('Unauthorized → 提示检查 token', () => {
    expect(describeError(new Error('Unauthorized — 无效的 access token'))[0]).toContain('bridge.token');
  });

  it('风控 HTML 页面 → 附带登录态/风控提示', () => {
    const lines = describeError(new Error('抖音返回了 HTML 页面'));
    expect(lines[0]).toContain('HTML 页面');
    expect(lines[1]).toContain('30 分钟');
  });

  it('非 JSON 响应同样命中风控提示分支', () => {
    expect(describeError(new Error('响应不是合法 JSON')).length).toBe(2);
  });

  it('普通错误 → 单行输出', () => {
    expect(describeError(new Error('随便一个错'))).toEqual(['错误: 随便一个错']);
  });
});

describe('run-command: 审计兜底', () => {
  /** 造一个审计替身，记录 endOperation 调用 */
  function auditSpy() {
    const calls = [];
    return {
      calls,
      startOperation: () => {},
      endOperation: (...args) => calls.push(args),
      logApiCall: () => {},
      setNoLog: () => {},
      _currentOp: null,
    };
  }

  /** 临时替换命令注册表里的某个命令 */
  async function withStubCommand(name, fn, body) {
    const registry = require('../core/commands');
    const orig = registry[name];
    registry[name] = fn;
    try { return await body(); } finally { registry[name] = orig; }
  }

  it('命令抛错 → 兜底把未闭合的操作记为 error 并原样抛错', async () => {
    const audit = auditSpy();
    const ctx = { audit };
    await withStubCommand('get', async () => { throw new Error('拉到一半炸了'); }, async () => {
      await expect(runCommand(ctx, 'get', [])).rejects.toThrow('拉到一半炸了');
    });
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0][0]).toBe('error');
    expect(audit.calls[0][3]).toBe('拉到一半炸了');
  });

  it('命令正常返回 → 不触发兜底（命令自己负责收尾）', async () => {
    const audit = auditSpy();
    const ctx = { audit };
    await withStubCommand('get', async () => ({ ok: 1 }), async () => {
      await expect(runCommand(ctx, 'get', [])).resolves.toEqual({ ok: 1 });
    });
    expect(audit.calls).toHaveLength(0);
  });

  it('未知命令不触发兜底（尚未开始任何操作）', async () => {
    const audit = auditSpy();
    await expect(runCommand({ audit }, 'nope', [])).rejects.toMatchObject({ code: 'UNKNOWN_COMMAND' });
    expect(audit.calls).toHaveLength(0);
  });

  it('兜底自身出错时不掩盖原始错误', async () => {
    const audit = {
      endOperation: () => { throw new Error('审计模块也炸了'); },
    };
    await withStubCommand('get', async () => { throw new Error('原始错误'); }, async () => {
      await expect(runCommand({ audit }, 'get', [])).rejects.toThrow('原始错误');
    });
  });

  it('ctx 上没有 audit 时兜底静默跳过', async () => {
    await withStubCommand('get', async () => { throw new Error('x'); }, async () => {
      await expect(runCommand({}, 'get', [])).rejects.toThrow('x');
    });
  });

  it('closeUnclosedOperation 可独立调用（幂等，无 audit 也不抛）', () => {
    const { closeUnclosedOperation } = require('../core/runtime/run-command');
    expect(() => closeUnclosedOperation({}, new Error('x'))).not.toThrow();
    expect(() => closeUnclosedOperation(null, new Error('x'))).not.toThrow();
  });
});
