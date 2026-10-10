// scripts/smoke-accounts.js — 多账号端到端冒烟
//
// 不需要浏览器：起一个真 Bridge Server，用两个假轮询客户端冒充两个账号，
// 验证「多账号同时在线 / 读操作轮换 / 写操作准入 / 写护栏下发 / 命令穿透」。
//
// 用法（在项目目录下）：
//   node scripts/smoke-accounts.js
//
// 完全隔离：跑在项目副本里，用临时 storage 和一个空闲端口，不碰正在跑的服务与真库。

const http = require('http');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { SITE, CLIENT_PROTOCOL_VERSION: CLIENT_V } = require('../lib/commands/helpers');
const STORAGE_ENV = SITE.startsWith('douyin') ? 'DOUYIN_STORAGE_DIR' : 'XHS_STORAGE_DIR';

// 整个冒烟跑在项目副本里，并用一个空闲端口 —— 两点都必须：
//   1. server 与 CLI 从同一份 config.json 读端口/token，副本保证一致
//   2. 不碰你在跑的那个 server/真 config.json。否则同端口会让 spawn 的 server
//      EADDRINUSE 静默退出，冒烟实际是在跟旧代码的 server 说话（假绿/假红）
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-cli-'));
for (const f of fs.readdirSync(ROOT)) {
  if (['node_modules', 'storage', 'logs', '.git', 'downloads'].includes(f)) continue;
  fs.cpSync(path.join(ROOT, f), path.join(WORK, f), { recursive: true });
}
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(WORK, 'node_modules'));
fs.mkdirSync(path.join(WORK, 'storage'), { recursive: true });
fs.mkdirSync(path.join(WORK, 'logs'), { recursive: true });

const LOG_DIR = path.join(os.tmpdir(), 'smoke-accounts');
fs.mkdirSync(LOG_DIR, { recursive: true });

/** 取一个当前空闲的端口 */
function freePort() {
  const { createServer } = require('net');
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

let PORT = 0;         // 在 main() 里赋值（取空闲端口是异步的）
let TOKEN = '';
let srv = null;
let logFile = '';
let storage = '';

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + TOKEN,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** 以某账号身份 poll 一次；超时返回 null（并掐断长轮询，否则这条等待会被服务端留着吞掉后续 eval） */
function poll(account, ms = 800) {
  let reqRef = null;
  let settled = false;
  const p = new Promise((resolve) => {
    const ch = encodeURIComponent(`${SITE}#${account || ''}`);
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: `/api/poll?channel=${ch}`, method: 'GET',
      headers: { Authorization: 'Bearer ' + TOKEN },
    }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { settled = true; let j = null; try { j = JSON.parse(b); } catch (_) {} resolve(j); });
    });
    r.on('error', () => { settled = true; resolve(null); });
    reqRef = r;
    r.end();
  });
  return Promise.race([p, new Promise(r => setTimeout(() => {
    if (reqRef && !settled) reqRef.destroy(); // 关掉这条 waiter，服务端 res.on('close') 会把它摘掉
    r(null);
  }, ms))]);
}

// 用 spawnSync 而不是 execFileSync：后者成功时只给你 stdout，
// stderr 直接漏到父进程终端，拿不到账号横幅
function cli(args, extraEnv) {
  const r = spawnSync(process.execPath, [path.join(WORK, 'cli.js'), ...args],
    { cwd: WORK, encoding: 'utf8', timeout: 20000, env: { ...cliEnv(), ...(extraEnv || {}) } });
  return { code: r.status == null ? -1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// CLI 子进程也必须用隔离 storage —— 否则 get/my 这类会落库的命令会写进真库，
// 冒烟就不再"完全隔离"了。
function cliEnv() {
  return { ...process.env, [STORAGE_ENV]: storage, DOUYIN_NO_ACCOUNT_BANNER: process.env.DOUYIN_NO_ACCOUNT_BANNER };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  let srvExited = null;
  try {
    // ── 起一个隔离的 server（副本 config + 空闲端口）──
    PORT = await freePort();
    const cfgPath = path.join(WORK, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    TOKEN = cfg.bridge.token;
    cfg.bridge.port = PORT;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

    storage = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-store-'));
    logFile = path.join(LOG_DIR, `smoke-accounts-${PORT}.log`);
    srv = spawn(process.execPath, [path.join(WORK, 'server.js')], {
      cwd: WORK,
      stdio: ['ignore', fs.openSync(logFile, 'w'), fs.openSync(logFile, 'a')],
      env: { ...process.env, [STORAGE_ENV]: storage },
    });
    srv.on('exit', (code) => { srvExited = code; });

    let up = false;
    for (let i = 0; i < 50 && !up && srvExited === null; i++) {
      try { up = (await req('GET', '/api/health')).status === 200; } catch (_) {}
      if (!up) await sleep(100);
    }
    if (!up) {
      throw new Error(`Bridge Server 未起来（exit=${srvExited}），日志见 ${logFile}`);
    }

    // ── 0. 未登录不接入：无 account 的连接必须被拒，且原因要分清 ──
    const oldClient = await req('POST', '/api/connect', { site: SITE });
    check('旧版客户端（完全没带 account）→ 400 client_outdated，提示去更新脚本',
      oldClient.status === 400 && oldClient.body.code === 'client_outdated'
        && /油猴脚本版本过旧/.test(oldClient.body.error),
      `${oldClient.status} ${oldClient.body && oldClient.body.code}`);

    const emptyAcc = await req('POST', '/api/connect', { site: SITE, account: '' });
    check('account 为空（未登录）→ 400 account_required，提示去登录',
      emptyAcc.status === 400 && emptyAcc.body.code === 'account_required'
        && /未登录/.test(emptyAcc.body.error),
      `${emptyAcc.status} ${emptyAcc.body && emptyAcc.body.code}`);

    // ── 1. 两个账号同时在线，互不踢线 ──
    await req('POST', '/api/connect', { site: SITE, account: 'ACC_A', nickname: '抖音小号A', clientVersion: CLIENT_V });
    const r2 = await req('POST', '/api/connect', { site: SITE, account: 'ACC_B', nickname: '小号B', clientVersion: CLIENT_V });
    check('第二个账号注册成功并回传 channel',
      r2.status === 200 && r2.body.channel === `${SITE}#ACC_B`, JSON.stringify(r2.body));

    const st = await req('GET', '/api/status');
    const accs = (st.body.accounts || {})[SITE] || [];
    const online = accs.map(a => a.account).sort();
    check('两个账号同时在线（不再互相踢线）',
      JSON.stringify(online) === JSON.stringify(['ACC_A', 'ACC_B']), `在线=${online.join(',')}`);
    check('/api/status 带出平台昵称',
      accs.find(a => a.account === 'ACC_A').nickname === '抖音小号A'
        && accs.find(a => a.account === 'ACC_B').nickname === '小号B',
      accs.map(a => `${a.account}=${a.nickname}`).join(', '));

    // ── 2. 读操作按账号轮换 ──
    const read1 = req('POST', '/api/call', { site: SITE, expression: '1+1', timeout: 3000 });
    await sleep(150);
    const gotA = await poll('ACC_A');
    check('读操作轮换：第 1 次落到 ACC_A', !!gotA && gotA.type === 'eval', gotA ? gotA.type : 'null');
    if (gotA && gotA.type === 'eval') await req('POST', '/api/result', { id: gotA.id, value: 'ok' });
    await read1;

    const read2 = req('POST', '/api/call', { site: SITE, expression: '2+2', timeout: 3000 });
    await sleep(150);
    const gotA2 = await poll('ACC_A');
    const gotB = await poll('ACC_B');
    check('读操作轮换：第 2 次落到 ACC_B（A 刚被服务过）',
      (!gotA2 || gotA2.type === 'idle') && !!gotB && gotB.type === 'eval',
      `A=${gotA2 ? gotA2.type : 'null'} B=${gotB ? gotB.type : 'null'}`);
    if (gotB && gotB.type === 'eval') await req('POST', '/api/result', { id: gotB.id, value: 'ok' });
    await read2;

    // ── 3. 写操作准入 ──
    const w1 = await req('POST', '/api/call', { site: SITE, expression: 'publish()', opType: 'write' });
    check('多账号下写操作未指定账号 → 409 account_required',
      w1.status === 409 && w1.body.code === 'account_required', `${w1.status} ${w1.body.code}`);

    const w2 = await req('POST', '/api/call', { site: SITE, expression: 'publish()', account: 'ZZZ' });
    check('指定未连接账号 → 404 account_not_connected（不静默改投）',
      w2.status === 404 && w2.body.code === 'account_not_connected', `${w2.status} ${w2.body.code}`);

    const w3 = req('POST', '/api/call', { site: SITE, expression: 'publish()', account: 'ACC_B', opType: 'write', timeout: 3000 });
    await sleep(150);
    const writeMsg = await poll('ACC_B');
    check('写操作下发到指定账号并带 expectAccount 护栏',
      !!writeMsg && writeMsg.type === 'eval' && writeMsg.expectAccount === 'ACC_B',
      writeMsg ? `expectAccount=${writeMsg.expectAccount}` : 'null');
    if (writeMsg && writeMsg.type === 'eval') await req('POST', '/api/result', { id: writeMsg.id, value: 'ok' });
    await w3;

    // ── 4. CLI 侧 ──
    const list = cli(['accounts']);
    const parsed = JSON.parse(list.stdout);
    check('cli accounts 列出两个在线账号',
      parsed.onlineCount === 2 && parsed.accounts.length === 2,
      list.stdout.replace(/\s+/g, ' ').slice(0, 120));

    const alias = cli(['accounts', 'alias', 'ACC_A', '主号']);
    check('cli accounts alias 写入成功',
      alias.code === 0 && JSON.parse(alias.stdout).alias === '主号');

    const after = JSON.parse(cli(['accounts']).stdout);
    check('别名体现在 cli accounts 输出里',
      after.accounts.some(a => a.account === 'ACC_A' && a.alias === '主号'));

    check('accounts 优先展示别名，未设别名的显示平台昵称（id 字段）',
      JSON.stringify(after.accounts.map(a => a.id).sort()) === JSON.stringify(['主号', '小号B']),
      JSON.stringify(after.accounts.map(a => a.id)));
    check('accounts 带出 nickname 字段便于人工识别',
      after.accounts.find(a => a.account === 'ACC_A').nickname === '抖音小号A'
        && after.accounts.find(a => a.account === 'ACC_B').nickname === '小号B',
      JSON.stringify(after.accounts.map(a => ({ account: a.account, nickname: a.nickname }))));

    // events 是本地查询命令（走账号解析、打横幅），且不打 bridge —— 用它观察横幅。
    // 注意别用 dedup 之类「账号无关」命令：它们已被设计为不打账号横幅。
    const banner = cli(['events']);
    check('每次调用都在 stderr 打印在线账号（无别名时用昵称）',
      /\[账号\] 在线 2：主号\(ACC_A\)、小号B\(ACC_B\)/.test(banner.stderr),
      (banner.stderr.split('\n')[0] || '').trim());

    const w = cli(['post', '1234567890', '测试内容']);
    check('cli 多账号下写操作未指定账号 → 拒绝并列出账号',
      w.code !== 0 && /必须用 --account 显式指定/.test(w.stderr) && /主号/.test(w.stderr),
      w.stderr.split('\n')[0].trim());

    // 读取"当前账号自身数据"的命令（my / dm list）与写操作同等对待：多号必须显式指定
    const myReject = cli(['my']);
    check('cli 多账号下 my（读取自身数据）未指定账号 → 拒绝',
      myReject.code !== 0 && /必须用 --account 显式指定/.test(myReject.stderr) && /读取「当前账号」/.test(myReject.stderr),
      myReject.stderr.split('\n')[0].trim());

    const dmReject = cli(['dm', 'list']);
    check('cli 多账号下 dm list（读取自身数据）未指定账号 → 拒绝',
      dmReject.code !== 0 && /必须用 --account 显式指定/.test(dmReject.stderr),
      dmReject.stderr.split('\n')[0].trim());

    const bad = cli(['get', '1234567890', '--account', '不存在']);
    check('cli 未知账号 → 报错并列出可用账号',
      bad.code !== 0 && /未知账号/.test(bad.stderr) && /主号/.test(bad.stderr),
      bad.stderr.split('\n')[0].trim());

    // 本地查询命令的 --account 只是过滤条件：账号离线也要能查历史，不该报"未知账号"
    const lenient = cli(['events', '--account', 'NOPE_OFFLINE']);
    check('本地查询（events）--account 允许离线账号，不报未知账号',
      lenient.code === 0 && !/未知账号/.test(lenient.stderr),
      `code=${lenient.code} stderr=${JSON.stringify(lenient.stderr.trim())}`);

    // 账号无关命令（读全局表）必须忽略账号：既不能因 DOUYIN_ACCOUNT 环境变量误伤
    // （campaign daemon 会设它），显式 --account 也只是提示、不报错。
    const agnosticEnv = cli(['replied', '--count'], { DOUYIN_ACCOUNT: 'NOPE_ENV' });
    check('账号无关命令（replied）忽略 DOUYIN_ACCOUNT 环境变量，不报未知账号',
      agnosticEnv.code === 0 && !/未知账号/.test(agnosticEnv.stderr),
      `code=${agnosticEnv.code} stderr=${JSON.stringify(agnosticEnv.stderr.trim())}`);

    const agnosticExplicit = cli(['replied', '--count', '--account', 'NOPE_OFFLINE']);
    check('账号无关命令显式 --account → 忽略并提示，不报错',
      agnosticExplicit.code === 0 && /已忽略 --account/.test(agnosticExplicit.stderr),
      `code=${agnosticExplicit.code} stderr=${JSON.stringify(agnosticExplicit.stderr.trim())}`);

    // ── 5. 旧版脚本必须被标出来 ──
    // 这是"脚本太旧"与"新脚本但探测失败"的唯一区分手段：
    // 前者压根不带 clientVersion，后者带了但 nickname 为空。
    await req('POST', '/api/connect', { site: SITE, account: 'ACC_OLD' }); // 故意不带 clientVersion
    const afterOld = JSON.parse(cli(['accounts']).stdout);
    const oldRow = afterOld.accounts.find(a => a.account === 'ACC_OLD');
    check('旧版脚本（未上报 clientVersion）被标记 scriptOutdated',
      !!oldRow && oldRow.scriptOutdated === true && oldRow.clientVersion === null,
      oldRow ? `clientVersion=${oldRow.clientVersion} outdated=${oldRow.scriptOutdated}` : 'null');

    const bannerOld = cli(['events']);
    check('横幅提示旧脚本需去 Tampermonkey 重装',
      /油猴脚本不是最新版/.test(bannerOld.stderr) && /Tampermonkey 重装/.test(bannerOld.stderr),
      (bannerOld.stderr.split('\n').filter(Boolean).pop() || '').trim());

    // ── 6. CLI --account 精确路由（穿过真 BridgeClient，而不是直接打 /api/call）──
    // 回归关键：BridgeClient 曾漏传 account/opType，服务端便一律当"读操作轮换"，
    // 于是 `--account A` 会悄悄落到 B。这里让 CLI 真的发一次请求，看它落到哪个 channel。
    const cliAsync = (args) => {
      const child = spawn(process.execPath, [path.join(WORK, 'cli.js'), ...args], { cwd: WORK, env: cliEnv() });
      child.out = ''; child.err = '';
      child.stdout.on('data', d => { child.out += d; });
      child.stderr.on('data', d => { child.err += d; });
      return child;
    };

    const pollUntil = async (account, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const m = await poll(account, Math.min(400, end - Date.now()));
        if (m && m.type === 'eval') return m;
      }
      return null;
    };

    // 在若干账号里轮询，返回第一个拿到 eval 的 { account, msg }
    const pollAny = async (accounts, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        for (const a of accounts) {
          const m = await poll(a, Math.min(400, end - Date.now()));
          if (m && m.type === 'eval') return { account: a, msg: m };
        }
      }
      return null;
    };

    const routedRead = cliAsync(['get', '1234567890', '--account', 'ACC_A', '--no-log']);
    const rMsgA = await pollUntil('ACC_A');
    const rMsgB = await poll('ACC_B', 300);
    check('CLI --account 精确路由：读操作只落指定账号（ACC_A），不轮换到 ACC_B',
      !!rMsgA && (!rMsgB || rMsgB.type === 'idle'),
      `A=${rMsgA ? rMsgA.type : 'null'} B=${rMsgB ? rMsgB.type : 'null'} err=${JSON.stringify(routedRead.err.trim())}`);
    if (rMsgA) {
      await req('POST', '/api/result', { id: rMsgA.id, value: { comments: [], has_more: 0 } });
    }
    routedRead.kill();

    const routedWrite = cliAsync(['like', '1234567890', '--account', 'ACC_B', '--no-throttle', '--no-log']);
    const wMsgB = await pollUntil('ACC_B');
    check('CLI --account 写操作下发写护栏（expectAccount=ACC_B）',
      !!wMsgB && wMsgB.expectAccount === 'ACC_B',
      wMsgB ? `expectAccount=${wMsgB.expectAccount}` : `null err=${JSON.stringify(routedWrite.err.trim())}`);
    if (wMsgB) {
      await req('POST', '/api/result', { id: wMsgB.id, value: { status_code: 0 } });
    }
    routedWrite.kill();

    // ── 7. 分页读不中途换号（命令内钉扎）──
    // 未指定账号的读操作，第一次由服务端轮换选中某个号；同一条 get --all 的后续分页
    // 必须仍在同一个号上 —— 否则 cursor 来自 A 号却拿去问 B 号，跨号拼接会错乱。
    const paginate = cliAsync(['get', '888', '--all', '--no-log']);
    const p1 = await pollAny(['ACC_A', 'ACC_B', 'ACC_OLD'], 3000);
    check('分页读第 1 页落到某个在线账号', !!p1, p1 ? p1.account : 'null');
    if (p1) {
      await req('POST', '/api/result', { id: p1.msg.id, value: { comments: [{ cid: 'c1', text: 'x', create_time: 1 }], has_more: 1, cursor: 10 } });
    }
    const p2 = await pollAny(['ACC_A', 'ACC_B', 'ACC_OLD'], 3000);
    check('分页读第 2 页仍落在同一账号（钉扎，不换号）',
      !!p1 && !!p2 && p2.account === p1.account,
      p1 && p2 ? `${p1.account} → ${p2.account}` : `p1=${p1 && p1.account} p2=${p2 && p2.account}`);
    if (p2) {
      await req('POST', '/api/result', { id: p2.msg.id, value: { comments: [], has_more: 0 } });
    }
    paginate.kill();

    console.log(`\n${results.filter(r => r.ok).length}/${results.length} 通过`);
    process.exitCode = results.every(r => r.ok) ? 0 : 1;
  } catch (e) {
    console.error('冒烟失败:', e.message);
    process.exitCode = 2;
  } finally {
    if (srv) srv.kill('SIGTERM');
    await sleep(300);
    for (const d of [WORK, storage]) { try { if (d) fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  }
})();
