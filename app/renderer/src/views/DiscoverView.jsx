import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import EmptyState from '../components/EmptyState.jsx';
import Spinner from '../components/Spinner.jsx';
import TaskActivity from '../components/TaskActivity.jsx';
import { abbrNum, ago } from '../format.js';
import { failText } from '../errors.js';

/**
 * 找视频 —— 运营对象的**入口**。
 *
 * 为什么需要这一页：此前只有命令行能往「运营对象」里加东西（`get <视频ID>`），
 * 而"找到一个值得评论的视频"这一步（搜索 / 看某个人的主页）根本没有界面。
 * 于是整个工作流的正门断在了终端里。
 *
 * 两条路，对应两个命令：
 *   - 关键词搜索 → `search <kw>`
 *   - 某个用户的主页 → `user <主页链接或 sec_uid>`
 *
 * 两者**都是读操作**：走队列、受读间隔约束（GUI 下是真的等，界面会显示倒计时），
 * 但不会产生任何发布。点「加入运营对象」才去拉那条视频的评论 —— 那一步是
 * 让它出现在「运营对象」列表里的唯一条件（该列表的判据就是"本地存到过评论"）。
 */

/** 一次搜多少条。上限与 search 命令内部一致（20）。 */
const PAGE_SIZE = 20;

/** 队列里"不会再变了"的那几个状态。三处判断都用它，别各写一份清单 */
const FINISHED = ['done', 'failed', 'blocked', 'cancelled'];
const isSettled = t => !!t && FINISHED.includes(t.status);

/**
 * @param {object} props
 * @param {object} props.memo - App 层存的这一页的浏览状态（切页会卸载，见 App.jsx 的 discoverMemo）
 * @param {function} props.onMemo - 每次变化写回去
 * @param {object} props.queueState - 队列快照，用来续上"离开这一页期间跑完"的任务
 */
export default function DiscoverView({ actions, memo, onMemo, queueState }) {
  const [mode, setMode] = useState(() => (memo && memo.mode) || 'search');
  const [keyword, setKeyword] = useState(() => (memo && memo.keyword) || '');
  const [userInput, setUserInput] = useState(() => (memo && memo.userInput) || '');

  const [results, setResults] = useState(() => (memo && memo.results) || []);
  const [status, setStatus] = useState(() => (memo && memo.status) || {});
  /** 正在等的任务（搜索 / 看主页），跑完自动取结果 */
  const [pending, setPending] = useState(() => (memo && memo.pending) || null);
  /** 已加入过队列、正在等结果的那几条视频 id（由 addingPairs 推出，不另存一份） */
  const [adding, setAdding] = useState(
    () => new Set(((memo && memo.addingPairs) || []).map(([a]) => a))
  );
  /** 勾选要批量加入的视频 id */
  const [picked, setPicked] = useState(() => new Set((memo && memo.picked) || []));
  const [notice, setNotice] = useState(() => (memo && memo.notice) || null);
  const [error, setError] = useState(() => (memo && memo.error) || null);
  /**
   * 刚跑完的一批"拉取评论"的账单：成功的 id 列表与失败条数。
   * 它是这一页唯一的"下一步"出口（拉完就能去工作台），所以要活得过切页。
   */
  const [justDone, setJustDone] = useState(() => (memo && memo.justDone) || null);

  /**
   * 这一台机器上真搜过的关键词（空态里那几颗按钮的原料）。
   *
   * `null` 只表示**还没读回来**，不等于"没有历史" —— 把它当空数组渲染，
   * 空态就会在数据到之前先说一句假话（"这台机器还没搜过东西"）。
   * 不进 memo：它是一次本地读，重新挂载再读一次比留着更准（刚搜过的那次要在）。
   */
  const [history, setHistory] = useState(null);

  useEffect(() => {
    let alive = true;
    window.dy.data.searchHistory({ limit: 8 }).then((r) => {
      if (!alive) return;
      setHistory(r && r.ok
        ? { ...r.data, error: null }
        : { items: [], scanned: 0, truncated: false, error: (r && r.error) || '未知原因' });
    });
    return () => { alive = false; };
  }, []);

  /** 这次等的是哪个命令的结果（'search' | 'user'）—— normalize 要按它分派 */
  const kindRef = useRef((memo && memo.kind) || 'search');
  /** 视频 id → 正在为它拉评论的任务 id。批量时靠它把完成的任务落回行上 */
  const addingRef = useRef(new Map((memo && memo.addingPairs) || []));
  /** 只订阅一次队列，避免"点了 8 次就挂 8 个监听" */
  const watchRef = useRef(null);
  /** 最新一次队列快照。用 ref 读：它不是判断条件，不该让订阅跟着重挂 */
  const queueRef = useRef(queueState);
  queueRef.current = queueState;

  useEffect(() => () => {
    // 组件卸载（切页）时队列还在跑 —— 不取消订阅的话监听会一直握着已卸载组件的 setState
    if (watchRef.current) watchRef.current();
  }, []);

  /** 问一次这批视频在库里的状态（已收录 / 可加入） */
  const refreshStatus = useCallback(async (ids) => {
    if (!ids || ids.length === 0) return;
    const r = await window.dy.data.targetStatus(ids);
    if (r && r.ok) setStatus(prev => ({ ...prev, ...r.data }));
  }, []);

  /** 把一条已完成的搜索/看主页任务收成列表 */
  const settlePending = useCallback(async (taskId, task) => {
    setPending(null);
    if (task.status !== 'done') {
      setError(failText(task.error, '未完成'));
      setResults([]);
      setJustDone(null);
      return;
    }
    const r = await window.dy.queue.result(taskId);
    // ⚠️ kind 必须取自入队时记下的那个，**不能**拿 pending（它是任务 id）。
    // 写成 normalize(pending, …) 的话两个分支都会走错那个，
    // 表现是"搜索结果永远是空的" —— 而错误本身不抛，只是没结果。
    const items = normalize(kindRef.current, r && r.result);
    setResults(items);
    // 换了一批结果就把勾选清掉：留着上一批的 id，批量按钮上的数字就和眼前这页对不上
    setPicked(new Set());
    setError(null);
    setNotice(items.length === 0
      ? '没有结果。换个关键词，或者确认浏览器里已登录、页面开着。'
      : `找到 ${items.length} 个视频 —— 逐条点「加入运营对象」，或勾几条一次排进队列。`
        + '加入就是去拉它的评论（读操作，要等间隔）。');
    refreshStatus(items.map(i => i.awemeId));
  }, [refreshStatus]);

  // 任务跑完 → 取结果
  useEffect(() => {
    if (!pending) return undefined;
    // 这一页被卸载期间任务可能已经跑完 —— 那次变更事件**不会重发**，
    // 只订阅的话界面会永远停在"正在搜索…"。先照快照判一次。
    const snap = (queueRef.current && queueRef.current.tasks || []).find(x => x.id === pending);
    if (isSettled(snap)) { settlePending(pending, snap); return undefined; }
    const un = window.dy.queue.onChanged((payload) => {
      const t = (payload.tasks || []).find(x => x.id === pending);
      if (isSettled(t)) settlePending(pending, t);
    });
    return un;
  }, [pending, settlePending]);

  /**
   * 用**指定**的那句话去搜。
   *
   * 为什么要单独收一个 raw：空态里的「最近搜过的词」是点一下就搜，
   * 而 `run()` 读的是 `keyword` state —— 在同一个事件回调里刚 setKeyword
   * 再调 run，state 还没更新，搜出去的还是上一句留着的那个词。
   * 这个 bug 不报错、不白屏，只是结果莫名其妙换了一个词。
   */
  async function runWith(kind, raw) {
    const kw = String(raw || '').trim();
    if (!kw) return;
    const spec = kind === 'search'
      ? { command: 'search', argv: [kw, '--count', String(PAGE_SIZE)], label: `搜索「${kw}」` }
      : { command: 'user', argv: [kw, '--count', String(PAGE_SIZE)], label: `看主页 ${kw}` };
    const id = await actions.enqueue(spec);
    if (!id) return;
    setResults([]);
    setError(null);
    setNotice(null);
    // 上一批的"拉完了"账单指的那几行已经从这一页消失了，留着会跳去看不存在的视频
    setJustDone(null);
    kindRef.current = kind;
    setPending(id);
  }

  async function run(kind) {
    await runWith(kind, kind === 'search' ? keyword : userInput);
  }

  /** 加入运营对象 = 拉这条视频的评论。列表的判据就是"本地存到过评论"。 */
  async function addTargets(vids) {
    const queueIn = [];
    for (const v of vids) {
      // 已经在拉的先跳过：重复入队就是重复拉同一批评论，
      // 而每条都要占一次读间隔 —— 白等的那几十秒是实打实的。
      if (addingRef.current.has(v.awemeId)) continue;
      const id = await actions.enqueue({
        command: 'get',
        argv: [v.awemeId, '--new', '--depth', '1', '--count', '20'],
        label: `拉取评论（${(v.title || v.awemeId).slice(0, 18)}）`,
      });
      // enqueue 失败时它自己已经弹过原因（未连接 / 被策略拦下），这里只数成功的
      if (id) queueIn.push({ id, awemeId: v.awemeId });
    }
    if (!queueIn.length) return;

    for (const q of queueIn) addingRef.current.set(q.awemeId, q.id);
    setAdding(new Set(addingRef.current.keys()));
    setPicked(new Set());
    setJustDone(null);
    setNotice(`已排入 ${queueIn.length} 条。队列是一条条走的，每条之间要等一次读间隔`
      + ` —— ${queueIn.length} 条不是"一会儿全部好"，而是按间隔依次完成。`
      + '可以放着让它跑，拉完的行会自己变成「去工作台」。');
    watchQueue();
  }

  /**
   * 回收完成的任务，把行上的"拉取中…"撤掉并刷新它的状态。
   *
   * 只订阅一次：批量 20 条若逐条挂监听，就是 20 个 onChanged
   * 在同一次推送里各扫一遍任务表，而且谁都不负责取消。
   */
  function watchQueue() {
    if (watchRef.current) return;
    watchRef.current = window.dy.queue.onChanged((payload) => {
      if (collectAdded(payload.tasks || [])) stopWatching();
    });
  }

  function stopWatching() {
    if (watchRef.current) {
      watchRef.current();
      watchRef.current = null;
    }
  }

  /**
   * 把已经跑完的"拉取评论"任务落回行上，并攒成一份账单。
   *
   * 成功与失败必须分开数：整批只说"完成了 N 条"的话，那几条失败的行仍然写着
   * 「加入运营对象」，而用户刚看过批量条上那个 N —— 两边对不上就只能怀疑数据丢了。
   *
   * @returns {boolean} 是否已经没有在等的任务了（调用方据此退订）
   */
  function collectAdded(tasks) {
    const ok = [];
    const failedIds = [];
    for (const [awemeId, id] of addingRef.current) {
      const t = tasks.find(x => x.id === id);
      if (!isSettled(t)) continue;
      addingRef.current.delete(awemeId);
      if (t.status === 'done') ok.push(awemeId); else failedIds.push(awemeId);
    }
    const settled = ok.length + failedIds.length;
    if (!settled) return addingRef.current.size === 0;
    setAdding(new Set(addingRef.current.keys()));
    // 失败的行也要重问一次状态：它可能其实已经写进库了（拉了一半），
    // 只刷成功的那半会让行上的按钮停在错误的分支上
    refreshStatus([...ok, ...failedIds]);
    setJustDone(prev => {
      const base = prev || { ok: [], failed: 0 };
      return { ok: [...base.ok, ...ok], failed: base.failed + failedIds.length };
    });
    return addingRef.current.size === 0;
  }

  /**
   * 续上"离开这一页期间"跑完的拉取任务。
   *
   * 与 pending 那条同一个道理：变更事件不会重发。这一页卸载时退掉了订阅，
   * 回来若不照快照补一次，行上会永远挂着"拉取中…"，而账单也永远出不来。
   */
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current || !queueState) return;
    resumedRef.current = true;
    if (!addingRef.current.size) return;
    if (collectAdded(queueState.tasks || [])) stopWatching();
    else watchQueue(); // 还有在跑的：把这一页的监听重新挂上
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueState]);

  /**
   * 把这一页的浏览状态写回 App。
   *
   * 只在变化时写、不在渲染里读 —— 与工作台那份 `wsMemo` 同一套：
   * 切页时组件卸载，state 就没了，而"等过一轮读间隔才换来的结果"是这一页最贵的东西。
   */
  useEffect(() => {
    if (onMemo) {
      onMemo({
        mode, keyword, userInput, results, status, pending, notice, error, justDone,
        kind: kindRef.current,
        picked: [...picked],
        addingPairs: [...addingRef.current.entries()],
      });
    }
  }, [mode, keyword, userInput, results, status, pending, notice, error,
    justDone, picked, adding]); // eslint-disable-line react-hooks/exhaustive-deps

  function togglePick(awemeId) {
    setPicked(prev => {
      const n = new Set(prev);
      if (n.has(awemeId)) n.delete(awemeId); else n.add(awemeId);
      return n;
    });
  }

  // 可以加入的 = 结果减去"当前账号已经在运营的"（那些只剩去工作台，勾选没有意义）
  const addable = results.filter(v => !(status[v.awemeId] && status[v.awemeId].mineOfCurrent));
  const pickedAddable = addable.filter(v => picked.has(v.awemeId));
  const allPicked = addable.length > 0 && pickedAddable.length === addable.length;

  const searching = results.length === 0 && pending;

  /**
   * 正在等的搜索/看主页任务。
   *
   * 从队列快照按 id 取，而不是自己再攒一份状态：这一页被卸载期间队列照跑，
   * 回来时快照里就是最新的那一格，倒计时不会是从前。
   */
  const pendingTask = pending
    ? ((queueState && queueState.tasks) || []).find(t => t.id === pending)
    : null;

  /** 这一批「拉取评论」任务里正在跑的那一条，以及还在排队的条数 */
  const liveAdd = useMemo(() => {
    const ids = [...addingRef.current.values()];
    if (!ids.length) return null;
    const tasks = (queueState && queueState.tasks) || [];
    const mine = ids.map(id => tasks.find(t => t.id === id)).filter(Boolean);
    const running = mine.find(t => !FINISHED.includes(t.status));
    if (!running) return null;
    return { task: running, queued: mine.filter(t => t.status === 'pending').length };
  }, [queueState, adding]);

  return (
    <div className="main-col">
      <h1 className="page-title">找视频</h1>
      <p className="page-sub">
        在这里找到值得评论的视频，加进「运营对象」。搜索与查看主页都是<b>只读</b>操作 ——
        不会发布任何内容，但同样受读间隔约束（要等的时候，这一页直接给出还要等多久）。
      </p>

      <div className="seg discover-mode">
        <button
          className={`seg-item ${mode === 'search' ? 'seg-item-active' : ''}`}
          onClick={() => setMode('search')}
        >
          按关键词搜
        </button>
        <button
          className={`seg-item ${mode === 'user' ? 'seg-item-active' : ''}`}
          onClick={() => setMode('user')}
        >
          按用户看主页
        </button>
      </div>

      <div className="row discover-bar">
        {mode === 'search' ? (
          <input
            className="input discover-input"
            placeholder="搜什么？比如「抖音运营」「AI 工具」"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') run('search'); }}
          />
        ) : (
          <input
            className="input discover-input"
            placeholder="粘主页链接（https://www.douyin.com/user/MS4wLjAB…）或 sec_uid"
            value={userInput}
            onChange={e => setUserInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') run('user'); }}
          />
        )}
        <button
          className="btn btn-primary"
          disabled={!!pending || !actions.canQueue}
          title={!actions.canQueue ? '浏览器未连接 —— 先到「连接」页接上抖音' : undefined}
          onClick={() => run(mode)}
        >
          {pending && <Spinner size={12} />}
          {mode === 'search' ? '搜索' : '看主页'}
        </button>
      </div>

      {notice && <div className="notice"><div>{notice}</div></div>}
      {error && <div className="notice notice-bad"><div>{error}</div></div>}

      {justDone && (justDone.ok.length > 0 || justDone.failed > 0) && (
        // 拉完是这一页真正的"下一步"时刻：以前只会把行上的按钮换成「去工作台」，
        // 用户得自己在 20 行里找到那条。失败的条数必须一起说 —— 整批只报"完成"
        // 的话，失败的那几行仍然写着「加入运营对象」，跟数字对不上。
        <div className="notice">
          <div>
            已拉完 <b className="num">{justDone.ok.length}</b> 个视频的评论
            {justDone.failed > 0 && <>，另有 <b className="num text-bad">{justDone.failed}</b> 个没拉到 —— 行上仍是「加入运营对象」，可以再点一次</>}
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            {justDone.ok.length === 1 ? (
              <button className="btn btn-primary" onClick={() => actions.openWorkspace(justDone.ok[0])}>
                去这个视频的工作台
              </button>
            ) : (
              <button className="btn" onClick={() => actions.goto('targets')}>
                去「运营对象」看这一批
              </button>
            )}
          </div>
        </div>
      )}

      {searching ? (
        <>
          <EmptyState
            variant="loading"
            title={mode === 'search' ? '正在搜索…' : '正在读取主页…'}
            hint="读操作要等一次读间隔（默认 30–50 秒）。"
          />
          {/* 等的是哪一段、还要多久、能不能收手 —— 都留在这一页。
              以前这里只写"队列页能看到还剩多久"，而读操作的 task.wait 根本没有值。 */}
          {pendingTask && (
            <TaskActivity
              task={pendingTask}
              onCancel={actions.cancelTask}
              cancelNote="取消在下一个等待边界生效：已经发出去的那一个请求打不断。"
            />
          )}
        </>
      ) : results.length === 0 ? (
        <EmptyState
          title="还没有结果。"
          hint={mode === 'search'
            ? '上面输一个关键词点「搜索」。搜到的视频点「加入运营对象」才会开始拉它的评论。'
            : '粘一个抖音用户主页的链接（或 MS4wLjAB 开头的那串 sec_uid），看他的作品列表。'}
          action={mode === 'search' && (
            <HistoryChips
              history={history}
              busy={!!pending}
              canQueue={actions.canQueue}
              onPick={(kw) => { setKeyword(kw); runWith('search', kw); }}
            />
          )}
        />
      ) : (
        <>
          <div className="row discover-tools">
            <span className="muted">
              本页 <span className="num">{results.length}</span> 个，
              可加入 <span className="num">{addable.length}</span> 个
            </span>
            {addable.length > 0 && (
              <button
                className="btn btn-quiet drafts-pickall"
                onClick={() => setPicked(allPicked
                  ? new Set()
                  : new Set(addable.map(v => v.awemeId)))}
              >
                {allPicked ? '取消全选' : `全选可加入的 ${addable.length} 个`}
              </button>
            )}
            {/* 加完要有地方看。以前这句只能靠用户自己想起侧栏里还有一个「运营对象」 */}
            <button className="btn btn-quiet drafts-pickall" onClick={() => actions.goto('targets')}>
              去「运营对象」
            </button>
          </div>

          {pickedAddable.length > 0 && (
            <div className="row ws-bulkbar" style={{ marginBottom: 10 }}>
              <span className="drafts-bulkbar-main">
                已选 {pickedAddable.length} 个 —— 加入就是逐个拉它们的评论
                <span className="muted">　·　队列串行，每两条之间要等一次读间隔</span>
              </span>
              <button
                className="btn btn-primary"
                disabled={!actions.canQueue}
                title={!actions.canQueue
                  ? '浏览器未连接 —— 先到「连接」页接上抖音，拉评论要经过它'
                  : `把这 ${pickedAddable.length} 个视频逐条排进队列拉评论`}
                onClick={() => addTargets(pickedAddable)}
              >
                加入运营对象 {pickedAddable.length} 个
              </button>
              <button className="btn btn-quiet" onClick={() => setPicked(new Set())}>取消选择</button>
            </div>
          )}

          {/* 批量拉取时这一批要跑 N × 读间隔。行上那个「拉取中…」不告诉人
              现在轮到谁、还要等多久，也告诉不了 —— 所以这一条单独占一行。 */}
          {liveAdd && (
            <TaskActivity
              task={liveAdd.task}
              note={liveAdd.queued > 0 ? `还有 ${liveAdd.queued} 条在排队` : '这是这一批的最后一条'}
              onCancel={actions.cancelTask}
              cancelNote="取消只停这一条 —— 队列里其它任务照跑；要全部停就去「队列」页按「取消排队中的 N 条」。"
            />
          )}

          <div className="list">
            {results.map(v => (
              <DiscoverRow
                key={v.awemeId}
                v={v}
                st={status[v.awemeId]}
                adding={adding.has(v.awemeId)}
                picked={picked.has(v.awemeId)}
                onPick={() => togglePick(v.awemeId)}
                onAdd={() => addTargets([v])}
                onOpen={actions.openWorkspace}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 一条搜索结果。
 *
 * 三种状态各自给一个明确的动作，不让用户猜：
 *   库里没有 / 有但不是当前账号的 → 勾选框 + 「加入运营对象」
 *   已经是当前账号在运营的        → 显示待回复数 + 「去工作台」
 * 已经在运营的不给勾选：它没有"加入"这个动作，勾上了也只能排一条注定重复的任务。
 */
function DiscoverRow({ v, st, adding, picked, onPick, onAdd, onOpen }) {
  const inLib = st && st.inLibrary;
  const mine = st && st.mineOfCurrent;
  return (
    <div className="row-item discover-row">
      {mine
        ? <span className="discover-pick" />
        : (
          <label className="discover-pick" title="勾选后可以一次加入多个">
            <input type="checkbox" checked={picked} onChange={onPick} />
          </label>
        )}
      {v.cover
        ? <img className="cover discover-cover" src={v.cover} alt="" loading="lazy" />
        : <div className="cover cover-fallback discover-cover" />}
      <div className="row-main">
        <div className="row-title">{v.title || '（无标题）'}</div>
        <div className="row-sub discover-sub">
          {v.author || '未知作者'}
          {v.plays > 0 && <> · <span className="num">{abbrNum(v.plays)}</span> 播放</>}
          {v.likes > 0 && <> · <span className="num">{abbrNum(v.likes)}</span> 点赞</>}
          {inLib && st.commentCount > 0 && <> · 本地已有 <span className="num">{st.commentCount}</span> 条评论</>}
        </div>
      </div>
      <div className="discover-actions">
        {mine ? (
          <>
            {st.pending > 0 && <span className="num discover-pending">{st.pending} 待回复</span>}
            <button className="btn btn-quiet" onClick={() => onOpen(v.awemeId)}>去工作台</button>
          </>
        ) : (
          <button className="btn" onClick={onAdd} disabled={adding}>
            {adding && <Spinner size={12} />}
            {adding ? '拉取中…' : inLib ? '拉取它的评论' : '加入运营对象'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 空态里的「最近搜过」。
 *
 * 为什么不是内置推荐词：那是这个工具的**作者**想象中的领域，对拿它卖水果的人是噪音，
 * 而噪音会被摆在整页最显眼的位置。这里只说一件核对得上的事 —— 你在这台机器上
 * 搜过这几个词（数据是 events 表里 status='success' 的 search 记录）。
 *
 * 三种"没有"要分开说，它们指向完全不同的下一步：
 *   还没读回来 → 什么都不画（画了就是猜）
 *   读失败     → 说没读回来，并且不假装"没有历史"
 *   真没有     → 说清是"没有一次成功搜索"还是"整台机器没搜过"
 */
function HistoryChips({ history, busy, canQueue, onPick }) {
  if (!history) return null;
  if (history.error) {
    return <div className="empty-hint">搜索历史这次没读回来：{history.error} —— 上面照常输关键词就行。</div>;
  }
  if (!history.items.length) {
    return (
      <div className="empty-hint">
        {history.scanned > 0
          ? `这台机器上还没有一次搜出结果的搜索（翻了近 ${history.scanned} 条搜索记录）。`
          : '这台机器上还没有搜索记录 —— 这是第一次用这一页，输个词就能开始。'}
      </div>
    );
  }
  return (
    <div className="empty-chips">
      <div className="empty-hint">最近搜过这几个词，点一下就再搜一次：</div>
      <div className="empty-chips-row">
        {history.items.map(k => (
          <button
            key={k.keyword}
            className="btn btn-quiet empty-chip"
            disabled={busy || !canQueue}
            title={!canQueue
              ? '浏览器未连接 —— 先到「连接」页接上抖音'
              : `再搜一次「${k.keyword}」`}
            onClick={() => onPick(k.keyword)}
          >
            {k.keyword}
            <span className="empty-chip-meta num">
              {k.lastCount == null ? '条数没记下' : `上次 ${k.lastCount} 条`}
              {k.times > 1 && ` · 搜过 ${k.times} 次`}
              {' · '}{ago(k.lastTs)}
            </span>
          </button>
        ))}
      </div>
      <div className="empty-hint">
        这几个词是从本机的操作记录里读的
        {history.truncated ? `（只看近 ${history.scanned} 条搜索记录，更早的没算）` : ''}
        ；在「诊断」页按天清理数据会连它们一起清掉。
      </div>
    </div>
  );
}

/**
 * 把两个命令的返回**归一成同一种形状**。
 *
 * 它们本来就长得不一样，而且这不一样有历史原因：
 *   `search` 经 withAudit 返回的是**裸数组**（它的 output 就是 items），
 *   字段是蛇形（aweme_id）；`user` 直接返回对象（`{user, aweme_list, …}`），
 *   字段也是蛇形但带 stats/cover。
 * 界面不该到处判断"这次是哪个命令的结果"，所以在这里收口一次。
 *
 * 认不出来的形状返回空数组 —— 显示"没有结果"比渲染一堆 undefined 好。
 */
function normalize(kind, res) {
  if (!res) return [];
  const isSearch = kind === 'search';
  const list = isSearch
    ? (Array.isArray(res) ? res : [])
    : (Array.isArray(res.aweme_list) ? res.aweme_list : []);
  // `user` 的每条作品里**不带作者名**（作者在顶层那个 user 上），
  // 逐条拿 it.author 会一律是 undefined —— 界面就会显示"未知作者"，
  // 而我们知道这是谁的作品。整批补上。
  const owner = !isSearch && res.user ? (res.user.nickname || '') : '';
  return list.map(it => ({
    awemeId: String(it.aweme_id || ''),
    title: it.desc || '',
    author: it.author || owner || '',
    plays: it.plays || it.stats?.plays || 0,
    likes: it.likes || it.stats?.likes || 0,
    cover: it.cover || '',
  })).filter(it => it.awemeId);
}
