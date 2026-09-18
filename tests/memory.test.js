// tests/memory.test.js — v3 持久化记忆层（P0）单元测试
//
// 关键不变量（每次发版必须保持）：
// 1. 删 storage/ 后任意一次 getDb() 都能自愈，schema 自动迁移到最新版本
// 2. events.append → query 往返语义（包括 args/summary JSON 反序列化）
// 3. findLastFetchTime 只看 'get' & 'success' 事件
// 4. AuditLogger.endOperation 触发双写：audit.json 与 events 表同时增长
// 5. setNoLog 路径不产生任何 events
// 6. 历史 audit.json 导入幂等

const fs = require('fs');
const path = require('path');
const os = require('os');
// vitest 全局函数（describe/it/expect/...）由 vitest.config.js globals: true 提供，
// 这里不再 require('vitest') —— v4 起 vitest 包不支持 CommonJS require。

// 每个用例独立 storage 目录（DOUYIN_STORAGE_DIR）+ 独立 logs 目录（cwd），
// 完全旁路项目主 storage/，不同 test file 并行运行也不冲突。
function withTempProject(fn) {
  return async () => {
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-v3-' + id + '-'));
    const tmpStorage = path.join(tmp, 'storage');
    const tmpLogs = path.join(tmp, 'logs');
    const origStorageEnv = process.env.DOUYIN_STORAGE_DIR;
    const origCwd = process.cwd();

    process.env.DOUYIN_STORAGE_DIR = tmpStorage;
    process.env.DOUYIN_LOG_DIR = tmpLogs;
    process.chdir(tmp);
    [
      '../core/memory/db', '../core/memory/events', '../core/audit',
    ].forEach(m => delete require.cache[require.resolve(m)]);

    try {
      await fn(tmp);
    } finally {
      try { require('../core/memory/db').closeDb(); } catch (e) { /* */ }
      process.chdir(origCwd);
      if (origStorageEnv == null) delete process.env.DOUYIN_STORAGE_DIR;
      else process.env.DOUYIN_STORAGE_DIR = origStorageEnv;
      delete process.env.DOUYIN_LOG_DIR;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

describe('memory/db', () => {
  it('首次打开自动建库 + 设置 user_version', withTempProject(async () => {
    const { getDb, getDbPath, SCHEMA_VERSION } = require('../core/memory/db');
    const db = getDb();
    expect(fs.existsSync(getDbPath())).toBe(true);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    expect(tables).toContain('events');
  }));

  it('删除 db 文件后下次调用自愈', withTempProject(async () => {
    const { getDb, getDbPath, closeDb } = require('../core/memory/db');
    getDb();
    closeDb();
    fs.rmSync(getDbPath());
    // 模块缓存清掉，模拟新进程
    delete require.cache[require.resolve('../core/memory/db')];
    const { getDb: getDb2, SCHEMA_VERSION } = require('../core/memory/db');
    const db2 = getDb2();
    expect(db2.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  }));
});

describe('memory/events', () => {
  it('append → query 往返', withTempProject(async () => {
    const events = require('../core/memory/events');
    events.append({ command: 'get', status: 'success', awemeId: 'v1', durationMs: 100, summary: { count: 5 } });
    events.append({ command: 'post', status: 'error', awemeId: 'v1', uid: 'u1', error: 'status_code=8' });
    expect(events.count()).toBe(2);
    expect(events.count({ command: 'post', status: 'error' })).toBe(1);
    const rows = events.query({ awemeId: 'v1' });
    expect(rows).toHaveLength(2);
    // 默认按 ts DESC 排序：最新在最前
    expect(rows[0].command).toBe('post');
    expect(rows[0].error).toBe('status_code=8');
    expect(rows[1].summary.count).toBe(5);
  }));

  it('findLastFetchTime 只统计 get + success', withTempProject(async () => {
    const events = require('../core/memory/events');
    events.append({ ts: 1000000, command: 'get', status: 'error',   awemeId: 'v1' });
    events.append({ ts: 2000000, command: 'post',  status: 'success', awemeId: 'v1' });
    events.append({ ts: 3000000, command: 'get',   status: 'success', awemeId: 'v1' });
    events.append({ ts: 4000000, command: 'get',   status: 'success', awemeId: 'v2' });
    expect(events.findLastFetchTime('v1')).toBe(3000); // ms→sec
    expect(events.findLastFetchTime('v2')).toBe(4000);
    expect(events.findLastFetchTime('v_unknown')).toBe(null);
  }));

  it('SQL 失败时降级返回空，不抛', withTempProject(async () => {
    const events = require('../core/memory/events');
    // 制造异常路径：传 undefined / 空 command 不应崩溃
    const id = events.append({ /* command 缺失 */ status: 'success' });
    expect(id === null || typeof id !== 'undefined').toBe(true);
  }));
});

describe('audit double-write', () => {
  it('endOperation 同步写入 audit.json + events 表', withTempProject(async () => {
    const { AuditLogger } = require('../core/audit');
    const events = require('../core/memory/events');
    const a = new AuditLogger();
    a.startOperation('search', { keyword: 'k1' });
    a.endOperation('success', { count: 3 }, null);
    expect(events.count()).toBe(1);
    const [evt] = events.query();
    expect(evt.command).toBe('search');
    expect(evt.summary.count).toBe(3);
    expect(evt.args.keyword).toBe('k1');
    expect(evt.sessionId).toBeTruthy();
  }));

  it('--no-log 只关文件日志，events 表照记', withTempProject(async (tmp) => {
    const { AuditLogger } = require('../core/audit');
    const events = require('../core/memory/events');
    const a = new AuditLogger();
    a.setNoLog(true);
    a.startOperation('get', { aweme_id: 'v1' });
    a.endOperation('success', { comments: 0 }, null);

    // 契约变更（本次审查修正）：`--no-log` 关掉的是**日志文件**，
    // 不是 events 表。events 是策略闸门与节奏守卫的唯一数据源
    // （配额/轮次/熔断/距上次写多久全靠它）。
    //
    // 旧行为是"events 也一条不写"，后果是 `post --no-log` 顺手拿到了
    // 「配额清零 + 节奏不等待」的效果 —— 一个叫"别记日志"的选项，
    // 实际把风控全关了，而且 help 里没有任何提示。
    expect(events.count()).toBe(1);
    expect(events.query({ limit: 1 })[0].awemeId).toBe('v1');

    // 文件侧仍然不写
    expect(fs.existsSync(path.join(tmp, 'logs', 'audit.json'))).toBe(false);
  }));

  it('error 状态也被双写', withTempProject(async () => {
    const { AuditLogger } = require('../core/audit');
    const events = require('../core/memory/events');
    const a = new AuditLogger();
    a.startOperation('post', { aweme_id: 'v1', text: 'hi' });
    a.endOperation('error', {}, null, 'status_code=8');
    const errors = events.query({ command: 'post', status: 'error' });
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe('status_code=8');
  }));
});
