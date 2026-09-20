// app/renderer/src/components/charts.jsx — 数据分析页的图表
//
// 为什么手写 SVG 而不是引图表库：
//   1. 渲染层 CSP 收得很紧，第三方库的体积与注入面都不值得为一个柱状图付出；
//   2. 这个界面要的图表形态固定（横向条形、按天柱状、环形占比），手写各几十行；
//   3. 颜色必须走 --*-soft / 状态 token，库的默认配色一进来就会破坏
//      "颜色只表示状态"的纪律。
//
// 所有图表都是**直接标注数值**而不是靠悬浮提示 —— 运营截图发群里时，
// 图上没有数字就等于没画。

import React from 'react';
import { abbrNum as abbr } from '../format.js';

/**
 * 横向条形排行（作品对比、活跃用户、耗时排行）。
 * items: [{ key, label, sub?, value }] —— 已由调用方排好序、截好条数。
 * max 显式传入时按它缩放（切换作品集时条形长度稳定，不会跳）。
 *
 * @param {(v:number)=>string} [props.format] - 数值怎么显示。
 *   默认走 abbrNum（几千几万缩写成"1.2万"），**但耗时不能用它** ——
 *   12000 毫秒缩写成「1.2万 ms/次」既丑又难读，而且 abbrNum 会把小数抹掉，
 *   于是「12.0 秒」变成「12 秒」。耗时类的调用方传自己的 format。
 */
export function BarList({ items, max, tone = 'neutral', unit = '', format, onPick }) {
  if (!items || items.length === 0) return null;
  const top = max != null ? max : Math.max(...items.map(i => i.value), 1);
  const fmt = format || abbr;

  return (
    <div className="barlist">
      {items.map((it) => {
        const pct = Math.max(2, Math.round((it.value / top) * 100));
        // 给了 onPick 就整行可点（下钻用）—— 用 <button> 而不是给 div 挂 onClick：
        // 前者键盘能 Tab 到、能回车触发，后者只有鼠标能用
        const Row = onPick ? 'button' : 'div';
        const rowProps = onPick
          ? { type: 'button', className: 'barlist-row barlist-row-pick', onClick: () => onPick(it), title: `查看 ${it.label}` }
          : { className: 'barlist-row' };
        return (
          <Row key={it.key} {...rowProps}>
            <div className="barlist-label" title={it.label}>{it.label}</div>
            <div className="barlist-track">
              <div className={`barlist-fill barlist-fill-${tone}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="barlist-value num">
              {fmt(it.value)}{unit}
              {it.sub && <span className="barlist-sub"> · {it.sub}</span>}
            </div>
          </Row>
        );
      })}
    </div>
  );
}

/**
 * 按天柱状图（评论节奏）。
 * data: [{ day: 'YYYY-MM-DD', count, replied }] —— 空天已由 core 补零。
 * 鼠标悬停 title 给出完整日期与数量。
 *
 * 柱子**分两段**：顶端绿色那段是已回复的。core 从第一版起就在算
 * `daily[].replied` 了，而这张图一直只画 count —— 于是"哪天回得慢"这个
 * 运营最该看见的东西在图上是看不出来的。
 * 用 --ok 而不是随便一个颜色：已回复在本应用别处（环形图、状态带）就是 ok。
 */
export function DayBars({ data }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data.map(d => d.count), 1);

  return (
    <div className="daybars">
      {data.map((d, i) => {
        const h = Math.max(d.count > 0 ? 6 : 2, Math.round((d.count / max) * 100));
        // 已回复占这根柱子的比例。count 为 0 时分子分母都是 0，直接给 0。
        const repliedPct = d.count > 0 ? Math.min(100, Math.round((d.replied / d.count) * 100)) : 0;
        const label = d.count > 0
          ? `${d.day}：${d.count} 条（已回 ${d.replied}）`
          : `${d.day}：无评论`;
        return (
          <div className="daybar-slot" key={d.day} title={label}>
            <div className="daybar-value num">{d.count > 0 ? d.count : ''}</div>
            <div className="daybar-track">
              <div
                className={`daybar-fill ${d.count > 0 ? '' : 'daybar-empty'}`}
                style={{ height: `${h}%` }}
              >
                {repliedPct > 0 && (
                  <div className="daybar-replied" style={{ height: `${repliedPct}%` }} />
                )}
              </div>
            </div>
            {/* x 轴标签只标每 5 格 + 最后一格，30 个全标会挤成竖排 */}
            <div className={`daybar-day num ${i % 5 === 0 || i === data.length - 1 ? '' : 'daybar-day-hidden'}`}>
              {d.day.slice(5)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 折线 / 面积图（趋势）。
 *
 * 为什么现在才加它：这张图之前一直没有，而"盯节奏"最需要的恰恰是趋势 ——
 * 柱状图能看出哪天多，看不出**在涨还是在落**。
 *
 * 两个几何上的取舍：
 *
 * 1. **用 `preserveAspectRatio="none"` 拉伸 + `vector-effect="non-scaling-stroke"`。**
 *    这样一条 SVG 就能自适应任意宽度，而不必去测量容器（这个仓没有
 *    ResizeObserver 那一套，也不值得为一个图引入）。线宽靠 non-scaling-stroke
 *    保持恒定，不会被横向拉扁。
 * 2. **y 轴刻度与 x 轴标签走 HTML，不进 SVG。** 拉伸过的 SVG 里文字会跟着变形 ——
 *    这与 DayBars 把日期放在柱子下面同一种做法。
 *
 * 颜色纪律：**两条线用线型区分，不用色相区分**。但"已回复 / 待回复"这一对
 * 在别处（环形图、状态带）已经固定是 ok / wait 了 —— 同一个语义在两处用两种
 * 颜色，比"多用了两抹颜色"更糟。所以这里沿用同一套：它们本身就是状态。
 *
 * @param {object} props
 * @param {string[]} props.labels - x 轴标签（已按天/格切好，长度与 values 一致）
 * @param {Array<{key:string,label:string,values:number[],tone?:'neutral'|'ok'|'wait'|'bad',fill?:boolean}>} props.series
 * @param {number} [props.height=150]
 * @param {string} [props.unit=''] - 悬停提示里的单位
 * @param {string} [props.labelEvery='auto'] - x 轴标签每隔几格标一个
 */
export function TrendChart({ labels, series, height = 150, unit = '', labelEvery }) {
  const n = (labels || []).length;
  if (!n || !series || !series.length) return null;

  // viewBox 用归一化空间：宽度取 600 只是为了数值别太小，实际由 CSS 拉伸
  const W = 600;
  const H = 100;
  const all = series.flatMap(s => s.values || []);
  // 全 0 时给 1，避免除零 —— 图会是一条贴底的直线，那是"没有数据"该有的样子
  const max = Math.max(1, ...all);
  const xAt = i => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const yAt = v => H - (Math.max(0, v) / max) * H;

  // x 轴标签：30 格全标会挤成竖排，90 格更不可能。默认按宽度匀出 6 个左右
  const every = labelEvery || Math.max(1, Math.ceil(n / 6));

  const ticks = [max, max / 2, 0];
  const fmt = v => (v >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(Math.round(v)));
  const lastOf = s => (s.values && s.values.length ? s.values[s.values.length - 1] : 0);
  const maxOf = s => Math.max(0, ...(s.values || []));

  return (
    <div className="trend">
      <div className="trend-legend">
        {series.map(s => (
          <span className="trend-legend-item" key={s.key}>
            <span className={`trend-swatch trend-swatch-${s.tone || 'neutral'}`} />
            {s.label}
          </span>
        ))}
      </div>

      <div className="trend-body">
        {/* y 轴刻度：没有它，读者只能靠柱高互相猜 —— 这是原柱状图的缺口之一 */}
        <div className="trend-y" style={{ height }}>
          {ticks.map(t => <span className="trend-y-tick num" key={t}>{fmt(t)}</span>)}
        </div>

        {/* 高度只给 SVG，不给这一层：`.trend-x` 是它的兄弟，得占自己的高度。
            之前把 height 加在外层、SVG 又 height:100%，x 轴标签就被挤到
            图表外面压住了下面的说明文字。 */}
        <div className="trend-plot">
          <svg
            className="trend-svg"
            style={{ height }}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {/* 网格线：只在刻度处，横线走满宽 */}
            {ticks.map((t, i) => (
              <line
                key={t}
                className="trend-grid"
                x1="0" x2={W}
                y1={yAt(t)} y2={yAt(t)}
                vectorEffect="non-scaling-stroke"
                // 第一根（0 线）画实一点：它同时是 x 轴
                data-axis={i === ticks.length - 1 ? 'x' : undefined}
              />
            ))}

            {series.map(s => {
              const pts = s.values.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' ');
              return (
                <g key={s.key}>
                  {s.fill && (
                    <polygon
                      className={`trend-area trend-area-${s.tone || 'neutral'}`}
                      points={`0,${H} ${pts} ${W},${H}`}
                    />
                  )}
                  <polyline
                    className={`trend-line trend-line-${s.tone || 'neutral'}`}
                    points={pts}
                    vectorEffect="non-scaling-stroke"
                    data-dash={s.tone === 'neutral' ? 'dashed' : undefined}
                  />
                </g>
              );
            })}

            {/* 悬停热区：每个 x 一格。90 个透明矩形换 90 个原生 tooltip，
                比给每个点画一个可见圆点便宜得多，也和 DayBars 的做法一致 */}
            {labels.map((lab, i) => (
              <rect
                key={lab}
                x={xAt(i) - W / n / 2}
                y="0"
                width={W / n}
                height={H}
                fill="transparent"
              >
                <title>
                  {`${lab}　${series.map(s => `${s.label} ${s.values[i]}${unit}`).join('　')}`}
                </title>
              </rect>
            ))}
          </svg>

          <div className="trend-x">
            {labels.map((lab, i) => (
              <span
                className={`trend-x-label num ${i % every === 0 || i === n - 1 ? '' : 'trend-x-hidden'}`}
                key={lab}
              >
                {lab.slice(5)}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* 直接标数：截图发群里时，图上没有数字就等于没画（与 BarList 同一条理由）。
          折线上标不了每一个点，就标"最高"和"当前"这两个最该被看见的。 */}
      <p className="trend-note muted num">
        {series.map(s => (
          <span key={s.key}>
            {s.label}：最新 <b>{lastOf(s)}{unit}</b> · 峰值 {maxOf(s)}{unit}
          </span>
        ))}
      </p>
    </div>
  );
}

/**
 * 环形占比（回复进度、判定分布）。
 * parts: [{ label, value, tone: 'ok'|'wait'|'bad'|'neutral' }]
 * center: { big, small } 圆心文字。
 */
export function Donut({ parts, center }) {
  const total = (parts || []).reduce((s, p) => s + p.value, 0);
  if (!parts || parts.length === 0 || total === 0) return null;

  // SVG 环形：用 stroke-dasharray 逐段画。半径与周长固定，
  // 每段按占比排布，段间留 2% 的缝隙让分段可读。
  const R = 52;
  const C = 2 * Math.PI * R;
  let offset = 0;

  return (
    <div className="donut">
      <svg viewBox="0 0 130 130" className="donut-svg" aria-hidden="true">
        {/* 底槽走 .donut-track（= --sunken），与条形图的底槽是同一个值 ——
            写死在 JSX 里就又多了一处"只有这里才有的颜色" */}
        <circle cx="65" cy="65" r={R} fill="none" className="donut-track" strokeWidth="15" />
        {parts.filter(p => p.value > 0).map((p) => {
          const frac = p.value / total;
          const seg = (
            <circle
              key={p.label}
              cx="65" cy="65" r={R} fill="none"
              className={`donut-seg donut-seg-${p.tone || 'neutral'}`}
              strokeWidth="15"
              strokeLinecap="butt"
              strokeDasharray={`${Math.max(0, frac * C - C * 0.012)} ${C}`}
              strokeDashoffset={-offset * C}
              transform="rotate(-90 65 65)"
            />
          );
          offset += frac;
          return seg;
        })}
        {center && (
          <>
            <text x="65" y="62" textAnchor="middle" className="donut-center-big num">{center.big}</text>
            <text x="65" y="80" textAnchor="middle" className="donut-center-small">{center.small}</text>
          </>
        )}
      </svg>
      <div className="donut-legend">
        {parts.map((p) => (
          <div className="donut-legend-row" key={p.label}>
            <span className={`donut-dot donut-seg-${p.tone || 'neutral'}-bg`} />
            <span className="donut-legend-label">{p.label}</span>
            <span className="donut-legend-value num">
              {abbr(p.value)}
              <span className="donut-legend-pct">{total ? ` ${Math.round((p.value / total) * 100)}%` : ''}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
