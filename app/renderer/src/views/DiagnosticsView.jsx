import React, { useCallback, useEffect, useRef, useState } from 'react';
import LoadingState from '../components/LoadingState.jsx';
// ago 收的是**毫秒时间戳**（events.ts 就是），不要传 ISO 字符串
import { ago, formatBytes } from '../format.js';

/**
 * 一键复制。
 *
 * 出问题时第一件事就是把数据目录、配置路径这些贴给别人看，而它们此前是
 * 裸 `<code>` —— 只能手工拖选，而路径夹在句子中间，"选中"本身就不容易。
 *
 * 反馈就地做在按钮上（换成「已复制」两秒），不弹全局 toast：
 * 复制是个小动作，弹一条盖住屏幕的提示比这个动作本身还重。
 *
 * 走主进程的剪贴板（`window.dy.app.copyText`）而不是 `navigator.clipboard`，
 * 理由见 app/main/ipc.js 里那段注释。
 */
function CopyBtn({ text, label = '复制' }) {
  const [state, setState] = useState(null);   // null | 'ok' | 'bad'
  const timer = useRef(null);
  // 组件卸载时清掉定时器：不清的话切页之后 setState 会打到已卸载的组件上
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    const r = await window.dy.app.copyText(text);
    setState(r && r.ok ? 'ok' : 'bad');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(null), 2000);
  }

  return (
    <button
      className="btn btn-quiet diag-copy"
      onClick={copy}
      disabled={!text}
      title={state === 'bad' ? '复制失败（系统剪贴板拒绝了）' : '复制到剪贴板'}
    >
      {state === 'ok' ? '已复制' : state === 'bad' ? '复制失败' : label}
    </button>
  );
}

/**
 * 检查更新之后的那几步。
 *
 * 改造前这里只有一句「有新版本 v2.1.0 —— [打开发布页]」。那不叫下一步：
 * 发布页上一排 `.exe` / `.dmg` / `.AppImage` / `source.zip`，运营者要自己猜
 * 哪个适配自己的系统；他也不知道装完数据还在不在（数据跟着安装目录走）、
 * 更不知道装之前该先备份。所以这一节把**只有主进程知道的事实**摊开：
 * `runtime.packaged`（装好的还是源码跑的）、`localAssets`（按平台+架构筛出来的那几个文件）。
 *
 * 判据不在这里重复一遍 —— `localAssets` 是 `core/shared/releaseAssets.js` 算的，
 * 与探针用的是同一个函数。界面只负责把它摆出来，认不出时**说认不出**。
 */
const OS_LABEL = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
const ARCH_LABEL = { x64: 'x64（64 位）', arm64: 'ARM 64 位' };

function UpdateGuide({ update, dataDir, onBackup }) {
  const runtime = update.runtime || {};
  const os = OS_LABEL[runtime.platform] || runtime.platform || '当前系统';
  const arch = ARCH_LABEL[runtime.arch] || runtime.arch || '';
  const all = Array.isArray(update.assets) ? update.assets : [];
  const mine = Array.isArray(update.localAssets) ? update.localAssets : [];
  const publishedTs = update.publishedAt ? Date.parse(update.publishedAt) : NaN;

  if (!update.ok) {
    return (
      <div className="notice notice-warn diag-update">
        <div>
          <b>这次没问到新版本：</b>{update.error || '未知原因'}
          <div className="muted">
            不影响正常使用 —— 这个检查只读发布页，不碰任何数据。
            想确认是不是网络问题，直接去发布页看一眼最快。
          </div>
          {update.releasesUrl && (
            <div className="diag-update-actions">
              <button className="btn btn-quiet" onClick={() => window.dy.openExternal(update.releasesUrl)}>
                打开发布页
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="diag-update">
      <div className="diag-update-head">
        <b>
          v{update.current} → <span className="num">v{update.latest}</span>
        </b>
        {Number.isFinite(publishedTs) && (
          <span className="muted">　发布于 {ago(publishedTs)}（{update.publishedAt.slice(0, 10)}）</span>
        )}
      </div>

      {update.notes
        ? (
          <>
            <pre className="diag-update-notes">{update.notes}</pre>
            {update.notesTruncated && (
              <div className="muted">—— 说明太长，这里只显示前一部分，全文在发布页。</div>
            )}
          </>
        )
        : <div className="muted">这个版本没写更新说明 —— 改了什么要去发布页看。</div>}

      <ol className="diag-update-steps">
        <li>
          <b>先备份一份</b>
          <span className="muted">
            　升级本身不删数据，但装到一半出事、或新版本要退回旧版时，这份备份是唯一的退路。
          </span>
          <div className="diag-update-actions">
            <button className="btn btn-quiet" onClick={onBackup}>备份数据库</button>
          </div>
        </li>

        <li>
          <b>下载适配自己机器的文件</b>
          <div className="muted">
            这台机器是 {os}{arch ? ` · ${arch}` : ''}
            {runtime.packaged ? '，跑的是装好的版本' : '，跑的是源码目录里的版本'}。
          </div>
          {mine.length > 0
            ? (
              <ul className="diag-update-files">
                {mine.map(a => (
                  <li key={a.url}>
                    <button className="btn btn-quiet" onClick={() => window.dy.openExternal(a.url)}>
                      下载 {a.name}
                    </button>
                    {a.size ? <span className="muted num">　{formatBytes(a.size)}</span> : null}
                  </li>
                ))}
              </ul>
            )
            : (
              <div className="muted">
                这一版发布了 {all.length} 个文件，我认不出哪个适配 {os}{arch ? ` · ${arch}` : ''} ——
                得你自己挑：{all.map(a => a.name).join('、') || '（一个文件都没有）'}
              </div>
            )}
        </li>

        {/* 源码跑的那份换不掉 —— 不写这一条，用户会以为下了包就是更新完了 */}
        {!runtime.packaged && (
          <li>
            <b>你现在跑的不是安装版</b>
            <div className="muted">
              从代码目录直接起的那份，下载新安装包<b>不会</b>把它换掉。
              要更新得回到你取代码的那一侧；想改用安装版就装一个然后以它为准 ——
              但那是<b>另一份数据</b>（见下一条），旧数据得靠上面那份备份导过去。
            </div>
          </li>
        )}

        <li>
          <b>装到<em>原来那个位置</em></b>
          <div className="muted">
            数据存在应用自己旁边：
            {dataDir ? <code className="diag-update-path">{dataDir}</code> : '（数据目录还没读回来）'}
            。装到新位置就是从零开始的另一份数据，看起来跟"作品和草稿全没了"一模一样。
            装的时候如果提示文件被占用，先把这个应用整个退出。
          </div>
        </li>
      </ol>

      <div className="muted diag-update-foot">
        这个应用不会自己更新 —— 检查只负责说有没有新版，下载安装要你来。
      </div>
    </div>
  );
}

/**
 * 后台读数清单：每一份都在 App.jsx 的失败账本里占一格（key 一致）。
 *
 * 为什么诊断页要列它：这几份读数失败时的默认画法都是**一句假话** ——
 * 侧栏「检测中」、队列页「没有任务」、作品页「还没有作品记录」。
 * 页面各自补了失败支之后，这里再给一处"今天到底哪几份没读回来"的汇总，
 * 用户不必挨个页面去撞。`retry` 必须是 actions 上真存在的函数，
 * 有护栏扫这一点（静态测试），否则这一节自己就成了那颗死按钮。
 */
const READ_SLOTS = [
  { key: 'status', label: '连接状态', where: '侧栏那一行与「连接」页顶部', retry: 'refresh' },
  { key: 'queue', label: '队列', where: '「队列」页整页与侧栏角标', retry: 'reloadQueue' },
  { key: 'account', label: '当前账号', where: '侧栏「当前账号」与所有按号过滤的数据', retry: 'reloadAccount' },
  { key: 'videos', label: '作品列表', where: '「我的作品」页与工作台入口', retry: 'reloadWorks' },
  { key: 'drafts', label: '草稿箱', where: '「草稿箱」页那一屏与侧栏那枚角标', retry: 'refreshDrafts' },
];

/** 诊断页那一节：把失败的读数逐行列出，每行一个真能重读的按钮 */
function ReadFailures({ failed, actions }) {
  if (failed.length === 0) return null;
  return (
    <section className="section">
      <h2 className="section-title" style={{ marginBottom: 12 }}>这几份读数这次没读回来</h2>
      <p className="muted chart-note" style={{ marginTop: 0 }}>
        它们在各页面上看起来像"没有"，其实是"没读到"。下面每一行都只重读那一份，不动任何数据。
      </p>
      <div className="list">
        {failed.map((f) => (
          <div className="diag-readfail" key={f.key}>
            <div>
              <b>{f.label}</b>
              <div className="sub">{f.where}</div>
              <div className="sub diag-readfail-why">{f.why}</div>
            </div>
            <button className="btn btn-quiet" onClick={() => actions[f.retry]()}>重新读取</button>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * 诊断。正常使用时不需要看，但出问题时是唯一能自查的地方：
 * 数据到底存哪了、配置被回退成了什么、脚本源在不在。
 */
export default function DiagnosticsView({ info, infoError, onRetryInfo, readErrors, status, actions }) {
  const warnings = (info && info.configWarnings) || [];
  // 账本没传也不该把这一页弄崩（这一页正是"别的地方崩了才来看"的地方）
  const failedReads = READ_SLOTS
    .map(f => ({ ...f, why: (readErrors || {})[f.key] }))
    .filter(f => f.why);
  // 桥接服务那一节的三行都从这一份 status 派生。null 有两种来历，
  // 说出来的话完全不同 —— 与侧栏/连接页同一条判据，只是这里词更短
  const statusUnknown = status ? null
    : ((readErrors || {}).status ? '没读回来' : '还在读…');

  // 更新检查是异步的网络请求，结果就地显示在这一行
  const [update, setUpdate] = useState(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState(null);

  // ── 操作历史 ──
  const [events, setEvents] = useState(null);
  // ── 清理 ──
  const [cleanupDays, setCleanupDays] = useState(90);
  const [preview, setPreview] = useState(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);

  async function checkUpdate() {
    setChecking(true);
    try {
      const r = await window.dy.app.checkUpdate();
      // **原样收下**，失败时也不挑字段重拼 —— 主进程失败分支特意带着 releasesUrl 回来
      // （网络不通时"打开发布页自己看一眼"恰恰是最需要的那一步），
      // 重拼一遍就等于把出口丢了。
      setUpdate(r);
    } catch (e) {
      // 走到这里说明这一次 IPC 整个没回来（不是"问到了但没有新版"）。
      // 没有这个分支的话，按钮点下去只是转一下又停下，一个字都不说。
      // releasesUrl 这里拿不到 —— 所以失败分支本就该在没有它的时候也只报理由，不假装知道出口。
      setUpdate({ ok: false, error: String((e && e.message) || e) });
    } finally {
      setChecking(false);
    }
  }

  const loadEvents = useCallback(async () => {
    const r = await window.dy.data.events({ limit: 40 });
    setEvents(r && r.ok ? r.data : []);
  }, []);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  /** 清理预演：先让用户看到"会删掉多少行" */
  async function dryRunCleanup() {
    setCleanupBusy(true);
    try {
      const r = await window.dy.data.cleanupPreview({ days: cleanupDays });
      if (r && r.ok) setPreview(r.data);
      else setNotice(`预演失败：${(r && r.error) || '未知错误'}`);
    } finally {
      setCleanupBusy(false);
    }
  }

  /**
   * 真正执行清理。
   *
   * 走**队列**（cleanup 命令），不是本地 IPC：它会删掉成千上万行，
   * 该有审计留痕、该能中途取消，也该和别的任务一样排在同一条队列里。
   */
  async function runCleanup() {
    const id = await actions.enqueue({
      command: 'cleanup',
      argv: ['--days', String(cleanupDays)],
      label: `清理 ${cleanupDays} 天前的数据`,
    });
    if (!id) return;
    setPreview(null);
    setNotice('已加入队列 —— 清理结果会显示在队列页；完成后这里的历史会重新读取');
    const un = window.dy.queue.onChanged((payload) => {
      const t = (payload.tasks || []).find(x => x.id === id);
      if (t && ['done', 'failed', 'blocked', 'cancelled'].includes(t.status)) {
        un();
        loadEvents();
        setNotice(t.status === 'done' ? '清理完成' : `清理未完成：${t.error || '未知原因'}`);
      }
    });
  }

  async function backupData() {
    const r = await window.dy.app.backupData();
    if (r.ok && !r.canceled) setNotice(`已备份到：${r.path}`);
    else if (!r.ok) setNotice(`备份失败：${r.error}`);
  }

  // 这一页是键值表，骨架屏占不出它的形状，所以走 text 形态。
  // 改造前这里**完全没有加载态**：读不到时每个字段渲染成一枚「…」，
  // 而那看起来像"这些值本来就是空的" —— 与"还在读"是两回事。
  if (!info) {
    // 「还在读」与「读失败了」是两种处境。只有前一种该转圈 ——
    // 后一直转圈等于这一页最该说话的时候不说话（app:info 没包 safe()，
    // 主进程任何一处抛出来都是一个 reject）。
    return (
      <div className="main-col">
        <h1 className="page-title">诊断</h1>
        {/* 运行环境读不到，不等于另外四份读数也读不到 —— 它们各走各的通道，
            这一节仍然要出现，否则"重新读取"这条路在这一页就断了 */}
        <ReadFailures failed={failedReads} actions={actions} />
        {infoError ? (
          <>
            <div className="notice notice-bad">
              <div>
                <b>读运行环境失败：</b>{infoError}
                <div className="muted" style={{ marginTop: 6 }}>
                  这一页的每一项都要从主进程读这一次才知道，读失败就没有任何一项能报 ——
                  包括这份失败本身出在哪。数据一条都没被动过，可以再读一次。
                </div>
                <div className="diag-update-actions">
                  <button className="btn" onClick={onRetryInfo}>重新读取</button>
                </div>
              </div>
            </div>
            <LoadingState variant="text" label="其余检查项在读回来之前一概不显示 —— 没有一项是「已知为正常」。" />
          </>
        ) : (
          <LoadingState variant="text" label="正在读取运行环境…" />
        )}
      </div>
    );
  }

  return (
    <div className="main-col">
      <h1 className="page-title">诊断</h1>
      <p className="page-sub">运行环境、数据位置与配置状态。出问题时先看这里。</p>

      {notice && <div className="notice"><div>{notice}</div></div>}

      {warnings.length > 0 && (
        <div className="notice notice-warn">
          <div>
            <b>配置里有非法值，已自动回退：</b>
            <ul>
              {warnings.map((w, i) => (
                <li key={i}><code>{w.key}</code> — {w.message}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {info && !info.sourceExists && (
        <div className="notice notice-bad">
          油猴脚本源文件缺失：<code>{info.sourceFile}</code>
          <br />安装包可能不完整，脚本相关的功能会失效。
        </div>
      )}

      <ReadFailures failed={failedReads} actions={actions} />

      <section className="section">
        <h2 className="section-title" style={{ marginBottom: 12 }}>运行环境</h2>
        <dl className="kv">
          <dt>版本</dt>
          <dd>
            v{info ? info.version : '…'}
            {/* 更新检查就放在版本旁边 —— 用户看到版本号时自然会想"是不是最新的" */}
            <button
              className="btn btn-quiet"
              style={{ marginLeft: 8, padding: '1px 8px', fontSize: 12 }}
              disabled={checking}
              onClick={checkUpdate}
            >
              {checking ? '检查中…' : '检查更新'}
            </button>
            {update && (
              <div className="sub">
                {!update.ok
                  ? `检查失败（${update.error || '未知原因'}）—— 不影响使用，多半是网络到发布页不通`
                  : !update.latest
                    ? '读到了发布页，但那边没给出版本号 —— 没法判断有没有新版'
                    : update.hasUpdate
                      ? <>有新版本 <b className="num">v{update.latest}</b> —— 下一步在下面的「更新」那一节</>
                      : <>已是最新（发布页 v{update.latest}，不比现在的 v{update.current} 新）</>}
              </div>
            )}
          </dd>

          <dt>运行时</dt>
          <dd className="num">
            {info ? `Electron ${info.electron} · Node ${info.node} · ${info.platform}` : '…'}
          </dd>

          <dt>数据目录</dt>
          <dd>
            <code>{info ? info.dataDir : '…'}</code>
            <CopyBtn text={info && info.dataDir} />
            <div className="sub">
              {info ? info.dataDirSource : ''}
              {/* 作品/评论/草稿全在这个目录里，备份和换机迁移都从这走 */}
              <button
                className="btn btn-quiet"
                style={{ marginLeft: 8, padding: '1px 8px', fontSize: 12 }}
                onClick={backupData}
              >
                备份数据库
              </button>
              <button
                className="btn btn-quiet"
                style={{ marginLeft: 4, padding: '1px 8px', fontSize: 12 }}
                onClick={() => window.dy.app.openDataDir()}
              >
                打开数据目录
              </button>
            </div>
          </dd>

          <dt>配置文件</dt>
          <dd>
            <code>{info ? info.configFile : '…'}</code>
            <CopyBtn text={info && info.configFile} />
          </dd>

          <dt>脚本源</dt>
          <dd>
            <code>{info ? info.sourceFile : '…'}</code>
            <CopyBtn text={info && info.sourceFile} />
            <div className="sub">{info && info.sourceExists ? '存在' : '缺失'}</div>
          </dd>
        </dl>

        {/* 「有新版本」之后要走的那几步。此前检查更新只给一句提示加一个浏览器按钮，
            等于把"该下哪个文件、装完数据还在不在、要不要先备份"全推给用户猜。 */}
        {update && (update.hasUpdate || !update.ok) && (
          <UpdateGuide update={update} dataDir={info && info.dataDir} onBackup={backupData} />
        )}
      </section>

      {/* ── 操作历史 ── */}
      <section className="section">
        <div className="section-head">
          <h2 className="section-title" style={{ marginBottom: 12 }}>最近的操作</h2>
          <button className="btn btn-quiet" onClick={loadEvents}>刷新</button>
        </div>
        {events === null
          ? <LoadingState variant="text" label="正在读取操作历史…" />
          : events.length === 0
            ? <div className="empty">还没有操作记录。</div>
            : (
              <div className="list">
                {events.map(e => (
                  <div className="row-item" key={e.id}>
                    <span
                      className="state-dot"
                      style={e.status === 'error' ? { background: 'var(--bad)' }
                        : e.status === 'running' ? { background: 'var(--text)' }
                          : { background: 'var(--ok)' }}
                    />
                    <div className="row-main">
                      <div className="row-title num">
                        {e.command}
                        {e.status === 'error' && <span className="tag tag-bad" style={{ marginLeft: 8 }}>失败</span>}
                      </div>
                      {e.error && <div className="row-sub text-bad">{e.error}</div>}
                    </div>
                    <div className="row-meta num">
                      {e.durationMs != null ? `${(e.durationMs / 1000).toFixed(1)}s` : ''}
                    </div>
                    <div className="row-meta num" style={{ minWidth: 86, textAlign: 'right' }}>
                      {ago(e.ts)}
                    </div>
                  </div>
                ))}
              </div>
            )}
        <p className="muted chart-note">
          所有命令的执行留痕（含失败），也是「失败模式」那张表的来源。只显示最近 40 条。
        </p>
      </section>

      {/* ── 数据清理 ── */}
      <section className="section">
        <h2 className="section-title" style={{ marginBottom: 12 }}>数据清理</h2>
        <p className="muted chart-note" style={{ marginTop: 0 }}>
          评论、操作记录、回复语料三张表都只增不减。这里按时间清掉旧的，
          让库不要一直长。（作品、草稿、用户资料不会被删。）
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <span className="muted" style={{ alignSelf: 'center' }}>保留最近</span>
          <input
            className="input settings-num"
            type="number"
            min={1}
            value={cleanupDays}
            onChange={e => { setCleanupDays(Math.max(1, Number(e.target.value) || 90)); setPreview(null); }}
          />
          <span className="muted" style={{ alignSelf: 'center' }}>天</span>
          <button className="btn" onClick={dryRunCleanup} disabled={cleanupBusy}>
            {cleanupBusy ? '预演中…' : '预演（只看会删多少）'}
          </button>
        </div>

        {preview && (
          <>
            <div className="notice notice-warn" style={{ marginTop: 12 }}>
              <div>
                会删除 <b className="num">{preview.events}</b> 条操作记录、
                <b className="num"> {preview.comments}</b> 条评论、
                <b className="num"> {preview.corpus}</b> 条回复语料
                （{preview.days} 天以前的）。<b>不可恢复</b> —— 建议先「备份数据库」。
              </div>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn btn-primary text-bad" onClick={runCleanup}>
                确认清理
              </button>
              <button className="btn btn-quiet" onClick={() => setPreview(null)}>取消</button>
            </div>
          </>
        )}
        <p className="muted chart-note">
          清理走队列（有审计留痕、可取消）。删掉的评论如果以后又被拉到，会重新入库。
        </p>
      </section>

      <section className="section">
        <h2 className="section-title" style={{ marginBottom: 12 }}>桥接服务</h2>
        <dl className="kv">
          <dt>状态</dt>
          {/* 「未启动」是一个结论，「没读回来」是另一个结论，两者不能共用一份 null：
              这一页是用户判断"到底是抖音没连上还是应用坏了"的唯一地方 */}
          <dd>{statusUnknown || (status.listening ? '运行中' : '未启动')}</dd>

          <dt>监听地址</dt>
          <dd>
            {status && status.url ? <code>{status.url}</code> : '—'}
            {status && status.url && <CopyBtn text={status.url} />}
          </dd>

          <dt>已连接</dt>
          <dd className="num">{statusUnknown || `${status.totalConnections} 个页面`}</dd>

          <dt>脚本地址</dt>
          <dd>
            {status && status.userscriptUrl
              ? (
                <>
                  <code>{status.userscriptUrl}</code>
                  <div className="sub">
                    换浏览器或换机器时，在装了 Tampermonkey 的浏览器里打开这个地址即可安装。
                    <button
                      className="btn btn-quiet"
                      style={{ marginLeft: 8, padding: '1px 8px', fontSize: 12 }}
                      onClick={actions.openUserscript}
                    >
                      一键安装
                    </button>
                    <button
                      className="btn btn-quiet"
                      style={{ marginLeft: 4, padding: '1px 8px', fontSize: 12 }}
                      onClick={actions.copyUserscriptUrl}
                    >
                      复制地址
                    </button>
                  </div>
                </>
              )
              : '—'}
          </dd>
        </dl>
      </section>
    </div>
  );
}
