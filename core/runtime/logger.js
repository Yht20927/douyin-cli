// core/runtime/logger.js — 结构化日志（替代散落的 console.*）
//
// 为什么需要这一层
// ----------------
// 改造前 core/ 下有 127 处 console.*（67 error + 41 warn + 19 log），加上 cli.js/server.js
// 共约 146 处。它们带来两个问题：
//
//   1. **GUI 拿不到**。桌面应用需要把"正在等待 23s""已拉取第 2/5 页"这类信息显示在界面上，
//      而 console 只写到进程的 stdout/stderr。
//   2. **没有留痕**。诊断信息只进 stderr，进程一退就没了，事后无法排查。
//
// 两条通道（重要）
// ----------------
// 改造前的 console.* 其实混用了两种语义，替换时必须区分，否则会破坏 CLI 的 JSON 纯净性：
//
//   - **diagnostic**（info/warn/error/debug）：诊断信息。CLI 下走 **stderr**，
//     保证 stdout 只有命令返回的 JSON。改造前的 67 处 console.error + 41 处 console.warn
//     都是这一类，替换后输出逐字节一致。
//   - **output**（output()）：命令**有意**打到 stdout 的人类可读输出
//     （`log` / `events` / `replied` 在非 --json 模式下的文本）。这 19 处必须继续进 stdout。
//   - **progress / phase**：结构化进度，GUI 用来画进度条与倒计时；CLI 下按 diagnostic 输出。
//
// 为什么是单例而不是层层透传 ctx
// ------------------------------
// 大量调用点所在的模块（risk-control.js / memory/* / reply-engine/* / server/*）
// 根本不接收 ctx。要给它们传 logger 就得改所有函数签名。所以这里用**可配置单例**：
// 进程启动时 configure() 一次决定 sink（CLI 用 console、GUI 用 IPC、两者都加文件），
// 之后任何模块直接 require 使用即可。命令层可通过 getLogger().child({ taskId }) 派生
// 带上下文的子 logger 挂到 ctx.logger 上。

const fs = require('fs');
const path = require('path');
const paths = require('../paths');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// ═══════════════════════════════════════════════════════════
// Sink
// ═══════════════════════════════════════════════════════════

/**
 * CLI 控制台 sink —— 保持与改造前逐字节一致的输出。
 * diagnostic → stderr；output → stdout。
 */
function consoleSink() {
  return {
    name: 'console',
    write(rec) {
      // output 是命令有意打到 stdout 的人类可读文本；
      // 其余（diagnostic / phase / progress）一律 stderr，保证 stdout 只有 JSON。
      if (rec.kind === 'output') console.log(rec.msg);
      else console.error(rec.msg);
    },
  };
}

/**
 * 文件 sink —— JSON Lines 写入 app.log，带简单体积轮转。
 * 解决"诊断信息只有 stderr、进程退出即丢失"的问题。
 *
 * 实现取舍（重要）
 * ----------------
 * 这里刻意用 appendFileSync 而不是 fs.createWriteStream。
 * WriteStream 会持有打开的 fd，**使 Node 事件循环无法自然退出** —— 任何忘记
 * 调用 close() 的路径都会让 `node cli.js <cmd>` 跑完命令后卡住不退出。
 * 日志量很低（每条命令几十行），同步写的代价可以忽略，而"进程一定能退出"
 * 这个性质值钱得多。
 */
function fileSink(opts = {}) {
  const maxBytes = opts.maxBytes || 5 * 1024 * 1024;
  const keep = opts.keep || 3;
  /** 已写入字节数（惰性初始化，避免每次写都 stat） */
  let written = null;
  /** 目录准备只做一次；一旦失败就永久停用，避免每行日志都去撞同一个坏路径 */
  let prepared = false;
  let disabled = false;

  const file = () => opts.file || paths.appLogFile();

  function rotate() {
    const f = file();
    try {
      for (let i = keep - 1; i >= 1; i--) {
        const from = `${f}.${i}`;
        const to = `${f}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      if (fs.existsSync(f)) fs.renameSync(f, `${f}.1`);
    } catch (e) { /* 轮转失败不影响写日志 */ }
    written = 0;
  }

  return {
    name: 'file',
    write(rec) {
      if (disabled) return;
      const f = file();

      // 目录只准备一次。某些挂载点（实测 procfs）上 mkdirSync 会**阻塞**而不是抛错，
      // 每行日志都去撞一次会把进程冻住 —— 所以失败后直接永久停用这个 sink。
      if (!prepared) {
        prepared = true;
        try {
          paths.ensureDir(path.dirname(f));
        } catch (e) {
          disabled = true;
          return;
        }
      }

      let line;
      try {
        line = JSON.stringify(rec) + '\n';
      } catch (e) {
        return; // 循环引用等，丢弃这条
      }

      try {
        const bytes = Buffer.byteLength(line);
        if (written === null) written = fs.existsSync(f) ? fs.statSync(f).size : 0;
        if (written + bytes > maxBytes) rotate();
        fs.appendFileSync(f, line);
        written += bytes;
      } catch (e) {
        // 路径不可写等情况：静默降级，日志绝不能影响业务
        disabled = true;
      }
    },
    // 无 fd 需要释放，保留 close() 以满足 sink 接口
    close() {},
  };
}

/**
 * 内存收集 sink —— 测试用。保留最近 N 条记录。
 */
function collectorSink(opts = {}) {
  const max = opts.max || 500;
  const records = [];
  return {
    name: 'collector',
    records,
    write(rec) {
      records.push(rec);
      if (records.length > max) records.shift();
    },
    clear() { records.length = 0; },
  };
}

/**
 * 自定义 sink —— 桌面主进程用它把记录转发到渲染进程。
 * @param {(rec:object)=>void} handler
 */
function customSink(handler, name = 'custom') {
  return { name, write: handler };
}

// ═══════════════════════════════════════════════════════════
// Logger
// ═══════════════════════════════════════════════════════════

class Logger {
  /**
   * @param {object} opts
   * @param {Array} [opts.sinks]     - sink 列表
   * @param {string} [opts.level]    - 最低级别（debug/info/warn/error）
   * @param {object} [opts.context]  - 附加到每条记录的上下文（如 { taskId, command }）
   */
  constructor(opts = {}) {
    this.sinks = opts.sinks || [];
    this.level = opts.level || 'info';
    this.context = opts.context || {};
  }

  /** 派生带额外上下文的 logger（共享同一批 sink） */
  child(extraContext = {}) {
    return new Logger({
      sinks: this.sinks,
      level: this.level,
      context: { ...this.context, ...extraContext },
    });
  }

  _emit(kind, level, msg, meta) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const rec = {
      ts: new Date().toISOString(),
      level,
      kind,
      msg: String(msg ?? ''),
      meta: meta === undefined ? null : meta,
      context: Object.keys(this.context).length ? this.context : null,
    };
    for (const sink of this.sinks) {
      try { sink.write(rec); } catch (e) { /* sink 异常不得影响业务 */ }
    }
  }

  // ── 诊断：CLI 下走 stderr，绝不污染 stdout 的 JSON ──
  debug(msg, meta) { this._emit('diagnostic', 'debug', msg, meta); }
  info(msg, meta) { this._emit('diagnostic', 'info', msg, meta); }
  warn(msg, meta) { this._emit('diagnostic', 'warn', msg, meta); }
  error(msg, meta) { this._emit('diagnostic', 'error', msg, meta); }

  /** 阶段提示（"正在拉取第 2/5 页"）。CLI 下同 diagnostic */
  phase(text, meta) { this._emit('phase', 'info', text, meta); }

  /**
   * 结构化进度。GUI 用来画进度条/倒计时，CLI 下按 text 输出到 stderr。
   * @param {object} p - { taskId?, pct?, text, ...extra }
   */
  progress(p) {
    const { text = '', ...rest } = p || {};
    this._emit('progress', 'info', text, rest);
  }

  /** 有意打到 stdout 的人类可读输出（log/events/replied 的文本模式） */
  output(msg) { this._emit('output', 'info', msg, null); }

  /** 关闭 sink（进程退出前调用，确保文件 flush） */
  close() {
    for (const sink of this.sinks) {
      try { if (sink.close) sink.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

/** 默认：CLI 行为（仅 console sink） */
let _current = new Logger({ sinks: [consoleSink()] });

/** 取当前 logger。任何模块可直接用，无需 ctx */
function getLogger() { return _current; }

/**
 * 配置全局 logger。进程启动时调用一次。
 * @param {object} opts - { sinks, level, context }
 * @returns {Logger}
 */
function configure(opts = {}) {
  _current = new Logger(opts);
  return _current;
}

/** 恢复默认（测试用） */
function reset() {
  try { _current.close(); } catch (e) { /* ignore */ }
  _current = new Logger({ sinks: [consoleSink()] });
  return _current;
}

// 便捷函数：模块级直接调用，避免到处 getLogger()
const info = (msg, meta) => _current.info(msg, meta);
const warn = (msg, meta) => _current.warn(msg, meta);
const error = (msg, meta) => _current.error(msg, meta);
const debug = (msg, meta) => _current.debug(msg, meta);
const phase = (text, meta) => _current.phase(text, meta);
const progress = (p) => _current.progress(p);
const output = (msg) => _current.output(msg);

module.exports = {
  Logger,
  LEVELS,
  getLogger,
  configure,
  reset,
  // sink 工厂
  consoleSink,
  fileSink,
  collectorSink,
  customSink,
  // 便捷函数
  info,
  warn,
  error,
  debug,
  phase,
  progress,
  output,
};
