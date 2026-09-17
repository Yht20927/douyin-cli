import React, { useEffect, useState } from 'react';
import PublishDialog from '../components/PublishDialog.jsx';

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

/**
 * 草稿箱。
 *
 * 存在这里的都是"准备好了但还没发"的内容 —— 包括定时拉取自动生成的 AI 草稿。
 * 每条都要人工点发布，这是 D7 定的半自动化边界：准备工作自动做，发布由人决定。
 */
export default function DraftsView({ drafts, loading, actions, reload }) {
  const [editing, setEditing] = useState(null);
  const [editText, setEditText] = useState('');
  const [publishing, setPublishing] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const list = drafts || [];

  async function remove(id) {
    const r = await window.dy.draft.remove(id);
    if (r.ok) { setNotice('已删除'); reload(); }
    else setNotice(`删除失败：${r.error}`);
  }

  return (
    <div className="main-col">
      <h1 className="page-title">草稿箱</h1>
      <p className="page-sub">
        待发布的内容。定时拉取自动生成的 AI 草稿也会落在这里 —— 发布始终由你决定。
      </p>

      {notice && <div className="notice"><div>{notice}</div></div>}

      <div className="row" style={{ marginBottom: 18 }}>
        <button className="btn" onClick={reload} disabled={loading}>刷新</button>
        <span className="muted" style={{ alignSelf: 'center', fontSize: 12.5 }}>
          共 {list.length} 条待发布
        </span>
      </div>

      {loading && list.length === 0
        ? <div className="empty">正在读取…</div>
        : list.length === 0
          ? (
            <div className="empty">
              草稿箱是空的。在<strong>评论工作台</strong>里对某条评论点「存草稿」，
              或者等定时拉取自动生成。
            </div>
          )
          : (
            <div className="list">
              {list.map(d => (
                <div className="draft-row" key={d.id}>
                  <div className="draft-main">
                    <div className="draft-head">
                      <span className="draft-video">{d.videoTitle || d.awemeId}</span>
                      {d.replyToCid && <span className="tag tag-dim">回复评论</span>}
                      {d.personaId && <span className="tag tag-dim">{d.personaId}</span>}
                    </div>

                    {editing === d.id
                      ? (
                        <>
                          <textarea
                            className="input reply-box"
                            rows={4}
                            value={editText}
                            onChange={e => setEditText(e.target.value)}
                          />
                          <div className="row" style={{ marginTop: 8 }}>
                            <button className="btn btn-primary" onClick={async () => {
                              // 草稿没有"改"接口，只能删旧存新 —— 对用户而言效果一样
                              await window.dy.draft.remove(d.id);
                              await window.dy.draft.save({
                                awemeId: d.awemeId, text: editText, replyToCid: d.replyToCid,
                                personaId: d.personaId,
                              });
                              setEditing(null);
                              setNotice('已保存');
                              reload();
                            }}>保存</button>
                            <button className="btn btn-quiet" onClick={() => setEditing(null)}>取消</button>
                          </div>
                        </>
                      )
                      : (
                        <>
                          <div className="draft-text">{d.text}</div>
                          <div className="draft-meta muted num">
                            {d.text.replace(/\s/g, '').length} 字 · {ago(d.createdAt)}
                          </div>
                          <div className="row" style={{ marginTop: 8 }}>
                            <button className="btn btn-primary"
                              onClick={() => setPublishing({
                                awemeId: d.awemeId,
                                cid: d.replyToCid,
                                text: d.text,
                                videoTitle: d.videoTitle,
                              })}>
                              发布
                            </button>
                            <button className="btn" onClick={() => { setEditing(d.id); setEditText(d.text); }}>
                              编辑
                            </button>
                            <button className="btn btn-quiet" onClick={() => remove(d.id)}>删除</button>
                          </div>
                        </>
                      )}
                  </div>
                </div>
              ))}
            </div>
          )}

      {publishing && (
        <PublishDialog
          target={publishing}
          onCancel={() => setPublishing(null)}
          onConfirm={async () => {
            const t = publishing;
            setPublishing(null);
            const argv = t.cid ? [t.awemeId, t.text, '--reply-to', t.cid] : [t.awemeId, t.text];
            const id = await actions.enqueue({ command: 'post', argv, label: '发布草稿' });
            if (id) setNotice('已加入队列 —— 去队列页看倒计时与结果');
          }}
        />
      )}
    </div>
  );
}
