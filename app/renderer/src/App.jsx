import React, { useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import ConnectionView from './views/ConnectionView.jsx';
import DiagnosticsView from './views/DiagnosticsView.jsx';

export default function App() {
  const [info, setInfo] = useState(null);
  const [status, setStatus] = useState(null);
  const [view, setView] = useState('connection');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  // 首次连上过之后就不再自动跳回「连接」页 —— 用户可能正在看诊断，
  // 把他拽回去只会打断。需要时侧栏的状态点一直在提示。
  const everConnected = useRef(false);

  useEffect(() => {
    let cancelled = false;

    window.dy.info().then((i) => { if (!cancelled) setInfo(i); });
    window.dy.bridge.status().then((s) => { if (!cancelled) applyStatus(s); });

    const unsubscribe = window.dy.bridge.onStatusChanged((s) => applyStatus(s));
    return () => { cancelled = true; unsubscribe(); };
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
    async copyUserscriptUrl() {
      const r = await window.dy.bridge.copyUserscriptUrl();
      flash(r.ok ? '安装地址已复制' : (r.error || '复制失败'));
    },
    async quit() {
      await window.dy.quit();
    },
  };

  return (
    <div className="shell">
      <Sidebar
        view={view}
        onNavigate={setView}
        status={status}
        version={info && info.version}
        onQuit={actions.quit}
      />

      <main className="main">
        <div className="main-inner">
          {view === 'connection'
            ? <ConnectionView status={status} actions={actions} busy={busy} />
            : <DiagnosticsView info={info} status={status} actions={actions} />}
        </div>
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
