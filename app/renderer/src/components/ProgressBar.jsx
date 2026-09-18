import React from 'react';

/**
 * 进度条。
 *
 * 为什么要有它：core 一直在上报进度（`logger.progress({ text, current, total })`
 * → `task-queue.js` 落成 `task.progress` → 随 `queue:changed` 推给界面），
 * 而渲染层**从来没读过 `current` / `total`** —— 批量生成 50 条时，
 * 界面上只有一行 12px 的小字"第 3/50 条：正在生成"，没有条、没有百分比。
 * 数据早就有，缺的只是把它画出来。
 *
 * 三种形态：
 *   - 有 total   → 确定进度（有条、有百分比）
 *   - 无 total   → 不确定进度（条纹滚动，表示"在跑但不知道还要多久"）
 *   - tone=bad   → 失败的任务也用它表达"跑到哪一步断的"
 *
 * @param {object} props
 * @param {number} [props.current] - 已完成的数量
 * @param {number} [props.total]   - 总数量。缺省或非正数时按不确定进度渲染
 * @param {string} [props.label]   - 条上方的说明文字
 * @param {'neutral'|'ok'|'wait'|'bad'} [props.tone]
 * @param {boolean} [props.compact] - 紧凑模式（行内小条，不带百分比行）
 */
export default function ProgressBar({
  current = 0, total = 0, label, tone = 'neutral', compact = false,
}) {
  const known = Number.isFinite(total) && total > 0;
  const done = known ? Math.min(Math.max(0, Number(current) || 0), total) : 0;
  const pct = known ? Math.round((done / total) * 100) : 0;

  return (
    <div className={`progress ${compact ? 'progress-compact' : ''}`} data-tone={tone}>
      {(label || known) && !compact && (
        <div className="progress-head">
          {label && <span className="progress-label">{label}</span>}
          {known && (
            <span className="progress-value num">
              {done}/{total}
              <span className="progress-pct"> · {pct}%</span>
            </span>
          )}
        </div>
      )}
      <div
        className="progress-track"
        role="progressbar"
        // 无障碍属性不是装饰：这条信息是"还要不要等、等多久"，
        // 读屏用户和视觉用户同样需要它
        aria-valuemin={known ? 0 : undefined}
        aria-valuemax={known ? total : undefined}
        aria-valuenow={known ? done : undefined}
        aria-label={label || (known ? `进度 ${pct}%` : '进行中')}
      >
        <div
          className={`progress-fill ${known ? '' : 'progress-fill-indeterminate'}`}
          style={known ? { width: `${pct}%` } : undefined}
        />
      </div>
    </div>
  );
}
