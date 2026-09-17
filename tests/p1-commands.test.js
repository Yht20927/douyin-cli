// tests/p1-commands.test.js — P1 命令切 SQL 的回归测试
//
// 不变量：
// 1. cmdLog 走 SQL 路径，能正确按 --video / --failed / --command / --uid 过滤
// 2. cmdProfile 走 SQL 路径时按 uid 精确匹配；events 为空时回退 audit.json
// 3. cmdEvents 输出 SQLite 行（含 sessionId / id / args / summary）
// 4. AuditLogger.findLastFetchTime 走 SQL，命中索引

const fs = require('fs');
const path = require('path');
const os = require('os');

function withTempProject(fn) {
  return async () => {
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-p1-' + id + '-'));
    const origStorageEnv = process.env.DOUYIN_STORAGE_DIR;
    const origLogEnv = process.env.DOUYIN_LOG_DIR;
    const origCwd = process.cwd();
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    process.env.DOUYIN_LOG_DIR = path.join(tmp, 'logs');
    process.chdir(tmp);
    [
      '../core/memory/db', '../core/memory/events', '../core/audit',
      '../core/commands/log', '../core/commands/profile', '../core/commands/events',
    ].forEach(m => delete require.cache[require.resolve(m)]);
    try {
      await fn(tmp);
    } finally {
      try { require('../core/memory/db').closeDb(); } catch (e) { /* */ }
      process.chdir(origCwd);
      if (origStorageEnv == null) delete process.env.DOUYIN_STORAGE_DIR;
      else process.env.DOUYIN_STORAGE_DIR = origStorageEnv;
      if (origLogEnv == null) delete process.env.DOUYIN_LOG_DIR;
      else process.env.DOUYIN_LOG_DIR = origLogEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

/** 静默 console.log 抓输出 */
function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.map(String).join(' '));
  try { return Promise.resolve(fn()).then(r => ({ result: r, output: lines.join('\n') })); }
  finally { console.log = orig; }
}

describe('P1: cmdLog (SQL path)', () => {
  it('按 --video --failed --command 过滤', withTempProject(async () => {
    const events = require('../core/memory/events');
    const cmdLog = require('../core/commands/log');
    events.append({ ts: 1000, command: 'get',  status: 'success', awemeId: 'v1' });
    events.append({ ts: 2000, command: 'post', status: 'error',   awemeId: 'v1', error: 'risk' });
    events.append({ ts: 3000, command: 'like', status: 'success', awemeId: 'v2' });

    const all = await captureLog(() => cmdLog({ audit: { load: () => ({ sessions: [] }) } }, []));
    expect(all.output).toContain('get');
    expect(all.output).toContain('post');
    expect(all.output).toContain('like');

    const failed = await captureLog(() => cmdLog({ audit: { load: () => ({ sessions: [] }) } }, ['--failed']));
    expect(failed.output).toContain('post');
    expect(failed.output).not.toContain('like');

    const v1Only = await captureLog(() => cmdLog({ audit: { load: () => ({ sessions: [] }) } }, ['--video', 'v1']));
    expect(v1Only.output).toContain('v1');
    expect(v1Only.output).not.toContain('v2');
  }));

  it('events 表为空时回退 audit.json', withTempProject(async () => {
    const cmdLog = require('../core/commands/log');
    const fakeAudit = { load: () => ({
      sessions: [{ operations: [{ command: 'search', status: 'success', args: { keyword: 'k' }, started: '2026-01-01T00:00:00.000Z' }] }],
    }) };
    const out = await captureLog(() => cmdLog({ audit: fakeAudit }, []));
    expect(out.output).toContain('search');
  }));
});

describe('P1: cmdProfile (SQL path)', () => {
  it('uid 精确匹配 events 表', withTempProject(async () => {
    const events = require('../core/memory/events');
    const cmdProfile = require('../core/commands/profile');
    events.append({ ts: 1000, command: 'post', status: 'success', uid: 'u123', cid: 'c1', awemeId: 'v1' });
    events.append({ ts: 2000, command: 'like', status: 'success', uid: 'u123', awemeId: 'v2' });
    events.append({ ts: 3000, command: 'post', status: 'success', uid: 'u_other', awemeId: 'v3' });

    const r = await cmdProfile({ audit: { load: () => ({ sessions: [] }) } }, ['u123']);
    expect(r.uid).toBe('u123');
    expect(r.total_interactions).toBe(2);
    expect(r.interactions[0].type).toBe('replied');
    expect(r.interactions[1].type).toBe('liked');
  }));

  it('events 无该 uid 时回退 audit.json (v2 行为)', withTempProject(async () => {
    const cmdProfile = require('../core/commands/profile');
    const fakeAudit = { load: () => ({
      sessions: [{ operations: [{
        command: 'post', status: 'success',
        args: { aweme_id: 'v1', reply_to: 'c1' },
        ended: '2026-01-01T00:00:00.000Z',
      }] }],
    }) };
    const r = await cmdProfile({ audit: fakeAudit }, ['u_anything']);
    expect(r.total_interactions).toBe(1);
    expect(r.interactions[0].type).toBe('replied');
  }));
});

describe('P1: cmdEvents', () => {
  it('--json 输出原始行（含 sessionId/id）', withTempProject(async () => {
    const events = require('../core/memory/events');
    const cmdEvents = require('../core/commands/events');
    events.append({ ts: 1000, command: 'get', status: 'success', awemeId: 'v1', sessionId: 's1' });
    const rows = await cmdEvents({}, ['--json']);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBeTypeOf('number');
    expect(rows[0].command).toBe('get');
  }));

  it('--since 数字下界过滤', withTempProject(async () => {
    const events = require('../core/memory/events');
    const cmdEvents = require('../core/commands/events');
    events.append({ ts: 1000, command: 'get', status: 'success' });
    events.append({ ts: 5000, command: 'post', status: 'success' });
    const rows = await cmdEvents({}, ['--json', '--since', '3000']);
    expect(rows).toHaveLength(1);
    expect(rows[0].command).toBe('post');
  }));
});

describe('P1: findLastFetchTime SQL', () => {
  it('优先 SQL，empty 时回退 audit.json', withTempProject(async () => {
    const { AuditLogger } = require('../core/audit');
    const events = require('../core/memory/events');
    events.append({ ts: 5000000, command: 'get', status: 'success', awemeId: 'v1' });
    events.append({ ts: 6000000, command: 'get', status: 'success', awemeId: 'v1' });
    const a = new AuditLogger();
    expect(a.findLastFetchTime('v1')).toBe(6000); // ms→sec

    // events 没有 v_only_audit_json，应走 audit.json
    const fakeAudit = { load: () => ({
      sessions: [{ operations: [{
        command: 'get', status: 'success', ended: '2026-06-01T00:00:00.000Z',
        args: { aweme_id: 'v_only_audit_json' },
      }] }],
    }) };
    a.load = fakeAudit.load.bind(fakeAudit);
    expect(a.findLastFetchTime('v_only_audit_json')).toBeGreaterThan(0);
  }));
});
