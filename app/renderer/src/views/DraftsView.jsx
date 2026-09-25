import React, { useEffect, useMemo, useState } from 'react';
import PublishDialog from '../components/PublishDialog.jsx';
import ProgressBar from '../components/ProgressBar.jsx';
import Spinner from '../components/Spinner.jsx';
import LoadingState from '../components/LoadingState.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Modal from '../components/Modal.jsx';
import { ago, fileNameOf } from '../format.js';
import { failText } from '../errors.js';
import useAutoRefresh from '../useAutoRefresh.js';

/** 输入停止多久后才去查库。太短会每敲一个字查一次，太长会觉得卡 */
const SEARCH_DEBOUNCE_MS = 260;

/** 确认框里最多预览几条草稿，其余用一行"还有 M 条"说明 */
const PUBLISH_PREVIEW_ROWS = 8;

/**
 * 批量发布大概要等多久。
 *
 * 每条草稿是一次独立的写任务，串行队列 + 每两条之间都要等设置的写间隔，
 * 所以 N 条要等 N-1 个间隔（第一条还要看离上次发布过了多久 —— 那个不由这里决定）。
 * 报的是一个区间而不是精确值：间隔本身就是随机的，给一个准数反而是假承诺。
 *
 * @param {number} n - 要发的条数
 * @param {[number, number]|null} interval - 写间隔秒数区间，读不到时返回 null
 */
function estimatePublishSpan(n, interval) {
  if (!(n > 1) || !Array.isArray(interval)) return null;
  const [lo, hi] = interval.map(Number);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const fmt = (sec) => (sec >= 90 ? `${Math.round(sec / 60)} 分钟` : `${Math.max(1, Math.round(sec))} 秒`);
  return `${fmt((n - 1) * lo)} ~ ${fmt((n - 1) * hi)}`;
}

/**
 * 草稿箱。
 *
 * 存在这里的都是"准备好了但还没发"的内容 —— 包括定时拉取自动生成的 AI 草稿。
 * 发不发始终由人决定（D7 的半自动化边界），但"由人决定"不该等于"由人逐条点"：
 * 一次勾选、一次确认、发一批，是同一件事的两种做法，后者才做得完活。
 *
 * @param {object} props
 * @param {Array} props.drafts - 已加载的草稿（最多 core 的 MAX_LIMIT 条）
 * @param {number} props.total - 当前账号待发布的**全部**条数（不受搜索影响，侧栏角标同源）
 * @param {number} props.matched - 当前搜索条件命中的条数
 * @param {number} props.unattributed - 没有标明归属账号、因此不在这个列表里的草稿条数
 * @param {object|null} props.bulkPublish - 批量发布的进度快照（没有批量在跑/刚跑完时为 null）。
 *   记在 App 层：这一页会被卸载，而进度必须活着回来。
 * @param {string[]|null} props.presetPicked - 从工作台「去草稿箱」带过来、要替用户勾上的草稿 id
 * @param {function} props.onPresetUsed - 应用完预选后回调，让 App 层把它清掉
 */
export default function DraftsView({ drafts, total, matched, unattributed = 0, bulkPublish, loading, actions, reload,
  presetPicked = null, onPresetUsed }) {
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

  const [query, setQuery] = useState('');
  /** 默认按视频分组：一个视频下攒了七八条回复时，平铺列表要凭标题认归属 */
  const [grouped, setGrouped] = useState(true);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [picked, setPicked] = useState(() => new Set());
  const [confirmingBatch, setConfirmingBatch] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);

  // 搜索词变化 → 查库（含首帧：离开页面时的搜索词会留在主进程那边，
  // 回来的时候如果不清，列表是过滤过的而搜索框是空的 —— 两处不一致）。
  // 条件走 SQL 而不是在这里 filter：列表只有最近 MAX_LIMIT 条，
  // 在已加载的那一页里过滤会把"没有命中"说成假话。
  useEffect(() => {
    const t = setTimeout(() => reload(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // 定时重读（间隔在设置页里配，0 = 关）。只读本地库，不发抖音请求。
  // 不传参 → 沿用当前搜索词，否则搜索结果会被后台刷新悄悄替换成全量
  useAutoRefresh('drafts', () => reload());

  const list = drafts || [];
  const boxTotal = typeof total === 'number' ? total : list.length;
  const hitTotal = typeof matched === 'number' ? matched : list.length;
  /** 这一页没显示出来的条数（搜索中按命中数算，否则按整箱算） */
  const hidden = Math.max(0, (query ? hitTotal : boxTotal) - list.length);

  /**
   * 从工作台「去草稿箱」带过来的预选：必须等列表读回来再勾。
   *
   * 立刻 setPicked 的话，"勾上了但这一页没有"与"根本没勾上"在界面上长得一样，
   * 而批量发布是按勾选集合发的 —— 所以这里与可见集合求交集，并把没勾到的条数
   * 说出来（当前有搜索词、或这批草稿归属在别的号下，是两种不同的下一步）。
   */
  useEffect(() => {
    if (!presetPicked || presetPicked.length === 0 || loading) return;
    const visible = new Set(list.map(d => d.id));
    const hit = presetPicked.filter(id => visible.has(id));
    setPicked(new Set(hit));
    setNotice(hit.length === presetPicked.length
      ? `已勾上刚生成的 ${hit.length} 条`
      : `已勾上 ${hit.length} 条；另有 ${presetPicked.length - hit.length} 条不在这个列表里 —— `
        + (query ? '当前有搜索词，清掉后再看。' : '可能归属别的账号，或已经发掉了。'));
    if (onPresetUsed) onPresetUsed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetPicked, loading, drafts]);

  // 只承认当前看得见的勾选：搜索、刷新、换号之后，选中集合里可能留着
  // 界面上已经不存在的 id —— 那是不属于这个账号的草稿，不能被这批删除带走
  const pickedItems = useMemo(
    () => list.filter(d => picked.has(d.id)),
    [list, picked]
  );
  const pickedIds = useMemo(() => pickedItems.map(d => d.id), [pickedItems]);

  /**
   * 待确认批量发布的草稿（点按钮那一刻拍的快照）。
   *
   * 存整份而不是只存 id：确认框要在用户读的时候一直保持同一批内容，
   * 而期间自动刷新可能把某条换掉 —— 那用户确认的就不是他看到的那批。
   * 快照里已经被发掉/删掉的条目，App 层入队前会再核一遍并如实报条数。
   */
  const [publishConfirm, setPublishConfirm] = useState(null);
  /** 设置的写间隔区间（秒），确认框用它估算"这批发完要等多久" */
  const [writeInterval, setWriteInterval] = useState(null);
  const [publishBusy, setPublishBusy] = useState(false);
  /** 这一批大概要发多久（只选了 1 条时没有"条与条之间"，返回 null） */
  const span = publishConfirm ? estimatePublishSpan(publishConfirm.length, writeInterval) : null;

  // 组始终算出来，哪怕当前是平铺：那个「平铺显示 / 按视频分组」的开关挂在
  // `groups.length > 1` 上，早先版本在平铺时直接 return null，于是切到平铺以后
  // 开关自己消失了 —— 用户再也回不到分组（进得去、出不来的状态最坑人）。
  const groups = useMemo(() => {
    const map = new Map();
    for (const d of list) {
      let g = map.get(d.awemeId);
      if (!g) { g = { awemeId: d.awemeId, title: d.videoTitle, ids: [], items: [] }; map.set(d.awemeId, g); }
      g.ids.push(d.id);
      g.items.push(d);
    }
    return [...map.values()];
  }, [list]);

  /** 分组后组数大于 1 才值得分组显示；只有一组时分组只是多一层壳 */
  const showGroups = grouped && groups.length > 1;

  function togglePick(id) {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleGroup(groupIds) {
    setPicked(prev => {
      const next = new Set(prev);
      const all = groupIds.every(id => next.has(id));
      for (const id of groupIds) { if (all) next.delete(id); else next.add(id); }
      return next;
    });
  }

  function toggleCollapse(awemeId) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(awemeId)) next.delete(awemeId); else next.add(awemeId);
      return next;
    });
  }

  async function remove(id) {
    const r = await window.dy.draft.remove(id);
    if (r.ok) { setNotice('已删除'); reload(); }
    else setNotice(`删除失败：${failText(r.error, '未知原因')}`);
  }

  async function deletePicked() {
    const ids = pickedIds;
    if (!ids.length) return;
    setBatchBusy(true);
    try {
      const r = await window.dy.draft.removeMany(ids);
      if (!r.ok) {
        // 一条都没删掉时不能说"已删除"：草稿还在，而用户已经相信它不在了
        setNotice(`批量删除失败：${failText(r.error, '未知原因')} —— 一条都没删，草稿都还在`);
        return;
      }
      const deleted = (r.data && r.data.deleted) || 0;
      const requested = (r.data && r.data.requested) || ids.length;
      setPicked(new Set());
      setNotice(deleted === requested
        ? `已删除 ${deleted} 条`
        : `已删除 ${deleted} 条，另有 ${requested - deleted} 条已不在当前账号的草稿箱里（未删除它们）`);
      reload();
    } finally {
      setBatchBusy(false);
      setConfirmingBatch(false);
    }
  }

  /** 打开批量发布确认框。写间隔是本地读一次就够的设置，用它估时长 */
  async function openPublishConfirm() {
    const items = pickedItems;
    if (!items.length) return;
    try {
      const r = await window.dy.config.describe();
      const iv = r && r.ok && r.data.config && r.data.config.intervals
        && r.data.config.intervals.write;
      setWriteInterval(Array.isArray(iv) ? iv : null);
    } catch (e) {
      // 读不到就不报具体分钟数，改成"要等设置的写间隔"—— 编一个数字比没有数字更糟
      setWriteInterval(null);
    }
    setPublishConfirm(items);
  }

  async function confirmPublish() {
    const snapshot = publishConfirm || [];
    // 按当前列表重核一遍：确认框开着的那段时间里自动刷新可能已经把某条换掉
    // （在别处发掉了、或删了）。那些不该照样发出去。
    const stillThere = snapshot.filter(d => list.some(x => x.id === d.id));
    const gone = snapshot.length - stillThere.length;
    if (!stillThere.length) {
      setPublishConfirm(null);
      setNotice('这些草稿已经不在这个箱里了（可能被删掉或已经发出去），一条都没发');
      return;
    }
    setPublishBusy(true);
    try {
      const ok = await actions.publishDrafts(stillThere);
      if (ok) {
        setPicked(new Set());
        setPublishConfirm(null);
        if (gone) setNotice(`已排入 ${stillThere.length} 条；另有 ${gone} 条在确认期间已不在箱里，没有发它们`);
      }
    } finally {
      setPublishBusy(false);
    }
  }

  function renderDraft(d, inGroup) {
    return (
      <div className="draft-row" key={d.id}>
        <label className="draft-pick" title="勾选后可以一次发布或一次删掉多条">
          <input type="checkbox" checked={picked.has(d.id)} onChange={() => togglePick(d.id)} />
        </label>
        <div className="draft-main">
          <div className="draft-head">
            {/* 分组显示时组头已经写了视频标题，行内再重复一次是噪声
                （还容易让人以为是两个不同的视频）。平铺时它必须留着，
                否则一条草稿根本看不出属于哪个视频。 */}
            {!inGroup && <span className="draft-video">{d.videoTitle || `视频 ····${String(d.awemeId).slice(-6)}`}</span>}
            {d.replyToCid && <span className="tag tag-dim">回复评论</span>}
            {d.personaId && (
              <span className="tag tag-dim" title={`人格标识 ${d.personaId}`}>
                {d.personaName || d.personaId}
              </span>
            )}
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
                          setNotice(`保存失败：${failText(r.error, '未知原因')} —— 原草稿未改动`);
                          return;
                        }
                        const rm = await window.dy.draft.remove(d.id);
                        if (rm.ok) {
                          setEditing(null);
                          setNotice('已保存');
                        } else {
                          // 先存后删的顺序保证了内容不丢；删除失败只会留下重复，
                          // 如实告诉用户该删哪条，而不是让它看起来像凭空多了一条
                          setNotice('已保存为新草稿，但删除旧草稿失败 —— 列表里会出现两条相同内容，请手动删掉旧的那条');
                        }
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
    );
  }

  function renderGroup(g) {
    const isCollapsed = collapsed.has(g.awemeId);
    const allPicked = g.ids.every(id => picked.has(id));
    return (
      <div className="draft-group" key={g.awemeId}>
        <div className="draft-group-head">
          <label className="draft-pick" title="勾选这个视频下的全部草稿">
            <input type="checkbox" checked={allPicked} onChange={() => toggleGroup(g.ids)} />
          </label>
          <button className="draft-group-toggle" onClick={() => toggleCollapse(g.awemeId)}
            title={isCollapsed ? '展开' : '收起'}>
            <span className="draft-caret" data-closed={isCollapsed ? '1' : undefined} aria-hidden="true">▾</span>
            <span className="draft-group-title">{g.title || `视频 ····${String(g.awemeId).slice(-6)}`}</span>
          </button>
          <span className="draft-group-count muted num">{g.items.length} 条</span>
        </div>
        {!isCollapsed && <div className="list">{g.items.map(d => renderDraft(d, true))}</div>}
      </div>
    );
  }

  return (
    <div className="main-col">
      <h1 className="page-title">草稿箱</h1>
      <p className="page-sub">
        待发布的内容。定时拉取自动生成的 AI 草稿也会落在这里 —— 发布始终由你决定。
      </p>

      {notice && <div className="notice"><div>{notice}</div></div>}

      {/* 批量发布的进度与结果。数据在 App 层（见 App.jsx 的 bulkPublish）：
          这个组件会在用户切去「队列」页看倒计时时卸载，进度不能跟着一起没了。 */}
      {bulkPublish && (
        <div className="drafts-bulkprogress">
          <ProgressBar
            current={bulkPublish.done}
            total={bulkPublish.total}
            label={bulkPublish.finished
              ? <>批量发布结束：发出 <b className="text-ok num">{bulkPublish.ok}</b> 条
                {bulkPublish.failed.length > 0 && <>、没发出去 <b className="text-bad num">{bulkPublish.failed.length}</b> 条</>}
                {bulkPublish.cancelled > 0 && <>、按你的取消撤下 <b className="num">{bulkPublish.cancelled}</b> 条</>}</>
              : `批量发布中：已完成 ${bulkPublish.done}/${bulkPublish.total} 条（每条之间要等写间隔）`}
            tone={bulkPublish.finished
              ? (bulkPublish.failed.length ? 'bad' : 'ok')
              : (bulkPublish.cancelledByUser ? 'wait' : 'neutral')}
          />
          {!bulkPublish.finished && (
            <button className="btn btn-quiet" onClick={() => actions.cancelBulkPublish()}>
              取消剩下的
            </button>
          )}
          {bulkPublish.finished && (
            <button className="btn btn-quiet" onClick={() => actions.clearBulkPublish()}>知道了</button>
          )}
          {bulkPublish.failed.length > 0 && (
            <div className="bulk-result">
              {bulkPublish.failed.map(f => (
                <div className="bulk-result-row" key={`bp-${f.draftId}-${f.error}`}>
                  <b className="text-bad">没发出</b>
                  <span>{f.label} —— {failText(f.error, '未知原因')}</span>
                </div>
              ))}
              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                这些草稿还在箱子里，一条都没丢 —— 修好原因（额度、重复回复、连接）后可以再发一次。
              </div>
            </div>
          )}
        </div>
      )}

      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => reload()} disabled={loading}>
          {loading && <Spinner size={12} />}刷新
        </button>
        <input
          className="input drafts-search"
          type="search"
          placeholder="搜索草稿内容、视频标题，或被回复的那条评论"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <span className="muted drafts-count" style={{ alignSelf: 'center', fontSize: 12.5 }}>
          {query ? `搜索到 ${hitTotal} 条` : `共 ${boxTotal} 条待发布`}
          {hidden > 0 && ` · 还有 ${hidden} 条没显示（只载入最近 ${list.length} 条，用搜索定位剩下的）`}
        </span>
      </div>

      {list.length > 0 && (
        <div className="row drafts-tools">
          {pickedIds.length > 0
            ? (
              <div className="drafts-bulkbar">
                <span className="drafts-bulkbar-main">
                  已选 {pickedIds.length} 条
                  {query && `（搜索中的 ${list.length} 条里）`}
                  <span className="muted">　·　发布后这些草稿会自动移出箱子；没发出去的会留着</span>
                </span>
                {/* 批量发布进行中先把"删除所选"灰掉：删掉一条已经排进队列的草稿
                    并不会取消那次发布（任务里带着自己的正文），
                    一次几十条时这个坑不能留给用户踩。要撤先取消剩下的。 */}
                <button className="btn btn-primary" onClick={openPublishConfirm}
                  disabled={!actions.canQueue || !!(bulkPublish && !bulkPublish.finished)}
                  title={!actions.canQueue
                    ? '浏览器未连接 —— 先到「连接」页接上抖音，发布要经过它'
                    : '把这批草稿逐条发到抖音：一次确认，每条仍然按设置的写间隔排队'}>
                  发布所选 {pickedIds.length} 条
                </button>
                <button className="btn btn-quiet text-bad" onClick={() => setConfirmingBatch(true)}
                  disabled={!!(bulkPublish && !bulkPublish.finished)}
                  title={bulkPublish && !bulkPublish.finished
                    ? '批量发布进行中 —— 先等它结束或取消剩下的，再删（删掉不会取消已排队的发布）' : undefined}>
                  删除所选
                </button>
                <button className="btn btn-quiet" onClick={() => setPicked(new Set())}>取消选择</button>
              </div>
            )
            : (
              <button className="btn btn-quiet drafts-pickall"
                onClick={() => setPicked(new Set(list.map(d => d.id)))}>
                全选这一页（{list.length} 条）
              </button>
            )}
          {groups.length > 1 && (
            <button className="btn btn-quiet drafts-pickall" onClick={() => setGrouped(v => !v)}>
              {grouped ? '平铺显示' : '按视频分组'}
            </button>
          )}
        </div>
      )}

      {unattributed > 0 && (
        // 这些草稿确实在库里，只是按账号过滤时不会露出来。不写出来的话，
        // 用户看到的就只是"我生成了 7 条，草稿箱是空的"，只能猜。
        <div className="notice notice-warn" style={{ marginBottom: 12 }}>
          <div>
            有 <b>{unattributed}</b> 条草稿没有标明是哪个账号的，为了不把别的号准备的话错发出去，
            它们没有列在下面。到「连接」页确认浏览器里登录着抖音，再重新生成一次就会正常归属。
          </div>
        </div>
      )}

      {loading && list.length === 0
        ? <LoadingState rows={3} title />
        : list.length === 0
          ? (
            query
              ? (
                // 搜不到不等于箱子空了 —— 清空搜索词的按钮必须在这里，
                // 否则用户只能把输入框删空，而"搜索到 0 条"很容易被读成"草稿没了"
                <EmptyState
                  title={`没有草稿含「${query}」。`}
                  hint={<>草稿箱里仍有 {boxTotal} 条待发布。搜索会同时匹配草稿正文、视频标题，以及被回复的那条评论的原文。</>}
                  action={<button className="btn" onClick={() => setQuery('')}>清空搜索</button>}
                />
              )
              : (
                // 不给行动按钮：草稿的来源在别的页面，这里放一个按钮要么是空动作、
                // 要么把用户送到一个他本来就不想去的地方。写清去哪儿做就够了。
                <EmptyState
                  title="草稿箱是空的。"
                  hint="在「我的作品」里点进任意作品就是评论工作台，对某条评论点「存草稿」即可；工作台批量条上的「批量生成」和「用固定回复存草稿」，结果也落到这里。"
                />
              )
          )
          : (
            <>
              {/* 只有一组时不加分组壳（showGroups），否则平铺能一眼看完的东西要多点一次 */}
              {showGroups
                ? groups.map(renderGroup)
                : <div className="list">{list.map(d => renderDraft(d, false))}</div>}
            </>
          )}

      {publishConfirm && (
        <Modal
          title={`发布选中的 ${publishConfirm.length} 条草稿？`}
          onClose={() => setPublishConfirm(null)}
          busy={publishBusy}
          width={620}
          footer={
            <>
              <button className="btn btn-quiet" onClick={() => setPublishConfirm(null)} disabled={publishBusy}>
                取消
              </button>
              <button className="btn btn-primary" onClick={confirmPublish} disabled={publishBusy}>
                {publishBusy && <Spinner size={12} />}
                {publishBusy ? '排队中…' : `确认发布 ${publishConfirm.length} 条`}
              </button>
            </>
          }
        >
          <div className="notice notice-warn" style={{ marginBottom: 12 }}>
            <div>
              这会<b>真的以当前账号把它们发到抖音</b>，不是存到别处。发出去的内容要逐条撤，
              位置在评论工作台的那条评论下面（「删除我的回复」）。
            </div>
          </div>

          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
            {publishConfirm.length > 1 ? (
              <>一条一次发布，<b>串行</b>进行：每两条之间都要等设置的写间隔
                {span
                  ? <>，这 {publishConfirm.length} 条大概要 <b className="num">{span}</b>（第一条还要看离上一次发布过了多久）</>
                  : '，所以一整批要等的时间远比一次点击长'}
                。
              </>
            ) : '这一条要等的是距上一次发布过了多久（设置里的写间隔）。'}
            期间可以随时「取消剩下的」，正在发的那一条会先结束。
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
            被策略拦下的（当日额度用完、这条评论已经回复过、内容重复）不会发出去，
            草稿留在箱里，进度面板会逐条写出原因。
          </div>

          {/* 确认的是这一批内容，不是"发不发"这个抽象动作 ——
              不把要发的东西摆出来，用户点的其实是运气 */}
          <div className="bulk-result">
            {publishConfirm.slice(0, PUBLISH_PREVIEW_ROWS).map(d => (
              <div className="bulk-result-row" key={d.id}>
                <b className="muted">#{d.id}</b>
                <span>
                  <span className="muted">{d.videoTitle || `视频 ····${String(d.awemeId).slice(-6)}`}：</span>
                  {d.text || '（纯图片草稿，无文字）'}
                </span>
              </div>
            ))}
            {publishConfirm.length > PUBLISH_PREVIEW_ROWS && (
              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                另外 {publishConfirm.length - PUBLISH_PREVIEW_ROWS} 条没有列出，确认后会一起发。
              </div>
            )}
          </div>
        </Modal>
      )}

      {confirmingBatch && (
        <Modal
          title={`删除选中的 ${pickedIds.length} 条草稿？`}
          onClose={() => setConfirmingBatch(false)}
          busy={batchBusy}
          footer={
            <>
              <button className="btn btn-quiet" onClick={() => setConfirmingBatch(false)} disabled={batchBusy}>
                取消
              </button>
              <button className="btn btn-primary text-bad" onClick={deletePicked} disabled={batchBusy}>
                {batchBusy && <Spinner size={12} />}
                {batchBusy ? '删除中…' : `删除 ${pickedIds.length} 条`}
              </button>
            </>
          }
        >
          <div className="notice notice-warn" style={{ marginBottom: 12 }}>
            <div>
              草稿删了无法恢复（没有回收站），但<b>不影响已经发到抖音的内容</b> ——
              这里删掉的只是还没发出去的准备稿。
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            只删当前账号的草稿；发布、编辑都不受影响。
          </div>
        </Modal>
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
