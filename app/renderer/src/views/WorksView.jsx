import React from 'react';
import LoadingState from '../components/LoadingState.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { abbrNum } from '../format.js';
import useAutoRefresh from '../useAutoRefresh.js';

/**
 * 互动数据是否已经拉到过（v9 之前入库的视频没有这些列）
 */
function hasAnyStat(stats) {
  if (!stats) return false;
  return ['plays', 'likes', 'comments', 'shares'].some(k => stats[k] != null);
}

function ago(ts) {
  if (!ts) return '从未拉取';
  const ms = Date.now() - ts;
  if (ms < 60000) return '刚刚';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/**
 * 作品发布时间。
 *
 * 注意单位：videos.create_time 来自抖音的 create_time，是**秒**
 * （见 core/memory/db.js 的时间戳约定），要乘 1000 才能交给 Date。
 *
 * 用绝对日期而不是"多久之前"：作品的发布时间是一个事实，
 * 而"3 个月前"这种相对说法在作品列表里没有决策价值，
 * 反而会和"这条评论多久没处理了"混在一起。
 */
function formatPublishDate(seconds) {
  if (!seconds) return '发布时间未知';
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) return '发布时间未知';
  const now = new Date();
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  // 跨年时带上年份，否则会以为是今年发的
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

/** 最后拉取时间：这是"我上次同步到哪"，与作品发布时间是两回事，必须标明 */
function fetchLabel(ms) {
  if (!ms) return '从未拉取';
  return `${ago(ms)}拉取`;
}

/**
 * 封面缩略图。
 *
 * 抖音的图存在 CDN 上，可能因防盗链或网络问题加载失败 —— 失败就降级成
 * 一个中性色块，而不是留个破图图标。列表的可用性不该被图片拖累。
 */
function Cover({ url }) {
  const [failed, setFailed] = React.useState(false);
  if (!url || failed) return <div className="cover cover-fallback" />;
  return (
    <img
      className="cover"
      src={url}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * 我的作品列表。
 *
 * `total` 是**数据库里的真实作品数**，来自 data.videos 的返回。
 * 改造前这里把 list.length 当总数显示（"共 50 个作品"），而有 120 个作品时
 * 第 51 个以后既看不到也点不进去 —— 工作台的唯一入口就在这一行。
 * 现在「加载更早」逐步放大读取上限（本地库直读，放大没有代价）。
 */
export default function WorksView({ videos, total, loading, actions, onRefresh, onLoadMore }) {
  const [q, setQ] = React.useState('');

  // 定时重读（间隔在设置页里配，0 = 关）。只读本地库，不发抖音请求。
  // 用 onRefresh 而不是自己再取一次 —— 列表由 App 持有，取数口径只有一份
  useAutoRefresh('works', onRefresh);
  const list = videos || [];
  const kw = q.trim();
  // 搜索只筛**已加载**的部分，并如实说明 —— "看到的就是全部"比藏在背后的
  // 全量扫描更不容易让人误会
  const filtered = kw
    ? list.filter(v => (v.title || '').includes(kw) || v.awemeId.includes(kw))
    : list;
  const hasMore = total > list.length;

  return (
    <div className="main-col">
      <h1 className="page-title">我的作品</h1>
      <p className="page-sub">
        这里的数字来自本地记录 —— 上次拉取时存下来的。想看最新的就点「刷新列表」。
      </p>

      <div className="row" style={{ marginBottom: 18 }}>
        <button
          className="btn btn-primary"
          disabled={loading || !actions.canQueue}
          title={!actions.canQueue
            ? '浏览器未连接 —— 先到「连接」页接上抖音'
            : '从抖音拉取最近 50 个作品（不发布任何内容）'}
          onClick={onRefresh}>
          刷新列表
        </button>
        <input
          className="input"
          style={{ width: 230 }}
          placeholder="搜索标题或视频 ID（限已加载的）"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <span className="muted" style={{ alignSelf: 'center', fontSize: 12.5 }}>
          共 {total || list.length} 个作品
          {total > list.length && `（已加载最近 ${list.length} 个）`}
          {kw && ` · 匹配 ${filtered.length} 条`}
        </span>
      </div>

      {loading && list.length === 0
        // 骨架屏而不是一句「正在读取…」：作品行有封面、有高，文字塌成一行
        // 会让数据回来时整页重排（见 Skeleton 的注释）
        ? <LoadingState rows={6} thumb title />
        : list.length === 0
          ? (
            <EmptyState
              title="还没有作品记录。"
              hint={<>点上面的「刷新列表」从抖音拉一次 —— 前提是浏览器里已装好脚本并打开着 douyin.com。</>}
            />
          )
          : (
            <>
              <div className="list">
                {filtered.map(v => (
                <button
                  className="work-row"
                  key={v.awemeId}
                  onClick={() => actions.openWorkspace(v.awemeId)}
                >
                  <Cover url={v.coverUrl} />

                  <div className="work-main">
                    <div className="work-title">{v.title || '（无标题）'}</div>

                    {/* 互动数据来自上次「刷新列表」。一个都没拉到时不显示这一行 ——
                        否则满屏的"— 播放 — 点赞"看着像坏了，而其实只是还没拉过。 */}
                    {hasAnyStat(v.stats) ? (
                      <div className="work-meta">
                        <span className="num">{abbrNum(v.stats.plays)}</span> 播放
                        <i />
                        <span className="num">{abbrNum(v.stats.likes)}</span> 点赞
                        <i />
                        <span className="num">{abbrNum(v.stats.comments)}</span> 评论
                        <i />
                        <span className="num">{abbrNum(v.stats.shares)}</span> 分享
                      </div>
                    ) : (
                      <div className="work-meta muted">互动数据尚未拉取</div>
                    )}

                    <div className="work-meta muted">
                      本地已存 <span className="num">{v.commentStats.total}</span> 条评论
                      {/* "我发的"单独标出来：它既不是待回复也不是已回复，
                          不说明的话"本地 36 条 · 待回复 2"会让人对不上账 */}
                      {v.commentStats.mine > 0 && (
                        <> · 其中我发的 <span className="num">{v.commentStats.mine}</span> 条</>
                      )}
                      {v.commentStats.pending > 0
                        ? <> · <b className="text-strong">待回复 {v.commentStats.pending}</b></>
                        : (v.commentStats.total > 0 && ' · 没有待回复')}
                    </div>
                  </div>

                  {/* 右侧两行都带明确标签。改造前这里只放一个没有标签的时间戳，
                      而它是"最后拉取评论的时间" —— 落在作品旁边必然被读成发布时间。 */}
                  <div className="work-side">
                    <div className="work-date">{formatPublishDate(v.createTime)}</div>
                    <div className="work-fetch muted">{fetchLabel(v.lastGetTs)}</div>
                    <div className="chev">›</div>
                  </div>
                </button>
              ))}
              </div>

              {/* 「加载更早」只在没有搜索词时出现 —— 搜索是针对已加载内容的，
                  此时加载更多只会让"匹配数"和"已加载数"互相追赶，没有意义 */}
              {hasMore && !kw && (
                <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}>
                  <button className="btn" disabled={loading} onClick={onLoadMore}>
                    {loading ? '读取中…' : `加载更早的作品（还有 ${total - list.length} 个）`}
                  </button>
                </div>
              )}
            </>
          )}
    </div>
  );
}
