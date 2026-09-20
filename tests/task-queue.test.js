// tests/task-queue.test.js — 串行任务队列
//
// 队列存在的首要理由是运营规则里「严禁并发执行任何命令」那一条（运营规则说明.md §1）。
// 改造前这条靠自觉，而 enforceDelay 进程内没有互斥 —— 并发请求能同时通过。
// 所以这里最重要的断言是：**任何时刻只有一个任务在跑**。

const fs = require('fs');
const path = require('path');
const os = require('os');

const { createTaskQueue } = require('../core/runtime/task-queue');
const { createPolicyEngine } = require('../core/policy');
const { createContext, bindCommands } = require('../core/runtime/context');
const config = require('../core/config');

const ENV_KEYS = ['DOUYIN_STORAGE_DIR', 'DOUYIN_LOG_DIR', 'DOUYIN_CONFIG'];

function withTempEnv(cfg, fn) {
  return async () => {
    const saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-queue-'));
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    process.env.DOUYIN_LOG_DIR = path.join(tmp, 'logs');
    const cfgFile = path.join(tmp, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify(cfg || {}));
    process.env.DOUYIN_CONFIG = cfgFile;
    delete process.env.DOUYIN_NO_THROTTLE;  // 本文件要验证节奏逻辑本身
    config.reset();

    const purge = () => {
      for (const m of ['../core/memory/db', '../core/memory/events']) {
        delete require.cache[require.resolve(m)];
      }
    };
    purge();

    try {
      await fn({ tmp, cfgFile });
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

/** 临时替换命令注册表里的某个命令，测试后恢复 */
async function withStub(name, fn, body) {
  const registry = require('../core/commands');
  const orig = registry[name];
  registry[name] = fn;
  try { return await body(); } finally { registry[name] = orig; }
}

/**
 * 造一个队列。ctx 由这里提供 —— 与桌面主进程同构：
 * 带上 signal 与任务级 logger。
 */
function makeQueue(opts = {}) {
  const policy = opts.policy || createPolicyEngine({});
  const created = [];
  const queue = createTaskQueue({
    policy,
    createContext: (task, o = {}) => {
      const ctx = createContext({
        bridge: { async call() { return { ok: true, value: null }; } },
        audit: { startOperation() {}, endOperation() {}, logApiCall() {}, setNoLog() {}, _currentOp: null },
        command: task.command,
        taskId: task.id,
        signal: o.signal,
        extraSinks: o.extraSinks || [],
      });
      bindCommands(ctx, require('../core/commands'));
      created.push(ctx);
      return ctx;
    },
  });
  queue._contexts = created;
  return queue;
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** 等到队列空闲（或超时） */
async function waitIdle(queue, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!queue.stats().idle) {
    if (Date.now() - t0 > timeoutMs) throw new Error('等待队列空闲超时');
    await wait(10);
  }
}

describe('串行执行（核心不变量）', () => {
  it('同时入队多个任务，任何时刻只有一个在跑', withTempEnv({}, async () => {
    const queue = makeQueue();
    let concurrent = 0;
    let maxConcurrent = 0;
    const order = [];

    await withStub('get', async (ctx, argv) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push(argv[0]);
      await wait(30);           // 故意给并发留出窗口
      concurrent--;
      return { ok: argv[0] };
    }, async () => {
      queue.enqueue({ command: 'get', argv: ['a'] });
      queue.enqueue({ command: 'get', argv: ['b'] });
      queue.enqueue({ command: 'get', argv: ['c'] });
      await waitIdle(queue);
    });

    expect(maxConcurrent).toBe(1);
    expect(order).toEqual(['a', 'b', 'c']);   // 严格按入队顺序
  }));

  it('入队顺序即执行顺序', withTempEnv({}, async () => {
    const queue = makeQueue();
    const order = [];
    await withStub('get', async (ctx, argv) => { order.push(argv[0]); }, async () => {
      for (const id of ['1', '2', '3', '4', '5']) queue.enqueue({ command: 'get', argv: [id] });
      await waitIdle(queue);
    });
    expect(order).toEqual(['1', '2', '3', '4', '5']);
  }));
});

describe('任务状态', () => {
  it('成功 → done，并带上耗时', withTempEnv({}, async () => {
    const queue = makeQueue();
    await withStub('get', async () => ({ n: 1 }), async () => {
      const id = queue.enqueue({ command: 'get', argv: ['x'], label: '测试任务' });
      await waitIdle(queue);
      const t = queue.get(id);
      expect(t.status).toBe('done');
      expect(t.endedAt).toBeGreaterThanOrEqual(t.startedAt);
      expect(t.label).toBe('测试任务');
    });
  }));

  it('失败 → failed，错误文案与 CLI 一致（不必界面再翻译）', withTempEnv({}, async () => {
    const queue = makeQueue();
    await withStub('get', async () => { throw new Error('Bridge Server 未启动 (127.0.0.1:19422)'); }, async () => {
      const id = queue.enqueue({ command: 'get', argv: ['x'] });
      await waitIdle(queue);
      const t = queue.get(id);
      expect(t.status).toBe('failed');
      expect(t.error).toContain('Bridge Server 未启动');
    });
  }));

  it('未知命令 → failed，且不卡住队列', withTempEnv({}, async () => {
    const queue = makeQueue();
    queue.enqueue({ command: 'nonexistent', argv: [] });
    await waitIdle(queue);
    const t = queue.list()[0];
    expect(t.status).toBe('failed');
    expect(t.error).toContain('未知命令');
  }));

  it('结果摘要不把大数组塞进队列状态', withTempEnv({}, async () => {
    const queue = makeQueue();
    await withStub('get', async () => Array.from({ length: 500 }, (_, i) => ({ i })), async () => {
      const id = queue.enqueue({ command: 'get', argv: ['x'] });
      await waitIdle(queue);
      const t = queue.get(id);
      expect(t.resultSummary).toEqual({ kind: 'array', count: 500 });
    });
  }));
});

describe('取消', () => {
  it('取消排队中的任务 → 不会被执行', withTempEnv({}, async () => {
    const queue = makeQueue();
    const ran = [];
    await withStub('get', async (ctx, argv) => { ran.push(argv[0]); await wait(20); }, async () => {
      queue.enqueue({ command: 'get', argv: ['first'] });
      const second = queue.enqueue({ command: 'get', argv: ['second'] });
      queue.cancel(second);
      await waitIdle(queue);
    });
    expect(ran).toEqual(['first']);
    expect(queue.list().find(t => t.argv[0] === 'second').status).toBe('cancelled');
  }));

  it('取消正在等待中的写任务 → 立刻中断，不等满', withTempEnv({
    policy: { dailyWriteQuota: 100 },
  }, async ({ }) => {
    const events = require('../core/memory/events');
    // 造一条刚发生的写记录 → 下一次写必须等 40-55 秒
    events.append({ ts: Date.now(), command: 'post', status: 'success' });

    const queue = makeQueue();
    const ran = [];
    await withStub('post', async (ctx, argv) => { ran.push(argv); }, async () => {
      const id = queue.enqueue({ command: 'post', argv: ['v1', '这是一条合规的回复内容'], meta: {} });
      await wait(120);
      expect(queue.get(id).status).toBe('waiting');
      expect(queue.get(id).wait.remainingMs).toBeGreaterThan(0);

      const t0 = Date.now();
      queue.cancel(id);
      await waitIdle(queue);
      expect(Date.now() - t0).toBeLessThan(1000);  // 立刻返回而非等满 40 秒
      expect(queue.get(id).status).toBe('cancelled');
    });
    expect(ran).toEqual([]);  // 被取消的任务绝不执行
  }));

  it('取消已结束的任务返回 false', withTempEnv({}, async () => {
    const queue = makeQueue();
    await withStub('get', async () => null, async () => {
      const id = queue.enqueue({ command: 'get', argv: ['x'] });
      await waitIdle(queue);
      expect(queue.cancel(id)).toBe(false);
    });
  }));

  it('cancelPending 清空尚未开始的任务', withTempEnv({}, async () => {
    const queue = makeQueue();
    await withStub('get', async () => { await wait(30); }, async () => {
      queue.enqueue({ command: 'get', argv: ['1'] });
      queue.enqueue({ command: 'get', argv: ['2'] });
      queue.enqueue({ command: 'get', argv: ['3'] });
      await wait(10);
      expect(queue.cancelPending()).toBe(2);
      await waitIdle(queue);
    });
    expect(queue.stats().counts.cancelled).toBe(2);
  }));
});

describe('写操作：策略闸门与节奏等待', () => {
  it('策略不允许时 → blocked，且不执行命令', withTempEnv({
    policy: { dailyWriteQuota: 1 },
  }, async () => {
    const events = require('../core/memory/events');
    events.append({ ts: Date.now(), command: 'post', status: 'success' });

    const queue = makeQueue();
    let ran = false;
    await withStub('post', async () => { ran = true; }, async () => {
      const id = queue.enqueue({ command: 'post', argv: ['v1', '这是一条合规的回复内容'] });
      await waitIdle(queue);
      const t = queue.get(id);
      expect(t.status).toBe('blocked');
      expect(t.error).toContain('上限');
      expect(t.blockers.length).toBeGreaterThan(0);
      expect(t.blockers[0].action).toBe('stop');
    });
    expect(ran).toBe(false);
  }));

  it('需要节奏等待时 → waiting，并给出截止时间与原因', withTempEnv({
    policy: { dailyWriteQuota: 100 },
  }, async () => {
    const events = require('../core/memory/events');
    events.append({ ts: Date.now(), command: 'post', status: 'success' });

    const queue = makeQueue();
    const seen = [];
    queue.subscribe((e) => seen.push(e.event));

    await withStub('post', async () => ({ cid: 'new' }), async () => {
      const id = queue.enqueue({ command: 'post', argv: ['v1', '这是一条合规的回复内容'] });
      await wait(150);
      const t = queue.get(id);
      expect(t.status).toBe('waiting');
      expect(t.wait.reason).toBeTruthy();
      expect(t.wait.until).toBeGreaterThan(Date.now());
      queue.cancel(id);
      await waitIdle(queue);
    });

    expect(seen).toContain('waiting');
  }));

  it('写操作会自动补 --no-throttle（避免命令内部再等一遍）', withTempEnv({
    policy: { dailyWriteQuota: 100 },
  }, async () => {
    const queue = makeQueue();
    let gotArgv = null;
    await withStub('post', async (ctx, argv) => { gotArgv = argv; }, async () => {
      queue.enqueue({ command: 'post', argv: ['v1', '这是一条合规的回复内容'] });
      await waitIdle(queue);
    });
    expect(gotArgv).toContain('--no-throttle');
  }));

  it('读操作不等待、不加 --no-throttle', withTempEnv({}, async () => {
    const queue = makeQueue();
    let gotArgv = null;
    await withStub('get', async (ctx, argv) => { gotArgv = argv; }, async () => {
      queue.enqueue({ command: 'get', argv: ['v1'] });
      await waitIdle(queue);
    });
    expect(gotArgv).toEqual(['v1']);
  }));
});

describe('进度捕获', () => {
  it('命令里的 logger.progress 会落到该任务的 progress 字段', withTempEnv({}, async () => {
    const queue = makeQueue();
    await withStub('get', async (ctx) => {
      ctx.logger.progress({ pct: 40, text: '正在拉取第 2/5 页' });
      await wait(20);
      return null;
    }, async () => {
      const id = queue.enqueue({ command: 'get', argv: ['x'] });
      await wait(10);
      expect(queue.get(id).progress).toMatchObject({ text: '正在拉取第 2/5 页', pct: 40 });
      await waitIdle(queue);
    });
  }));

  // 只把进度写进 task.progress 是不够的：渲染层靠 queue:changed 推送才看得见。
  // 曾经这里只赋值不 emit，于是**任何不经过 enforceDelay 的长循环**（全量拉取翻页就是）
  // 界面上的进度条会整个冻住，直到任务结束才跳到 100% —— 而批量生成因为顺带搭了
  // 每次"等间隔"时 waiting/resumed 事件的便车，看起来是正常的，把这个问题盖住了。
  it('进度更新会推给订阅者（不只在任务边界推）', withTempEnv({}, async () => {
    const queue = makeQueue();
    const events = [];
    queue.subscribe((p) => events.push(p));
    await withStub('get', async (ctx) => {
      ctx.logger.progress({ text: '第 1 页' });
      await wait(20);
      ctx.logger.progress({ text: '第 2 页' });
      await wait(20);
      return null;
    }, async () => {
      queue.enqueue({ command: 'get', argv: ['x'] });
      await waitIdle(queue);
    });

    const texts = events.map(e => (e.tasks.find(t => t.command === 'get') || {}).progress)
      .filter(Boolean).map(p => p.text);
    // 两次进度都得被推出来，而且第 1 页要在第 2 页之前 —— 顺序反了说明是结束时才补推的
    expect(texts).toContain('第 1 页');
    expect(texts.indexOf('第 1 页')).toBeLessThan(texts.indexOf('第 2 页'));
  }));

  it('任务结束后清掉进度（不残留过期信息）', withTempEnv({}, async () => {
    const queue = makeQueue();
    await withStub('get', async (ctx) => {
      ctx.logger.progress({ text: '进行中' });
      return null;
    }, async () => {
      const id = queue.enqueue({ command: 'get', argv: ['x'] });
      await waitIdle(queue);
      expect(queue.get(id).progress).toBeNull();
    });
  }));
});

describe('订阅与统计', () => {
  it('订阅者收到队列事件，且监听回调抛错不影响队列', withTempEnv({}, async () => {
    const queue = makeQueue();
    const events = [];
    queue.subscribe((e) => { events.push(e.event); throw new Error('监听方炸了'); });

    await withStub('get', async () => null, async () => {
      queue.enqueue({ command: 'get', argv: ['x'] });
      await waitIdle(queue);
    });

    expect(events).toContain('enqueued');
    expect(events).toContain('finished');
    expect(queue.stats().idle).toBe(true);   // 队列没被监听方拖垮
  }));

  it('stats 给出各状态计数与当前任务', withTempEnv({}, async () => {
    const queue = makeQueue();
    await withStub('get', async () => { await wait(30); }, async () => {
      queue.enqueue({ command: 'get', argv: ['1'] });
      await wait(5);
      const s = queue.stats();
      expect(s.counts.running + s.counts.waiting).toBe(1);
      expect(s.currentId).toBeTruthy();
      expect(s.serial).toBe(true);
      await waitIdle(queue);
    });
    expect(queue.stats().counts.done).toBe(1);
  }));

  it('历史只保留最近若干条（避免长跑后内存无界增长）', withTempEnv({}, async () => {
    const queue = makeQueue();
    await withStub('get', async () => null, async () => {
      for (let i = 0; i < 30; i++) queue.enqueue({ command: 'get', argv: [String(i)] });
      await waitIdle(queue, 15000);
    });
    // 上限 200，这里只放 30 条，应全部保留
    expect(queue.list()).toHaveLength(30);
  }));
});

describe('停止与恢复', () => {
  it('stop() 后不再取新任务，已入队的不执行', withTempEnv({}, async () => {
    const queue = makeQueue();
    const ran = [];
    await withStub('get', async (ctx, argv) => { ran.push(argv[0]); await wait(30); }, async () => {
      queue.enqueue({ command: 'get', argv: ['1'] });
      await wait(5);
      queue.stop();
      queue.enqueue({ command: 'get', argv: ['2'] });
      await wait(150);
    });
    expect(ran).not.toContain('2');
  }));

  it('start() 恢复后继续执行', withTempEnv({}, async () => {
    const queue = makeQueue();
    const ran = [];
    await withStub('get', async (ctx, argv) => { ran.push(argv[0]); }, async () => {
      queue.stop();
      queue.enqueue({ command: 'get', argv: ['1'] });
      await wait(50);
      expect(ran).toEqual([]);

      queue.start();
      await waitIdle(queue);
    });
    expect(ran).toEqual(['1']);
  }));
});

// ═══════════════════════════════════════════════════════════
// front 插队：批量生成要跑十几分钟，紧急发布不该排在它后面。
// 风控上无额外代价（生成是读+LLM；写间隔闸门在执行时照常生效）。
// ═══════════════════════════════════════════════════════════
describe('task-queue: front 插队', withTempEnv({}, () => it('front 任务插到所有 pending 之前执行', async () => {
  const queue = makeQueue();
  const ran = [];
  await withStub('get', async (ctx, argv) => {
    // 第一个任务故意跑得慢，制造"有任务正在 running"的场景
    if (argv[0] === 'slow') await wait(300);
    ran.push(argv[0]);
  }, async () => {
    queue.enqueue({ command: 'get', argv: ['slow'] });
    queue.enqueue({ command: 'get', argv: ['normal-1'] });
    queue.enqueue({ command: 'get', argv: ['normal-2'] });
    // 等 slow 真正进入 running —— 插队不允许越过正在跑的任务
    await wait(60);
    queue.enqueue({ command: 'get', argv: ['urgent'], front: true });
    await waitIdle(queue);
  });
  expect(ran).toEqual(['slow', 'urgent', 'normal-1', 'normal-2']);
})));

// ═══════════════════════════════════════════════════════════
// 写操作的识别
//
// 回归背景：命令注册表里叫 `delete-comment`（连字符），而 events 表与
// policy 的写操作族用的是 `delete_comment`（下划线）。队列此前用
// `WRITE_COMMANDS.includes(task.command)` 判定，对删除**恒为 false** ——
// 于是删除不走轮次闸门、也不补 --no-throttle，它的等待跑到了命令内部，
// 与其他写操作不再协调（两个写操作可能几乎同时发出去）。
//
// 这里断言的是**行为**（argv 里有没有那个参数），而不是直接测辅助函数 ——
// 后者只证明函数对，证明不了队列真的用了它。
// ═══════════════════════════════════════════════════════════
describe('写操作的识别', () => {
  it('delete-comment 被当成写操作（补 --no-throttle）', withTempEnv({}, async () => {
    let seen = null;
    await withStub('delete-comment', async (ctx, argv) => { seen = argv.slice(); }, async () => {
      const queue = makeQueue();
      queue.enqueue({ command: 'delete-comment', argv: ['cid1'] });
      await waitIdle(queue);
    });
    // 只有认成写操作时队列才会补这个参数（节奏由队列统一安排，命令内不必再等）
    expect(seen).toEqual(['cid1', '--no-throttle']);
  }));

  it('读操作不补 --no-throttle（别把判定放宽成"全都算写"）', withTempEnv({}, async () => {
    let seen = null;
    await withStub('get', async (ctx, argv) => { seen = argv.slice(); }, async () => {
      const queue = makeQueue();
      queue.enqueue({ command: 'get', argv: ['v1'] });
      await waitIdle(queue);
    });
    expect(seen).toEqual(['v1']);
  }));
});
