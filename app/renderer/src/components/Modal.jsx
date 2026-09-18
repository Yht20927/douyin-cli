import React, { useEffect, useRef } from 'react';

/**
 * 通用模态框。
 *
 * 改造前全项目只有 `PublishDialog` 一个弹窗，它自己实现了一遍 backdrop + 面板，
 * 而且缺三样东西：
 *   1. **Esc 关不掉** —— 只处理了点击 backdrop。桌面应用里 Esc 是最基本的期待。
 *   2. **没有焦点陷阱** —— Tab 会把焦点跑到后面的页面上，键盘用户点着点着就"失联"了。
 *   3. **没有 `role="dialog"` / `aria-modal`** —— 读屏用户不知道弹窗开了。
 *
 * 这三样都是"没有也照样能用、但用起来别扭"的那类问题，正好是这个项目的通病。
 *
 * @param {object} props
 * @param {string} props.title
 * @param {React.ReactNode} props.children - 正文
 * @param {React.ReactNode} [props.footer] - 底部操作区
 * @param {Function} [props.onClose] - 关闭（Esc / 点 backdrop / 点关闭按钮）
 * @param {boolean} [props.busy] - 处理中：屏蔽关闭，避免请求飞着的时候界面被扯掉
 * @param {string} [props.width] - 面板宽度（缺省 520px）
 */
export default function Modal({ title, children, footer, onClose, busy = false, width }) {
  const panelRef = useRef(null);
  /** 打开前的焦点，关闭时还回去 —— 否则键盘用户关掉弹窗后焦点掉回 body */
  const restoreRef = useRef(null);

  // Esc 关闭 + 焦点陷阱
  useEffect(() => {
    restoreRef.current = document.activeElement;
    // 打开后把焦点移进面板，Tab 才有起点
    const first = panelRef.current && panelRef.current.querySelector(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (first) first.focus();

    function onKeyDown(e) {
      if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose && onClose(); return; }
      if (e.key !== 'Tab' || !panelRef.current) return;
      // 焦点陷阱：把 Tab 限制在面板内循环
      const nodes = panelRef.current.querySelectorAll(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), '
        + 'textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      );
      if (nodes.length === 0) return;
      const firstNode = nodes[0];
      const lastNode = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === firstNode) {
        e.preventDefault(); lastNode.focus();
      } else if (!e.shiftKey && document.activeElement === lastNode) {
        e.preventDefault(); firstNode.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const back = restoreRef.current;
      if (back && back.focus) back.focus();
    };
  }, [onClose, busy]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        // 用 mousedown 而不是 click：从面板内拖选文字、松开时落在 backdrop 上，
        // 用 click 会误判成"点了外面"从而关掉弹窗，正在读的内容就没了
        if (e.target === e.currentTarget && !busy) onClose && onClose();
      }}
    >
      <div
        className="modal"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={width ? { width } : undefined}
      >
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          {onClose && (
            <button
              className="btn btn-quiet modal-close"
              onClick={() => !busy && onClose()}
              disabled={busy}
              aria-label="关闭"
              title="关闭（Esc）"
            >
              ×
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
