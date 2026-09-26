// tests/ipc-update-and-history.test.js — 真调用 app/main/ipc.js 的三条读通道
//
// 为什么这一层要有测试（延续 tests/ipc-draft-update-many.test.js 的路子）
// ------------------------------------------------------------------
// `app:check-update` 是本轮「检查更新之后要说得清下一步」的数据来源：界面那一整节
// （哪个文件适配这台机器、说明有没有被截断、装的是安装版还是源码版）**全部**来自
// 这一个 handler 的返回。而它以前只测过"能不能编译"—— 于是有三种错都能活着：
//   - 版本号按字符串比 → "10.0.0" 比 "2.0.0" 小，用户永远被告知"已是最新"；
//   - localAssets 在界面或探针里各抄一份判据 → 三处对同一个包给出三种答案；
//   - 失败分支只回一句 error → 界面连"上哪儿自己看一眼"都给不出。
//
// `data:backup` 也算这条链路上：升级指引第一步就是"先备份"。它此前用
// copyFileSync 拷主文件，而库是 WAL 模式 —— 最近的写入还在 `-wal` 里，
// 拷出来的那份会少一段，界面却报"已备份到"。所以下面有一条专门盯它的用例。
//
// GitHub API 的响应形状照 `GET /repos/{owner}/{repo}/releases/latest` 的真实字段
// （tag_name / html_url / published_at / body / assets[].browser_download_url），
// 不是随手编的：假形状会让"读不到 browser_download_url 时退回 download_url"
// 这类分支恒为真而通过（§2.28 那一类假护栏）。

const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

describe('ipc 的检查更新 / 搜索历史 / 备份', () => {
  let tmpDir;
  let handlers;
  let call;
  let electronApp;
  let showSaveDialog;
  let fetchCalls;
  let fetchImpl;
  const realFetch = global.fetch;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-ipc-update-'));
    // ⚠️ 必须指定数据目录：这几条用例要写库（备份那一条还会读备份出来的文件），
    // 不设就会写到用户真库里去（test-isolation-data-dir）。
    process.env.DOUYIN_STORAGE_DIR = tmpDir;

    handlers = {};
    const noop = () => {};
    const ep = require.resolve('electron', { paths: [ROOT] });
    electronApp = {
      getVersion: () => '2.0.0',
      getPath: () => tmpDir,
      getName: () => 'app',
      on: noop,
      quit: noop,
      isPackaged: false,
      whenReady: () => Promise.resolve(),
    };
    showSaveDialog = async () => ({ canceled: true });
    require.cache[ep] = {
      id: ep, filename: ep, loaded: true,
      exports: {
        ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, removeHandler: noop },
        app: electronApp,
        shell: { openExternal: async () => true, showItemInFolder: noop, openPath: async () => '' },
        clipboard: { writeText: noop, readText: () => '' },
        dialog: {
          showMessageBox: async () => ({ response: 0 }),
          showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
          showSaveDialog: (...a) => showSaveDialog(...a),
        },
        BrowserWindow: class BrowserWindow { static getAllWindows() { return []; } },
        Menu: { setApplicationMenu: noop, buildFromTemplate: () => ({}) },
        nativeTheme: { on: noop },
      },
    };

    require('../app/main/ipc').registerIpc({
      bridge: {
        getStatus: () => ({ online: false, userscriptInstalled: false, connections: [] }),
        refresh: async () => ({}),
        getUserscriptUrl: () => 'http://127.0.0.1:1/user.js',
        subscribe: () => () => {},
      },
      dataDirInfo: { dir: tmpDir, source: 'env', fellBack: false },
      configWarnings: [],
    });
    call = (ch, ...args) => handlers[ch]({ sender: {} }, ...args);

    // 桩掉网络：断言"请求打到了哪儿、带没带 UA"由 fetchCalls 承担
    fetchCalls = [];
    global.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return fetchImpl();
    };
  });

  afterAll(() => {
    global.fetch = realFetch;
    try { require('../core/memory/db').closeDb(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    delete process.env.DOUYIN_STORAGE_DIR;
  });

  /** 按 GitHub releases/latest 的真形状造一个 200 响应 */
  function release(over = {}) {
    fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v2.5.0',
        html_url: 'https://github.com/o/r/releases/tag/v2.5.0',
        published_at: '2026-09-20T08:00:00Z',
        body: '修了发布前的图片校验',
        assets: [
          { name: 'douyinTool-Setup-2.5.0-x64.exe', size: 90000000, browser_download_url: 'https://dl/a.exe' },
          { name: 'douyinTool-2.5.0-x86_64.dmg', size: 80000000, browser_download_url: 'https://dl/a.dmg' },
          { name: 'douyinTool-2.5.0-linux-x86_64.AppImage', size: 100000000, browser_download_url: 'https://dl/a.appimage' },
          { name: 'douyinTool-2.5.0-linux-arm64.AppImage', size: 95000000, browser_download_url: 'https://dl/arm.appimage' },
          { name: 'source.zip', size: 1000000, browser_download_url: 'https://dl/src.zip' },
        ],
        ...over,
      }),
    });
  }

  // ── 1. 有没有新版 ────────────────────────────────────────
  it('远端 10.0.0 相对本地 2.0.0 算"有新版"（按字符串比就会反过来）', async () => {
    release({ tag_name: 'v10.0.0' });
    electronApp.getVersion = () => '2.0.0';
    const r = await call('app:check-update');
    expect(r).toMatchObject({ ok: true, hasUpdate: true, latest: '10.0.0', current: '2.0.0' });

    // 反向的一半：本地更新时不许催升级（这才叫"只说真话"）
    electronApp.getVersion = () => '10.0.0';
    release({ tag_name: 'v2.5.0' });
    const back = await call('app:check-update');
    expect(back).toMatchObject({ ok: true, hasUpdate: false, latest: '2.5.0' });
    electronApp.getVersion = () => '2.0.0';
  });

  it('tag_name 缺失或空串：latest=null、hasUpdate=false（界面据此说"没法判断"）', async () => {
    release({ tag_name: '' });
    const r = await call('app:check-update');
    expect(r.ok).toBe(true);
    expect(r.latest).toBeNull();
    expect(r.hasUpdate).toBe(false);
  });

  // ── 2. 该下哪个文件（判据只有一份）──────────────────────
  it('localAssets 只留本机平台+架构的那几个：arm64 的包不给 x64 机器', async () => {
    release();
    const r = await call('app:check-update');
    expect(r.runtime).toEqual({
      packaged: false, platform: process.platform, arch: process.arch,
    });
    const names = r.localAssets.map(a => a.name);
    // 与 core/shared/releaseAssets 同一判据：这里断言"挑出来的每一个都过",
    // 而不是硬编码某台机器的文件名 —— 否则换台机器就红。
    const { assetForThisMachine } = require('../core/shared/releaseAssets');
    expect(names.length).toBeGreaterThan(0);
    for (const a of r.assets.filter(x => names.includes(x.name))) {
      expect(assetForThisMachine(a.name, process.platform, process.arch)).toBe(true);
    }
    // 反向的一半：另一种架构一定不在其中（平台对、架构不对也算不适配）
    const other = process.arch === 'x64' ? 'arm64' : 'x64';
    for (const a of r.assets) {
      if (new RegExp(`-${other}\\b`).test(a.name)) {
        expect(names, `${a.name} 不该给 ${process.arch} 的机器`).not.toContain(a.name);
      }
    }
    expect(names).not.toContain('source.zip');   // 源码包不是"装好的机器"该下的
  });

  it('一台都对不上时 localAssets 是空数组 —— 不许硬凑一个给用户', async () => {
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => ({
        tag_name: 'v2.5.0', assets: [{ name: 'plan9.iso', browser_download_url: 'https://dl/p' }],
      }),
    });
    const r = await call('app:check-update');
    expect(r.assets.length).toBe(1);
    expect(r.localAssets).toEqual([]);
  });

  // ── 3. 说明与出口 ───────────────────────────────────────
  it('超长的更新说明截断并明说截断，短的原样给', async () => {
    release({ body: '长'.repeat(1500) });
    const r = await call('app:check-update');
    expect(r.notes.length).toBe(1200);
    expect(r.notesTruncated).toBe(true);

    release({ body: '就一句' });
    const s = await call('app:check-update');
    expect(s).toMatchObject({ notes: '就一句', notesTruncated: false });

    release({ body: undefined });
    expect((await call('app:check-update')).notes).toBe('');
  });

  it('没有 html_url 时 releasesUrl 兜底到仓库发布页（界面那颗按钮不能是 undefined）', async () => {
    release({ html_url: undefined, published_at: undefined });
    const r = await call('app:check-update');
    expect(r.releasesUrl).toBe('https://github.com/Yht20927/douyin-cli/releases');
    expect(r.publishedAt).toBeNull();
  });

  // ── 4. 失败也要有出口 ───────────────────────────────────
  it('HTTP 非 200 与网络异常都带 releasesUrl / runtime / current 回来', async () => {
    fetchImpl = async () => ({ ok: false, status: 502, json: async () => ({}) });
    const http = await call('app:check-update');
    expect(http.ok).toBe(false);
    expect(http.error).toContain('502');
    expect(http.releasesUrl).toBeTruthy();
    expect(http.current).toBe('2.0.0');
    expect(http.runtime.packaged).toBe(false);

    fetchImpl = async () => { throw new Error('fetch failed'); };
    const net = await call('app:check-update');
    expect(net.ok).toBe(false);
    expect(net.error).toContain('网络请求失败');
    expect(net.releasesUrl).toBeTruthy();
  });

  it('请求带的是 releases/latest，且带 User-Agent（GitHub 无 UA 一律 403）', async () => {
    release();
    await call('app:check-update');
    const last = fetchCalls[fetchCalls.length - 1];
    expect(last.url).toMatch(/\/releases\/latest$/);
    expect(last.opts.headers['User-Agent']).toBeTruthy();
  });

  it('runtime.packaged 报的是 app.isPackaged 的真值（源码跑与安装版是两条出路）', async () => {
    release();
    electronApp.isPackaged = true;
    expect((await call('app:check-update')).runtime.packaged).toBe(true);
    electronApp.isPackaged = false;
    expect((await call('app:check-update')).runtime.packaged).toBe(false);
  });

  // ── 5. 空态的搜索历史：参数要真的转发 ───────────────────
  it('data:searchHistory 把 limit / scan 递到 core，而不是在界面里数', async () => {
    const events = require('../core/memory/events');
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) {
      events.append({
        ts: t0 - i * 1000, command: 'search', status: 'success',
        args: { keyword: `历史词${i}`, offset: 0, count: 10 }, summary: { count: 5 },
      });
    }
    const r = await call('data:searchHistory', { limit: 2 });
    expect(r.ok).toBe(true);
    expect(r.data.items.length).toBe(2);
    expect(r.data.items[0].keyword).toBe('历史词0');
    expect((await call('data:searchHistory', { limit: 1, scan: 1 })).data.truncated).toBe(true);
    // 整个不传也不能炸（界面首屏就是这一条路）
    expect((await call('data:searchHistory')).data.items.length).toBeGreaterThan(0);
  });

  // ── 6. 升级指引的第一步：备份得真的能备到 ───────────────
  it('备份带得上 WAL 里还没落主文件的写入（copyFileSync 会静默少一段）', async () => {
    const drafts = require('../core/memory/drafts');
    const id = drafts.save({ awemeId: 'v-up', text: '升级前存的那条', accountUid: 'uidA' });
    // ⚠️ 这里**不能**做任何 checkpoint：WAL 的价值就是这条用例的靶子，
    // 一次 wal_checkpoint 会把写入刷进主文件，旧实现当场变绿。
    const target = path.join(tmpDir, 'backup-check.db');
    showSaveDialog = async () => ({ canceled: false, filePath: target });
    const r = await call('data:backup');
    expect(r.ok).toBe(true, r.error);
    expect(r.path).toBe(target);

    const { DatabaseSync } = require('node:sqlite');
    const probe = new DatabaseSync(target, { readOnly: true });
    try {
      const row = probe.prepare('SELECT text FROM drafts WHERE id = ?').get(id);
      expect(row && row.text, '备份里没有刚写入的那条草稿').toBe('升级前存的那条');
    } finally {
      probe.close();
    }
    // 变异检查做过：把 handler 换回 fs.copyFileSync(dbFile, target) 后，
    // 这一条红 —— 主文件当时只有 4KB，全部写入都还在 230KB 的 WAL 里。
  });

  it('目标文件已存在也能备成功（VACUUM INTO 拒绝覆盖，所以走临时文件 + rename）', async () => {
    const target = path.join(tmpDir, 'backup-overwrite.db');
    fs.writeFileSync(target, '不是数据库的旧内容');
    showSaveDialog = async () => ({ canceled: false, filePath: target });
    const r = await call('data:backup');
    expect(r.ok).toBe(true, r.error);
    const { DatabaseSync } = require('node:sqlite');
    const probe = new DatabaseSync(target, { readOnly: true });
    try {
      expect(probe.prepare('SELECT count(*) AS n FROM drafts').get().n).toBeGreaterThanOrEqual(1);
    } finally {
      probe.close();
    }
    // 临时文件不许留在原地（失败了也要清）
    expect(fs.readdirSync(tmpDir).filter(f => f.includes('.tmp-'))).toEqual([]);
  });

  it('用户在保存框里点取消：ok:true + canceled:true，不许报"已备份"', async () => {
    showSaveDialog = async () => ({ canceled: true });
    const r = await call('data:backup');
    expect(r).toMatchObject({ ok: true, canceled: true });
    expect(r.path).toBeUndefined();
  });
});
