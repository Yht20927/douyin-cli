// core/memory/sqlite-driver.js — SQLite 驱动适配层
//
// 为什么要换掉 better-sqlite3
// --------------------------
// better-sqlite3 是原生模块，ABI 必须与运行时匹配。Node 与 Electron 的 ABI 不同：
//
//   Node v24    ABI 137
//   Electron 40 ABI 143
//
// 结果是在 Node 下跑 CLI 一切正常，桌面应用里 `require('better-sqlite3')` 直接失败，
// 于是**所有读本地数据的页面全是空的** —— 而且 db.js 把异常吞掉了，应用不崩、
// 只是静默显示为空，极难定位。
//
// 换到 node:sqlite（Node 22.5+ 内置）之后：
//   - 同一个运行时内置，**不存在 ABI 问题**
//   - CLI 与桌面应用走完全相同的代码路径（行为分叉正是上面那个 bug 的根源）
//   - 打包时不再需要重编译原生模块，Windows 上也不需要 VS Build Tools
//
// 本层把 node:sqlite 包装成 better-sqlite3 的调用形状，其余代码一行不用改。
//
// 两处需要抹平的差异
// ------------------
//   1. better-sqlite3 把 undefined 当作 NULL 绑定；node:sqlite 直接抛
//      TypeError: Provided value cannot be bound。所有参数统一过一遍 sanitize。
//   2. node:sqlite 没有 pragma() 与 transaction() 方法，在这里补上。
//
// 一处刻意保留的差异（不抹平）
// --------------------------
//   整数超过 Number.MAX_SAFE_INTEGER 时，better-sqlite3 会静默返回一个**丢失精度**
//   的 number，而 node:sqlite 直接抛 RangeError。**让它抛更好** —— 静默取整才是灾难。
//   本项目的 schema 里所有大 ID（aweme_id / cid / uid）都是 TEXT，
//   INTEGER 列只有时间戳与计数，正常情况下不会触发。

const { DatabaseSync } = require('node:sqlite');

/**
 * 把 undefined 转成 null。
 * better-sqlite3 允许绑定 undefined（当 NULL），node:sqlite 会抛错。
 * 逐个参数过一遍，而不是只处理顶层 —— 命名参数与位置参数都要覆盖。
 */
function sanitizeParams(params) {
  if (params === undefined) return undefined;
  if (params === null) return null;
  if (Array.isArray(params)) {
    return params.map(v => (v === undefined ? null : (v instanceof Date ? v.toISOString() : v)));
  }
  if (typeof params === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(params)) {
      out[k] = v === undefined ? null : (v instanceof Date ? v.toISOString() : v);
    }
    return out;
  }
  return params;
}

/** 一条语句的包装：只暴露 better-sqlite3 用到的那些方法 */
class Statement {
  constructor(stmt) {
    this._stmt = stmt;
  }

  /**
   * 调用底层的 run/get/all。两个坑都在这里抹平：
   *
   * 1) **无参数时必须一个都不传**。`stmt.get(undefined)` 在 better-sqlite3 里
   *    等于不传参，而 node:sqlite 会把那个 undefined 当成"要绑定的第 1 个参数"，
   *    直接抛 Provided value cannot be bound —— 所有 count() 之类的无参查询
   *    会全数失败，且报错完全指不到真正的原因。
   *
   * 2) **必须支持不定参数**。原代码大量使用 `stmt.get(a, b)` 这种写法，
   *    首版包装成了 `get(params)` 只接一个参数，第二个起被静默丢弃，
   *    表现为"库里明明有 7 行，按条件查却是 0 行"。
   */
  _invoke(method, args) {
    if (args.length === 0) return this._stmt[method]();
    if (args.length === 1) {
      const p = sanitizeParams(args[0]);
      return p === undefined ? this._stmt[method]() : this._stmt[method](p);
    }
    return this._stmt[method](...args.map(v => (v === undefined ? null : v)));
  }

  run(...args) { return this._invoke('run', args); }

  /** node:sqlite 的 get() 没有行时返回 undefined；better-sqlite3 同样 */
  get(...args) { return this._invoke('get', args); }

  all(...args) { return this._invoke('all', args); }

  /** better-sqlite3 的 iterate() 用法极少，这里用数组实现保底 */
  iterate(...args) {
    return this.all(...args)[Symbol.iterator]();
  }
}

class Database {
  constructor(file) {
    // node:sqlite 的 DatabaseSync 不接受 undefined 作为路径
    this._db = new DatabaseSync(file);
  }

  prepare(sql) {
    return new Statement(this._db.prepare(sql));
  }

  exec(sql) {
    return this._db.exec(sql);
  }

  /**
   * 读取或设置 PRAGMA。
   *
   * 用法与 better-sqlite3 一致：
   *   db.pragma('journal_mode = WAL')         设置（返回值忽略）
   *   db.pragma('user_version', {simple:true}) 读取标量
   *
   * 注意 node:sqlite 对不同 PRAGMA 的返回行形状不一致：`synchronous`/`foreign_keys`
   * 这类纯设置项没有返回行，`busy_timeout` 的列名是 timeout 而不是 busy_timeout。
   * 所以统一用 all() 取，再按需要抽第一列的值。
   */
  pragma(str, opts = {}) {
    const rows = this._db.prepare(`PRAGMA ${str}`).all();
    if (!rows || rows.length === 0) return undefined;
    const row = rows[0];
    if (opts.simple) {
      const keys = Object.keys(row);
      return keys.length ? row[keys[0]] : undefined;
    }
    return row;
  }

  /**
   * 事务包装。返回一个函数，调用它时在事务里执行。
   *
   * 用 SAVEPOINT 而不是裸 BEGIN：原项目的迁移与批量 upsert 存在嵌套调用
   * （migrate 里的 applyAll 事务内又跑 stmt），外层 BEGIN 嵌套会直接报错。
   * SAVEPOINT 支持嵌套，语义也更安全。
   */
  transaction(fn) {
    return (...args) => {
      const name = `sp_${Math.random().toString(36).slice(2, 10)}`;
      this._db.exec(`SAVEPOINT ${name}`);
      try {
        const out = fn(...args);
        this._db.exec(`RELEASE ${name}`);
        return out;
      } catch (e) {
        try { this._db.exec(`ROLLBACK TO ${name}`); this._db.exec(`RELEASE ${name}`); }
        catch (_) { /* 回滚失败时保留原始错误 */ }
        throw e;
      }
    };
  }

  close() {
    return this._db.close();
  }
}

module.exports = { Database, Statement, sanitizeParams };
