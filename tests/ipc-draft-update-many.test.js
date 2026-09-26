// tests/ipc-draft-update-many.test.js — 真调用 app/main/ipc.js 的 draft:update-many
//
// 为什么这个文件值得存在
// ---------------------
// 第十九轮交接时我在 `开发进度.md` 里写了一条验证边界：「ipc handler 里的形状
// 转换（core 的 `{changed: [...ids], skipped, preview}` → 界面的 `{changed: N, …}`）
// 只有真跑一次应用才走得到」。写完这个文件才发现**不必真跑**：把 `electron`
// 塞进 require.cache，就能把 57 个通道收下来逐个调用，跑的是真 core + 真临时库。
//
// 而这一层恰好是本仓最容易藏缺陷的地方：它上下两头都各自被测过（core 有行为测试、
// 界面有静态护栏），**中间这一次转换谁都没碰**。转换里最容易出的两种错都不报错：
//   - 把 `changed` 数组原样透出去 → 界面 `${editData.changed}` 渲染成 "1,2,3"；
//   - 把 preview 在执行时也带出去 → 一次 IPC 里塞 200 条正文全文。
// 这两种都能过上面所有测试。
//
// 夹具的账号形状照 `core/memory/accounts.js` 的 `aliveUids()` 实际读的样式
// （`connections[].account.uid` + `alive`），不是随手编的：假的 connections
// 会让 currentAccountUid() 恒为 null，于是"越权改不到别的号"这条护栏
// 在假夹具下**恒为真**（§2.28 那一类假护栏）。
//
// ⚠️ `call()` 是 async：第二十二轮把 `safe()` 改成 await 之后，凡是走 safe()
// 的通道都返回 Promise。这本身就是要测的东西 —— 见最后那条「safe() 兜得住异步抛出」。

const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

describe('ipc 的 draft:update-many：core → 界面的那一次形状转换', () => {
  let tmpDir;
  let handlers;
  let call;
  let drafts;
  let views;
  let ids;
  /** 当前"连着"的号。null = 一个都没连上，也没存过 current */
  let onlineUid;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-ipc-drafts-'));
    process.env.DOUYIN_STORAGE_DIR = tmpDir;

    handlers = {};
    const noop = () => {};
    // ipc.js 顶层就解构了 ipcMain / app / shell…，必须在 require 它之前把假模块放好。
    // 按项目根解析，否则拿到的不是 ipc.js 那一句 require('electron') 命中的同一个文件。
    const ep = require.resolve('electron', { paths: [ROOT] });
    require.cache[ep] = {
      id: ep, filename: ep, loaded: true,
      exports: {
        ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, removeHandler: noop },
        app: {
          getVersion: () => '0.0.0', getPath: () => tmpDir, getName: () => 'app',
          on: noop, quit: noop, isPackaged: false, whenReady: () => Promise.resolve(),
        },
        shell: { openExternal: async () => true, showItemInFolder: noop, openPath: async () => '' },
        clipboard: { writeText: noop, readText: () => '' },
        dialog: {
          showMessageBox: async () => ({ response: 0 }),
          showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        },
        BrowserWindow: class BrowserWindow { static getAllWindows() { return []; } },
        Menu: { setApplicationMenu: noop, buildFromTemplate: () => ({}) },
        nativeTheme: { on: noop },
      },
    };

    drafts = require('../core/memory/drafts');
    views = require('../core/data/views');
    onlineUid = 'uidA';
    const bridge = {
      getStatus: () => ({
        online: !!onlineUid,
        userscriptInstalled: true,
        connections: onlineUid
          ? [{ id: 'c1', alive: true, account: { uid: onlineUid, nickname: '甲号' } }]
          : [],
      }),
      refresh: async () => bridge.getStatus(),
      getUserscriptUrl: () => 'http://127.0.0.1:1/user.js',
      subscribe: () => () => {},
    };
    require('../app/main/ipc').registerIpc({
      bridge,
      dataDirInfo: { dir: tmpDir, source: 'env', fellBack: false },
      configWarnings: [],
    });
    // handler 的第一个实参是 IpcMainInvokeEvent，本文件从不读它
    call = async (ch, ...args) => handlers[ch]({ sender: {} }, ...args);

    ids = {
      a1: drafts.save({ awemeId: 'v1', text: '甲号一', accountUid: 'uidA' }),
      a2: drafts.save({ awemeId: 'v1', text: '甲号二 (1)', accountUid: 'uidA' }),
      a3: drafts.save({ awemeId: 'v2', text: '甲号三', accountUid: 'uidA' }),
      b1: drafts.save({ awemeId: 'v1', text: '乙号一', accountUid: 'uidB' }),
      orphan: drafts.save({ awemeId: 'v1', text: '没标归属的一条' }),
      posted: (() => {
        const id = drafts.save({ awemeId: 'v1', text: '已经发掉的', accountUid: 'uidA' });
        drafts.markPosted(id);
        return id;
      })(),
      withImage: drafts.save({ awemeId: 'v1', text: '带图的', imagePath: '/tmp/x.png', accountUid: 'uidA' }),
    };
  });

  afterAll(() => {
    try { require('../core/memory/db').closeDb(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
    delete process.env.DOUYIN_STORAGE_DIR;
  });

  const text = (id) => (drafts.get(id) || { text: '(没了)' }).text;
  const all = () => [ids.a1, ids.a2, ids.a3, ids.b1, ids.orphan, ids.posted, ids.withImage];

  it('通道确实注册了（假 electron 生效，否则本文件全是假绿）', () => {
    expect(Object.keys(handlers).length).toBeGreaterThan(40);
    expect(typeof handlers['draft:update-many']).toBe('function');
  });

  // ── 1. 转换本身 ──────────────────────────────────────────
  it('changed 是**条数**不是 id 数组；界面那句「已改动 N 条」靠的就是这一处', async () => {
    const r = await call('draft:update-many', [ids.a1], { text: '改过了' });
    expect(r.ok).toBe(true);
    expect(typeof r.data.changed).toBe('number');
    expect(r.data.changed).toBe(1);
    expect(Array.isArray(r.data.changed)).toBe(false);
    await call('draft:update-many', [ids.a1], { text: '甲号一' });   // 还原，别污染后面的用例
  });

  it('预览带 preview，执行一定带空数组（执行时 200 条全文过 IPC 没有意义）', async () => {
    const p = await call('draft:update-many', [ids.a1, ids.a2], { find: '号', replace: 'X' }, { dryRun: true });
    expect(p.data.preview.length).toBe(2);
    expect(p.data.preview[0]).toMatchObject({ id: ids.a1, from: '甲号一', to: '甲X一' });
    // 执行那一次必须挑一个**真的会改动**的查找词。早先用的是不命中的词，plan 本身
    // 就是空的 —— 于是"执行时也把 preview 带出去"这个坏版本照样绿（§2.28 的假护栏）
    const e = await call('draft:update-many', [ids.a1, ids.a2], { find: '号', replace: 'X' });
    expect(e.data.changed).toBe(2);                // 先确认这一次确实动了笔
    expect(e.data.preview).toEqual([]);            // 而明细一条都没往回传
    // 还原：后面那条用例要拿同一批行再算一次预览
    await call('draft:update-many', [ids.a1], { text: '甲号一' });
    await call('draft:update-many', [ids.a2], { text: '甲号二 (1)' });
  });

  it('预览与执行说的是同一个数：转换没有把判定改歪', async () => {
    const prev = (await call('draft:update-many', all(), { find: '号', replace: 'X' }, { dryRun: true })).data;
    const run = (await call('draft:update-many', all(), { find: '号', replace: 'X' })).data;
    // changed / requested / skipped 逐项相等 —— 界面「会改动 N 条」与「另有 M 条不动」
    // 全部来自这三个数，任何一处不相等都是一句假话
    expect(run.changed).toBe(prev.changed);
    expect(run.requested).toBe(prev.requested);
    expect(run.skipped).toEqual(prev.skipped);
    // 而"改了"必须真的落到库里，不只是数字对
    expect(text(ids.a1)).toBe('甲X一');
    expect(text(ids.a3)).toBe('甲X三');
  });

  it('core 抛出的两种非法 patch 原样变成 {ok:false,error}，中文理由不被吞掉', async () => {
    const both = await call('draft:update-many', [ids.a1], { text: 'a', find: 'b', replace: 'c' });
    expect(both.ok).toBe(false);
    expect(both.error).toContain('只能选一种');
    const none = await call('draft:update-many', [ids.a1], {});
    expect(none.ok).toBe(false);
    expect(none.error).toContain('没有要改的内容');
  });

  // ── 2. 账号边界：只能由主进程补，且渲染层覆盖不了 ──────────
  it('渲染层在 opts 里塞 accountUid 也改不到别的号（展开顺序必须是 ...opts 在前）', async () => {
    const r = await call('draft:update-many', [ids.b1], { text: '被越权改了' }, { accountUid: 'uidB' });
    expect(r.data.changed).toBe(0);
    expect(r.data.skipped.foreign).toBe(1);
    expect(text(ids.b1)).toBe('乙号一');
    // 反向的一半：换成"没标归属"的那条也改不到（无法判断归属就不该动）
    const o = await call('draft:update-many', [ids.orphan], { text: '被越权改了' }, { accountUid: 'uidA' });
    expect(o.data.skipped.foreign).toBe(1);
    expect(text(ids.orphan)).toBe('没标归属的一条');
  });

  it('没连上任何号时：账号校验整个消失 —— 而这一屏**确实**把那些行列出来了', async () => {
    // 钉的是既有口径（list / delete-many / update-many 三处同一个），不是本轮新引入：
    // currentAccountUid() 为 null 时 core 不做账号过滤。它之所以还算诚实，唯一的
    // 支撑就是"看得见 == 改得动"。哪天 list 改成按号过滤，这一条必须跟着改。
    onlineUid = null;
    const box = views.listDrafts({ posted: false });
    const listed = box.items.map(d => d.id);
    expect(listed).toContain(ids.b1);        // 界面上列得出来
    const r = await call('draft:update-many', [ids.b1], { text: '断开时改的' });
    expect(r.data.changed).toBe(1);          // 所以这里改得动
    expect(text(ids.b1)).toBe('断开时改的');
    // 与批量删除同一个口径（否则"删得掉"与"改得动"又是两套规矩）
    expect((await call('draft:delete-many', [ids.b1])).data.deleted).toBe(1);
    onlineUid = 'uidA';
  });

  // ── 3. 净化只有一份 ──────────────────────────────────────
  it('requested 说的是**净化后**的条数：ipc 不再抄一遍，两处才不会对不上', async () => {
    // 先读回当前正文再原样提交：前面那条用例真的改过这一行，硬编码正文
    // 会让"本来就是这样的"变成"确实改了一次"，noop 就成了碰巧
    const cur = text(ids.a3);
    const r = await call('draft:update-many', [0, -1, 1.5, 'abc', null, undefined, ids.a3], { text: cur });
    expect(r.data.requested).toBe(1);        // 只有 ids.a3 活下来
    expect(r.data.skipped.noop).toBe(1);     // 而它本来就是这样的
    expect(r.data.changed).toBe(0);
    expect(text(ids.a3)).toBe(cur);
    expect((await call('draft:update-many', [], { text: 'z' })).data).toMatchObject(
      { changed: 0, requested: 0, preview: [] });
  });

  it('opts 整个不传也照样执行（单条编辑就是这一条路）', async () => {
    const r = await call('draft:update-many', [ids.withImage], { text: '' });
    expect(r.data.changed).toBe(1);
    // 带附图的允许改成空：发出去不是一条空评论。没有附图时 core 会拦成 skipped.empty
    expect(text(ids.withImage)).toBe('');
    expect((await call('draft:update-many', [ids.a3], { text: '  ' })).data.skipped.empty).toBe(1);
  });

  it('一次改 200 条不炸（SQL 参数上限与净化都要吃得下这个量）', async () => {
    const many = [];
    for (let i = 0; i < 200; i++) many.push(drafts.save({ awemeId: 'v-bulk', text: `原始 ${i}`, accountUid: 'uidA' }));
    const r = await call('draft:update-many', many, { find: '原始', replace: '已改' });
    expect(r.ok).toBe(true);
    expect(r.data.changed).toBe(200);
    expect(text(many[0])).toBe('已改 0');
    expect(text(many[199])).toBe('已改 199');
    // 界面只画前 6 条明细，但"另外 M 条"要靠 preview 的长度算 —— 所以这里是全量
    const p = await call('draft:update-many', many, { find: '已改', replace: '已改过' }, { dryRun: true });
    expect(p.data.preview.length).toBe(200);
  });

  // ── 4. safe() 对异步抛出的形状（第二十二轮）────────────────
  //
  // 原版 `safe` 是同步 try/catch。包到 async fn 上时 catch 住的是一个 Promise：
  // 它不抛，于是返回 `{ ok: true, data: <Promise> }`，而 Promise 过 IPC 序列化后
  // 什么都不剩 —— 渲染层拿到 `{ ok: true, data: {} }`。**一次失败被报成一次
  // 成功**，而全应用界面只按 `r.ok` 判断可信不可信。这几条在 handler 层面钉住它，
  // 因为上面所有用例喂的都是同步 core，碰不到这条路径。
  // ⚠️ 传的是**取模块的函数**不是模块本身：这几条在收集用例阶段就求值，
  // 那时 beforeAll 还没 require 过 core，直接传 `views` 会拿到 undefined。
  const rejectFrom = (host, key, prefix) => () => {
    const obj = host();
    const orig = obj[key];
    obj[key] = () => Promise.reject(new Error(`${prefix}：异步抛出的读失败`));
    return () => { obj[key] = orig; };
  };
  const asyncCase = (label, stub, callArgs) =>
    it(label, async () => {
      const restore = stub();
      try {
        const r = await call(...callArgs);
        expect(r.ok).toBe(false);
        expect(r.error).toContain('异步抛出的读失败');
        // 坏版本在这里是 {ok:true, data:Promise}：光断言 ok=false 就够它红，
        // 这一条是把"为什么够"写下来，免得后人以为漏了什么
        expect(r.data).toBeUndefined();
      } finally {
        restore();
      }
    });

  asyncCase('core 异步抛出时 data:drafts 必须是 {ok:false}，不能是 {ok:true,data:{}}',
    rejectFrom(() => views, 'listDrafts', '草稿箱'), ['data:drafts', {}]);
  asyncCase('同一件事对 data:targets 也成立：一条判据不该只覆盖一张表',
    rejectFrom(() => views, 'listTargets', '运营对象'), ['data:targets', {}]);
  // 为什么没有 data:videos 这一条：它的 handler 体是**同步**取完再拼对象的
  // （`const items = views.listMyVideos(...)` 后面还有 `count()`），
  // Promise 在 handler 内部就被当成数组用掉了，`safe()` 根本看不见它 ——
  // 它会返回 `{ok:true, data:{items:<Promise>}}`。异步化真正救到的只有
  // "直接把 core 的返回递出去"那一类 handler。这条边界写在这里，
  // 免得后人以为这两条用例覆盖了全部 data:* 通道。

  it('异步化没把正常路径改坏：data 仍是 core 返回的那个对象本身', async () => {
    const r = await call('data:drafts', { posted: false });
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data.items)).toBe(true);
    expect(typeof r.data.total).toBe('number');
  });
});
