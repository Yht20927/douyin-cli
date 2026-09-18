import React, { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Toasts from './components/Toast.jsx';
import QueueView from './views/QueueView.jsx';
import WorksView from './views/WorksView.jsx';
import WorkspaceView from './views/WorkspaceView.jsx';
import DraftsView from './views/DraftsView.jsx';
import ConnectionView from './views/ConnectionView.jsx';
import DiagnosticsView from './views/DiagnosticsView.jsx';
import SettingsView from './views/SettingsView.jsx';

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
  /**
   * 提示队列。
   *
   * 改造前是一个字符串：成功与失败长得完全一样，来第二条直接把第一条顶掉，
   * 而且 3.2 秒后无条件消失 —— 一条报错往往还没读完就没了。
   * 现在可以并存多条、按性质着色，失败类默认多留一会儿。
   */
  const [toasts, setToasts] = useState([]);
  const toastSeq = useRef(0);

  const everConnected = useRef(false);

  // ── 数据读取（本地 SQLite，不走队列）──
  const [videoTotal, setVideoTotal] = useState(0);

  const reloadVideos = useCallback(async () => {
    setLoadingVideos(true);
    try {
      const r = await window.dy.data.videos({ limit: 50 });
      if (r.ok) {
        setVideos(r.data.items || []);
        setVideoTotal(r.data.total || 0);
      } else {
        setVideos([]);
        setVideoTotal(0);
        flash(`读取作品列表失败：${r.error || '未知错误'}`, 'bad');
      }
    } finally { setLoadingVideos(false); }
  }, []);

  const reloadDrafts = useCallback(async () => {
    setLoadingDrafts(true);
    try {
      const r = await window.dy.data.drafts();
      if (r.ok) {
        setDrafts(r.data);
      } else {
        // 失败不能伪装成"草稿箱是空的"：那会让用户以为草稿被删了，
        // 而侧栏角标同时变成 0，两边互相印证一个错误结论。
        // 这里保留上一次的列表，只报错。
        flash(`读取草稿箱失败：${r.error || '未知错误'}`, 'bad');
      }
    } finally { setLoadingDrafts(false); }
  }, []);

  useEffect(() => {
    let cancelled = false;

    window.dy.info().then((i) => { if (!cancelled) setInfo(i); });
    window.dy.bridge.status().then((s) => { if (!cancelled) applyStatus(s); });
    window.dy.queue.state().then((q) => { if (!cancelled && q) setQueueState(q); });
    reloadVideos();
    // 草稿角标要在启动时就有值。改造前只在进入草稿箱页面时才加载，
    // 于是工作台「存草稿」提示成功之后，侧栏角标还是旧值 —— 用户以为没存上。
    reloadDrafts();

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

  /**
   * 弹一条提示。
   *
   * @param {string} message
   * @param {'info'|'ok'|'bad'|'wait'} [tone='info'] - 决定左侧色条与停留时长
   * @param {number} [ttl] - 毫秒。缺省：失败类 6 秒、其余 3.2 秒 ——
   *   一条报错通常比"已复制"需要更多时间读完
   */
  function flash(message, tone = 'info', ttl) {
    const id = ++toastSeq.current;
    // 最多同时留 3 条：再多会把下面的界面盖住，而提示的职责是"告知"不是"占屏"
    setToasts((prev) => [...prev.slice(-2), { id, message, tone }]);
    const life = ttl || (tone === 'bad' ? 6000 : 3200);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), life);
    return id;
  }

  function dismissToast(id) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
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
      if (!r.ok) { flash(r.error || '入队失败', 'bad'); return null; }
      return r.id;
    },

    async runCommand(spec) {
      if (spec.afterDone === 'refreshVideos') {
        const r = await window.dy.queue.enqueue(spec);
        if (r.ok) {
          // 等它跑完再刷新，否则刷到的是旧数据
          flash('已加入队列 —— 完成后列表会自动刷新', 'ok');
          trackTask(r.id, reloadVideos);
        } else flash(r.error || '入队失败', 'bad');
        return;
      }
      const r = await window.dy.queue.enqueue(spec);
      if (!r.ok) flash(r.error || '入队失败', 'bad');
    },

    /**
     * 发布一条草稿。
     *
     * 跟踪逻辑放在 App 层而不是 DraftsView 里 —— DraftsView 只在草稿箱页面挂载，
     * 用户点了发布之后切到队列页看进度，组件就卸载了，"发布成功后标记草稿"
     * 永远不会执行：草稿原样留在箱里，用户以为没发出去、再点一次，
     * 这次被重复回复策略拦下，于是确信"工具坏了"。App 一直是挂着的。
     *
     * uid 必须带上：策略里「同一个用户每轮最多回复几条」只看 meta.uid，
     * 不带的话这条规则从草稿箱发出去时不生效 —— 而同一条规则从工作台发就生效，
     * 同一个按钮在两条路径上行为不同，是最难排查的那类问题。
     */
    async publishDraft(d) {
      const argv = d.cid ? [d.awemeId, d.text, '--reply-to', d.cid] : [d.awemeId, d.text];
      if (d.imagePath) argv.push('--image', d.imagePath);
      const meta = { awemeId: d.awemeId, cid: d.cid, uid: d.uid || null, text: d.text };
      if (d.skipWait) meta.skipWait = true;

      const r = await window.dy.queue.enqueue({ command: 'post', argv, label: '发布草稿', meta });
      if (!r.ok) { flash(r.error || '入队失败', 'bad'); return null; }
      trackTask(r.id, async () => {
        const m = await window.dy.draft.markPosted(d.draftId);
        if (m.ok) reloadDrafts();
      });
      return r.id;
    },

    async cancelTask(id) { await window.dy.queue.cancel(id); },
    async cancelPending() { await window.dy.queue.cancelPending(); },

    openWorkspace(awemeId) { setWorkspaceId(awemeId); },
    backToWorks() { setWorkspaceId(null); reloadVideos(); },

    async openDouyin() {
      return withBusy(async () => {
        await window.dy.openExternal('https://www.douyin.com');
        flash('已打开抖音 —— 确认已登录，并保持页面开着', 'ok');
      });
    },

    async refresh() { return withBusy(() => window.dy.bridge.refresh()); },

    async copyUserscriptUrl() {
      const r = await window.dy.bridge.copyUserscriptUrl();
      flash(r.ok ? '安装地址已复制' : (r.error || '复制失败'), r.ok ? 'ok' : 'bad');
    },

    /**
     * 用系统浏览器打开安装地址，让 Tampermonkey 直接弹安装页。
     *
     * 这是唯一"点一下就能装好"的路径：脚本里的 token 由服务端现场注入，
     * 用户不用手工复制任何凭证。此前这条链路只有主进程和托盘有，
     * 渲染层没有入口 —— 而设置页还把"连接页有一键入口"当作不暴露 bridge.token
     * 的理由，等于那个理由指向的按钮并不存在。
     */
    async openUserscript() {
      const r = await window.dy.bridge.openUserscript();
      flash(r.ok ? '已在浏览器里打开安装页 —— 确认 Tampermonkey 的安装提示' : (r.error || '打开失败'), r.ok ? 'ok' : 'bad');
    },

    async quit() { await window.dy.quit(); },

    /** 工作台「存草稿」之后要刷新草稿角标与草稿箱列表 */
    async refreshDrafts() { return reloadDrafts(); },

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
                  <WorksView videos={videos} total={videoTotal} loading={loadingVideos} actions={actions} />
                )}
                {view === 'drafts' && (
                  <DraftsView
                    drafts={drafts}
                    loading={loadingDrafts}
                    actions={actions}
                    reload={reloadDrafts}
                  />
                )}
                {view === 'settings' && <SettingsView />}
                {view === 'connection' && <ConnectionView status={status} actions={actions} busy={busy} />}
                {view === 'diagnostics' && <DiagnosticsView info={info} status={status} actions={actions} />}
              </>
            )}
        </div>
      </main>

      <Toasts items={toasts} onDismiss={dismissToast} />
    </div>
  );
}
