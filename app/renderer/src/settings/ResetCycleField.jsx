import React, { useEffect, useState } from 'react';

/**
 * 循环进度：显示"现在轮到第几条"，并可重置。
 *
 * 循环进度存在独立的 reply-state.json，不是配置项 —— 所以这里不是表单控件，
 * 而是一个带副作用的操作。放在「循环方式」旁边是有意的：
 * 用户改完循环方式后最自然的疑问就是"那现在从哪儿接着走"。
 */
export default function ResetCycleField({ field }) {
  const [progress, setProgress] = useState(null);
  const [notice, setNotice] = useState(null);

  async function load() {
    const r = await window.dy.reply.cycleProgress();
    setProgress(r && r.ok ? r.data : null);
  }

  useEffect(() => { load(); }, []);

  async function reset() {
    const r = await window.dy.reply.resetCycle('fixed');
    if (r && r.ok) {
      setNotice('已重置，下次生成从第一条开始');
      load();
    } else {
      setNotice((r && r.error) || '重置失败');
    }
  }

  const f = progress && progress.fixed;

  return (
    <div className="settings-field">
      <div className="settings-field-label"><span>{field.label}</span></div>
      <div className="settings-inline">
        <span className="muted num">
          {!f || !f.total
            ? '暂无可循环的条目'
            : `下次取第 ${f.nextIndex} / ${f.total} 条`}
          {f && f.deckRemaining > 0 && ` · 当前这轮还剩 ${f.deckRemaining} 条没用`}
        </span>
        <button className="btn btn-quiet" onClick={reset} disabled={!f || !f.total}>
          重置进度
        </button>
      </div>
      {notice && <div className="settings-hint">{notice}</div>}
      <div className="settings-hint">
        进度保存在 reply-state.json，重启应用后接着上次继续；重置只清进度，不影响上面的内容列表。
      </div>
    </div>
  );
}
