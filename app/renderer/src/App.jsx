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
import { describeError, failText } from './errors.js';

/** 把多行文案压成一行（明细行里换行会把原因挤下去） */
function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

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
   * 工作台每个视频的浏览状态（标签 / 搜索 / 排序 / 勾选）。
   *
   * 用 ref 不用 state：这份表只在**进入某个视频那一次**被读来当初始值，
   * 之后每次变更都写回来，但没有任何地方渲染它 —— 放 state 等于每次勾选
   * 都让 App 整棵树重渲染一遍。
   */
  const wsMemo = useRef(new Map());
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
  /** 当前搜索条件命中的条数。与 draftTotal 是两个数：搜一个词不该让侧栏角标变小 */
  const [draftMatched, setDraftMatched] = useState(0);
  /**
   * 没有标明归属账号、因此不会出现在草稿箱列表里的草稿条数。
   * 不报出来的话，"生成成功但草稿箱是空的"就只能靠用户自己发现。
   */
  const [draftUnattributed, setDraftUnattributed] = useState(0);
  /**
   * 草稿箱的搜索词。放在 ref 里而不是 state：`reloadDrafts()` 会被
   * 自动刷新、发布成功、删除之后等多处**无参**调用，它必须沿用当前搜索词，
   * 否则用户搜着搜着后台刷一次，列表就悄悄变回全量了。
   */
  const draftQueryRef = useRef('');
  /**
   * 批量发布的进度。
   *
   * 记在 App 层而不是草稿箱页面里 —— 发起之后用户多半会切到「队列」页看倒计时，
   * 那时 DraftsView 已经卸载，"发布到第几条了、哪几条被拦下"就无处可去了
   * （同一个坑在单条发布的"标记已发布"上已经踩过一次，见 actions.publishDraft）。
   */
  const [bulkPublish, setBulkPublish] = useState(null);
  const bulkPublishRef = useRef(null);
  /** 这一批发布任务 id：它们的失败由面板逐条列出，不再各弹一条 toast */
  const bulkPublishTaskIds = useRef(new Set());
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [loadingDrafts, setLoadingDrafts] = useState(false);
  /**
   * 从工作台「去草稿箱」带过来的一批草稿 id —— 到草稿箱后替用户勾上。
   *
   * 用 state 不用 ref：DraftsView 必须等列表**读回来之后**才能判断这些 id
   * 在不在当前列表里（被搜索词或账号过滤挡住时要说出来，不能假装勾上了），
   * 而 ref 的变更不会触发那次重跑。
   */
  const [draftPreset, setDraftPreset] = useState(null);

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

  // 换号就把工作台那张表整个丢掉：里面存的勾选是上一个号的列表，
  // cid 再对得上也不该被当成"用户在这个号下勾过的东西"恢复回来。
  useEffect(() => {
    wsMemo.current.clear();
    setDraftPreset(null);
  }, [account]);

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
        flash(`读取作品列表失败：${failText(r.error, '未知错误')}`, 'bad');
      }
    } finally { setLoadingVideos(false); }
  }, []);

  const reloadDrafts = useCallback(async (q) => {
    if (typeof q === 'string') draftQueryRef.current = q;
    setLoadingDrafts(true);
    try {
      const r = await window.dy.data.drafts({ q: draftQueryRef.current });
      if (r.ok) {
        setDrafts(r.data.items || []);
        // total 恒为整箱待发布数（侧栏角标读它），matched 才是这次搜索的命中数。
        // 两者混成一个的话，搜一个词就会让角标变成"3"，那是对整个箱子的假话。
        setDraftTotal(r.data.total || 0);
        setDraftMatched(r.data.matched || 0);
        setDraftUnattributed(r.data.unattributed || 0);
        // 加载上限一直是不可见的：第 201 条草稿既不会出现也不会有任何提示，
        // 于是"草稿箱只有 200 条"这个界面事实与库里事实悄悄分叉
        if (r.data.truncated) {
          flash(`只显示最近 ${(r.data.items || []).length} 条（${draftQueryRef.current ? '搜索命中' : '共'} ${r.data.total} 条）`, 'wait', 6000);
        }
      } else {
        // 失败不能伪装成"草稿箱是空的"：那会让用户以为草稿被删了，
        // 而侧栏角标同时变成 0，两边互相印证一个错误结论。
        // 这里保留上一次的列表，只报错。
        flash(`读取草稿箱失败：${failText(r.error, '未知错误')}`, 'bad');
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
          // 批量发布的那几条不在这弹：一次几十条会把界面刷成 toast 墙，
          // 明细由草稿箱顶部的面板逐条列出，结束时再汇总提示一次
          if (bulkPublishTaskIds.current.has(t.id)) continue;
          // 停在别的页面时，toast 是用户唯一一次看到这个失败 —— 所以光说"没完成"
          // 不够，必须把下一步一起带出来（队列页的明细他可以之后再看，也可能根本不看）。
          const note = describeError(t.error || '被策略拦下');
          flash(`「${t.label}」未完成：${note.text}${note.next.length ? ` —— ${note.next[0]}` : ''}`, 'bad', 9000);
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
      if (!r.ok) { flash(failText(r.error, '入队失败'), 'bad'); return null; }
      return r.id;
    },

    async runCommand(spec) {
      if (spec.afterDone === 'refreshVideos') {
        const r = await window.dy.queue.enqueue(spec);
        if (r.ok) {
          // 等它跑完再刷新，否则刷到的是旧数据
          flash('已加入队列 —— 完成后列表会自动刷新', 'ok');
          trackTask(r.id, reloadVideos);
        } else flash(failText(r.error, '入队失败'), 'bad');
        return;
      }
      const r = await window.dy.queue.enqueue(spec);
      if (!r.ok) flash(failText(r.error, '入队失败'), 'bad');
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
      if (!r.ok) { flash(failText(r.error, '入队失败'), 'bad'); return null; }
      trackTask(r.id, async () => {
        const m = await window.dy.draft.markPosted(d.draftId);
        if (m.ok) reloadDrafts();
      });
      return r.id;
    },

    /**
     * 批量发布草稿 —— 一条草稿 = 一个独立的 `post` 写任务。
     *
     * 串行队列与每条之间的写间隔闸门照常生效，这里连起来的只是"逐条点发布"
     * 这个动作本身：一箱 30 条要点 30 次按钮 + 30 次确认弹窗，
     * 运营者于是干脆不发 —— 那是产品做不到用它的人，不是风控松不松的问题。
     * 而"一次点下去就把 30 条同时发出去"这里也做不到、不该做：
     * 队列是串行的，写间隔是硬闸门，所以批量发完 N 条必然要等 N 个间隔。
     *
     * 不提供「跳过本次等待」：那个开关是"我确认这一条现在就能发"，
     * 对一整批同时成立等于把节奏保护整个关掉。
     */
    async publishDrafts(items) {
      const list = (Array.isArray(items) ? items : []).filter(d => d && d.id && d.awemeId);
      if (!list.length) { flash('没有可发布的草稿 —— 它们可能已经被删掉或发出去了', 'bad'); return false; }
      if (bulkPublishRef.current) {
        flash('上一批还没发完（草稿箱顶部能看到进度）—— 先等它结束或取消剩下的', 'wait');
        return false;
      }
      bulkPublishTaskIds.current = new Set();
      bulkPublishRef.current = {
        total: list.length, done: 0, ok: 0, failed: [], cancelled: 0,
        finished: false, cancelledByUser: false, taskIds: [], startedAt: Date.now(),
      };
      setBulkPublish({ ...bulkPublishRef.current, failed: [] });

      // 倒序 + front：front 每次都插到第一个待执行任务之前，倒着提才能让
      // 队列里显示的顺序跟用户勾选的顺序一致（正着提会整个反过来）。
      const enqueueErrors = [];
      for (let i = list.length - 1; i >= 0; i--) {
        const d = list[i];
        const argv = d.replyToCid
          ? [d.awemeId, d.text, '--reply-to', d.replyToCid]
          : [d.awemeId, d.text];
        if (d.imagePath) argv.push('--image', d.imagePath);
        // uid 必须带上，与单条发布同一口径：「同一个用户每轮最多回复几条」只看它
        const meta = { awemeId: d.awemeId, cid: d.replyToCid, uid: d.replyToUid || null, text: d.text };
        const r = await window.dy.queue.enqueue({
          command: 'post', argv, label: `发布草稿 #${d.id}`, meta, front: true,
        });
        if (!r.ok) { enqueueErrors.push({ draft: d, error: `入队失败：${r.error || '未知错误'}` }); continue; }
        bulkPublishTaskIds.current.add(r.id);
        bulkPublishRef.current.taskIds.unshift(r.id);
        const draft = d;
        trackTask(r.id, async () => {
          recordBulkPublishResult(null, draft);
          // 发出去就要把草稿标成已发布，否则它留在箱里等着被第二次发布
          const m = await window.dy.draft.markPosted(draft.id);
          if (m.ok) reloadDrafts();
        }, (err) => recordBulkPublishResult(err, draft));
      }
      // 入队失败的排在最后记，避免它们在别的任务还在跑时就把这批判成"已结束"
      for (const e of enqueueErrors) recordBulkPublishResult(e.error, e.draft);

      flash(`已把 ${list.length} 条草稿排进队列 —— 每条之间要等写间隔，进度在草稿箱顶部`, 'ok', 6000);
      return true;
    },

    /**
     * 取消批量发布里**还没开始**的那些。
     *
     * 只挑 pending：正在等间隔（waiting）与正在发（running）的那条已经在流程里了，
     * 收回来会让"发了一半"的状态更难解释 —— 面板上会继续说清它发完了。
     */
    async cancelBulkPublish() {
      const b = bulkPublishRef.current;
      if (!b) return;
      const ids = new Set(b.taskIds);
      const pending = ((queueState && queueState.tasks) || [])
        .filter(t => ids.has(t.id) && t.status === 'pending');
      for (const t of pending) await window.dy.queue.cancel(t.id);
      b.cancelledByUser = true;
      setBulkPublish({ ...b, failed: b.failed.slice() });
      flash(pending.length
        ? `已取消还没开始的 ${pending.length} 条 —— 草稿还在箱里；正在排队发布的那条会先结束`
        : '没有还没开始的了 —— 正在排队发布的那条会先结束', 'wait', 6000);
    },

    /** 收起批量发布结果面板（明细里那些草稿仍在箱子里，一条都没丢） */
    clearBulkPublish() {
      bulkPublishRef.current = null;
      setBulkPublish(null);
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
      if (!r || !r.ok) { flash(failText(r && r.error, '切换账号失败'), 'bad'); return; }
      await reloadAccount();
      // 提示语说"各页数据会按新账号重新读取"，那它就真的得重新读取。
      // 页面 key 带 uid 会重挂载，那只覆盖"组件自己去取"的那些数据；
      // videos / drafts 存在 App 层（侧栏角标与「我的作品」都读它），
      // 不在这儿重取，换号后就继续显示上一个号的作品和草稿计数。
      reloadVideos(videoLimit);
      reloadDrafts();
      flash('已切换当前账号 —— 各页数据会按新账号重新读取', 'ok');
    },

    /** 侧栏之外的第二条去「连接」页的路（队列页状态条上用） */
    gotoConnection() { setWorkspaceId(null); setView('connection'); },

    /**
     * 空态与结果条上的"下一步就去这里"。
     *
     * 为什么要有它：这些位置以前只能写"到「草稿箱」里确认"这样一句话，
     * 让用户自己找侧栏去点 —— 而空态里那句"入口在命令行"就是这么来的，
     * 界面里明明有「找视频」页，写出来的却是运营者根本不会用的命令。
     */
    goto(next) { setWorkspaceId(null); setUserId(null); setView(next); },

    /**
     * 带着"刚生成的那几条"去草稿箱。
     *
     * 只跳转的话，用户到草稿箱还要在一箱待发草稿里认出刚才那批 —— 而批量生成
     * 恰恰就是为几十条一起做的。拿不到 id 时（老数据、或部分保存失败）退化成
     * 单纯跳转，不拦这条路。
     */
    gotoDrafts(draftIds) {
      setDraftPreset(Array.isArray(draftIds) && draftIds.length > 0 ? draftIds : null);
      setWorkspaceId(null); setUserId(null); setView('drafts');
    },

    async openDouyin() {
      return withBusy(async () => {
        await window.dy.openExternal('https://www.douyin.com');
        flash('已打开抖音 —— 确认已登录，并保持页面开着', 'ok');
      });
    },

    async refresh() { return withBusy(() => window.dy.bridge.refresh()); },

    async copyUserscriptUrl() {
      const r = await window.dy.bridge.copyUserscriptUrl();
      flash(r.ok ? '安装地址已复制' : failText(r.error, '复制失败'), r.ok ? 'ok' : 'bad');
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
      flash(r.ok ? '已在浏览器里打开安装页 —— 确认 Tampermonkey 的安装提示' : failText(r.error, '打开失败'), r.ok ? 'ok' : 'bad');
    },

    /** 工作台「存草稿」之后要刷新草稿角标与草稿箱列表 */
    async refreshDrafts() { return reloadDrafts(); },

    // 界面用的只读派生值
    get canQueue() { return !!(status && status.online); },
  };

  /**
   * 等某个任务结束后执行回调（用于"跑完自动刷新"这类联动）。
   *
   * `onFail` 是可选的：只有批量发布这类**一次盯几十个任务**的调用方需要知道
   * 失败原因，其余调用方维持原语义（只有成功才做联动，失败由全局 toast 说）。
   */
  const trackers = useRef(new Map());
  function trackTask(taskId, cb, onFail) {
    trackers.current.set(taskId, { cb, onFail });
  }

  /**
   * 累加一条批量发布的结果。
   *
   * 计数走 ref 而不是 setState 的函数式更新：回调是从队列变化的 effect 里逐个
   * 触发的，一份可变对象 + 每次推一个快照给界面，比在 updater 里做副作用干净
   * （updater 被调两次不是假设，是 React 的行为）。
   */
  function recordBulkPublishResult(error, draft) {
    const b = bulkPublishRef.current;
    if (!b) return;
    b.done += 1;
    // 「用户取消的」与「失败/被拦下的」分开记：一次 30 条里自己撤了 25 条时，
    // 把那 25 条列成红色"没发出去"是假话（那正是用户要的），
    // 真实故障有几条也就会被淹掉。
    if (error && /^已取消/.test(error)) b.cancelled += 1;
    else if (error) {
      b.failed.push({
        draftId: draft.id,
        // 标题和正文都是多行文案，不压掉换行的话这一行明细会被撑成五行，
        // 真正要看的原因反而被挤到看不见
        label: `${(oneLine(draft.videoTitle) || `视频 ····${String(draft.awemeId || '').slice(-6)}`).slice(0, 30)}`
          + ` · ${oneLine(draft.text || '（纯图草稿）').slice(0, 28)}`,
        error,
      });
    } else {
      b.ok += 1;
    }
    if (b.done >= b.total) {
      b.finished = true;
      bulkPublishRef.current = null;   // 允许发起下一批；面板继续读 state 里那份快照
    }
    setBulkPublish({ ...b, failed: b.failed.slice() });

    if (b.finished) {
      const bad = b.failed.length;
      const tail = b.cancelled ? `，${b.cancelled} 条按你的取消没发` : '';
      flash(bad
        ? `批量发布结束：${b.ok} 条已发出，${bad} 条没发出去${tail} —— 草稿箱顶部有逐条原因（那些草稿还在箱里）`
        : `批量发布结束：${b.ok} 条全部发出${tail}`, bad ? 'bad' : 'ok', 9000);
      reloadDrafts();
    }
  }

  useEffect(() => {
    if (!queueState) return;
    for (const [id, entry] of [...trackers.current.entries()]) {
      const t = (queueState.tasks || []).find(x => x.id === id);
      if (t && ['done', 'failed', 'blocked', 'cancelled'].includes(t.status)) {
        trackers.current.delete(id);
        if (t.status === 'done') {
          try { entry.cb(); } catch (e) { /* 刷新失败不影响主流程 */ }
        } else if (entry.onFail) {
          try { entry.onFail(t.error || '未完成'); } catch (e) { /* 同上 */ }
        }
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
                memo={wsMemo.current.get(workspaceId)}
                onMemo={(m) => wsMemo.current.set(workspaceId, m)}
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
                    matched={draftMatched}
                    unattributed={draftUnattributed}
                    bulkPublish={bulkPublish}
                    loading={loadingDrafts}
                    presetPicked={draftPreset}
                    onPresetUsed={() => setDraftPreset(null)}
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
