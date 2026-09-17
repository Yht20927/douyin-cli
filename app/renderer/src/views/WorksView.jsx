import React from 'react';

/** 大数字缩写：2589 → 2.6k，避免列表里数字长度参差 */
function abbr(n) {
  if (n == null) return '—';
  if (n < 10000) return String(n);
  return `${(n / 10000).toFixed(1)}w`;
}

/** 互动数据是否已经拉到过（v9 之前入库的视频没有这些列） */
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

export default function WorksView({ videos, loading, actions }) {
  const list = videos || [];

  return (
    <div className="main-col">
      <h1 className="page-title">我的作品</h1>
      <p className="page-sub">
        这里的数字来自本地记录 —— 上次拉取时存下来的。想看最新的就点「刷新列表」。
      </p>

      <div className="row" style={{ marginBottom: 18 }}>
        <button className="btn btn-primary" disabled={loading}
          onClick={() => actions.runCommand({
            command: 'my', argv: ['--count', '20'], label: '拉取我的作品',
            afterDone: 'refreshVideos',
          })}>
          刷新列表
        </button>
        <span className="muted" style={{ alignSelf: 'center', fontSize: 12.5 }}>
          共 {list.length} 个作品
        </span>
      </div>

      {loading && list.length === 0
        ? <div className="empty">正在读取…</div>
        : list.length === 0
          ? (
            <div className="empty">
              还没有作品记录。<strong>点上面的「刷新列表」</strong>从抖音拉一次 ——
              前提是浏览器里已装好脚本并打开着 douyin.com。
            </div>
          )
          : (
            <div className="list">
              {list.map(v => (
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
                        <span className="num">{abbr(v.stats.plays)}</span> 播放
                        <i />
                        <span className="num">{abbr(v.stats.likes)}</span> 点赞
                        <i />
                        <span className="num">{abbr(v.stats.comments)}</span> 评论
                        <i />
                        <span className="num">{abbr(v.stats.shares)}</span> 分享
                      </div>
                    ) : (
                      <div className="work-meta muted">互动数据尚未拉取</div>
                    )}

                    <div className="work-meta muted">
                      本地已存 <span className="num">{v.commentStats.total}</span> 条评论
                      {v.commentStats.pending > 0 && (
                        <> · <b className="text-strong">待回复 {v.commentStats.pending}</b></>
                      )}
                      {v.commentStats.pending === 0 && v.commentStats.total > 0 && ' · 全部已回复'}
                    </div>
                  </div>

                  <div className="work-side">
                    <div className="muted" style={{ fontSize: 12 }}>{ago(v.lastGetTs)}</div>
                    <div className="chev">›</div>
                  </div>
                </button>
              ))}
            </div>
          )}
    </div>
  );
}
