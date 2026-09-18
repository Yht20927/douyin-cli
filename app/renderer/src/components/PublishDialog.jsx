import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import Spinner from './Spinner.jsx';
import EmptyState from './EmptyState.jsx';
import { fileNameOf, formatBytes } from '../format.js';

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
  /** 附图的即时预检结果：文件在不在、格式认不认、有没有超限 */
  const [image, setImage] = useState(null);

  const text = target.text || '';
  const len = text.replace(/\s/g, '').length;
  const imagePath = target.imagePath || null;

  /**
   * 预检结果的截止时刻。
   *
   * 必须存成**绝对时刻**而不是时长：check 只请求一次，waitMs 是个快照，
   * 用它渲染倒计时的话那个数字永远不会变（改造前就是这样 —— 定时器每 500ms
   * 触发一次重渲染，却没有任何地方读 now，于是"还需等待 00:47"永远停在 00:47，
   * 按钮一直灰着，用户以为界面卡死了）。
   */
  const [deadline, setDeadline] = useState(0);

  useEffect(() => {
    setCheck(null);
    window.dy.policy.check({
      awemeId: target.awemeId,
      cid: target.cid,
      // uid 要带上：不加它，"同一用户每轮最多回复 N 条"在预检里看不到，
      // 弹窗会说"可以发布"、点下去却被命令层的闸门拦下 —— 而弹窗顶部
      // 明确承诺过"这里说能发、点下去就一定能发"。
      uid: target.uid,
      text,
    }).then((r) => {
      const check = r.ok ? r.check : { ok: false, hardBlockers: [{ reason: r.error }], waitMs: 0 };
      setDeadline(Date.now() + Math.max(0, check.waitMs || 0));
      setCheck(check);
    });
  }, [target.awemeId, target.cid, target.uid, text]);

  // 图片预检放在这里而不是等上传失败：文件被删/改名是最常见的情况，
  // 等到点了发布才失败，用户会以为是风控问题，排查方向整个跑偏。
  useEffect(() => {
    if (!imagePath) { setImage(null); return; }
    let alive = true;
    window.dy.reply.checkImage(imagePath).then((r) => {
      if (alive) setImage(r && r.ok ? r.data : { ok: false, reason: r && r.error });
    });
    return () => { alive = false; };
  }, [imagePath]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  if (!check) {
    return (
      <Modal title="确认发布" onClose={onCancel}>
        {/* 用 EmptyState 的加载态而不是裸文字：预检要发一次 IPC，
            这段时间里弹窗已经在屏幕上了，得说明"还在算"而不是留个空框 */}
        <EmptyState variant="loading" title="正在预检…" hint="检查配额、节奏与内容校验" />
      </Modal>
    );
  }

  const blockers = check.hardBlockers || [];
  const waits = (check.blockers || []).filter(b => b.action === 'wait');
  // 由绝对截止时刻算出剩余，配合每 500ms 的 now 更新 —— 这样它才会走
  const remaining = Math.max(0, deadline - now);
  // 图片不可用时直接拦在这里：与策略拦截同一级别，且原因说得很具体。
  //
  // 它必须并进 blockers 一起显示 —— 只把按钮禁用而不说原因的话，
  // 下面的「预检通过，可以发布」会和灰掉的按钮同时出现，用户只会觉得界面坏了。
  const imageBad = !!imagePath && image && image.ok === false;
  const shownBlockers = imageBad
    ? [...blockers, { reason: `附带图片不可用（${image.reason}）` }]
    : blockers;
  const canPublish = check.ok && !imageBad && (remaining === 0 || skipWait);

  async function confirm() {
    setWorking(true);
    try {
      await onConfirm(skipWait ? { skipWait: true } : {});
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal
      title="确认发布"
      onClose={onCancel}
      busy={working}
      // 底部交给 Modal 统一渲染 —— 这里只把内容拼好传进去
      footer={(
        <>
          {remaining > 0 && shownBlockers.length === 0 && (
            <label className="skip-wait">
              <input type="checkbox" checked={skipWait} onChange={e => setSkipWait(e.target.checked)} />
              <span className="text-bad">跳过本次等待</span>
              <span className="muted">（只影响这一次，不改变节奏设置）</span>
            </label>
          )}
          <div className="modal-actions">
            <button className="btn" onClick={onCancel} disabled={working}>取消</button>
            <button className="btn btn-primary" onClick={confirm} disabled={!canPublish || working}>
              {working && <Spinner size={12} />}
              {working ? '提交中…' : '发布'}
            </button>
          </div>
        </>
      )}
    >
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
        {text
          ? <div className="publish-text">{text}</div>
          : <div className="publish-text muted">（只发图，不带文字）</div>}
        <div className="sub num">{len} 字</div>
      </dd>

      {imagePath && (
        <>
          <dt>附带图片</dt>
          <dd>
            <div className="sub">{fileNameOf(imagePath)}</div>
            <div className="sub muted path-line" title={imagePath}>{imagePath}</div>
            {image && (image.ok
              ? (
                <div className="sub muted num">
                  {image.format} · {formatBytes(image.size)}
                  {image.large && ' · 偏大，上传会慢一些'}
                </div>
              )
              : <div className="sub text-bad">图片不可用：{image.reason}</div>)}
          </dd>
        </>
      )}
      </dl>

      {shownBlockers.length > 0 && (
        <div className="notice notice-bad" style={{ marginTop: 14 }}>
          <div>
            <b>现在发不了：</b>
            <ul>
              {shownBlockers.map((b, i) => <li key={i}>{b.reason}</li>)}
            </ul>
          </div>
        </div>
      )}

      {shownBlockers.length === 0 && remaining > 0 && (
        <div className="notice notice-warn" style={{ marginTop: 14 }}>
          <div>
            {waits.map((w, i) => <div key={i}>{w.reason}</div>)}
            <div className="wait-line">
              还需等待 <b className="num">{mmss(remaining)}</b>
            </div>
          </div>
        </div>
      )}

      {shownBlockers.length === 0 && remaining === 0 && (
        <div className="notice" style={{ marginTop: 14 }}>
          预检通过，可以发布。
        </div>
      )}

      {check.warnings && check.warnings.length > 0 && (
        <div className="notice notice-warn">
          <div>{check.warnings.map((w, i) => <div key={i}>{w}</div>)}</div>
        </div>
      )}
    </Modal>
  );
}
