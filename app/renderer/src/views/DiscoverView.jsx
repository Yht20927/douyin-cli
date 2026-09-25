import React, { useCallback, useEffect, useRef, useState } from 'react';
import EmptyState from '../components/EmptyState.jsx';
import Spinner from '../components/Spinner.jsx';
import { abbrNum } from '../format.js';
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

export default function DiscoverView({ actions }) {
  const [mode, setMode] = useState('search');
  const [keyword, setKeyword] = useState('');
  const [userInput, setUserInput] = useState('');

  const [results, setResults] = useState([]);
  const [status, setStatus] = useState({});
  /** 正在等的任务（搜索 / 看主页），跑完自动取结果 */
  const [pending, setPending] = useState(null);
  /** 已加入过队列、正在等结果的那几条视频 id */
  const [adding, setAdding] = useState(() => new Set());
  /** 勾选要批量加入的视频 id */
  const [picked, setPicked] = useState(() => new Set());
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  /** 这次等的是哪个命令的结果（'search' | 'user'）—— normalize 要按它分派 */
  const kindRef = useRef('search');
  /** 视频 id → 正在为它拉评论的任务 id。批量时靠它把完成的任务落回行上 */
  const addingRef = useRef(new Map());
  /** 只订阅一次队列，避免"点了 8 次就挂 8 个监听" */
  const watchRef = useRef(null);

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

  // 任务跑完 → 取结果
  useEffect(() => {
    if (!pending) return undefined;
    const un = window.dy.queue.onChanged(async (payload) => {
      const t = (payload.tasks || []).find(x => x.id === pending);
      if (!t || !['done', 'failed', 'blocked', 'cancelled'].includes(t.status)) return;
      setPending(null);
      if (t.status !== 'done') {
        setError(failText(t.error, '未完成'));
        return;
      }
      const r = await window.dy.queue.result(pending);
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
    });
    return un;
  }, [pending, refreshStatus]);

  async function run(kind) {
    const kw = (kind === 'search' ? keyword : userInput).trim();
    if (!kw) return;
    const spec = kind === 'search'
      ? { command: 'search', argv: [kw, '--count', String(PAGE_SIZE)], label: `搜索「${kw}」` }
      : { command: 'user', argv: [kw, '--count', String(PAGE_SIZE)], label: `看主页 ${kw}` };
    const id = await actions.enqueue(spec);
    if (!id) return;
    setResults([]);
    setError(null);
    setNotice(null);
    kindRef.current = kind;
    setPending(id);
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
      const tasks = payload.tasks || [];
      const finished = [];
      for (const [awemeId, id] of addingRef.current) {
        const t = tasks.find(x => x.id === id);
        if (t && ['done', 'failed', 'blocked', 'cancelled'].includes(t.status)) finished.push(awemeId);
      }
      if (!finished.length) return;
      for (const a of finished) addingRef.current.delete(a);
      setAdding(new Set(addingRef.current.keys()));
      refreshStatus(finished);
      if (!addingRef.current.size && watchRef.current) {
        watchRef.current();
        watchRef.current = null;
      }
    });
  }

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

  return (
    <div className="main-col">
      <h1 className="page-title">找视频</h1>
      <p className="page-sub">
        在这里找到值得评论的视频，加进「运营对象」。搜索与查看主页都是<b>只读</b>操作 ——
        不会发布任何内容，但同样受读间隔约束（队列页能看到倒计时）。
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

      {searching ? (
        <EmptyState
          variant="loading"
          title={mode === 'search' ? '正在搜索…' : '正在读取主页…'}
          hint="读操作要等读间隔（默认 30–50 秒），队列页能看到还剩多久。"
        />
      ) : results.length === 0 ? (
        <EmptyState
          title="还没有结果。"
          hint={mode === 'search'
            ? '上面输一个关键词点「搜索」。搜到的视频点「加入运营对象」才会开始拉它的评论。'
            : '粘一个抖音用户主页的链接（或 MS4wLjAB 开头的那串 sec_uid），看他的作品列表。'}
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
