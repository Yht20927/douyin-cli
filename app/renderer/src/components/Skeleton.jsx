import React from 'react';

/**
 * 骨架屏。
 *
 * 改造前完全没有（styles.css 里 grep `skeleton` = 0 命中），列表加载时用
 * 一句「正在读取…」顶着 —— 那是**布局跳动**的来源：文字塌成一行，
 * 数据回来之后整页重排，用户刚看的位置就变了。
 *
 * 骨架屏的价值不在"好看"，在于**占住和真实内容一样的形状**，数据回来时
 * 只换内容不换布局。所以行高要与真实列表行一致，而不是随便糊几个灰条。
 *
 * @param {object} props
 * @param {number} [props.rows=4]   - 行数
 * @param {boolean} [props.thumb]   - 左侧要不要占位块（作品列表那种带封面的）
 * @param {boolean} [props.title]   - 每组要不要一条更宽的"标题"行
 */
export default function Skeleton({ rows = 4, thumb = false, title = false }) {
  const list = Array.from({ length: rows }, (_, i) => i);
  return (
    <div className="skeleton-list" aria-hidden="true">
      {list.map((i) => (
        <div className="skeleton-row" key={i}>
          {thumb && <span className="skeleton-block skeleton-thumb" />}
          <div className="skeleton-main">
            {title && <span className="skeleton-block skeleton-title" />}
            <span
              className="skeleton-block skeleton-line"
              // 每行宽度略微不同，看起来像真实文本而不是整齐的色块
              style={{ width: `${[92, 74, 83, 61, 88][i % 5]}%` }}
            />
            <span className="skeleton-block skeleton-line skeleton-line-short" />
          </div>
        </div>
      ))}
    </div>
  );
}
