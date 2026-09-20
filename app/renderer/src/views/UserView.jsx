import React, { useCallback, useEffect, useState } from 'react';
import EmptyState from '../components/EmptyState.jsx';
import LoadingState from '../components/LoadingState.jsx';
import Notice from '../components/Notice.jsx';
import Spinner from '../components/Spinner.jsx';
import { ago } from '../format.js';

/**
 * 用户详情 —— 某个评论者的全部留痕。
 *
 * 数据来自 `whois` / `profile` 两个命令的视图版（`data.userProfile` /
 * `data.userEvents`）。走 data 通道而不是命令：这两件事都只读本地 SQLite，
 * 让"点开一个用户"去排读间隔是错的。
 *
 * 入口有两个：工作台里点评论作者的名字、数据页「最活跃的评论者」那一行。
 * 这条下钻路径此前是断的 —— 数据页能看到"谁最活跃"，却点不进去。
 */

/** 分级 → 中文。与 `note` 命令的取值一致（vip/normal/blacklist/spam）。 */
const TIERS = [
  { value: '', label: '未分级' },
  { value: 'vip', label: 'VIP' },
  { value: 'normal', label: '普通' },
  { value: 'blacklist', label: '黑名单' },
  { value: 'spam', label: '垃圾' },
];

const SENTIMENT = {
  positive: { label: '正面', tone: 'ok' },
  neutral: { label: '中性', tone: 'dim' },
  negative: { label: '负面', tone: 'bad' },
};

export default function UserView({ uid, actions, onBack }) {
  const [data, setData] = useState(null);
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null);   // { tier, notes, tags }
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [tagInput, setTagInput] = useState('');
  /** 发私信：展开的输入框与内容 */
  const [dmOpen, setDmOpen] = useState(false);
  const [dmText, setDmText] = useState('');

  const load = useCallback(async () => {
    const [p, e] = await Promise.all([
      window.dy.data.userProfile(uid),
      window.dy.data.userEvents(uid, { limit: 30 }),
    ]);
    if (p && p.ok && p.data) {
      setData(p.data);
      setDraft({
        tier: (p.data.profile && p.data.profile.tier) || '',
        notes: (p.data.profile && p.data.profile.notes) || '',
        tags: [...((p.data.profile && p.data.profile.tags) || [])],
      });
      setError(null);
    } else {
      setError((p && p.error) || '未知错误');
    }
    setEvents(e && e.ok ? e.data : []);
  }, [uid]);

  useEffect(() => { load(); }, [load]);

  /** 保存分级 / 标签 / 备注。**只提交改过的字段**，免得把没动过的覆盖掉 */
  async function save() {
    if (!draft) return;
    const orig = (data && data.profile) || {};
    const patch = {};
    const tier = draft.tier || null;
    if ((orig.tier || null) !== tier) patch.tier = tier;
    const notes = draft.notes.trim() || null;
    if ((orig.notes || null) !== notes) patch.notes = notes;
    const added = draft.tags.filter(t => !((orig.tags || []).includes(t)));
    const removed = (orig.tags || []).filter(t => !draft.tags.includes(t));
    if (added.length) patch.addTags = added;
    if (removed.length) patch.removeTags = removed;

    if (Object.keys(patch).length === 0) { setNotice('没有改动'); return; }
    setSaving(true);
    try {
      const r = await window.dy.user.setNote(uid, patch);
      if (r && r.ok) { setNotice('已保存'); await load(); }
      else setNotice(`保存失败：${(r && r.error) || '未知错误'}`);
    } finally {
      setSaving(false);
    }
  }

  /**
   * 发私信。
   *
   * 走队列（写操作，要过策略闸门与写间隔）—— 界面上点一下就发，比命令行
   * 更容易连点，所以那两道闸门在这里比在 CLI 下更要紧。
   *
   * ⚠️ 收到的私信不在这个页面上：油猴脚本把消息存在**浏览器页面的内存**里
   * （`window.__dmQueue`），页面一刷新就没了，本地库也没有对应表。
   * 所以这里只做"发"，不做"收件箱" —— 见页脚的说明。
   */
  async function sendDM() {
    const text = dmText.trim();
    if (!text) return;
    const id = await actions.enqueue({
      command: 'dm',
      argv: ['send', uid, text],
      // 用 data.profile 而不是下面那个 `p` —— 它在组件后半段才定义，
      // 这里引用它虽然当下能跑（调用时早过了初始化），但那是巧合而不是保证
      label: `发私信给 ${(data.profile && data.profile.nickname) || uid}`,
    });
    if (!id) return;
    setDmText('');
    setDmOpen(false);
    setNotice('已加入队列 —— 私信是写操作，要等写间隔');
    const un = window.dy.queue.onChanged((payload) => {
      const t = (payload.tasks || []).find(x => x.id === id);
      if (t && ['done', 'failed', 'blocked', 'cancelled'].includes(t.status)) {
        un();
        if (t.status === 'done') {
          // 「已发出」能说到哪一步：core 判的是 IM 响应里 error_desc 为空，
          // 也就是**抖音服务器收下了这条消息**。不证明对方已读，
          // 抖音那边也没有可查的送达回执 —— 措辞必须停在这一步。
          window.dy.queue.result(id).then((r) => {
            const cid = r && r.result && r.result.conversation_id
              ? String(r.result.conversation_id) : '';
            setNotice(cid
              ? `抖音已接收这条私信（会话 ····${cid.slice(-6)}）—— 对方看没看到，只能在抖音的聊天里确认`
              : '抖音已接收这条私信 —— 会话号没取回来，请到抖音的聊天里确认');
          });
        } else {
          setNotice({ text: `私信未发出：${t.error || '未知原因'}`, warn: true });
        }
      }
    });
  }

  if (error) {
    return (
      <div className="main-col">
        <button className="btn btn-quiet" onClick={onBack}>‹ 返回</button>
        <h1 className="page-title" style={{ marginTop: 10 }}>用户详情</h1>
        <div className="notice notice-bad"><div>读取失败：{error}</div></div>
      </div>
    );
  }

  if (!data || !draft) {
    return (
      <div className="main-col">
        <button className="btn btn-quiet" onClick={onBack}>‹ 返回</button>
        <h1 className="page-title" style={{ marginTop: 10 }}>用户详情</h1>
        <LoadingState variant="text" label="正在读取…" />
      </div>
    );
  }

  const p = data.profile;
  const dirty = p
    && ((p.tier || null) !== (draft.tier || null)
      || (p.notes || null) !== (draft.notes.trim() || null)
      || JSON.stringify(p.tags || []) !== JSON.stringify(draft.tags));

  return (
    <div className="main-col">
      <button className="btn btn-quiet" onClick={onBack}>‹ 返回</button>
      <h1 className="page-title" style={{ marginTop: 10 }}>
        {p && p.nickname ? p.nickname : (data.found ? '（无昵称）' : '本地没有这个用户的记录')}
      </h1>
      <p className="page-sub num">
        UID {data.uid}
        {p && p.firstSeen ? ` · 首次见到 ${ago(p.firstSeen)}` : ''}
        {p && p.lastSeen ? ` · 最后活动 ${ago(p.lastSeen)}` : ''}
      </p>

      {/* 发私信。放在这里而不是单开一个"收件箱"页 ——
          收到的消息只存在浏览器页面的内存里（见 sendDM 的注释），
          一个大部分时候空着、还说不清为什么空的收件箱没有意义。 */}
      <div className="row" style={{ marginBottom: 16 }}>
        <button className="btn" onClick={() => setDmOpen(o => !o)} disabled={!actions.canQueue}
          title={!actions.canQueue ? '浏览器未连接 —— 先到「连接」页接上抖音' : undefined}>
          {dmOpen ? '收起' : '发私信'}
        </button>
        <span className="muted" style={{ alignSelf: 'center', fontSize: 12.5 }}>
          私信是写操作，要等写间隔；<b>收到的私信不在这个界面上</b>
        </span>
      </div>
      {dmOpen && (
        <>
          <textarea
            className="input reply-box"
            rows={3}
            placeholder={`发给 ${(p && p.nickname) || data.uid} 的私信内容…`}
            value={dmText}
            onChange={e => setDmText(e.target.value)}
          />
          <div className="row" style={{ marginTop: 8, marginBottom: 16 }}>
            <button className="btn btn-primary" onClick={sendDM} disabled={!dmText.trim()}>
              发送
            </button>
            <button className="btn btn-quiet" onClick={() => { setDmOpen(false); setDmText(''); }}>
              取消
            </button>
          </div>
        </>
      )}

      <Notice data={notice} />

      {!data.found && (
        <div className="notice notice-warn">
          <div>
            本地没有这个用户的资料 —— 多半是还没拉到过他的评论。
            下面的标签与备注仍然可以填，拉到他之后会自动带上。
          </div>
        </div>
      )}

      {/* ── 我们和他之间的账 ── */}
      <div className="stat-cards">
        <div className="stat-card">
          <div className="stat-label">他的评论</div>
          <div className="stat-value num">{data.totalComments}</div>
          <div className="stat-sub muted">本地共收录</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">我们回过的</div>
          <div className="stat-value num">{data.repliedCount}</div>
          <div className="stat-sub muted">{data.truncated ? `按最近 ${data.shownComments} 条统计` : ''}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">还欠着的</div>
          <div className="stat-value num">{data.pendingCount}</div>
          <div className="stat-sub muted">{data.truncated ? `按最近 ${data.shownComments} 条统计` : '他评过、我们没回的'}</div>
        </div>
      </div>

      {/* ── 标签与备注 ── */}
      <section className="section">
        <div className="section-head">
          <h2 className="section-title">分级与备注</h2>
          <div className="row">
            <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
              {saving && <Spinner size={12} />}{saving ? '保存中…' : '保存'}
            </button>
            <button className="btn btn-quiet" onClick={load} disabled={saving}>放弃改动</button>
          </div>
        </div>
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="muted" style={{ alignSelf: 'center' }}>分级</span>
          <select
            className="input"
            value={draft.tier}
            onChange={e => setDraft(d => ({ ...d, tier: e.target.value }))}
          >
            {TIERS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <span className="muted" style={{ alignSelf: 'center' }}>
            （黑名单会影响评论筛选的判定）
          </span>
        </div>

        <div className="row" style={{ marginBottom: 12 }}>
          {draft.tags.map(t => (
            <span className="tag tag-dim" key={t}>
              {t}
              <button
                className="tag-x"
                title="移除这个标签"
                onClick={() => setDraft(d => ({ ...d, tags: d.tags.filter(x => x !== t) }))}
              >×</button>
            </span>
          ))}
          <input
            className="input"
            style={{ width: 140 }}
            placeholder="加标签，回车"
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => {
              if (e.key !== 'Enter') return;
              const t = tagInput.trim();
              if (t && !draft.tags.includes(t)) setDraft(d => ({ ...d, tags: [...d.tags, t] }));
              setTagInput('');
            }}
          />
        </div>

        <textarea
          className="input reply-box"
          rows={3}
          placeholder="备注（只有你自己看得到）"
          value={draft.notes}
          onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))}
        />
        {dirty && <p className="muted chart-note">有未保存的改动。</p>}
      </section>

      {/* ── 他的评论 ── */}
      <section className="section">
        <div className="section-head">
          <h2 className="section-title">他说过什么</h2>
          <span className="section-meta">
            最近 {data.shownComments} 条{data.truncated ? `（共 ${data.totalComments} 条）` : ''}
          </span>
        </div>
        {data.comments.length === 0 ? (
          <EmptyState compact title="本地没有他的评论。" hint="拉取过包含他的评论区之后就会有。" />
        ) : (
          <div className="list">
            {data.comments.map(c => (
              <div className="row-item" key={c.cid}>
                <div className="row-main">
                  <div className="row-title">
                    {c.text}
                  </div>
                  <div className="row-sub user-sub">
                    {c.videoTitle ? `《${c.videoTitle.slice(0, 24)}》` : `视频 ····${String(c.awemeId).slice(-6)}`}
                    {' · '}{ago(c.createdAt)}
                    {c.digg > 0 && <> · <span className="num">♥ {c.digg}</span></>}
                  </div>
                  {c.replied && (
                    <div className="cmt-reply">
                      {c.myReply || '（回复内容未记录）'}
                    </div>
                  )}
                </div>
                <div className="row-meta">
                  {c.replied
                    ? <span className="tag tag-dim">已回复</span>
                    : <span className="tag tag-warn">待回复</span>}
                  {c.sentiment && SENTIMENT[c.sentiment] && (
                    <span className={`tag tag-${SENTIMENT[c.sentiment].tone}`}>{SENTIMENT[c.sentiment].label}</span>
                  )}
                  {c.priority > 0 && <span className="num">P{c.priority}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── 交互历史 ── */}
      {events && events.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">交互历史</h2>
            <span className="section-meta">最近 {events.length} 次操作</span>
          </div>
          <div className="list">
            {events.map(e => (
              <div className="row-item" key={e.id}>
                <div className="row-main">
                  <div className="row-title num">{e.command}</div>
                  {e.error && <div className="row-sub text-bad">{e.error}</div>}
                </div>
                <div className="row-meta num">{ago(e.ts)}</div>
              </div>
            ))}
          </div>
          <p className="muted chart-note">本工具在这个用户身上做过的操作（发回复、点赞等）。</p>
        </section>
      )}
    </div>
  );
}

/* 关于"收件箱"为什么没做（写给下一个人）：
 *
 * `dm listen` / `dm list` 读的是油猴脚本在**页面内存**里的队列
 * （`window.__dmQueue`），而且两者都用 `splice` 取走 —— 取一次就没了，
 * 页面刷新更是全丢。做成一页"收到的私信"，用户看到的会是一个大部分时候
 * 空着、还说不清为什么空的列表，比没有更糟。
 *
 * 要真正做收件箱，得先有本地记忆：一张 `dm_messages` 表（schema v14），
 * `dm listen` 收到就落库、页面从库里分页读。那是一次数据模型变更，
 * 不在"补全命令入口"的范围里 —— 记在这里，别当成忘了。
 */
