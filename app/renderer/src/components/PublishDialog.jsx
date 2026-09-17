import React, { useEffect, useState } from 'react';

function mmss(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * 发布二次确认。
 *
 * 这个弹窗要在一屏之内回答三个问题：发什么、发到哪、现在能不能发。
 * 前两个来自传入的参数，第三个来自策略预检 —— 与队列执行时用的是同一个
 * beforeWrite，所以这里说能发、点下去就一定能发，不会出现"确认了又被拦"。
 *
 * 「跳过等待」只跳过**本次**的节奏等待，且标红警告；它不改变任何策略配置，
 * 也跳不过配额、去重与内容校验那几类硬拦截。
 */
export default function PublishDialog({ target, onCancel, onConfirm }) {
  const [check, setCheck] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [working, setWorking] = useState(false);
  const [skipWait, setSkipWait] = useState(false);

  const text = target.text || '';
  const len = text.replace(/\s/g, '').length;

  useEffect(() => {
    setCheck(null);
    window.dy.policy.check({
      awemeId: target.awemeId,
      cid: target.cid,
      text,
    }).then((r) => setCheck(r.ok ? r.check : { ok: false, hardBlockers: [{ reason: r.error }], waitMs: 0 }));
  }, [target.awemeId, target.cid, text]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  if (!check) {
    return (
      <div className="modal-backdrop">
        <div className="modal"><div className="empty">正在预检…</div></div>
      </div>
    );
  }

  const blockers = check.hardBlockers || [];
  const waits = (check.blockers || []).filter(b => b.action === 'wait');
  const remaining = Math.max(0, check.waitMs || 0);
  const canPublish = check.ok && (remaining === 0 || skipWait);

  async function confirm() {
    setWorking(true);
    try {
      await onConfirm(skipWait ? { skipWait: true } : {});
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal">
        <div className="modal-head">
          <h2 className="modal-title">确认发布</h2>
        </div>

        <div className="modal-body">
          <dl className="kv kv-tight">
            <dt>目标视频</dt>
            <dd>{target.videoTitle || target.awemeId}</dd>

            {target.commentText && (
              <>
                <dt>回复对象</dt>
                <dd>
                  {target.userName && <span className="muted">{target.userName}：</span>}
                  {target.commentText}
                </dd>
              </>
            )}

            <dt>内容</dt>
            <dd>
              <div className="publish-text">{text}</div>
              <div className="sub num">{len} 字</div>
            </dd>
          </dl>

          {blockers.length > 0 && (
            <div className="notice notice-bad" style={{ marginTop: 14 }}>
              <div>
                <b>现在发不了：</b>
                <ul>
                  {blockers.map((b, i) => <li key={i}>{b.reason}</li>)}
                </ul>
              </div>
            </div>
          )}

          {blockers.length === 0 && remaining > 0 && (
            <div className="notice notice-warn" style={{ marginTop: 14 }}>
              <div>
                {waits.map((w, i) => <div key={i}>{w.reason}</div>)}
                <div className="wait-line">
                  还需等待 <b className="num">{mmss(remaining)}</b>
                </div>
              </div>
            </div>
          )}

          {blockers.length === 0 && remaining === 0 && (
            <div className="notice" style={{ marginTop: 14 }}>
              预检通过，可以发布。
            </div>
          )}

          {check.warnings && check.warnings.length > 0 && (
            <div className="notice notice-warn">
              <div>{check.warnings.map((w, i) => <div key={i}>{w}</div>)}</div>
            </div>
          )}
        </div>

        <div className="modal-foot">
          {remaining > 0 && blockers.length === 0 && (
            <label className="skip-wait">
              <input type="checkbox" checked={skipWait} onChange={e => setSkipWait(e.target.checked)} />
              <span className="text-bad">跳过本次等待</span>
              <span className="muted">（只影响这一次，不改变节奏设置）</span>
            </label>
          )}
          <div className="modal-actions">
            <button className="btn" onClick={onCancel} disabled={working}>取消</button>
            <button className="btn btn-primary" onClick={confirm} disabled={!canPublish || working}>
              {working ? '提交中…' : '发布'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
