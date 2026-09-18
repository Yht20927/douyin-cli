import React from 'react';

/**
 * 轻提示（右下角浮层）。
 *
 * 改造前是一颗**单独的** toast：成功与失败长得完全一样（只有一个 `.toast` 样式），
 * 后一条直接覆盖前一条（`flash()` 就是 setState 一个字符串），不能关，
 * 也没有 `aria-live` —— 读屏用户完全收不到这些提示。
 *
 * 现在改成队列：可以同时有多条、按类型着色、可手动关闭。
 * 「按类型着色」在这里**不违反**「颜色只表示状态」那条原则 ——
 * 提示条本身就是状态（成功 / 失败 / 警告），颜色在这里表达的是状态而不是装饰。
 *
 * @param {object} props
 * @param {Array<{id:number, message:string, tone:'info'|'ok'|'bad'|'wait'}>} props.items
 * @param {Function} props.onDismiss - (id) => void
 */
export default function Toasts({ items, onDismiss }) {
  if (!items || items.length === 0) return null;

  return (
    // aria-live=polite：读屏会在当前朗读结束后播报，不打断用户
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div className="toast" key={t.id} data-tone={t.tone || 'info'}>
          <span className="toast-msg">{t.message}</span>
          <button
            className="toast-close"
            onClick={() => onDismiss(t.id)}
            aria-label="关闭提示"
            title="关闭"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
