import React from 'react';

/**
 * 空态 / 加载态占位。
 *
 * 把这两种状态放进同一个组件是有意的：改造前它们**共用同一个 `.empty` 样式**，
 * 于是"正在读取…"和"没有数据"长得一模一样，而这是两种完全不同的处境 ——
 * 前者要等，后者要动手。更糟的是工作台根本没有加载态：`reload()` 不设任何
 * loading state，切标签页或搜索时 `comments` 还是空数组，界面直接显示
 * 「这个筛选下没有评论。」—— **把"还在读"显示成了"没有数据"**。
 *
 * 所以这里用 `variant` 把两者分开：loading 时带 spinner，empty 时可以带一个行动按钮。
 *
 * @param {object} props
 * @param {'empty'|'loading'} [props.variant='empty']
 * @param {string} [props.title]   - 主文案（可含 <strong>）
 * @param {React.ReactNode} [props.hint] - 补充说明
 * @param {React.ReactNode} [props.action] - 行动按钮（只有空态才给）
 * @param {boolean} [props.compact]
 */
export default function EmptyState({
  variant = 'empty', title, hint, action, compact = false,
}) {
  const loading = variant === 'loading';
  return (
    <div className={`empty ${compact ? 'empty-compact' : ''}`} data-variant={variant}>
      {loading && <span className="spinner empty-spinner" aria-hidden="true" />}
      <div className="empty-body">
        {title && <div className="empty-title">{title}</div>}
        {hint && <div className="empty-hint">{hint}</div>}
        {action && <div className="empty-action">{action}</div>}
      </div>
    </div>
  );
}
