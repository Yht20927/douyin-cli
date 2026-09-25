import React, { useCallback, useEffect, useState } from 'react';
import EmptyState from '../components/EmptyState.jsx';
import LoadingState from '../components/LoadingState.jsx';
import Notice from '../components/Notice.jsx';
import Spinner from '../components/Spinner.jsx';
import { ago } from '../format.js';
import { failText } from '../errors.js';
import useAutoRefresh from '../useAutoRefresh.js';

/**
 * 运营对象 —— 别人的视频里我正在互动的那批评论区。
 *
 * 为什么要有这一页
 * ----------------
 * 这个工具的实际打法是在**别人的**视频评论区互动引流，而此前工作台的
 * 唯一入口是「我的作品」（只列 is_mine=1）。实测某台机器上 215 个视频里
 * 只有 7 个是自己的、1850 条评论（96%）落在别人那边 —— 也就是说
 * 真正在运营的东西在界面上根本不可达，只能靠命令行。
 *
 * 与「我的作品」的分工：
 *   - 我的作品 → 我发的内容，看的是播放/点赞（作品视角）
 *   - 运营对象 → 我要去回的评论区，看的是待回复（工作量视角）
 *
 * 标题可能为空的说明见下面 renderRow 的注释。
 */

/** 一页取多少条。真实总数由 core 返回，页面显示「共 N 个」 */
const PAGE_SIZE = 200;

/**
 * 补全结果 → 一句话。
 *
 * 明细取不回来时（200 条的 updated 数组可能超过队列 64KB 的结果上限）
 * 要说"跑完了、明细没取回来"，不能把 undefined 当成 0 条 ——
 * 那一趟真的发了请求也写了库，报"补全 0 条"会让人以为没生效而再点一次，白跑一遍。
 */
function describeEnrich(res) {
  if (!res || typeof res !== 'object') {
    return { text: '补全跑完了，但结果明细太大没能取回来 —— 看列表里的标题是否补上即可确认', warn: false };
  }
  const requested = Number(res.requested) || 0;
  const done = Number(res.updatedCount) || 0;
  const failed = Number(res.failedCount) || 0;
  if (!requested) return { text: '没有需要补全的视频 —— 本地这些作品的标题与封面已经齐了', warn: false };
  if (failed) {
    // 逐条失败原因里最常见的是"桥接超时"与"服务没起来"那两句英文串，
    // 运营者从中读不出该做什么，所以先过一遍翻译层再举例。
    const one = Array.isArray(res.failed) ? res.failed[0] : null;
    const first = one && one.error ? failText(one.error, '未知原因') : '';
    return {
      text: `补全 ${done}/${requested} 条，${failed} 条没取到${first ? `（例如：${first}）` : ''}`,
      warn: done === 0,
    };
  }
  return { text: `补全完成：${done}/${requested} 条已写入标题与封面`, warn: false };
}

export default function TargetsView({ actions }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [order, setOrder] = useState('pending');
  /** 已加载的条数上限 —— 点「加载更多」放大 */
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [enriching, setEnriching] = useState(null);
  /** 上一次补全的账面结果 `{ text, warn }`，null = 还没跑过 */
  const [enrichResult, setEnrichResult] = useState(null);

  const reload = useCallback(async (nextLimit) => {
    setLoading(true);
    try {
      const r = await window.dy.data.targets({ order, limit: nextLimit || limit });
      if (r.ok) { setData(r.data); setError(null); }
      else setError(failText(r.error, '未知错误'));
    } finally {
      setLoading(false);
    }
  }, [order, limit]);

  useEffect(() => { reload(); /* eslint-disable-line */ }, [order, limit]);

  // 定时重读（间隔在设置页里配，0 = 关）。只读本地库，不发抖音请求。
  useAutoRefresh('targets', () => reload());

  async function enrich() {
    setEnrichResult(null);
    const r = await window.dy.queue.enqueue({
      command: 'enrich',
      argv: ['--missing', '--limit', '200'],
      label: '补全视频信息',
    });
    if (!r.ok) { setError(failText(r.error, '入队失败')); return; }
    setEnriching(r.id);
  }

  // 补全任务跑完自动刷新列表 —— 不刷新的话标题补上了列表还是旧的，
  // 用户会以为没生效（与「拉取我的作品」同一个联动）
  useEffect(() => {
    if (!enriching) return undefined;
    const un = window.dy.queue.onChanged((payload) => {
      const t = (payload.tasks || []).find(x => x.id === enriching);
      if (t && ['done', 'failed', 'blocked', 'cancelled'].includes(t.status)) {
        const id = enriching;
        setEnriching(null);
        if (t.status === 'done') {
          // 数量只在完整结果里（resultSummary 对对象只有键名清单）。
          // 200 条的 updated 数组有可能超过队列 64KB 的结果上限 ——
          // 那时取回 null，**不能**报成"补全 0 条"，那是在说一件没发生的事。
          window.dy.queue.result(id).then((r) => setEnrichResult(describeEnrich(r && r.result)));
        } else {
          setEnrichResult({ text: `补全未完成：${failText(t.error, '未知原因')}`, warn: true });
        }
        reload();
      }
    });
    return un;
  }, [enriching, reload]);

  if (error) {
    return (
      <div className="main-col">
        <h1 className="page-title">运营对象</h1>
        <div className="notice notice-bad"><div>读取本地数据失败：{error}</div></div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" onClick={() => reload()}>重试</button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="main-col">
        <h1 className="page-title">运营对象</h1>
        <LoadingState rows={5} title />
      </div>
    );
  }

  const { items, total, shown, truncated, scanCapped, scanLimit, missingInfoCount, orders, accountCertain } = data;

  return (
    <div className="main-col">
      <h1 className="page-title">运营对象</h1>
      <p className="page-sub">
        你在<b>别人视频</b>的评论区里互动过的那些作品 —— 按还剩多少条没回排序。
        想管自己发的作品去「我的作品」。
      </p>

      <div className="row targets-bar">
        <select
          className="input"
          value={order}
          onChange={e => { setLimit(PAGE_SIZE); setOrder(e.target.value); }}
          title="排序方式"
        >
          {(orders || []).map(o => <option key={o.name} value={o.name}>{o.label}</option>)}
        </select>
        <button className="btn" onClick={() => reload()} disabled={loading}>
          {loading && <Spinner size={12} />}刷新
        </button>
        {/* 只在真的缺标题时才出现 —— 一个永远没用的按钮比没有按钮更糟 */}
        {missingInfoCount > 0 && (
          <>
            <button
              className="btn"
              onClick={enrich}
              disabled={!!enriching || !actions.canQueue}
              title={!actions.canQueue
                ? '浏览器未连接 —— 先到「连接」页接上抖音'
                : `这个数数的是库里所有还缺标题与封面的作品（${missingInfoCount} 个），点下去补的就是这一整批 ——`
                + '它和右下角的「共 N 个对象」不是一个口径：这里还包括「我的作品」，以及拉过评论但已经不在本列表里的历史对象。'
                + '补全会逐个取一次视频详情，顺便带上播放与点赞。'}
            >
              {enriching ? <><Spinner size={12} />补全中…</> : `补全视频信息（${missingInfoCount} 个）`}
            </button>
            {/* 两个数字对不上时必须在明面上讲一句 —— 悬停提示没人找，而"按钮说 200、
                页面说 5"看起来就像一个坏掉的计数。 */}
            {missingInfoCount > total && (
              <span className="muted" style={{ fontSize: 12 }}>
                （{missingInfoCount - total} 个不在本列表里 —— 含「我的作品」与历史对象）
              </span>
            )}
          </>
        )}
        <span className="muted targets-count num">
          共 {total} 个对象
          {truncated && ` · 当前显示 ${shown} 个`}
        </span>
      </div>

      {/* views.js 一直随数据返回 accountUid / accountCertain，注释写着"界面必须显示它"，
          而此前整个渲染层没有任何一处读它 —— 于是"换了号数据没变"这个用户报过的问题
          在屏幕上完全没有痕迹。accountCertain=false 意味着当前没确认到登录账号，
          列表**没有**按账号过滤（不是过滤不到），显示的是所有账号拉过评论的作品。 */}
      {!accountCertain && (
        <div className="notice notice-warn">
          <div>
            现在没确认到登录账号 —— 下面列出的是<b>所有账号</b>拉过评论的作品，不是某一个号的清单。
            到「连接」页把抖音接上（或在左下角切换账号），这份列表就会按当前账号分开显示。
          </div>
        </div>
      )}

      {scanCapped && (
        <div className="notice notice-warn">
          <div>
            视频数超出统计上限（最多扫 {scanLimit} 个），「待回复最多」可能不是全局最靠前的那个。
          </div>
        </div>
      )}

      <Notice data={enrichResult} style={{ margin: '0 0 12px' }} />

      {items.length === 0
        ? (
          <EmptyState
            title="还没有可运营的对象。"
            hint={<>运营对象 = 你在别人视频的评论区里互动过的作品。这里添加它的唯一入口是<b>「找视频」</b>：
              搜到作品、打开它拉一次评论，这个作品就会出现在下面。</>}
            action={<button className="btn btn-primary" onClick={() => actions.goto('discover')}>去「找视频」</button>}
          />
        )
        : (
          <div className="list">
            {items.map(t => {
              // 主标签首先要能认出"这是哪个视频"。标题为空的常见原因是拉评论的接口
              // 不返回视频信息（这类视频行是 get/post 顺手建出来的壳），此时作者昵称
              // 是唯一读得出身份的信息 —— 只给尾号数字，一排壳对象长得一模一样，
              // 只能逐个点进去看。
              const titled = !!t.title;
              const label = t.title || (t.authorNickname ? `${t.authorNickname} 的作品` : '');
              return (
                <button
                  className="row-item target-row"
                  key={t.awemeId}
                  onClick={() => actions.openWorkspace(t.awemeId)}
                >
                  <div className="row-main">
                    <div className="row-title">
                      {label || <span className="muted">视频 <span className="num">····{String(t.awemeId).slice(-6)}</span></span>}
                    </div>
                    <div className="row-sub target-sub">
                      <span className="num">{t.commentStats.total}</span> 条评论
                      {' · '}已回 <span className="num">{t.commentStats.replied}</span>
                      {t.commentStats.mine > 0 && <>（其中我发的 <span className="num">{t.commentStats.mine}</span>）</>}
                      {titled && t.authorNickname && <> · 作者 {t.authorNickname}</>}
                    </div>
                  </div>
                  {/* 待回复是这个页面的主指标 —— 它是"还没干完的活"，
                      所以给最大的一档字重，而不是混在说明文字里 */}
                  {t.commentStats.pending > 0
                    ? <div className="target-pending"><b className="num">{t.commentStats.pending}</b> 待回复</div>
                    : <div className="target-pending target-done muted">没有待回复</div>}
                  <div className="row-meta num">{ago(Math.max(t.lastPostTs || 0, t.lastGetTs || 0))}</div>
                  <div className="chev">›</div>
                </button>
              );
            })}
          </div>
        )}

      {truncated && (
        <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}>
          <button className="btn" disabled={loading}
            onClick={() => setLimit(limit + PAGE_SIZE)}>
            {loading ? '读取中…' : `加载更多（还有 ${total - shown} 个）`}
          </button>
        </div>
      )}
    </div>
  );
}
