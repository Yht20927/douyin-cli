// tests/server/real-chain.test.js — 三条链路的端到端验证（真 HTTP + 真队列 + 真库）
//
// 为什么要这一个文件
// ------------------
// enrich（补全视频信息）、删除回复、发私信这三条都改了核心路径，
// 而此前**只跑过失败分支**：命令的单测把 `ctx.loggedCall` 换成一个假的异步函数，
// 直接返回一个对象。那种测法验证不了链路上真正会断的东西 ——
//   - 表达式拼出来到底是不是合法 JS、参数有没有传错位置
//   - 油猴脚本暴露的那几个 `window.__bridge.*` 名字与返回形状对不对
//   - /api/connect → /api/poll → /api/result 这一趟往返有没有把结果送回来
//   - 结果落库之后，界面读的那几个视图数字是否跟着变
//   - 一次操作做完，风控到底看没看见它（"看不见"就是这轮修的那个 bug）
//
// 这里把上面几层全部换成真的：进程内起 Bridge Server（端口 0 由系统分配），
// 一个按油猴脚本同样的协议工作的假浏览器（长轮询 + 在 vm 里 eval 表达式 + 回 /api/result），
// 命令通过**真实的任务队列**跑（isWriteCommand → 补 --no-throttle → afterWrite），
// 数据落在临时 SQLite 里，最后从 data 视图那一层读数。
//
// 写任务的 meta.skipWait = true：等写间隔是 risk-control/policy 那些用例负责的事，
// 这里要验的是"接线"，让测试跑 40 秒没有任何额外收益。

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');

const SITE = 'douyin.com';
const TOKEN = 'chain-token-xyz';
const MY_UID = 'me';

const ENV_KEYS = ['DOUYIN_CONFIG', 'DOUYIN_DATA_DIR', 'DOUYIN_STORAGE_DIR', 'DOUYIN_LOG_DIR'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 与油猴脚本一致的 token 头 + 记录活着的请求（收尾时要掐断长轮询） */
function makeHttp(port) {
  const live = new Set();

  function req(method, urlPath, body, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const headers = { Authorization: `Bearer ${TOKEN}` };
      if (payload != null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const r = http.request({
        hostname: '127.0.0.1', port, path: urlPath, method, headers, timeout: timeoutMs,
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          live.delete(r);
          try { resolve(JSON.parse(data)); } catch (e) {
            reject(new Error(`响应不是 JSON：${data.slice(0, 120)}`));
          }
        });
      });
      r.on('error', (e) => { live.delete(r); reject(e); });
      r.on('timeout', () => { live.delete(r); r.destroy(new Error('客户端超时')); });
      live.add(r);
      if (payload != null) r.write(payload);
      r.end();
    });
  }

  req.destroyAll = () => {
    for (const r of live) r.destroy(new Error('teardown'));
    live.clear();
  };
  return req;
}

/**
 * 假浏览器：照 scripts/douyin.user.js 的 connect()/poll() 抄的协议。
 *
 * 表达式交给 `vm.runInNewContext` 在沙箱里 eval，沙箱里只有 `window.__bridge`
 * —— 与真脚本用 `unsafeWindow.eval` 的区别仅在于这里没有抖音页面可调用。
 * 关键是**必须真的解析那段表达式**：拼错一个引号、参数少一个，这里就会抛出来。
 */
function startFakeBrowser(port, impl) {
  const get = makeHttp(port);
  const seen = [];

  const sandbox = {
    window: {
      __bridge: Object.fromEntries(Object.entries(impl).map(([name, fn]) => [name, async (...args) => {
        seen.push({ name, args });
        return fn(...args);
      }])),
    },
  };

  let stopped = false;
  const loop = (async () => {
    const reg = await get('POST', '/api/connect', {
      site: SITE,
      url: 'https://www.douyin.com/',
      title: '',
      userAgent: 'fake-browser',
      // 2 = 会带登录账号信息。真脚本靠它区分"旧版不会上报"与"新版识别失败"
      clientVersion: 2,
      account: { uid: MY_UID, nickname: '我的号', avatar: '' },
    });
    const connId = reg && reg.id;
    if (!connId) throw new Error('假浏览器注册失败: ' + JSON.stringify(reg));

    while (!stopped) {
      let msg;
      try {
        // 长轮询在服务端挂 25s，客户端超时给得比它长
        msg = await get('GET', `/api/poll?site=${SITE}&id=${connId}`, undefined, 40000);
      } catch (e) {
        if (stopped) break;
        await sleep(60);
        continue;
      }
      if (!msg || msg.type !== 'eval') continue;   // idle → 立刻再挂一次长轮询

      let reply;
      try {
        const v = vm.runInNewContext(msg.expression, sandbox, { timeout: 5000 });
        reply = { id: msg.id, value: msg.awaitPromise === false ? v : await v };
      } catch (e) {
        reply = { id: msg.id, error: e.message || String(e) };
      }
      try { await get('POST', '/api/result', reply); } catch (e) { /* 正在收尾 */ }
    }
  })();

  return {
    seen,
    async stop() {
      stopped = true;
      get.destroyAll();
      await loop.catch(() => { /* 收尾时连接被掐断是预期内的 */ });
    },
  };
}

/** 等某个队列任务进入终态 */
function waitTask(queue, id, timeoutMs = 20000) {
  const TERMINAL = ['done', 'failed', 'blocked', 'cancelled'];
  return new Promise((resolve, reject) => {
    const t0 = queue.get(id);
    if (t0 && TERMINAL.includes(t0.status)) return resolve(t0);
    const un = queue.subscribe((payload) => {
      const t = (payload.tasks || []).find(x => x.id === id);
      if (t && TERMINAL.includes(t.status)) {
        un();
        clearTimeout(timer);
        resolve(t);
      }
    });
    const timer = setTimeout(() => {
      un();
      reject(new Error(`等待队列任务超时（${timeoutMs}ms）`));
    }, timeoutMs);
  });
}

const quietLogger = {
  info() {}, debug() {}, warn() {}, error() {},
  output() {}, progress() {}, phase() {},
  child() { return quietLogger; },
};

describe('三条链路的端到端验证（补全 / 删除回复 / 私信）', () => {
  let tmp = null;
  let saved = {};
  let server = null;
  let chainPort = 0;
  let fake = null;
  let queue = null;
  let m = {};

  /** 假浏览器那边每个用例可改的应答 */
  const bridgeState = {
    deleteReply: { status_code: 0 },
    /** 非空 = 抖音在 IM 响应里回了一句错误（protobuf 的 error_desc） */
    dmError: null,
    detailFor: (awemeId) => ({
      aweme_detail: {
        desc: `「${awemeId}」的真实标题`,
        video: { origin_cover: { url_list: ['https://p3.example/cover.jpg'] } },
        author: { uid: 'author-1', nickname: '原作者' },
        create_time: 1700000000,
        statistics: { play_count: '1200', digg_count: '34', comment_count: '5', share_count: '1' },
      },
    }),
  };

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-chain-'));
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.DOUYIN_CONFIG = path.join(tmp, 'config.json');
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    process.env.DOUYIN_DATA_DIR = path.join(tmp, 'storage');
    process.env.DOUYIN_LOG_DIR = path.join(tmp, 'logs');

    const { createBridgeServer } = require('../../core/server/create-server');
    server = createBridgeServer({ port: 0, host: '127.0.0.1', token: TOKEN, logger: quietLogger });
    const { port } = await server.start();
    chainPort = port;

    // 配置要在拿到端口之后写：createContext 里的 BridgeClient 就是从这份配置取端口的
    fs.writeFileSync(process.env.DOUYIN_CONFIG, JSON.stringify({
      bridge: { host: '127.0.0.1', port, token: TOKEN, requestTimeout: 8000 },
      policy: { dailyWriteQuota: 999, dailyRounds: 99 },
    }));

    // 环境就绪之后再打 core —— 这些模块在加载时会读配置/建库
    const config = require('../../core/config');
    config.reset();
    m = {
      config,
      videos: require('../../core/memory/videos'),
      comments: require('../../core/memory/comments'),
      corpus: require('../../core/memory/corpus'),
      events: require('../../core/memory/events'),
      accounts: require('../../core/memory/accounts'),
      riskControl: require('../../core/risk-control'),
      views: require('../../core/data/views'),
      queueMod: require('../../core/runtime/task-queue'),
      ctxMod: require('../../core/runtime/context'),
    };

    fake = startFakeBrowser(port, {
      getDetail: async (id) => bridgeState.detailFor(id),
      // 字段名保持抖音原样（下划线、嵌套 user）—— 落库那侧的解析依赖它们
      getComments: async () => ({
        comments: [{
          cid: 'g1',
          text: '第一次拉到的评论',
          create_time: Math.floor(Date.now() / 1000) - 60,
          reply_comment_total: 0,
          digg_count: 0,
          user: { uid: 'u9', nickname: '路人', sec_uid: 'sec-u9' },
        }],
        cursor: 0,
        has_more: false,
        total: 1,
      }),
      replies: async () => ({ comments: [], cursor: 0, has_more: false }),
      deleteComment: async () => bridgeState.deleteReply,
      createConversation: async (uid) => ({
        conversation_id: `conv-${uid}-000123`, conversation_short_id: '77', ticket: 'tk',
      }),
      sendDM: async () => ({ cmd: 100, sequence_id: 7, error_desc: bridgeState.dmError || '' }),
    });

    // 真队列 + 真 ctx（与 app/main/index.js 里那份装配方式保持一致）
    queue = m.queueMod.createTaskQueue({
      policy: require('../../core/policy').getPolicy(),
      logger: quietLogger,
      createContext: (task, o = {}) => {
        const ctx = m.ctxMod.createContext({
          command: task.command,
          taskId: task.id,
          signal: o.signal,
          extraSinks: o.extraSinks || [],
          logger: quietLogger,
          accountUid: MY_UID,
        });
        return m.ctxMod.bindCommands(ctx);
      },
    });

    // 等浏览器把连接注册上来（/api/connect 是异步的，账号解析靠它）
    for (let i = 0; i < 100; i++) {
      const st = await makeHttp(port)('GET', '/api/status');
      if (st && st.connections && st.connections.length > 0) break;
      await sleep(50);
    }
  }, 60000);

  afterAll(async () => {
    try { if (queue) queue.stop(); } catch (_) { /* */ }
    try { if (fake) await fake.stop(); } catch (_) { /* */ }
    try { if (server) await server.stop(); } catch (_) { /* */ }
    try { require('../../core/memory/db').closeDb(); } catch (_) { /* */ }
    try { m.config && m.config.reset(); } catch (_) { /* */ }
    for (const k of ENV_KEYS) {
      if (saved[k] == null) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }, 30000);

  beforeEach(() => {
    fake.seen.length = 0;
    bridgeState.deleteReply = { status_code: 0 };
    bridgeState.dmError = null;
  });

  // ═══════════════════════════════════════════════════════
  it('前提：执行账号真的从桥接解析出来了（三条写链路的守卫都建在这上面）', async () => {
    const { BridgeClient } = require('../../core/client/bridge-client');
    const client = new BridgeClient({ host: '127.0.0.1', port: chainPort, token: TOKEN });

    // 服务端线格式不变：仍是按 site 分组的对象（router.test.js 锁着这个形状）
    const raw = await makeHttp(chainPort)('GET', '/api/status');
    expect(Array.isArray(raw.connections)).toBe(false);
    expect(Object.keys(raw.connections)).toContain(SITE);

    // 客户端把它摊平成数组 —— 归一发生在这一层，消费方从此只面对一种形状
    const status = await client.status();
    expect(Array.isArray(status.connections)).toBe(true);
    expect(status.connections[0]).toMatchObject({ site: SITE, alive: true });
    expect(status.connections[0].account.uid).toBe(MY_UID);

    expect(m.accounts.aliveUids(status)).toEqual([MY_UID]);
    // 主进程缓存的快照（数组）也被喂进同一个 helper，不能只认对象
    expect(m.accounts.aliveUids({ connections: status.connections })).toEqual([MY_UID]);

    // resolveExecutor 刻意只认桥接（ctx.accountUid 是"界面想看谁的列表"，不是"谁在执行"）
    const r = await m.accounts.resolveExecutor({ bridge: client });
    expect(r).toMatchObject({ uid: MY_UID, source: 'bridge' });

    // 最重要的那道守卫：要写的数据属于别的号 → 必须拦，否则会之以另一个号发出
    const guard = await m.accounts.checkWriteAccount({ bridge: client }, 'someone-else');
    expect(guard).toMatchObject({ ok: false, reason: 'mismatch', actual: MY_UID });
    expect((await m.accounts.checkWriteAccount({ bridge: client }, MY_UID)).ok).toBe(true);
  });

  // ═══════════════════════════════════════════════════════
  it('补全视频信息：get 留下的空壳行，补完之后标题/封面/互动数据都落库，待补全角标归零', async () => {
    // 与真实场景一致的起点：只拉过一次评论，所以库里只有 aweme_id + ops_uid 的壳
    expect(m.videos.markGet('v_shell', { accountUid: MY_UID })).toBeTruthy();
    const shell = m.videos.get('v_shell');
    expect(shell.title).toBeFalsy();
    expect(m.videos.countMissingInfo({ accountUid: MY_UID })).toBeGreaterThan(0);

    const id = queue.enqueue({ command: 'enrich', argv: ['--missing', '--limit', '20'], label: '补全视频信息' });
    const t = await waitTask(queue, id);
    expect({ status: t.status, error: t.error }).toMatchObject({ status: 'done', error: null });

    // 真的到了浏览器那一侧，而且表达式带的是这个视频 ID
    const call = fake.seen.find(c => c.name === 'getDetail');
    expect(call).toBeTruthy();
    expect(call.args).toEqual(['v_shell']);

    const v = m.videos.get('v_shell');
    expect(v.title).toBe('「v_shell」的真实标题');
    expect(v.coverUrl).toBe('https://p3.example/cover.jpg');
    expect(v.stats).toMatchObject({ plays: 1200, likes: 34, comments: 5, shares: 1 });

    // 角标读的是 countMissingInfo —— 补完必须掉下去，否则按钮会一直挂着
    expect(m.videos.countMissingInfo({ accountUid: MY_UID })).toBe(0);

    // 结果形状：TargetsView 报"补全 N/M 条"读的就是这几个字段
    const res = queue.getResult(id);
    expect(res).toMatchObject({ requested: 1, updatedCount: 1, failedCount: 0 });
  });

  // ═══════════════════════════════════════════════════════
  it('删除回复：抖音侧删掉之后本地真的回到待回复，界面读的 localRemoved/localUnmarked 有值', async () => {
    m.comments.upsert({ cid: 'q1', awemeId: 'v_shell', uid: 'u1', text: '求教程' });
    m.comments.markReplied('q1', 'v_shell', 'r1');
    m.comments.upsert({ cid: 'r1', awemeId: 'v_shell', uid: MY_UID, text: '在置顶', parentCid: 'q1' });
    m.corpus.append({
      srcCid: 'q1', srcText: '求教程', replyText: '在置顶',
      replyCid: 'r1', awemeId: 'v_shell', postedAt: Date.now(), outcome: 'published',
    });
    expect(m.comments.get('q1').replied).toBe(true);

    const id = queue.enqueue({
      command: 'delete-comment', argv: ['r1'], label: '删除我的回复',
      meta: { skipWait: true },
    });
    const t = await waitTask(queue, id);
    expect({ status: t.status, error: t.error }).toMatchObject({ status: 'done', error: null });

    const call = fake.seen.find(c => c.name === 'deleteComment');
    expect(call.args).toEqual(['r1']);

    expect(m.comments.get('r1')).toBeNull();
    expect(m.comments.get('q1')).toMatchObject({ replied: false, replyCid: null });
    // 队列写进 events 的名字必须是 delete_comment —— 风控按这个名字算间隔
    expect(m.riskControl.lastWriteTs()).toBeGreaterThan(0);

    const res = queue.getResult(id);
    expect(res).toMatchObject({ status: 'deleted', localRemoved: 1, localUnmarked: 1, localError: null });
  });

  it('删除回复：抖音那边报"评论已被删除"时，任务失败且本地一行都不许动', async () => {
    // 删的必须是自己发的那条 —— 否则会被下面的本地归属守卫拦下，压根到不了抖音
    m.comments.upsert({ cid: 'mine1', awemeId: 'v_shell', uid: MY_UID, text: '我自己发的评论' });
    bridgeState.deleteReply = { status_code: 2055, status_msg: '评论已被删除' };

    const id = queue.enqueue({
      command: 'delete-comment', argv: ['mine1'], label: '删除我的回复',
      meta: { skipWait: true },
    });
    const t = await waitTask(queue, id);

    expect(t.status).toBe('failed');
    // 服务端原话必须出现在错误里（用户据此判断是"已经没了"还是"没权限"）
    expect(t.error).toMatch(/2055/);
    expect(t.error).toMatch(/评论已被删除/);
    expect(m.comments.get('mine1')).not.toBeNull();
  });

  it('归属守卫真的生效：删别人发的评论在本地就拦下，请求不会送到浏览器', async () => {
    bridgeState.deleteReply = { deleted: true };
    const callsBefore = fake.seen.filter(c => c.name === 'deleteComment').length;

    // q1 是 u1 发的（上一条用例里我回过它）。抖音那边也会拒，但错误是
    // "网络请求失败"级别的，用户看不出是账号不对 —— 所以本地先判一次。
    //
    // 守卫靠 resolveExecutor 从**桥接**拿"浏览器现在登的是谁"（刻意不看 ctx.accountUid，
    // 那只是界面想操作谁的列表）。/api/status 的 connections 是按 site 分组的对象，
    // 而 aliveUids 用 for…of 遍历它 —— 抛出的 TypeError 曾被 resolveCurrent 的 catch
    // 当成"桥接不可用"吞掉，于是 uid 恒为 null，守卫直接放行。修好形状之前，
    // 这条用例里的删除请求会真的发到浏览器去。
    const id = queue.enqueue({
      command: 'delete-comment', argv: ['q1'], label: '删除我的回复',
      meta: { skipWait: true },
    });
    const t = await waitTask(queue, id);

    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/不是当前账号发的/);
    expect(fake.seen.filter(c => c.name === 'deleteComment')).toHaveLength(callsBefore);
    expect(m.comments.get('q1')).not.toBeNull();
  });

  // ═══════════════════════════════════════════════════════
  it('发私信：两步（建会话→发消息）参数原样送到浏览器，结果带会话号，且写额度真的扣到了', async () => {
    const writesBefore = m.riskControl.lastWriteTs();

    const id = queue.enqueue({
      command: 'dm', argv: ['send', 'u42', '你好，看到你的评论，想交流一下'], label: '发私信',
      meta: { skipWait: true },
    });
    const t = await waitTask(queue, id);
    expect({ status: t.status, error: t.error }).toMatchObject({ status: 'done', error: null });

    const names = fake.seen.map(c => c.name);
    expect(names).toEqual(['createConversation', 'sendDM']);
    expect(fake.seen[0].args).toEqual(['u42']);
    // 会话标识三段拼起来，缺任何一段抖音那边都认不出会话
    expect(fake.seen[1].args[0]).toBe('conv-u42-000123|77|tk');
    expect(fake.seen[1].args[1]).toBe('你好，看到你的评论，想交流一下');

    const res = queue.getResult(id);
    // UserView 完成提示读 conversation_id（尾号给用户对齐抖音里的会话）
    expect(res).toMatchObject({ conversation_id: 'conv-u42-000123', status: 'sent' });

    // 这轮修的正是"私信对闸门不可见"：events 里没有 dm.send 那一行时，
    // lastWriteTs() 会一直停在删除回复那一刻
    const rows = m.events.query({ command: 'dm.send' });
    expect(rows.length).toBeGreaterThan(0);
    expect(m.riskControl.lastWriteTs()).toBeGreaterThan(writesBefore);
  });

  it('发私信：抖音回了一个 error_desc（protobuf 里没有 status_code）必须报失败', async () => {
    // 请求成功往返，但响应内容说没发出去 —— 老代码正是把这种当成"已发出"，
    // 因为它判的是 HTTP 那套 data.status_code，而 IM 的解码结果里没有这个键
    bridgeState.dmError = 'frequency limit exceeded';

    const id = queue.enqueue({
      command: 'dm', argv: ['send', 'u42', '再发一条'], label: '发私信',
      meta: { skipWait: true },
    });
    const t = await waitTask(queue, id);
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/frequency limit/);
    // 抖音确实收到了那条 send 请求 —— 失败在判定环节，不在链路上
    expect(fake.seen.some(c => c.name === 'sendDM')).toBe(true);
  });

  // ═══════════════════════════════════════════════════════
  it('表达式里的参数含引号与换行时，浏览器那一侧照样能 eval 回来', async () => {
    // 走真链路的意义之一：转义函数没被调用点绕过。
    // 删除的 cid 来自库里，正常不会有换行；私信正文是用户手打的，什么都有。
    const nasty = "第一行\n带'引号'与\"双引号\"\n第三行";
    const id = queue.enqueue({
      command: 'dm', argv: ['send', 'u42', nasty], label: '发私信',
      meta: { skipWait: true },
    });
    const t = await waitTask(queue, id);
    expect(t.status).toBe('done');
    const sent = fake.seen.filter(c => c.name === 'sendDM').pop();
    expect(sent.args[1]).toBe(nasty);
  });

  it('界面读数与链路结果同一口径：待补全角标随补全归零，列表里的标题真的变了', async () => {
    m.videos.markGet('v_shell2', { accountUid: MY_UID });
    // 一条评论都没有的空壳视频不算"运营对象"（listTargets 会过滤掉），
    // 所以要真落一条评论，它才会出现在列表里
    m.comments.upsert({ cid: 'c-shell2', awemeId: 'v_shell2', uid: 'u1', text: '怎么做的' });

    const before = m.views.listTargets({ limit: 50, accountUid: MY_UID });
    expect(before.missingInfoCount).toBe(1);

    const t = await waitTask(queue, queue.enqueue({ command: 'enrich', argv: ['--missing', '--limit', '20'] }));
    expect(t.status).toBe('done');

    const after = m.views.listTargets({ limit: 50, accountUid: MY_UID });
    expect(after.missingInfoCount).toBe(0);
    expect((after.items.find(x => x.awemeId === 'v_shell2') || {}).title)
      .toBe('「v_shell2」的真实标题');
  });

  // ═══════════════════════════════════════════════════════
  // 放在最后：这条会留下一个没有标题的视频壳，前面那条"待补全角标"会把它数进去
  it('拉取评论：归属账号记的是浏览器当前登录的那个（运营对象页按号隔离全靠这一列）', async () => {
    const id = queue.enqueue({ command: 'get', argv: ['v_pull'], label: '拉取评论' });
    const t = await waitTask(queue, id);
    expect({ status: t.status, error: t.error }).toMatchObject({ status: 'done', error: null });

    const call = fake.seen.find(c => c.name === 'getComments');
    expect(call).toBeTruthy();
    expect(call.args).toEqual(['v_pull', 0, 20]);

    expect(m.comments.get('g1')).toMatchObject({ awemeId: 'v_pull', uid: 'u9' });
    // 这一列以前恒为 null：`get` 用的是 resolveExecutor（只认桥接），而桥接状态
    // 的形状对不上 → uid 取不到 → 归属写空。于是"换了号列表还停在原来那个号"
    // 只能靠 post 写上的那几个视频才正常。
    expect(m.videos.get('v_pull')).toMatchObject({ opsUid: MY_UID });
  });
});
