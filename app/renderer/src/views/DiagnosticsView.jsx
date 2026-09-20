import React, { useCallback, useEffect, useRef, useState } from 'react';
import LoadingState from '../components/LoadingState.jsx';
// ago 收的是**毫秒时间戳**（events.ts 就是），不要传 ISO 字符串
import { ago } from '../format.js';

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
 * 诊断。正常使用时不需要看，但出问题时是唯一能自查的地方：
 * 数据到底存哪了、配置被回退成了什么、脚本源在不在。
 */
export default function DiagnosticsView({ info, status, actions }) {
  const warnings = (info && info.configWarnings) || [];

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
      setUpdate(r.ok ? r : { ok: false, error: r.error, current: r.current });
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
    return (
      <div className="main-col">
        <h1 className="page-title">诊断</h1>
        <LoadingState variant="text" label="正在读取运行环境…" />
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
                {update.ok
                  ? (update.hasUpdate
                    ? (
                      <>
                        有新版本 v{update.latest} ——
                        <button
                          className="btn btn-quiet"
                          style={{ marginLeft: 4, padding: '1px 8px', fontSize: 12 }}
                          onClick={() => window.dy.openExternal(update.url)}
                        >
                          打开发布页
                        </button>
                      </>
                    )
                    : '已是最新版本')
                  : `检查失败（${update.error}）—— 不影响使用，多半是网络到 GitHub 不通`}
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
          评论、操作记录、回复语料三张表都是**只增不减**的。这里按时间清掉旧的，
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
          <dd>{status && status.listening ? '运行中' : '未启动'}</dd>

          <dt>监听地址</dt>
          <dd>
            {status && status.url ? <code>{status.url}</code> : '—'}
            {status && status.url && <CopyBtn text={status.url} />}
          </dd>

          <dt>已连接</dt>
          <dd className="num">{status ? status.totalConnections : '—'} 个页面</dd>

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
