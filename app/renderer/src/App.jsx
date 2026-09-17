import React, { useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import QueueView from './views/QueueView.jsx';
import ConnectionView from './views/ConnectionView.jsx';
import DiagnosticsView from './views/DiagnosticsView.jsx';

export default function App() {
  const [info, setInfo] = useState(null);
  const [status, setStatus] = useState(null);
  const [queueState, setQueueState] = useState(null);
  const [view, setView] = useState('queue');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const everConnected = useRef(false);

  useEffect(() => {
    let cancelled = false;

    window.dy.info().then((i) => { if (!cancelled) setInfo(i); });
    window.dy.bridge.status().then((s) => { if (!cancelled) applyStatus(s); });
    window.dy.queue.state().then((q) => { if (!cancelled && q) setQueueState(q); });

    const unStatus = window.dy.bridge.onStatusChanged((s) => applyStatus(s));
    const unQueue = window.dy.queue.onChanged((payload) => {
      // 队列事件里已带上最新策略快照，一次替换掉整块状态 ——
      // 分成两次 setState 会让界面短暂显示不一致的组合
      setQueueState({ tasks: payload.tasks, stats: payload.stats, policy: payload.policy });
    });

    return () => { cancelled = true; unStatus(); unQueue(); };
  }, []);

  function applyStatus(s) {
    if (s && s.online) everConnected.current = true;
    setStatus(s);
  }

  function flash(message) {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  }

  async function withBusy(fn) {
    setBusy(true);
    try { return await fn(); } finally { setBusy(false); }
  }

  const actions = {
    async openDouyin() {
      return withBusy(async () => {
        await window.dy.openExternal('https://www.douyin.com');
        flash('已打开抖音 —— 确认已登录，并保持页面开着');
      });
    },

    async refresh() {
      return withBusy(() => window.dy.bridge.refresh());
    },

    async runCommand(spec) {
      const r = await window.dy.queue.enqueue(spec);
      if (!r.ok) flash(r.error || '入队失败');
    },

    async cancelTask(id) {
      await window.dy.queue.cancel(id);
    },

    async copyUserscriptUrl() {
      const r = await window.dy.bridge.copyUserscriptUrl();
      flash(r.ok ? '安装地址已复制' : (r.error || '复制失败'));
    },

    async quit() {
      await window.dy.quit();
    },
  };

  const activeCount = (queueState && queueState.stats && queueState.stats.counts)
    ? (queueState.stats.counts.pending || 0)
      + (queueState.stats.counts.running || 0)
      + (queueState.stats.counts.waiting || 0)
    : 0;

  return (
    <div className="shell">
      <Sidebar
        view={view}
        onNavigate={setView}
        status={status}
        queueCount={activeCount}
        version={info && info.version}
        onQuit={actions.quit}
      />

      <main className="main">
        <div className="main-inner">
          {view === 'queue' && <QueueView state={queueState} actions={actions} busy={busy} />}
          {view === 'connection' && <ConnectionView status={status} actions={actions} busy={busy} />}
          {view === 'diagnostics' && <DiagnosticsView info={info} status={status} actions={actions} />}
        </div>
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
