import React from 'react';
import Skeleton from './Skeleton.jsx';
import EmptyState from './EmptyState.jsx';

/**
 * 「正在读」的统一写法。
 *
 * 为什么要有它：同一个状态在本仓曾有**五种长相**，而且都在同一批页面里 ——
 *   工作台：骨架屏
 *   草稿箱：骨架屏 + 空态
 *   作品页：一句裸文字「正在读取…」（`.empty` 裸 div，与"没有数据"同款）
 *   数据页：手写的 spinner 空态
 *   诊断页：**没有加载态**，直接渲染出一排「…」
 * 五种里至少两种长得跟"没有数据"一样，而这两件事的处境完全不同：
 * 前者要等，后者要动手（见 EmptyState 的注释）。
 *
 * 两种形态，按"知不知道内容的形状"来选：
 *   - `skeleton`（默认）—— 知道形状就用骨架屏。它的价值不是好看，是
 *     **占住和真实内容一样的形状**，数据回来时只换内容不换布局。
 *     `rows` 尽量贴近真实列表的条数，否则还是会重排。
 *   - `text` —— 不知道形状时（诊断页那种键值表）退化成一行 spinner + 文案。
 *     它仍然不会长得像空态：两者共用 `EmptyState`，由 `variant` 分开。
 *
 * @param {object} props
 * @param {'skeleton'|'text'} [props.variant='skeleton']
 * @param {number} [props.rows=4]   - skeleton 的行数
 * @param {boolean} [props.thumb]   - 行里要不要左侧占位块（带封面的列表）
 * @param {boolean} [props.title]   - 每组要不要一条更宽的"标题"行
 * @param {string} [props.label]    - text 形态的文案
 * @param {boolean} [props.compact]
 */
export default function LoadingState({
  variant = 'skeleton', rows = 4, thumb = false, title = false, label = '正在读取…', compact = false,
}) {
  if (variant === 'text') {
    return <EmptyState variant="loading" title={label} compact={compact} />;
  }
  return <Skeleton rows={rows} thumb={thumb} title={title} />;
}
