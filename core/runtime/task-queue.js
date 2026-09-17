// core/runtime/task-queue.js — 串行任务队列
//
// 为什么必须是串行的
// ------------------
// 全局规则.md §1 的第一条就是「🔴 严禁并发执行任何 CLI 命令」，理由写在 §11：
// 并发或过快间隔会触发风控（限流 / 验证码 / 封号）。改造前这条靠 agent 自觉遵守，
// 而 risk-control 的 enforceDelay 只读 events 表的 max(ts)，**进程内没有互斥** ——
// 两个并发请求可以同时通过检查。所以串行必须由队列来保证，而不是靠约定。
//
// 为什么等待要放在队列里
// --------------------
// 写操作的节奏等待最长 55 秒（单轮触顶后的冷却更长）。CLI 下阻塞无所谓，
// 但界面必须知道"还要等多久、在等什么"，并且允许取消。所以：
//   - 队列先问 PolicyEngine（快，不阻塞）→ 拿到 waitMs 与原因
//   - 把等待状态与截止时间广播出去，界面本地倒计时
//   - 等待用可中断的 sleep，取消立刻生效
//   - 真正执行命令时传 --no-throttle，避免命令内部再等一遍（双倍等待）
//
// 注意 --no-throttle 只跳过**节奏等待**，跳不过 PolicyEngine 的策略闸门 ——
// 命令入口的 assertWritable 照样会跑。

const { randomUUID } = require('crypto');

const loggerModule = require('./logger');
const { sleepAbortable, isAbortError } = require('./abort');
const { runCommand, describeError } = require('./run-command');
const { getPolicy, WRITE_COMMANDS } = require('../policy');

/** 任务记录保留上限（避免长时间运行后内存无限增长） */
const MAX_HISTORY = 200;

/**
 * 单个任务的完整结果最多保留多大（字节，JSON 序列化后）。
 *
 * 有些操作的结果必须完整回传给界面 —— 比如"生成回复"的产出就是一段文本，
 * 摘要（{kind:'object', keys:[...]}）对它毫无意义。而拉评论这种大数组则只需要
 * 计数。所以小结果留着、大结果只留摘要。
 *
 * 不放进 list() 的常规推送里：那会在每次队列变化时把结果全量过一遍 IPC，
 * 界面调用 queue.getResult(id) 按需取即可。
 */
const MAX_RESULT_BYTES = 64 * 1024;

/**
 * 创建任务队列。
 *
 * @param {object} opts
 * @param {Function} opts.createContext - (task) => ctx，由调用方提供（CLI / 桌面主进程）
 * @param {object}   [opts.policy]      - PolicyEngine，缺省用全局单例
 * @param {object}   [opts.logger]      - logger，缺省用全局单例
 * @returns {object} queue
 */
function createTaskQueue(opts = {}) {
  const policy = opts.policy || getPolicy();
  const rootLogger = opts.logger || loggerModule.getLogger();
  const createContext = opts.createContext;

  if (typeof createContext !== 'function') {
    throw new Error('createTaskQueue 需要 opts.createContext(task)');
  }

  /** @type {Array<object>} 任务记录（含历史） */
  const tasks = [];
  const byId = new Map();

  const listeners = new Set();
  /** 队列是否正在跑 */
  let draining = false;
  /** 是否已请求停止（停止后不再取新任务，正在跑的那个会跑完） */
  let stopping = false;

  function emit(event = 'change') {
    const snapshot = list();
    for (const fn of listeners) {
      try {
        fn({ event, tasks: snapshot, stats: stats() });
      } catch (e) {
        // 隔离监听方异常，但必须留痕 —— 静默 catch 会把编程错误一起藏起来
        rootLogger.warn('[queue] 监听回调出错: ' + e.message);
      }
    }
  }

  /** 对外暴露的任务视图（去掉内部字段） */
  function view(t) {
    const now = Date.now();
    return {
      id: t.id,
      command: t.command,
      argv: t.argv,
      label: t.label,
      status: t.status,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      error: t.error,
      blockers: t.blockers,
      warnings: t.warnings,
      progress: t.progress,
      resultSummary: t.resultSummary,
      // 等待信息：给界面本地倒计时用（不必每秒推一次 IPC）
      wait: t.wait ? { ...t.wait, remainingMs: Math.max(0, t.wait.until - now) } : null,
    };
  }

  function list() {
    return tasks.map(view);
  }

  function get(taskId) {
    const t = byId.get(taskId);
    return t ? view(t) : null;
  }

  function stats() {
    const counts = { pending: 0, running: 0, waiting: 0, done: 0, failed: 0, cancelled: 0, blocked: 0 };
    for (const t of tasks) {
      if (counts[t.status] !== undefined) counts[t.status] += 1;
    }
    const current = tasks.find(t => t.status === 'running' || t.status === 'waiting') || null;
    return {
      counts,
      total: tasks.length,
      currentId: current ? current.id : null,
      /** 队列是否空闲（没有待执行也没有在跑） */
      idle: !draining && counts.pending === 0 && counts.running === 0 && counts.waiting === 0,
      serial: true,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // 入队 / 取消
  // ═══════════════════════════════════════════════════════════

  /**
   * 入队一个命令。
   *
   * @param {object} spec
   * @param {string} spec.command - 命令名
   * @param {string[]} [spec.argv] - 参数（不含命令名）
   * @param {string} [spec.label]  - 界面上显示的名字，缺省用命令名
   * @param {object} [spec.meta]   - 传给 PolicyEngine 的上下文（uid / awemeId / cid / text）
   * @returns {string} taskId
   */
  function enqueue(spec = {}) {
    if (!spec.command) throw new Error('enqueue 需要 command');
    const task = {
      id: randomUUID(),
      command: spec.command,
      argv: Array.isArray(spec.argv) ? spec.argv.slice() : [],
      label: spec.label || spec.command,
      meta: spec.meta || {},
      status: 'pending',
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      error: null,
      blockers: [],
      warnings: [],
      progress: null,
      resultSummary: null,
      wait: null,
      _abort: null,
    };

    tasks.push(task);
    byId.set(task.id, task);
    // 历史裁剪：只保留最近 MAX_HISTORY 条**已结束**的任务
    pruneHistory();

    rootLogger.info(`[queue] 入队 ${task.label}（${task.command}）`);
    emit('enqueued');
    drain();
    return task.id;
  }

  function pruneHistory() {
    if (tasks.length <= MAX_HISTORY) return;
    const finished = t => ['done', 'failed', 'cancelled', 'blocked'].includes(t.status);
    for (let i = 0; i < tasks.length && tasks.length > MAX_HISTORY; i++) {
      if (finished(tasks[i])) {
        byId.delete(tasks[i].id);
        tasks.splice(i, 1);
        i--;
      }
    }
  }

  /**
   * 取消一个任务。排队中的直接移除；正在等/正在跑的会中断。
   * @returns {boolean} 是否确实取消了什么
   */
  function cancel(taskId) {
    const t = byId.get(taskId);
    if (!t) return false;
    if (t.status === 'done' || t.status === 'failed' || t.status === 'cancelled') return false;

    if (t.status === 'pending') {
      t.status = 'cancelled';
      t.endedAt = Date.now();
      t.error = '已取消（尚未开始）';
    } else {
      t.status = 'cancelled';
      t.endedAt = Date.now();
      t.error = '已取消';
      if (t._abort) t._abort.abort();
    }
    t.wait = null;
    emit('cancelled');
    return true;
  }

  /** 取消所有尚未开始的任务 */
  function cancelPending() {
    let n = 0;
    for (const t of tasks) {
      if (t.status === 'pending') { cancel(t.id); n++; }
    }
    return n;
  }

  // ═══════════════════════════════════════════════════════════
  // 执行
  // ═══════════════════════════════════════════════════════════

  function drain() {
    if (draining || stopping) return;
    draining = true;
    setImmediate(() => {
      loop().catch((e) => {
        rootLogger.error('[queue] 队列循环异常终止: ' + e.message);
        draining = false;
      });
    });
  }

  async function loop() {
    try {
      for (;;) {
        if (stopping) break;
        const next = tasks.find(t => t.status === 'pending');
        if (!next) break;
        await runTask(next);
      }
    } finally {
      draining = false;
      emit('idle');
    }
  }

  async function runTask(task) {
    const ac = new AbortController();
    task._abort = ac;
    task.startedAt = Date.now();
    task.status = 'running';
    emit('started');

    const isWrite = WRITE_COMMANDS.includes(task.command);

    // ── ① 策略判定与节奏等待（只有写操作需要）──
    if (isWrite) {
      const ok = await awaitTurn(task, ac.signal);
      if (!ok) return; // 状态已被 awaitTurn 设置好
    }

    // ── ② 真正执行 ──
    // 写操作补 --no-throttle：节奏已由队列统一安排，命令内部不必再等一遍。
    // 这只跳过等待，跳不过命令入口的 policy.assertWritable。
    const argv = task.argv.slice();
    if (isWrite && !argv.includes('--no-throttle')) argv.push('--no-throttle');

    // 进度捕获：给这个任务挂一个临时 sink，命令里的 logger.progress 会落到 task.progress
    const progressSink = {
      name: 'task-progress',
      write(rec) {
        if (rec.kind === 'progress') {
          task.progress = { text: rec.msg, ...(rec.meta || {}) };
        } else if (rec.kind === 'phase') {
          task.progress = { text: rec.msg, phase: true };
        }
      },
    };

    try {
      const ctx = createContext(task, { signal: ac.signal, extraSinks: [progressSink] });
      const result = await runCommand(ctx, task.command, argv);
      if (task.status === 'cancelled') return; // 执行期间被取消

      task.status = 'done';
      task.endedAt = Date.now();
      task.progress = null;
      task.resultSummary = summarizeResult(result);
      task.result = keepResult(result);

      if (isWrite) policy.afterWrite({ ok: true });
      rootLogger.info(`[queue] 完成 ${task.label}（${task.endedAt - task.startedAt}ms）`);
    } catch (e) {
      task.endedAt = Date.now();
      task.progress = null;
      const cancelled = isAbortError(e) || task.status === 'cancelled';
      task.status = cancelled ? 'cancelled' : 'failed';
      // 用与人读提示一致的说法，界面不必再翻译一遍
      task.error = cancelled ? '已取消' : describeError(e).join(' ');

      if (isWrite && !cancelled) policy.afterWrite({ ok: false, error: e.message });
      if (!cancelled) rootLogger.error(`[queue] 失败 ${task.label}: ${e.message}`);
    } finally {
      task._abort = null;
      task.wait = null;
      emit('finished');
    }
  }

  /**
   * 等到"可以写"的时刻。可能经历多次等待（策略随时间变化）。
   * @returns {Promise<boolean>} true=放行；false=已被拦下或取消（状态已写好）
   */
  async function awaitTurn(task, signal) {
    // 最多重试若干轮，防止策略反复要求等待导致死循环
    for (let round = 0; round < 20; round++) {
      const check = policy.beforeWrite(task.meta || {});
      task.warnings = check.warnings || [];

      if (!check.ok) {
        task.status = 'blocked';
        task.endedAt = Date.now();
        task.blockers = check.hardBlockers.map(b => ({ reason: b.reason, action: b.action }));
        task.error = check.hardBlockers.map(b => b.reason).join('；');
        rootLogger.warn(`[queue] 拦下 ${task.label}: ${task.error}`);
        return false;
      }

      if (check.waitMs <= 0) return true;

      // 上报等待：界面据此本地倒计时，不必每秒推 IPC
      const reason = (check.blockers.find(b => b.action === 'wait') || {}).reason
        || `节奏等待 ${Math.ceil(check.waitMs / 1000)}s`;
      task.status = 'waiting';
      task.wait = { until: Date.now() + check.waitMs, reason, waitMs: check.waitMs };
      emit('waiting');
      rootLogger.info(`[queue] ${task.label} 等待 ${Math.ceil(check.waitMs / 1000)}s：${reason}`);

      try {
        await sleepAbortable(check.waitMs, signal);
      } catch (e) {
        if (isAbortError(e)) {
          task.status = 'cancelled';
          task.endedAt = Date.now();
          task.error = '已取消';
          return false;
        }
        throw e;
      }
      task.status = 'running';
      task.wait = null;
      emit('resumed');
    }

    task.status = 'blocked';
    task.endedAt = Date.now();
    task.error = '等待轮次过多，已放弃（策略反复要求等待）';
    return false;
  }

  /** 给界面用的结果摘要 —— 不把大数组塞进常规推送 */
  function summarizeResult(result) {
    if (result === undefined || result === null) return null;
    if (Array.isArray(result)) return { kind: 'array', count: result.length };
    if (typeof result === 'object') {
      const keys = Object.keys(result);
      return { kind: 'object', keys: keys.slice(0, 12) };
    }
    return { kind: typeof result, value: String(result).slice(0, 200) };
  }

  /**
   * 决定是否为这个任务保留完整结果。
   * 序列化不了或太大的都不留 —— 留着既占内存又会拖慢 IPC。
   */
  function keepResult(result) {
    if (result === undefined || result === null) return null;
    if (typeof result === 'function' || typeof result === 'symbol') return null;
    try {
      const s = JSON.stringify(result);
      if (s === undefined) return null;
      if (Buffer.byteLength(s) > MAX_RESULT_BYTES) return null;
      // 过一遍序列化再存，确保能安全地经 IPC 传出去（structured clone）
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }

  /**
   * 取某个任务的完整结果（按需调用，不随常规推送走）。
   * 结果过大或不可序列化时返回 null，此时只能用 resultSummary。
   */
  function getResult(taskId) {
    const t = byId.get(taskId);
    return t && t.result !== undefined ? t.result : null;
  }

  return {
    enqueue,
    cancel,
    cancelPending,
    list,
    get,
    getResult,
    stats,
    /** 订阅队列变化，返回取消订阅函数 */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** 停止取新任务（正在跑的会跑完） */
    stop() {
      stopping = true;
      return cancelPending();
    },
    /** 恢复取任务 */
    start() {
      stopping = false;
      drain();
    },
  };
}

module.exports = { createTaskQueue, MAX_HISTORY };
