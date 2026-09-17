import React from 'react';
import { describeStatus } from '../status.js';

/**
 * 状态带 —— 界面上的签名元素。
 *
 * 它占据的高度随严重程度变化：正常时是安静的一行，需要用户动手时才展开
 * 说明"该做什么"。信息优先级直接映射到视觉权重，而不是一律塞进同样大的卡片。
 *
 * 彩色只出现在这里（左侧色条 + 状态词），因为在这个工具里
 * "现在能不能发"就是唯一值得用颜色标出的信息。
 */
export default function StatusBand({ status, actions, busy }) {
  const d = describeStatus(status);

  const buttonFor = (key) => {
    if (key === 'refresh') {
      return (
        <button key="refresh" className="btn" disabled={busy} onClick={actions.refresh}>
          重新检测
        </button>
      );
    }
    if (key === 'openDouyin') {
      return (
        <button key="douyin" className="btn btn-quiet" disabled={busy} onClick={actions.openDouyin}>
          打开抖音
        </button>
      );
    }
    return null;
  };

  return (
    <section className="band" data-state={d.state}>
      <div className="band-head">
        <div className="band-main">
          <div className="band-word">
            <span className="band-dot" />
            {d.word}
          </div>
          <p className="band-note">{d.note}</p>
        </div>
        {d.actions.length > 0 && (
          <div className="band-actions">{d.actions.map(buttonFor)}</div>
        )}
      </div>

      {d.hint && (
        <div className="band-hint">
          <div className="band-hint-title">{d.hint.title}</div>
          <ol>
            {d.hint.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
        </div>
      )}
    </section>
  );
}
