import React, { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Toasts from './components/Toast.jsx';
import Modal from './components/Modal.jsx';
import QueueView from './views/QueueView.jsx';
import DiscoverView from './views/DiscoverView.jsx';
import UserView from './views/UserView.jsx';
import TargetsView from './views/TargetsView.jsx';
import WorksView from './views/WorksView.jsx';
import WorkspaceView from './views/WorkspaceView.jsx';
import DraftsView from './views/DraftsView.jsx';
import AnalyticsView from './views/AnalyticsView.jsx';
import ConnectionView from './views/ConnectionView.jsx';
import DiagnosticsView from './views/DiagnosticsView.jsx';
import SettingsView from './views/SettingsView.jsx';

export default function App() {
  const [info, setInfo] = useState(null);
  const [status, setStatus] = useState(null);
  const [queueState, setQueueState] = useState(null);
  /**
   * 当前账号。
   *
   * 界面上的每一份数据都属于某个账号 —— 不把它取回来传给页面，两个号的
   * 作品/评论/草稿就会混在一起（这正是"换了号刷新后列表没变"的根因）。
   * 主进程那边按"浏览器当前登录的号"解析，这里只管显示与切换。
   */
  const [account, setAccount] = useState(null);

  // view 决定主区渲染哪个页面；workspaceId 非空时优先显示工作台
  const [view, setView] = useState('queue');
  const [workspaceId, setWorkspaceId] = useState(null);
  /**
   * 是从哪个页面点进工作台的。
   *
   * 工作台现在有两个入口（运营对象 / 我的作品），返回时回原来那个 ——
   * 此前写死回「我的作品」，从运营对象点进去再返回，人会莫名其妙地
   * 落到一个自己没去过的页面上。
   */
  const workspaceFrom = useRef('works');
  /**
   * 正在看的用户（评论者画像）。
   *
   * 它是**第二层下钻**（工作台/数据页 → 用户），与 workspaceId 并列而不是嵌在
   * 里面：从数据页点过来时并不经过工作台。非空时主区优先显示它。
   */
  const [userId, setUserId] = useState(null);
  /** 从哪一层进的用户页，返回时要回得去 */
  const userFrom = useRef('analytics');

  const [videos, setVideos] = useState([]);
  const [drafts, setDrafts] = useState([]);
  /** 未发布草稿的真实条数（drafts 只是加载进来的那一页） */
  const [draftTotal, setDraftTotal] = useState(0);
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

  // ── 全局可见性（失败/断线不能只留在队列页里）──
  /** 用户是否点过侧栏导航 —— 首次落地重定向只在用户没动过界面时生效 */
  const navClicked = useRef(false);
  /** 首次落地重定向只做一次 */
  const didRedirect = useRef(false);
  /** 上一轮的连接状态，用于"断开/恢复"的边沿检测 */
  const prevOnline = useRef(null);
  /** 已经提示过失败的任务 id —— 同一个失败只弹一次 toast */
  const seenFailures = useRef(new Set());

  /** 退出确认弹窗（有活动任务时才出现） */
  const [confirmQuit, setConfirmQuit] = useState(null);

  // ── 数据读取（本地 SQLite，不走队列）──
  const [videoTotal, setVideoTotal] = useState(0);
  /** 作品列表的显示上限：点「加载更早」逐步放大（本地库直读，放大没有代价） */
  const [videoLimit, setVideoLimit] = useState(50);

  /**
   * 取当前账号。
   *
   * ⚠️ 桥接状态**每 5 秒推一次**（connectionWatch 的轮询），applyStatus 每次都
   * 会调到这里。所以必须在"账号真的变了"时才换 state 对象：每次都换新对象
   * 不仅白重渲染，下面 `.main-inner` 上的 `key` 虽然按 uid 算不会重挂载，
   * 但无谓的对象更新会让所有子页面的 props 全部变化。
   */
  const reloadAccount = useCallback(async () => {
    const r = await window.dy.account.state();
    if (!r || !r.ok) return;
    setAccount((prev) => {
      const same = prev
        && String(prev.uid) === String(r.data.uid)
        && prev.needsChoice === r.data.needsChoice
        && JSON.stringify(prev.candidates) === JSON.stringify(r.data.candidates);
      return same ? prev : r.data;
    });
  }, []);

  const reloadVideos = useCallback(async (limit) => {
    const n = limit || 50;
    setLoadingVideos(true);
    try {
      const r = await window.dy.data.videos({ limit: n });
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
        setDrafts(r.data.items || []);
        setDraftTotal(r.data.total || 0);
        // 加载上限一直是不可见的：第 201 条草稿既不会出现也不会有任何提示，
        // 于是"草稿箱只有 200 条"这个界面事实与库里事实悄悄分叉
        if (r.data.truncated) {
          flash(`草稿箱只显示最近 ${(r.data.items || []).length} 条（共 ${r.data.total} 条）`, 'wait', 6000);
        }
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
    reloadAccount();
    window.dy.queue.state().then((q) => { if (!cancelled && q) setQueueState(q); });
    reloadVideos(50);
    // 草稿角标要在启动时就有值。改造前只在进入草稿箱页面时才加载，
    // 于是工作台「存草稿」提示成功之后，侧栏角标还是旧值 —— 用户以为没存上。
    reloadDrafts();

    const unStatus = window.dy.bridge.onStatusChanged((s) => applyStatus(s));
    const unQueue = window.dy.queue.onChanged((payload) => {
      setQueueState({ tasks: payload.tasks, stats: payload.stats, policy: payload.policy });
      // 任务失败不能只留在队列页 —— 用户多半停在别的页面。
      // 每个失败任务只提示一次（同一个 id 不重复弹）。
      for (const t of payload.tasks || []) {
        if ((t.status === 'failed' || t.status === 'blocked') && !seenFailures.current.has(t.id)) {
          seenFailures.current.add(t.id);
          flash(`「${t.label}」未完成：${t.error || '被策略拦下'}`, 'bad', 8000);
        }
      }
    });

    return () => { cancelled = true; unStatus(); unQueue(); };
  }, [reloadVideos]);

  function applyStatus(s) {
    if (s && s.online) everConnected.current = true;
    // 连接的账号可能变了（在浏览器里换了号、或关掉了某个页面）——
    // 重新解析一次当前账号，界面上的数据随之整体重读
    reloadAccount();

    // 断开/恢复是**状态边沿**，值得打断用户一下；初始状态（prevOnline 为 null）不弹。
    if (prevOnline.current === true && s && !s.online && s.listening) {
      flash('连接已断开 —— 抖音页面可能被关掉了，命令会一直排队直到超时', 'bad', 8000);
    } else if (prevOnline.current === false && s && s.online) {
      flash('连接已恢复', 'ok');
    }
    if (s) prevOnline.current = s.online;

    // 第一次使用（从没连上过）且用户还没点过导航 → 直接带到「连接」页，
    // 那里有三步安装引导。用户点过导航就不再插手。
    if (!didRedirect.current && !navClicked.current && !everConnected.current
      && s && s.listening && !s.online) {
      didRedirect.current = true;
      setView('connection');
    }

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

      const r = await window.dy.queue.enqueue({ command: 'post', argv, label: '发布草稿', meta, front: true });
      if (!r.ok) { flash(r.error || '入队失败', 'bad'); return null; }
      trackTask(r.id, async () => {
        const m = await window.dy.draft.markPosted(d.draftId);
        if (m.ok) reloadDrafts();
      });
      return r.id;
    },

    async cancelTask(id) { await window.dy.queue.cancel(id); },
    async cancelPending() { await window.dy.queue.cancelPending(); },

    /**
     * 退出应用。有任务在跑/在排时先确认 —— 退出会取消未开始的任务、
     * 中断正在执行的任务，批量生成跑到一半手滑退出等于白跑。
     */
    async quit() {
      try {
        const s = await window.dy.queue.state();
        const c = (s && s.stats && s.stats.counts) || {};
        const active = (c.pending || 0) + (c.running || 0) + (c.waiting || 0);
        if (active > 0) { setConfirmQuit({ active }); return; }
      } catch (e) { /* 状态拿不到就不拦 —— 退出本身不该被故障挡住 */ }
      await window.dy.quit();
    },

    openWorkspace(awemeId) { workspaceFrom.current = view; setWorkspaceId(awemeId); },

    /** 打开某个评论者的详情（工作台里点作者名、数据页点活跃榜） */
    openUser(uid) {
      userFrom.current = workspaceId ? 'workspace' : view;
      setUserId(String(uid));
    },
    /** 从用户页返回：回工作台就带着 workspaceId 一起回 */
    closeUser() {
      setUserId(null);
      if (userFrom.current !== 'workspace') setView(userFrom.current);
    },
    /** 返回工作台的来源页（运营对象 或 我的作品） */
    backFromWorkspace() {
      setWorkspaceId(null);
      setView(workspaceFrom.current);
      // 作品列表的统计要跟着刷新（在工作台里发过回复，"待回复"应该少一条）。
      // 回运营对象页时不用手动刷 —— 那个视图是重新挂载的，自己会取一次。
      if (workspaceFrom.current === 'works') reloadVideos(videoLimit);
    },

    /** 多账号同时在线时选定当前账号（只有一个时是自动跟随的，用不到） */
    async setAccount(uid) {
      const r = await window.dy.account.set(uid);
      if (!r || !r.ok) { flash((r && r.error) || '切换账号失败', 'bad'); return; }
      await reloadAccount();
      flash('已切换当前账号 —— 各页数据会按新账号重新读取', 'ok');
    },

    /** 侧栏之外的第二条去「连接」页的路（队列页状态条上用） */
    gotoConnection() { setWorkspaceId(null); setView('connection'); },

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

  return (
    <div className="shell">
      <Sidebar
        // 在工作台里时，高亮的应该是"从哪进来的"那一项，而不是写死「我的作品」
        view={userId ? (userFrom.current === 'workspace' ? workspaceFrom.current : userFrom.current)
          : workspaceId ? workspaceFrom.current : view}
        onNavigate={(v) => { navClicked.current = true; setWorkspaceId(null); setUserId(null); setView(v); }}
        status={status}
        account={account}
        onSwitchAccount={actions.setAccount}
        queueCount={activeCount}
        draftCount={draftTotal}
        version={info && info.version}
        onQuit={actions.quit}
      />

      <main className="main">
        {/* key 里带上当前账号：换号之后把当前页面整个重挂载，各页的取数
            effect 自然重跑。比在每个页面里各写一遍"账号变了要重读"可靠得多
            ——后者只要有一页忘了写，那一页就会继续显示上一个号的数据，
            而症状恰好又是"换了号数据没变"。 */}
        <div
          className="main-inner"
          key={`${account ? String(account.uid || 'none') : 'loading'}:${userId || workspaceId || ''}`}
        >
          {userId
            ? <UserView uid={userId} actions={actions} onBack={actions.closeUser} />
            : workspaceId
            ? (
              <WorkspaceView
                awemeId={workspaceId}
                queueState={queueState}
                actions={actions}
                onBack={actions.backFromWorkspace}
              />
            )
            : (
              <>
                {view === 'queue' && (
                  <QueueView state={queueState} status={status} actions={actions} busy={busy} />
                )}
                {view === 'discover' && <DiscoverView actions={actions} />}
                {view === 'targets' && <TargetsView actions={actions} />}
                {view === 'works' && (
                  <WorksView
                    videos={videos}
                    total={videoTotal}
                    shown={videos.length}
                    loading={loadingVideos}
                    actions={actions}
                    onRefresh={() => reloadVideos(videoLimit)}
                    onLoadMore={() => {
                      const next = Math.min(videoLimit + 100, 500);
                      setVideoLimit(next);
                      reloadVideos(next);
                    }}
                  />
                )}
                {view === 'drafts' && (
                  <DraftsView
                    drafts={drafts}
                    total={draftTotal}
                    loading={loadingDrafts}
                    actions={actions}
                    reload={reloadDrafts}
                  />
                )}
                {view === 'analytics' && <AnalyticsView actions={actions} />}
                {view === 'settings' && <SettingsView />}
                {view === 'connection' && <ConnectionView status={status} actions={actions} busy={busy} />}
                {view === 'diagnostics' && <DiagnosticsView info={info} status={status} actions={actions} />}
              </>
            )}
        </div>
      </main>

      {confirmQuit && (
        <Modal title="确认退出？" onClose={() => setConfirmQuit(null)}>
          <div style={{ marginBottom: 16 }}>
            还有 <b className="text-strong num">{confirmQuit.active}</b> 个任务在排队或执行中。
            退出会<b className="text-bad">取消未开始的任务、中断正在执行的任务</b>（批量生成跑到一半会白跑）。
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setConfirmQuit(null)}>取消</button>
            <button className="btn btn-primary text-bad" onClick={() => window.dy.quit()}>仍然退出</button>
          </div>
        </Modal>
      )}

      <Toasts items={toasts} onDismiss={dismissToast} />
    </div>
  );
}
