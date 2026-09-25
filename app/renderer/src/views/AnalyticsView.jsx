import React, { useCallback, useEffect, useState } from 'react';
import { BarList, DayBars, Donut, TrendChart } from '../components/charts.jsx';
import EmptyState from '../components/EmptyState.jsx';
import LoadingState from '../components/LoadingState.jsx';
import Spinner from '../components/Spinner.jsx';
import { ago, abbrNum as short, commandLabel, purposeLabel } from '../format.js';
import { describeError, failText } from '../errors.js';
import useAutoRefresh from '../useAutoRefresh.js';

/** 作品对比可切换的指标 */
const METRICS = [
  { key: 'plays', label: '播放' },
  { key: 'likes', label: '点赞' },
  { key: 'comments', label: '评论' },
  { key: 'shares', label: '分享' },
];

const DECISION_META = [
  { key: 'reply', label: '建议回复', tone: 'ok' },
  { key: 'emoji_reply', label: '表情回复', tone: 'wait' },
  { key: 'skip', label: '跳过', tone: 'neutral' },
];

/**
 * 数据分析。
 *
 * 数据全部来自**本地库的上次快照**（互动数据来自上次「刷新列表」或
 * 「补全视频信息」），图表不会自己发起任何抖音请求 —— 这页是纯读。
 * 想更新数据去对应页面点刷新，或者回这里点「重新读取」。
 *
 * 口径（scope）：
 *   - 全部（默认）—— 库里的每一个视频，包括别人的。**这才是真实的工作面**：
 *     实测 215 个视频里只有 7 个是自己的、1850 条评论（96%）落在别人那边
 *   - 仅我的 —— 只算自己发的作品，用于看"我这条内容表现如何"
 */
export default function AnalyticsView({ actions }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [metric, setMetric] = useState('plays');
  const [scope, setScope] = useState('all');
  /** 时间范围（天）。7 / 30 / 90 三档 —— 趋势图在 30 天以下看不出走向 */
  const [range, setRange] = useState(30);
  /** 对比图取前几个作品 */
  const TOP_N = 8;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await window.dy.data.analytics({ scope, dayWindow: range });
      if (r.ok) { setData(r.data); setError(null); }
      else setError(failText(r.error, '未知错误'));
    } finally {
      setLoading(false);
    }
  }, [scope, range]);

  useEffect(() => { load(); }, [load]);

  // 定时重读（间隔在设置页里配，0 = 关）。只读本地库，不发抖音请求。
  useAutoRefresh('analytics', load);

  if (error) {
    return (
      <div className="main-col">
        <h1 className="page-title">数据分析</h1>
        <div className="notice notice-bad"><div>读取本地数据失败：{error}</div></div>
      </div>
    );
  }

  if (!data) {
    // 这一页的形状是"统计卡 + 图表"，与列表骨架屏不同，所以走 text 形态。
    // 但文案是「正在统计…」而不是「还没有数据」—— 两者不能长成一个样。
    return (
      <div className="main-col">
        <h1 className="page-title">数据分析</h1>
        <LoadingState variant="text" label="正在统计…" />
      </div>
    );
  }

  const t = data.totals;
  const counts = data.scopeCounts || { all: 0, mine: 0 };
  const hasVideos = data.videos.length > 0;
  const hasComments = t.localComments > 0;

  // 互动数据一个都没拉到过（v9 前入库 / 从没点过刷新列表 / 从没补全过）
  const hasAnyStat = t.statsWithData > 0;
  // 有的作品有互动数据、有的没有 —— 两者都有时，"总播放"这类数字必须带上
  // 覆盖率，否则 215 个作品配一个只覆盖 7 个的数字，读起来像全量
  const statsPartial = t.statsWithData > 0 && t.statsWithData < data.videos.length;

  const metricItems = hasAnyStat
    // 只画真有互动数据的作品：剩下那些 stats 全是 0（不是"0 次播放"，
    // 是"从没拉到过"），混进图里就是一排零长度条 + 一堆"（无标题）"
    ? data.videos
      .filter(v => v.hasStats)
      .sort((a, b) => (b.stats[metric] || 0) - (a.stats[metric] || 0))
      .slice(0, TOP_N)
      .map(v => ({ key: v.awemeId, label: v.title, value: v.stats[metric] || 0 }))
    : [];
  const metricMax = metricItems.length ? metricItems[0].value : 0;

  const replyParts = [
    { label: '已回复', value: t.replied, tone: 'ok' },
    { label: '待回复', value: t.pending, tone: 'wait' },
  ];

  const decisionParts = DECISION_META.map(m => ({ label: m.label, value: data.decision[m.key] || 0, tone: m.tone }));

  // 播放增长（schema v12 起才有）。升级前的库里是空的，所以每一处都要能显示空态
  const growth = data.growth || { daily: [], perVideo: [], covered: 0, totalDays: 0 };
  // 点赞增量榜。与上面播放增量榜同一套筛选口径：只有一条快照的视频算不出增量，
  // 增量为 0 的也不列（列出来是一根空柱子，只会让人以为图坏了）
  const likeGrowth = growth.perVideo
    .filter(p => p.likesDelta != null && p.likesDelta > 0)
    .sort((a, b) => b.likesDelta - a.likesDelta)
    .slice(0, 8)
    .map(p => ({
      key: p.awemeId,
      label: p.title || `视频 ····${String(p.awemeId).slice(-6)}`,
      value: p.likesDelta,
      sub: `${p.fromDay.slice(5)} → ${p.toDay.slice(5)}`,
    }));

  /** 打开某个评论者的详情（`whois` 的视图版）。缺 actions 时优雅降级成不可点 */
  const onOpenUser = (uid) => { if (actions && actions.openUser && uid) actions.openUser(uid); };

  return (
    <div className="main-col">
      <h1 className="page-title">数据分析</h1>
      <p className="page-sub">
        全部来自本地记录的快照 —— 互动数据随「刷新列表」/「补全视频信息」更新，评论随「拉取新评论」更新。这里不会请求抖音。
      </p>

      {/* 口径切换。默认「全部」：这个工具的实际工作面是别人的评论区，
          只算自己的作品等于在分析 3% 的业务 */}
      <div className="row analytics-bar">
        <div className="seg">
          <button
            className={`seg-item ${scope === 'all' ? 'seg-item-active' : ''}`}
            onClick={() => setScope('all')}
          >
            全部 {counts.all} 个视频
          </button>
          <button
            className={`seg-item ${scope === 'mine' ? 'seg-item-active' : ''}`}
            onClick={() => setScope('mine')}
          >
            仅我的 {counts.mine} 个
          </button>
        </div>
        <button className="btn" onClick={load} disabled={loading}>
          {loading && <Spinner size={12} />}重新读取
        </button>
        {/* 时间范围。7 天看不出走向，90 天看不出具体哪天 —— 三档各有用途，
            所以放在这一行而不是藏进设置里 */}
        <div className="seg analytics-range">
          {[7, 30, 90].map(d => (
            <button
              key={d}
              className={`seg-item ${range === d ? 'seg-item-active' : ''}`}
              onClick={() => setRange(d)}
            >
              最近 {d} 天
            </button>
          ))}
        </div>
      </div>

      {t.capped && (
        <div className="notice notice-warn">
          <div>本地评论量超出统计上限（{t.scanned} 条），以下数字可能偏小。</div>
        </div>
      )}

      {!hasVideos && !hasComments ? (
        <EmptyState
          title="还没有数据可分析。"
          hint="到「我的作品」点「刷新列表」拉取作品与互动数据；想覆盖别人的评论区，到「运营对象」页点「补全视频信息」把它们的标题与互动数据取回来。评论节奏与回复进度图要有评论才会出现。"
        />
      ) : (
        <>
          {/* ── 顶部统计卡 ── */}
          <div className="stat-cards">
            <div className="stat-card">
              <div className="stat-label">视频</div>
              <div className="stat-value num">{t.videos}</div>
              <div className="stat-sub muted">{scope === 'mine' ? '我发的作品' : '含别人的（运营对象）'}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">总播放</div>
              <div className="stat-value num">{hasAnyStat ? short(t.plays) : '—'}</div>
              {/* 覆盖率必须跟着数字走：没有互动数据的那些不是 0 次播放，
                  是"从没拉到过"，混在一起报总数就是一句听起来精确的假话 */}
              <div className="stat-sub muted">
                {statsPartial ? `仅 ${t.statsWithData}/${t.videos} 个视频有数据` : '来自上次刷新'}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">总获赞</div>
              <div className="stat-value num">{hasAnyStat ? short(t.likes) : '—'}</div>
              <div className="stat-sub muted">
                {statsPartial ? `仅 ${t.statsWithData}/${t.videos} 个视频有数据` : '来自上次刷新'}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">本地评论</div>
              <div className="stat-value num">{t.localComments}</div>
              <div className="stat-sub muted">已回复 {t.replied} · 待回复 {t.pending}</div>
            </div>
          </div>

          {/* ── 作品对比 ── */}
          <section className="section">
            <div className="section-head">
              <h2 className="section-title">作品对比</h2>
              <div className="seg">
                {METRICS.map(m => (
                  <button
                    key={m.key}
                    className={`seg-item ${metric === m.key ? 'seg-item-active' : ''}`}
                    onClick={() => setMetric(m.key)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            {!hasAnyStat ? (
              <EmptyState
                compact
                title="互动数据尚未拉取。"
                hint="到「我的作品」点「刷新列表」；别人的视频到「运营对象」点「补全视频信息」—— 两者都会把这批视频的播放/点赞取回来。"
              />
            ) : (
              <>
                <BarList items={metricItems} max={metricMax} />
                <p className="muted chart-note">
                  Top {metricItems.length} · 按{METRICS.find(m => m.key === metric).label}排序
                  {/* 只画有数据的那些，就得说清分母 —— 否则读者会以为这是全部作品的排名 */}
                  {statsPartial && `（仅统计有互动数据的 ${t.statsWithData} 个视频，其余 ${t.videos - t.statsWithData} 个还没拉过）`}
                </p>
              </>
            )}
          </section>

          {/* ── 播放增长（需要 schema v12 的历史快照） ── */}
          <section className="section">
            <div className="section-head">
              <h2 className="section-title">播放增长</h2>
              <span className="section-meta">
                {growth.covered > 0 ? `覆盖 ${growth.covered} 个视频 · ${growth.totalDays} 天快照` : '还没有历史'}
              </span>
            </div>
            {growth.daily.length === 0 ? (
              // 空态必须说清"为什么空"：这是个新功能，历史从升级后**第一次刷新**
              // 才开始积累 —— 只显示"没有数据"，用户会以为坏了
              <EmptyState
                compact
                title="还没有播放历史。"
                hint="历史快照从这次升级之后的第一次「刷新列表」（或「补全视频信息」）开始积累：每天一条，记下当时的播放/点赞。今天刷新一次，明天就能看到增长。"
              />
            ) : growth.daily.length < 2 ? (
              <EmptyState
                compact
                title={`已经记下 ${growth.covered} 个视频的今天读数。`}
                hint="还只有一天的快照，画不出趋势 —— 明天再刷新一次就能看到变化了。"
              />
            ) : (
              <>
                <div className="chart-card">
                  <TrendChart
                    labels={growth.daily.map(d => d.day)}
                    unit=" 播放"
                    series={[
                      // 总播放 = 当天各视频读数之和。**只有一条线**：这是"我的号整体在涨吗"
                      { key: 'plays', label: '已覆盖视频的总播放', values: growth.daily.map(d => d.plays), tone: 'ok', fill: true },
                    ]}
                  />
                </div>
                {/* 覆盖数变化会让总和跳一下 —— 那是覆盖变了，不是增长，必须说明 */}
                <GrowthCoverageNote daily={growth.daily} />
                <div className="chart-card" style={{ marginTop: 12 }}>
                  <BarList
                    items={growth.perVideo
                      .filter(p => p.playsDelta != null && p.playsDelta > 0)
                      .slice(0, 8)
                      .map(p => ({
                        key: p.awemeId,
                        label: p.title || `视频 ····${String(p.awemeId).slice(-6)}`,
                        value: p.playsDelta,
                        sub: `${p.fromDay.slice(5)} → ${p.toDay.slice(5)}`,
                      }))}
                    unit=" 播放"
                  />
                  <p className="muted chart-note">
                    窗口内每条视频的播放增量（按增量排序）。
                    只有一条快照的视频给不出增量，不列在这里。
                  </p>
                </div>
                {likeGrowth.length > 0 && (
                  <div className="chart-card" style={{ marginTop: 12 }}>
                    <BarList items={likeGrowth} unit=" 赞" />
                    <p className="muted chart-note">
                      同窗口内的点赞增量 —— 播放高但点赞少的内容，问题通常在结尾那几秒。
                    </p>
                  </div>
                )}
              </>
            )}
          </section>

          {/* ── 评论节奏 ── */}
          {hasComments && (
            <section className="section">
              <div className="section-head">
                <h2 className="section-title">评论节奏</h2>
                <span className="section-meta">最近 {range} 天 · 每日新评论</span>
              </div>
              <div className="chart-card">
                <DayBars data={data.daily} />
              </div>
              <p className="muted chart-note">
                评论者的原评论，不含你自己发出的回复；柱子顶端<span className="text-ok">绿色那段是已回复的</span>。
                悬停柱子可看具体日期与数量。
              </p>
            </section>
          )}

          {/* ── 回复产出：进来多少 vs 回出去多少 ── */}
          {data.daily.some(d => d.count > 0 || d.sent > 0) && (
            <section className="section">
              <div className="section-head">
                <h2 className="section-title">回复产出</h2>
                <span className="section-meta">最近 {range} 天</span>
              </div>
              <div className="chart-card">
                <TrendChart
                  labels={data.daily.map(d => d.day)}
                  unit=" 条"
                  series={[
                    { key: 'count', label: '当天进来的评论', values: data.daily.map(d => d.count), tone: 'neutral' },
                    { key: 'sent', label: '我们当天发出的回复', values: data.daily.map(d => d.sent), tone: 'ok', fill: true },
                  ]}
                />
              </div>
              <p className="muted chart-note">
                两条线一高一低就说明回复跟不上进来的量。
                口径说明：<b>按评论进来的那天</b>归集「进来的评论」，<b>按我们发出的那天</b>归集「发出的回复」——
                上一张图的绿段是前者里"已经被回过"的比例，与这里的产出是两件事。
                只统计在别人的视频评论区里的回复（我们自己发的顶级评论不算回复）。
              </p>
            </section>
          )}

          {/* ── 回复进度 + 判定分布 ── */}
          {(t.replied + t.pending) > 0 && (
            <section className="section">
              <div className="section-head">
                <h2 className="section-title">回复进度</h2>
              </div>
              <div className="chart-grid">
                <div className="chart-card">
                  <Donut
                    parts={replyParts}
                    center={{ big: `${t.replied + t.pending ? Math.round((t.replied / (t.replied + t.pending)) * 100) : 0}%`, small: '已回复' }}
                  />
                  <p className="muted chart-note" style={{ marginTop: 10 }}>
                    「已回复 / 待回复」按<b>评论</b>算：待回复 = 本地评论 − 已回复 − 我自己发的。
                  </p>
                </div>
                <div className="chart-card">
                  <Donut parts={decisionParts} center={{ big: short(t.localComments), small: '条评论' }} />
                  <p className="muted chart-note" style={{ marginTop: 10 }}>
                    判定分布与工作台「建议回复 / 表情回复 / 跳过」三个标签页同一口径。
                    ⚠️ 它统计<b>每一行</b>，包含已经回过的评论 ——
                    所以「建议回复」在这里的意思是"这类评论值得回"，不是"还剩这么多没回"。
                    还剩多少没回看上面那个环。
                  </p>
                </div>
              </div>
            </section>
          )}

          {/* ── 运营成本与产出 ── */}
          {(data.llm.calls > 0 || data.ops.total > 0) && (
            <section className="section">
              <div className="section-head">
                <h2 className="section-title">运营成本</h2>
                {/* 明说这几张卡不吃上面那个口径切换 —— 它们是"我干了什么"，
                    与"统计哪些视频"无关 */}
                <span className="section-meta">全部来源 · 不受上方口径影响</span>
              </div>
              <div className="stat-cards">
                <div className="stat-card">
                  <div className="stat-label">AI 调用</div>
                  <div className="stat-value num">{data.llm.calls}</div>
                  <div className="stat-sub muted">最近 {range} 天 · {data.llm.tokens} tokens</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">估算成本</div>
                  <div className="stat-value num">
                    {/* 单价表是按模型名匹配的估算值，缺匹配时给 null —— 显示「—」而不是 $0.00 */}
                    {data.llm.cost > 0 ? `$${data.llm.cost.toFixed(4)}` : '—'}
                  </div>
                  <div className="stat-sub muted">按模型单价估算，仅供量级参考</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">单次生成平均耗时</div>
                  <div className="stat-value num">{data.llm.avgMs != null ? `${(data.llm.avgMs / 1000).toFixed(1)}s` : '—'}</div>
                  <div className="stat-sub muted">批量生成 N 条 ≈ N × 这个数</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">命令成功率</div>
                  <div className="stat-value num">
                    {data.ops.total > 0 ? `${Math.round(((data.ops.total - data.ops.errors) / data.ops.total) * 100)}%` : '—'}
                  </div>
                  <div className="stat-sub muted">最近 {range} 天 · 共 {data.ops.total} 次，失败 {data.ops.errors}</div>
                </div>
              </div>

              {data.llm.byPurpose.length > 0 && (
                <div className="chart-card" style={{ marginTop: 12 }}>
                  <BarList
                    items={data.llm.byPurpose.map(p => ({
                      key: p.purpose,
                      label: purposeLabel(p.purpose),
                      // 条形按"单次耗时"排 —— 用户真正关心的是"哪一种最慢"，
                      // 而成本条目的绝对金额太小（几厘钱），画出来全是一样长的短线。
                      // 单位换算成**秒**：AI 调用是十几秒的量级，"12000 ms"要心算一下
                      value: (p.avgMs || 0) / 1000,
                      sub: `${p.calls} 次`,
                    }))}
                    format={v => v.toFixed(1)}
                    unit=" 秒/次"
                  />
                  <p className="muted chart-note">
                    按<b>每次调用的平均耗时</b>排（不是总耗时）—— 这决定了你点一次「批量生成」要等多久。
                    {data.llm.cost > 0 && ` 最近 ${range} 天估算花了 $${data.llm.cost.toFixed(4)}。`}
                  </p>
                </div>
              )}

              {data.ops.byCommand.length > 0 && (
                <div className="chart-card" style={{ marginTop: 12 }}>
                  <BarList
                    items={data.ops.byCommand.slice(0, 8).map(c => ({
                      key: c.command,
                      label: commandLabel(c.command),
                      // 与上面那张卡统一用秒，免得同一个页面上两种时间单位
                      value: (c.avgMs || 0) / 1000,
                      sub: `${c.total} 次${c.errors > 0 ? ` · 失败 ${c.errors}` : ''}`,
                    }))}
                    format={v => v.toFixed(1)}
                    unit=" 秒/次"
                  />
                  <p className="muted chart-note">按<b>平均耗时</b>排。失败次数标在每条的后面 —— 成功率高的命令也可能偶发卡住。</p>
                </div>
              )}
            </section>
          )}

          {/* ── 失败模式 ── */}
          {data.failures.length > 0 && (
            <section className="section">
              <div className="section-head">
                <h2 className="section-title">失败模式</h2>
                {/* hit_count 是累计值，配一个"最近 N 天"的筛选会得到两个口径混在一起的数字 */}
                <span className="section-meta">累计 · 不随时间范围变</span>
              </div>
              <div className="list">
                {data.failures.map(f => (
                  <div className="row-item" key={f.signature}>
                    <div className="row-main">
                      {/* signature 是 core 归一化出来的**机器键**（status_code=8 /
                          bridge_offline / msg:…），以前直接当标题上屏，
                          这张表等于一本没人读得懂的账。 */}
                      <div className="row-title">{describeError(f.signature).text}</div>
                      <div className="row-sub">
                        <span className="num">{f.signature}</span>
                        {f.exampleText && <> · 例如：{f.exampleText}</>}
                      </div>
                    </div>
                    <div className="row-meta num">
                      {f.hitCount} 次
                      {f.lastHit ? ` · ${ago(f.lastHit)}` : ''}
                    </div>
                  </div>
                ))}
              </div>
              <p className="muted chart-note">
                按出现次数排。这张表也是 AI 生成回复时的「避雷清单」来源 —— 同一个错误反复出现，说明它不是偶发。
              </p>
            </section>
          )}

          {/* ── 回复效果 ── */}
          {data.replyEffect.replied > 0 && (
            <section className="section">
              <div className="section-head">
                <h2 className="section-title">回复效果</h2>
                <span className="section-meta">最近 {range} 天 · 共回了 {data.replyEffect.replied} 条</span>
              </div>
              <div className="stat-cards">
                <div className="stat-card">
                  <div className="stat-label">对方又来了</div>
                  <div className="stat-value num">
                    {data.replyEffect.secondRate != null
                      ? `${Math.round(data.replyEffect.secondRate * 100)}%`
                      : '—'}
                  </div>
                  <div className="stat-sub muted">
                    {data.replyEffect.withTime > 0
                      ? `${data.replyEffect.second} / ${data.replyEffect.withTime} 条能判定先后`
                      : '这些回复没有时间戳，判断不了先后'}
                    {/* 4 条里中 1 条就是 25% —— 这种数字不写清样本量，
                        读者会拿它当结论。宁可显得啰嗦 */}
                    {data.replyEffect.withTime > 0 && data.replyEffect.withTime < 10
                      && ' · 样本太少，先别当结论看'}
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">回复获赞</div>
                  <div className="stat-value num">
                    {data.replyEffect.withLikes > 0 ? data.replyEffect.likes : '—'}
                  </div>
                  <div className="stat-sub muted">
                    {data.replyEffect.withLikes > 0
                      ? `来自 ${data.replyEffect.withLikes} 条`
                      : '还没采集过 —— 我们发出的评论不带赞数，要重新拉取那个视频的评论才有'}
                  </div>
                </div>
              </div>
              <p className="muted chart-note">
                「对方又来了」= 你回过的那个人，后来在同一个视频里又留了言 ——
                可能是回复了你，也可能只是又评论了一条；本地数据分不出这两者，所以不写成"对方回复了你"。
                只统计<b>我们的回复有时间戳</b>的那些（早期发出的回复没记时间，算进来会让比例凭空偏低）。
              </p>
            </section>
          )}

          {/* ── 高赞评论 ── */}
          {data.topComments.length > 0 && (
            <section className="section">
              <div className="section-head">
                <h2 className="section-title">高赞评论</h2>
                <span className="section-meta">Top {data.topComments.length}</span>
              </div>
              <div className="list">
                {data.topComments.map(c => (
                  <div className="row-item" key={c.cid}>
                    <div className="row-main">
                      <div className="row-title">
                        <button className="linklike" onClick={() => onOpenUser(c.uid)} title="查看这个人">
                          {c.nickname || '匿名'}
                        </button>
                        {c.replied && <span className="tag tag-ok" style={{ marginLeft: 8 }}>已回复</span>}
                      </div>
                      <div className="topcmt-text">{c.text}</div>
                      {/* 别人的视频在库里没标题（拉评论的接口不返回视频信息），
                          直接写《》会像坏掉了 —— 缺标题时改用视频号锚定身份，
                          与「运营对象」列表同一种写法 */}
                      <div className="row-sub">
                        {c.videoTitle
                          ? `《${c.videoTitle}》`
                          : <>视频 <span className="num">····{String(c.awemeId).slice(-6)}</span></>}
                        {' · '}{ago(c.createdAt)}
                      </div>
                    </div>
                    <div className="row-meta num">♥ {c.digg}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── 活跃用户 ── */}
          {data.topUsers.length > 0 && (
            <section className="section">
              <div className="section-head">
                <h2 className="section-title">最活跃的评论者</h2>
                <span className="section-meta">按本地评论条数</span>
              </div>
              <div className="chart-card">
                <BarList
                  items={data.topUsers.map(u => ({ key: u.uid, label: u.nickname || `UID ${u.uid}`, value: u.count, uid: u.uid }))}
                  unit=" 条"
                  // 点进去看这个人的全部留痕（他说过什么、我们回过几条）
                  onPick={it => onOpenUser(it.uid)}
                />
                <p className="muted chart-note">
                  点任意一行可以看他的全部评论与我们的互动记录。
                  他们又来评论时，在对应作品的工作台里会按「历史评论数」标出 —— 老观众值得优先回复。
                </p>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/**
 * 覆盖数变化提示。
 *
 * 总播放 = 当天各视频读数的和，而"有几个视频有快照"是会变的 ——
 * 今天新补全了一个视频，总和就会跳一下。那是**覆盖变了，不是增长**。
 * 不说明的话，读者会把它当成"今天涨了一大截"。
 *
 * 只在覆盖数真的变过时才出现：一直是 3 个视频就不用说，说了是噪音。
 */
function GrowthCoverageNote({ daily }) {
  const counts = [...new Set(daily.map(d => d.videos))];
  if (counts.length <= 1) return null;
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  return (
    <p className="muted chart-note">
      ⚠ 这几天里有快照的视频数在 {min}–{max} 之间变化（新补全一个视频就会多一个），
      曲线的跳变里有一部分来自覆盖变化，不全是自然增长。
    </p>
  );
}
