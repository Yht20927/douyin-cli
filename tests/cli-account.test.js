// tests/cli-account.test.js — CLI 多账号准入（真实进程 + 假 bridge）
//
// 服务端/路由层的测试在 router.test.js；这里验证 CLI 自己那一道体验层护栏：
//   - 多账号在线时，写操作没有 --account → 在发出任何 /api/call 之前就退出
//   - --account 支持 uid 与唯一昵称，并透传 account + opType:'write'
//
// 用真实子进程而不是 require cli.js：cli.js 是入口脚本，require 会直接跑 main()。
// 每个用例独立数据目录，避免上一条 like 的 events 触发写间隔/配额。

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli.js');

let server;
let port;
let calls = [];

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (req.url === '/api/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            connections: {
              'douyin.com': [
                { id: 'c1', account: { nickname: 'A号', uid: 'uidA' }, uid: 'uidA', nickname: 'A号', clientVersion: 3, alive: true, channel: 'douyin.com#uidA' },
                { id: 'c2', account: { nickname: 'B号', uid: 'uidB' }, uid: 'uidB', nickname: 'B号', clientVersion: 3, alive: true, channel: 'douyin.com#uidB' },
              ],
            },
            accounts: { 'douyin.com': [] },
            totalConnections: 2,
          }));
          return;
        }
        if (req.url === '/api/call') {
          const parsed = JSON.parse(body || '{}');
          calls.push(parsed);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true, value: { status_code: 0 },
            account: parsed.account, connection: 'polling',
          }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
}

function runCli(args, extraEnv = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-cli-acct-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    bridge: { host: '127.0.0.1', port, token: '' },
  }));

  return new Promise((resolve) => {
    const env = {
      ...process.env,
      DOUYIN_DATA_DIR: tmp,
      DOUYIN_STORAGE_DIR: path.join(tmp, 'storage'),
      DOUYIN_LOG_DIR: path.join(tmp, 'logs'),
      DOUYIN_ACCOUNT: '',
      ...extraEnv,
    };
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('exit', (code) => {
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

beforeAll(startServer);
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => { calls = []; });

describe('CLI 多账号写准入', () => {
  it('两个账号在线、写操作不带 --account → 退出 1，且没有发出 /api/call', async () => {
    const r = await runCli(['like', '123456']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/2 个账号在线/);
    expect(r.stderr).toMatch(/--account/);
    expect(r.stderr).toMatch(/A号\(uidA\)/);
    expect(r.stderr).toMatch(/B号\(uidB\)/);
    expect(calls).toHaveLength(0);
  });

  it('--account 用 uid → 透传 account 与 opType:write', async () => {
    const r = await runCli(['like', '123456', '--account', 'uidB']);
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].account).toBe('uidB');
    expect(calls[0].opType).toBe('write');
    expect(calls[0].expression).toContain('digg');
    expect(JSON.parse(r.stdout).action).toBe('liked');
  });

  it('--account 用唯一昵称 → 解析成对应 uid', async () => {
    const r = await runCli(['like', '123456', '--account', 'A号']);
    expect(r.code).toBe(0);
    expect(calls[0].account).toBe('uidA');
    expect(calls[0].opType).toBe('write');
  });

  it('DOUYIN_ACCOUNT 等价于 --account', async () => {
    const r = await runCli(['like', '123456'], { DOUYIN_ACCOUNT: 'uidA' });
    expect(r.code).toBe(0);
    expect(calls[0].account).toBe('uidA');
  });

  it('指定不在线的账号 → 在发出请求前退出（不静默换号）', async () => {
    const r = await runCli(['like', '123456', '--account', 'uidX']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown|未知账号|未连接/i);
    expect(calls).toHaveLength(0);
  });
});
