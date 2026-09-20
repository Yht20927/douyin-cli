import React, { useCallback, useEffect, useRef, useState } from 'react';
import EmptyState from '../components/EmptyState.jsx';
import Spinner from '../components/Spinner.jsx';
import { abbrNum } from '../format.js';

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
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  /** 这次等的是哪个命令的结果（'search' | 'user'）—— normalize 要按它分派 */
  const kindRef = useRef('search');

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
        setError(t.error || '未完成');
        return;
      }
      const r = await window.dy.queue.result(pending);
      // ⚠️ kind 必须取自入队时记下的那个，**不能**拿 pending（它是任务 id）。
      // 写成 normalize(pending, …) 的话两个分支都会走错那个，
      // 表现是"搜索结果永远是空的" —— 而错误本身不抛，只是没结果。
      const items = normalize(kindRef.current, r && r.result);
      setResults(items);
      setError(null);
      setNotice(items.length === 0
        ? '没有结果。换个关键词，或者确认浏览器里已登录、页面开着。'
        : `找到 ${items.length} 个视频 —— 点「加入运营对象」会去拉它的评论（读操作，要等间隔）。`);
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
  async function addTarget(v) {
    const id = await actions.enqueue({
      command: 'get',
      argv: [v.awemeId, '--new', '--depth', '1', '--count', '20'],
      label: `拉取评论（${(v.title || v.awemeId).slice(0, 18)}）`,
    });
    if (!id) return;
    setAdding(prev => new Set(prev).add(v.awemeId));
    setNotice('已加入队列 —— 拉完评论它就会出现在「运营对象」里。读操作要等间隔。');
    // 拉完刷新这条的状态（顺便把"待回复 N"带出来）
    const un = window.dy.queue.onChanged((payload) => {
      const t = (payload.tasks || []).find(x => x.id === id);
      if (t && ['done', 'failed', 'blocked', 'cancelled'].includes(t.status)) {
        un();
        setAdding(prev => { const n = new Set(prev); n.delete(v.awemeId); return n; });
        refreshStatus([v.awemeId]);
      }
    });
  }

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
        <div className="list">
          {results.map(v => (
            <DiscoverRow
              key={v.awemeId}
              v={v}
              st={status[v.awemeId]}
              adding={adding.has(v.awemeId)}
              onAdd={() => addTarget(v)}
              onOpen={actions.openWorkspace}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 一条搜索结果。
 *
 * 三种状态各自给一个明确的动作，不让用户猜：
 *   库里没有 / 有但不是当前账号的 → 「加入运营对象」
 *   已经是当前账号在运营的        → 显示待回复数 + 「去工作台」
 */
function DiscoverRow({ v, st, adding, onAdd, onOpen }) {
  const inLib = st && st.inLibrary;
  const mine = st && st.mineOfCurrent;
  return (
    <div className="row-item discover-row">
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
