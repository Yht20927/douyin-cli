import React, { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import QueueView from './views/QueueView.jsx';
import WorksView from './views/WorksView.jsx';
import WorkspaceView from './views/WorkspaceView.jsx';
import DraftsView from './views/DraftsView.jsx';
import ConnectionView from './views/ConnectionView.jsx';
import DiagnosticsView from './views/DiagnosticsView.jsx';

export default function App() {
  const [info, setInfo] = useState(null);
  const [status, setStatus] = useState(null);
  const [queueState, setQueueState] = useState(null);

  // view 决定主区渲染哪个页面；workspaceId 非空时优先显示工作台
  const [view, setView] = useState('queue');
  const [workspaceId, setWorkspaceId] = useState(null);

  const [videos, setVideos] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [loadingDrafts, setLoadingDrafts] = useState(false);

  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const everConnected = useRef(false);

  // ── 数据读取（本地 SQLite，不走队列）──
  const reloadVideos = useCallback(async () => {
    setLoadingVideos(true);
    try {
      const r = await window.dy.data.videos(50);
      setVideos(r.ok ? r.data : []);
    } finally { setLoadingVideos(false); }
  }, []);

  const reloadDrafts = useCallback(async () => {
    setLoadingDrafts(true);
    try {
      const r = await window.dy.data.drafts();
      setDrafts(r.ok ? r.data : []);
    } finally { setLoadingDrafts(false); }
  }, []);

  useEffect(() => {
    let cancelled = false;

    window.dy.info().then((i) => { if (!cancelled) setInfo(i); });
    window.dy.bridge.status().then((s) => { if (!cancelled) applyStatus(s); });
    window.dy.queue.state().then((q) => { if (!cancelled && q) setQueueState(q); });
    reloadVideos();

    const unStatus = window.dy.bridge.onStatusChanged((s) => applyStatus(s));
    const unQueue = window.dy.queue.onChanged((payload) => {
      setQueueState({ tasks: payload.tasks, stats: payload.stats, policy: payload.policy });
    });

    return () => { cancelled = true; unStatus(); unQueue(); };
  }, [reloadVideos]);

  function applyStatus(s) {
    if (s && s.online) everConnected.current = true;
    setStatus(s);
  }

  function flash(message) {
    setToast(message);
    setTimeout(() => setToast(null), 3200);
  }

  const actions = {
    /**
     * 入队并返回任务 id —— 调用方靠它跟踪自己那个任务的完成情况。
     *
     * 必须是 async：首版写成同步返回，而 id 要等 IPC 回来才有，
     * 调用方（工作台）拿它当跟踪句柄，实际拿到的是 null，联动刷新全部失效。
     */
    async enqueue(spec) {
      const r = await window.dy.queue.enqueue(spec);
      if (!r.ok) { flash(r.error || '入队失败'); return null; }
      return r.id;
    },

    async runCommand(spec) {
      if (spec.afterDone === 'refreshVideos') {
        const r = await window.dy.queue.enqueue(spec);
        if (r.ok) {
          // 等它跑完再刷新，否则刷到的是旧数据
          flash('已加入队列 —— 完成后列表会自动刷新');
          trackTask(r.id, reloadVideos);
        } else flash(r.error || '入队失败');
        return;
      }
      const r = await window.dy.queue.enqueue(spec);
      if (!r.ok) flash(r.error || '入队失败');
    },

    async cancelTask(id) { await window.dy.queue.cancel(id); },

    openWorkspace(awemeId) { setWorkspaceId(awemeId); },
    backToWorks() { setWorkspaceId(null); reloadVideos(); },

    async openDouyin() {
      return withBusy(async () => {
        await window.dy.openExternal('https://www.douyin.com');
        flash('已打开抖音 —— 确认已登录，并保持页面开着');
      });
    },

    async refresh() { return withBusy(() => window.dy.bridge.refresh()); },

    async copyUserscriptUrl() {
      const r = await window.dy.bridge.copyUserscriptUrl();
      flash(r.ok ? '安装地址已复制' : (r.error || '复制失败'));
    },

    async quit() { await window.dy.quit(); },

    // 界面用的只读派生值
    get canQueue() { return !!(status && status.online); },
  };

  /** 等某个任务结束后执行回调（用于"跑完自动刷新"这类联动） */
  const trackers = useRef(new Map());
  function trackTask(taskId, cb) {
    trackers.current.set(taskId, cb);
  }
  useEffect(() => {
    if (!queueState) return;
    for (const [id, cb] of [...trackers.current.entries()]) {
      const t = (queueState.tasks || []).find(x => x.id === id);
      if (t && ['done', 'failed', 'blocked', 'cancelled'].includes(t.status)) {
        trackers.current.delete(id);
        if (t.status === 'done') { try { cb(); } catch (e) { /* 刷新失败不影响主流程 */ } }
      }
    }
  }, [queueState]);

  async function withBusy(fn) {
    setBusy(true);
    try { return await fn(); } finally { setBusy(false); }
  }

  const counts = (queueState && queueState.stats && queueState.stats.counts) || {};
  const activeCount = (counts.pending || 0) + (counts.running || 0) + (counts.waiting || 0);
  const draftCount = drafts.length;

  return (
    <div className="shell">
      <Sidebar
        view={workspaceId ? 'works' : view}
        onNavigate={(v) => { setWorkspaceId(null); setView(v); }}
        status={status}
        queueCount={activeCount}
        draftCount={draftCount}
        version={info && info.version}
        onQuit={actions.quit}
      />

      <main className="main">
        <div className="main-inner">
          {workspaceId
            ? (
              <WorkspaceView
                awemeId={workspaceId}
                queueState={queueState}
                actions={actions}
                onBack={actions.backToWorks}
              />
            )
            : (
              <>
                {view === 'queue' && <QueueView state={queueState} actions={actions} busy={busy} />}
                {view === 'works' && (
                  <WorksView videos={videos} loading={loadingVideos} actions={actions} />
                )}
                {view === 'drafts' && (
                  <DraftsView
                    drafts={drafts}
                    loading={loadingDrafts}
                    actions={actions}
                    reload={reloadDrafts}
                  />
                )}
                {view === 'connection' && <ConnectionView status={status} actions={actions} busy={busy} />}
                {view === 'diagnostics' && <DiagnosticsView info={info} status={status} actions={actions} />}
              </>
            )}
        </div>
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
