import React, { useEffect, useRef, useState } from 'react';
import PublishDialog from '../components/PublishDialog.jsx';

/** 判定结果 → 界面标签与颜色。三种结果对应三种处置，用词保持一致。 */
const DECISION = {
  reply: { label: '建议回复', tone: 'ok' },
  emoji_reply: { label: '表情回复', tone: 'warn' },
  skip: { label: '跳过', tone: 'dim' },
};

/** 筛选标签。前三个走 SQL（按已回复状态），后三个按判定结果在内存里筛。 */
const TABS = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待处理' },
  { key: 'reply', label: '建议回复' },
  { key: 'emoji_reply', label: '表情回复' },
  { key: 'skip', label: '跳过' },
  { key: 'replied', label: '已回复' },
];

function ago(ts) {
  if (!ts) return '';
  const ms = Date.now() - ts;
  if (ms < 60000) return '刚刚';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export default function WorkspaceView({ awemeId, queueState, actions, onBack }) {
  const [video, setVideo] = useState(null);
  const [stats, setStats] = useState(null);
  const [comments, setComments] = useState([]);
  const [tab, setTab] = useState('pending');
  const [search, setSearch] = useState('');
  const [selectedCid, setSelectedCid] = useState(null);
  const [draftText, setDraftText] = useState('');
  const [genTaskId, setGenTaskId] = useState(null);
  const [publishing, setPublishing] = useState(null);
  const [notice, setNotice] = useState(null);

  // 记录"这一次刷新是因为哪个任务完成的"，避免把无关的队列变化当成自己的
  const pendingRefresh = useRef(null);
  const genHandled = useRef(null);

  async function reload() {
    const [v, s, c] = await Promise.all([
      window.dy.data.video(awemeId),
      window.dy.data.videoStats(awemeId),
      window.dy.data.comments(awemeId, { filter: tab, search: search || undefined, limit: 300 }),
    ]);
    setVideo(v.ok ? v.data : null);
    setStats(s.ok ? s.data : null);
    setComments(c.ok ? c.data : []);
  }

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [awemeId, tab, search]);

  // 队列变化 → 完成自己关心的事情
  useEffect(() => {
    if (!queueState) return;
    const tasks = queueState.tasks || [];

    // 拉完评论后刷新列表
    if (pendingRefresh.current) {
      const t = tasks.find(x => x.id === pendingRefresh.current);
      if (t && ['done', 'failed', 'blocked', 'cancelled'].includes(t.status)) {
        pendingRefresh.current = null;
        if (t.status === 'done') reload();
        else setNotice(t.error || '拉取未完成');
      }
    }

    // 生成回复：拿完整结果（摘要对一段文本没有意义）
    if (genTaskId && genHandled.current !== genTaskId) {
      const t = tasks.find(x => x.id === genTaskId);
      if (t && ['done', 'failed', 'blocked', 'cancelled'].includes(t.status)) {
        genHandled.current = genTaskId;
        setGenTaskId(null);
        if (t.status === 'done') {
          window.dy.queue.result(genTaskId).then((r) => {
            const text = extractReplyText(r && r.result);
            if (text) setDraftText(text);
            else setNotice('生成成功但没解析出文本，请查看队列里的结果');
          });
        } else {
          setNotice(t.error || '生成失败');
        }
      }
    }
    /* eslint-disable-next-line */
  }, [queueState]);

  const selected = comments.find(c => c.cid === selectedCid) || null;

  function select(c) {
    setSelectedCid(c.cid);
    setNotice(null);
    if (!c.replied && c.decision && c.decision.action !== 'skip') setDraftText('');
    else setDraftText('');
  }

  async function fetchComments() {
    const id = await actions.enqueue({
      command: 'get',
      argv: [awemeId, '--new', '--depth', '1', '--count', '20'],
      label: '拉取新评论',
    });
    if (!id) return;
    pendingRefresh.current = id;
    setNotice('已加入队列 —— 拉取完成后列表会自动刷新');
  }

  async function generate() {
    if (!selected) return;
    const id = await actions.enqueue({
      command: 'getReply',
      argv: [awemeId, selected.cid],
      label: `生成回复（${(selected.user && selected.user.nickname) || '该评论'}）`,
    });
    if (!id) return;
    genHandled.current = null;
    setGenTaskId(id);
    setNotice('已加入队列 —— AI 生成较慢，完成后会自动填进编辑框');
  }

  async function saveDraft() {
    const r = await window.dy.draft.save({
      awemeId,
      text: draftText,
      replyToCid: selected ? selected.cid : null,
    });
    setNotice(r.ok ? `已存入草稿箱（#${r.data.id}）` : `保存失败：${r.error}`);
  }

  const genRunning = !!genTaskId;

  return (
    <div className="workspace">
      <div className="ws-head">
        <button className="btn btn-quiet" onClick={onBack}>‹ 返回</button>
        <div className="ws-title">
          <div className="ws-title-main">{video ? (video.title || '（无标题）') : '…'}</div>
          {stats && (
            <div className="ws-title-sub">
              本地 {stats.total} 条 ·
              已回 <span className="num">{stats.replied}</span> ·
              待回 <b className="text-strong num">{stats.pending}</b>
              　建议回复 <span className="num">{stats.byDecision.reply}</span> ·
              表情 <span className="num">{stats.byDecision.emoji_reply}</span> ·
              跳过 <span className="num">{stats.byDecision.skip}</span>
            </div>
          )}
        </div>
        <div className="ws-actions">
          <button className="btn" onClick={reload}>刷新</button>
          <button className="btn btn-primary" onClick={fetchComments} disabled={!actions.canQueue}>
            拉取新评论
          </button>
        </div>
      </div>

      {notice && (
        <div className="notice" style={{ margin: '0 0 12px' }}>
          <div>{notice}</div>
        </div>
      )}

      <div className="ws-tabs">
        {TABS.map(t => (
          <button
            key={t.key}
            className={`tab ${tab === t.key ? 'tab-active' : ''}`}
            onClick={() => { setTab(t.key); setSelectedCid(null); }}
          >
            {t.label}
          </button>
        ))}
        <input
          className="input tab-search"
          placeholder="搜索评论或昵称"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="ws-body">
        <div className="ws-list">
          {comments.length === 0
            ? (
              <div className="empty">
                这个筛选下没有评论。
                {tab === 'pending' && '若一条都没拉到过，点右上角「拉取新评论」。'}
              </div>
            )
            : comments.map(c => (
              <button
                key={c.cid}
                className={`cmt ${selectedCid === c.cid ? 'cmt-active' : ''}`}
                onClick={() => select(c)}
              >
                <div className="cmt-top">
                  <span className="cmt-user">{(c.user && c.user.nickname) || '匿名'}</span>
                  <span className="cmt-time">{ago(c.createdAt)}</span>
                </div>
                <div className="cmt-text">{c.text}</div>
                <div className="cmt-tags">
                  {c.replied
                    ? <span className="tag tag-dim">已回复</span>
                    : c.decision && (
                      <span className={`tag tag-${DECISION[c.decision.action].tone}`}>
                        {DECISION[c.decision.action].label}
                      </span>
                    )}
                  {c.decision && !c.replied && (
                    <span className="cmt-reason">{c.decision.reason}</span>
                  )}
                  {c.digg > 0 && <span className="cmt-digg num">♥ {c.digg}</span>}
                </div>
              </button>
            ))}
        </div>

        <div className="ws-detail">
          {!selected
            ? <div className="empty">从左边选一条评论。</div>
            : (
              <>
                <div className="detail-head">
                  <div className="detail-user">
                    {(selected.user && selected.user.nickname) || '匿名'}
                    {selected.user && selected.user.tier && selected.user.tier !== 'normal' && (
                      <span className="tag tag-dim" style={{ marginLeft: 8 }}>{selected.user.tier}</span>
                    )}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {selected.user && selected.user.commentCount > 0
                      && `历史评论 ${selected.user.commentCount} 条 · `}
                    {ago(selected.createdAt)}
                  </div>
                </div>

                <div className="detail-comment">{selected.text}</div>

                {selected.decision && (
                  <div className="detail-decision">
                    判定：<b>{DECISION[selected.decision.action].label}</b>
                    <span className="muted"> · {selected.decision.reason}</span>
                    {selected.decision.emojiCandidates && selected.decision.emojiCandidates.length > 0 && (
                      <span className="muted"> · 候选 {selected.decision.emojiCandidates.join(' ')}</span>
                    )}
                  </div>
                )}

                <textarea
                  className="input reply-box"
                  placeholder="回复内容…（可以 AI 生成、自己写，或从草稿箱取）"
                  value={draftText}
                  onChange={e => setDraftText(e.target.value)}
                  rows={5}
                />
                <div className="reply-meta muted num">
                  {draftText.replace(/\s/g, '').length} 字
                </div>

                <div className="detail-actions">
                  <button className="btn" onClick={generate} disabled={genRunning || selected.replied}>
                    {genRunning ? '生成中…' : 'AI 生成'}
                  </button>
                  <button className="btn" onClick={saveDraft} disabled={!draftText.trim()}>
                    存草稿
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={!draftText.trim()}
                    onClick={() => setPublishing({
                      awemeId,
                      cid: selected.cid,
                      text: draftText,
                      videoTitle: video && video.title,
                      commentText: selected.text,
                      userName: selected.user && selected.user.nickname,
                    })}
                  >
                    发布
                  </button>
                </div>

                {selected.replied && (
                  <div className="notice" style={{ marginTop: 10 }}>
                    这条评论已经回复过了 —— 策略会拦下重复回复。
                  </div>
                )}
              </>
            )}
        </div>
      </div>

      {publishing && (
        <PublishDialog
          target={publishing}
          onCancel={() => setPublishing(null)}
          onConfirm={async () => {
            const t = publishing;
            setPublishing(null);
            const argv = [t.awemeId, t.text, '--reply-to', t.cid];
            const id = await actions.enqueue({ command: 'post', argv, label: '发布回复' });
            if (id) {
              pendingRefresh.current = id;   // 发完顺便刷新，让"已回复"标记跟上
              setNotice('已加入队列 —— 队列页可以看到倒计时与执行结果');
            }
            setDraftText('');
          }}
        />
      )}
    </div>
  );
}

/**
 * 从 getReply 的结果里取出回复文本。
 * 兼容两种形状：回复模式 { reply: { text } } 与其它可能的包装，
 * 取不到就返回空字符串，由调用方提示用户去看队列结果。
 */
function extractReplyText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (result.reply && result.reply.text) return String(result.reply.text);
  if (result.text) return String(result.text);
  if (result.comments && result.comments[0] && result.comments[0].text) {
    return String(result.comments[0].text);
  }
  return '';
}
