import React, { useEffect, useState } from 'react';
import PublishDialog from '../components/PublishDialog.jsx';
import Spinner from '../components/Spinner.jsx';
import Skeleton from '../components/Skeleton.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { ago, fileNameOf } from '../format.js';

/**
 * 草稿箱。
 *
 * 存在这里的都是"准备好了但还没发"的内容 —— 包括定时拉取自动生成的 AI 草稿。
 * 每条都要人工点发布，这是 D7 定的半自动化边界：准备工作自动做，发布由人决定。
 */
export default function DraftsView({ drafts, loading, actions, reload }) {
  // 注：「发布成功后把草稿标记为已发布」的跟踪**不在这个组件里** ——
  // 它只在草稿箱页面挂载，用户一点发布就切到队列页的话组件卸载，
  // 标记永远不会执行（草稿留在箱里 → 用户再点一次 → 被重复回复策略拦下）。
  // 现在由 App.jsx 的 actions.publishDraft 在应用级跟踪，这里只负责触发。

  const [editing, setEditing] = useState(null);
  const [editText, setEditText] = useState('');
  const [publishing, setPublishing] = useState(null);
  const [notice, setNotice] = useState(null);
  /** 正在等待二次确认删除的草稿 id */
  const [confirmingDelete, setConfirmingDelete] = useState(null);
  /** 正在保存（编辑后）的草稿 id。防连点，也用来显示进行中态 */
  const [savingId, setSavingId] = useState(null);

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
        <button className="btn" onClick={reload} disabled={loading}>
          {loading && <Spinner size={12} />}刷新
        </button>
        <span className="muted" style={{ alignSelf: 'center', fontSize: 12.5 }}>
          共 {list.length} 条待发布
        </span>
      </div>

      {loading && list.length === 0
        ? <Skeleton rows={3} title />
        : list.length === 0
          ? (
            // 不给行动按钮：草稿的来源在别的页面，这里放一个按钮要么是空动作、
            // 要么把用户送到一个他本来就不想去的地方。写清去哪儿做就够了。
            <EmptyState
              title="草稿箱是空的。"
              hint="在「我的作品」里点进任意作品就是评论工作台，对某条评论点「存草稿」即可；工作台的批量生成结果也会落到这里。"
            />
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

                    {/* 这是一条"回复某条评论"的草稿 —— 不显示被回复的原文，
                        用户面对一句"感谢支持！"根本想不起来它是回给谁的，
                        发布前只能靠猜。查不到原文时如实说明，而不是整行不显示。 */}
                    {d.replyToCid && (
                      <div className="draft-target">
                        回复：{d.replyToText || '（原评论已不在本地库里）'}
                      </div>
                    )}

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
                            <button className="btn btn-primary" disabled={savingId !== null}
                              onClick={async () => {
                                // 草稿没有"改"接口，只能存新的再删旧的。
                                // **顺序不能反**：改造前是先 remove 再 save，save 失败时
                                // 旧草稿已经删掉了，用户改了一半的内容彻底消失，
                                // 界面上只有一句"保存失败"。先存后删时最坏情况是
                                // 多出一条重复草稿（可删），而不是丢内容。
                                // 附图必须跟着一起搬，否则编辑一次就把图弄丢了。
                                //
                                // savingId 不只是好看：这里连跑两次 IPC，
                                // 没有进行中态的话连点两下会真的存出两条草稿。
                                setSavingId(d.id);
                                try {
                                  const r = await window.dy.draft.save({
                                    awemeId: d.awemeId, text: editText, replyToCid: d.replyToCid,
                                    personaId: d.personaId, imagePath: d.imagePath,
                                  });
                                  if (!r.ok) {
                                    setNotice(`保存失败：${r.error} —— 原草稿未改动`);
                                    return;
                                  }
                                  await window.dy.draft.remove(d.id);
                                  setEditing(null);
                                  setNotice('已保存');
                                  reload();
                                } finally {
                                  setSavingId(null);
                                }
                              }}>
                              {savingId === d.id && <Spinner size={12} />}
                              {savingId === d.id ? '保存中…' : '保存'}
                            </button>
                            <button className="btn btn-quiet" onClick={() => setEditing(null)}>取消</button>
                          </div>
                        </>
                      )
                      : (
                        <>
                          {d.text
                            ? <div className="draft-text">{d.text}</div>
                            : <div className="draft-text muted">（纯图片草稿，无文字）</div>}
                          <div className="draft-meta muted num">
                            {d.text.replace(/\s/g, '').length} 字
                            {d.imagePath && ` · 附图 ${fileNameOf(d.imagePath)}`}
                            {' · '}{ago(d.createdAt)}
                          </div>
                          <div className="row" style={{ marginTop: 8 }}>
                            <button className="btn btn-primary"
                              onClick={() => setPublishing({
                                draftId: d.id,
                                awemeId: d.awemeId,
                                cid: d.replyToCid,
                                text: d.text,
                                imagePath: d.imagePath,
                                videoTitle: d.videoTitle,
                                // 这两个是给发布确认框用的：没有它们，
                                // 弹窗里"回复对象"整行不会渲染，用户只能凭草稿正文猜回的是谁。
                                commentText: d.replyToText,
                                // 策略里「同一用户每轮最多回复几条」只看这个 uid
                                uid: d.replyToUid,
                              })}>
                              发布
                            </button>
                            <button className="btn" onClick={() => { setEditing(d.id); setEditText(d.text); }}>
                              编辑
                            </button>
                            {confirmingDelete === d.id
                              ? (
                                <>
                                  <button className="btn btn-quiet text-bad" onClick={() => { setConfirmingDelete(null); remove(d.id); }}>
                                    确认删除
                                  </button>
                                  <button className="btn btn-quiet" onClick={() => setConfirmingDelete(null)}>取消</button>
                                </>
                              )
                              : (
                                // 二次确认：草稿删了就没有了（没有回收站），
                                // 而它和「发布/编辑」是挨着的三连按钮，很容易点错。
                                <button className="btn btn-quiet" onClick={() => setConfirmingDelete(d.id)}>删除</button>
                              )}
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
          onConfirm={async (opts) => {
            const t = publishing;
            setPublishing(null);
            // 走 actions.publishDraft 而不是直接 enqueue：标记"已发布"的跟踪在
            // App 层（这个组件会被卸载），传参也由它统一，免得两处各写一份 argv。
            const id = await actions.publishDraft({
              draftId: t.draftId,
              awemeId: t.awemeId,
              cid: t.cid,
              text: t.text,
              imagePath: t.imagePath,
              uid: t.uid,
              skipWait: !!(opts && opts.skipWait),
            });
            if (id) setNotice('已加入队列 —— 发布成功后这条草稿会自动从列表里移除');
          }}
        />
      )}
    </div>
  );
}
