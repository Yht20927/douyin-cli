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

/** 批量改正文：输入停止多久后才去库里算一次预览 */
const EDIT_DEBOUNCE_MS = 260;

/** 预览里最多列几条改动，其余用一行"还有 M 条"说明 */
const EDIT_PREVIEW_ROWS = 6;

/**
 * 表单 → core 的 patch 形状。**预览与执行都只从这里拿**。
 *
 * 两处各拼一份的话，"预览说会改 12 条、按下去实际改了 11 条"迟早出现 ——
 * 而那是这个确认框存在的唯一理由被拆掉。
 *
 * 返回 null 表示还没填完：不去查库，确认按钮也按不动。
 * 「查找」留空必须是 null 而不是一次"把每个字之间都插入替换串"的替换
 * （core 那边也拦，但拦下来会变成一个谁也看不懂的失败）。
 */
function editPatch(mode, assign, find, replace) {
  // 空着不算"要把正文清空"，算"还没填完"。探针里实测到过：一打开框子就报
  // 「会改动 1 条」而确认键是亮的 —— 那一下点下去是覆盖，不是空操作。
  // 真想清空正文有明确的路：切到「在每条里查找替换」，把那一句整个查找掉。
  if (mode === 'assign') return String(assign == null ? '' : assign).trim()
    ? { text: String(assign) } : null;
  const f = String(find == null ? '' : find);
  if (!f) return null;
  return { find: f, replace: String(replace == null ? '' : replace) };
}

/**
 * skipped → 人话。只列非零的那几类。
 *
 * 这一堆分类计数的存在理由就是这几句：批量写操作不能只报"改了 N 条"，
 * 必须说得出**没动的那些为什么没动**，否则用户下一次还是靠猜。
 */
function skipNotes(skipped) {
  const s = skipped || {};
  const out = [];
  if (s.posted) out.push(`${s.posted} 条已经发到抖音了，没动它们`);
  if (s.foreign) out.push(`${s.foreign} 条不属于当前账号（或没标明归属），没动它们`);
  if (s.missing) out.push(`${s.missing} 条已经不在箱里（被删掉或已经发掉），没动它们`);
  if (s.empty) out.push(`${s.empty} 条改完会既没文字也没附图 —— 那样发出去是一条空评论，放弃了`);
  if (s.noop) out.push(`${s.noop} 条本来就是这样的`);
  return out;
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
  presetPicked = null, onPresetUsed, readError }) {
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

  // ── 批量改正文 ──
  const [editOpen, setEditOpen] = useState(false);
  const [editMode, setEditMode] = useState('assign');
  const [editAssign, setEditAssign] = useState('');
  const [editFind, setEditFind] = useState('');
  const [editReplace, setEditReplace] = useState('');
  /** 预览结果：{busy} / {error} / {data}，null = 还没开始算 */
  const [editPreview, setEditPreview] = useState(null);
  const [editBusy, setEditBusy] = useState(false);

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
  // 自动刷新每来一次都会重建 pickedIds（内容相同、引用不同）。预览的依赖
  // 必须挂内容而不是引用，否则每一次后台刷新都会重新查一遍库
  const pickedKey = pickedIds.join(',');
  /** 当前表单拼出来的 patch；null = 还没填完，不能预览也不能确认 */
  const editPatchNow = editPatch(editMode, editAssign, editFind, editReplace);
  /** 预览已经算回来的那份数据（还在算 / 算失败时为 null） */
  const editData = (editPreview && editPreview.data) || null;

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

  /**
   * 确认框开着时，把当前输入拿到库里**真算一遍**（dryRun，一个字都不写）。
   *
   * 为什么不在界面自己数命中几条：列表里只有已载入的那 MAX_LIMIT 条，
   * 而"哪几条已经发出去了、哪几条其实属于别的账号"只有 SQL 知道。
   * 预览发的是同一个 editPatchNow 产物 —— 预览里的条数就是按下去之后的条数，
   * 这条性质不能靠"两边看起来一样"来维持。
   */
  useEffect(() => {
    if (!editOpen) return undefined;
    const patch = editPatchNow;
    if (!patch || !pickedIds.length) { setEditPreview(null); return undefined; }
    let dead = false;
    setEditPreview({ busy: true });
    const t = setTimeout(async () => {
      const r = await window.dy.draft.updateMany(pickedIds, patch, { dryRun: true });
      if (dead) return;
      setEditPreview(r.ok ? { data: r.data } : { error: failText(r.error, '未知原因') });
    }, EDIT_DEBOUNCE_MS);
    return () => { dead = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editOpen, editMode, editAssign, editFind, editReplace, pickedKey]);

  /** 按确认：把预览的那一次原样执行（不带 dryRun），并照实报改了哪几条、没动哪几条 */
  async function applyBatchEdit() {
    const ids = pickedIds;
    const patch = editPatchNow;
    if (!ids.length || !patch) return;
    setEditBusy(true);
    try {
      const r = await window.dy.draft.updateMany(ids, patch);
      if (!r.ok) {
        // 一条都没改时说"改好了"是这一页最贵的那种假话：用户接下来就按新文案去发布了
        setNotice(`批量改正文失败：${failText(r.error, '未知原因')} —— 一条都没改，草稿都还是原来的`);
        return;
      }
      const d = r.data || {};
      const notes = skipNotes(d.skipped);
      setNotice(d.changed
        ? `已改动 ${d.changed} 条${notes.length ? `；另有 ${notes.join('；')}` : ''}`
        : `一条都没改${notes.length ? `：${notes.join('；')}` : ''}`);
      setEditOpen(false);
      reload();
    } finally {
      setEditBusy(false);
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
                      // 改正文只有一个入口：一次 UPDATE。id 与 created_at 都不变，
                      // 附图天然跟着走 —— 旧做法是"存一条新的再删旧的"，
                      // 于是这条会在列表里跳到最前，而两步之间失败就留下
                      // 两条内容相同的待发草稿（接着批量发布 = 同一句发两遍）。
                      //
                      // savingId 仍然要：这是一次异步写，没有进行中态的话
                      // 连点两下会飞两次请求出去。
                      setSavingId(d.id);
                      try {
                        const r = await window.dy.draft.updateMany([d.id], { text: editText });
                        if (!r.ok) {
                          setNotice(`保存失败：${failText(r.error, '未知原因')} —— 原草稿未改动`);
                          return;
                        }
                        const data = r.data || {};
                        const s = data.skipped || {};
                        if (data.changed) {
                          setEditing(null);
                          setNotice('已保存');
                        } else if (s.empty) {
                          // 不许改成"既没字又没图"：那样发出去是一条空评论。
                          // 留在编辑态里，用户能接着改，而不是白丢一次输入
                          setNotice('正文空了，而这条没有附图 —— 那样会发不出去，所以没保存');
                        } else if (s.noop) {
                          setEditing(null);
                          setNotice('正文没有变化');
                        } else {
                          // posted / missing：这一条在别处被发掉或删掉了
                          setEditing(null);
                          setNotice(s.posted
                            ? '这条已经发到抖音了，草稿箱里的这份没动'
                            : '这条已经不在当前账号的草稿箱里（可能被删掉或已经发出），没保存');
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
                  {query && `（当前是搜索结果里的 ${list.length} 条）`}
                  <span className="muted">　·　
                    {hidden > 0 && pickedIds.length === list.length
                      // 勾到"可见的全部"不等于勾到"全部"。这时候不提醒，
                      // 用户会以为这一批发完箱子就空了。
                      ? `这已经是全部可见的 ${list.length} 条；同条件的还有 ${hidden} 条没载入、没勾上 —— 要一次做完先用搜索缩小范围`
                      : '发布后这些草稿会自动移出箱子；没发出去的会留着'}
                  </span>
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
                <button className="btn" onClick={() => setEditOpen(true)}>
                  批量改正文
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
              <>
                {/* 原来叫「全选这一页」：这一页到底是什么范围，用户只能猜。
                    而列表最多只载入 core 的 MAX_LIMIT 条，"全选"覆盖的其实只是
                    已载入的那几条 —— 勾完之后批量发布漏掉一半才是真事故。 */}
                <button className="btn btn-quiet drafts-pickall"
                  onClick={() => setPicked(new Set(list.map(d => d.id)))}>
                  全选这 {list.length} 条
                </button>
                {hidden > 0 && (
                  <span className="muted">
                    同条件的还有 <span className="num">{hidden}</span> 条没载入，这一勾覆盖不到它们
                  </span>
                )}
              </>
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
        : list.length === 0 && readError
          ? (
            // 「读失败」必须与「没有」不同形。这一屏原来的画法是「草稿箱是空的。」
            // 再加侧栏那枚消失的角标 —— 两处互相印证一个错误结论，而唯一那句报错
            // 是一条六秒后就消失的 toast（§2.44 记的就是这一类）
            <EmptyState
              title="草稿箱这次没读回来。"
              hint={<>这不是"没有草稿"。原因：{readError}。列表和侧栏那个数都停在上一次读到的结果上，
                重新读一次就有答案 —— 读失败不会动到任何一条草稿。</>}
              action={<button className="btn" onClick={() => reload()}>重新读取</button>}
            />
          )
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
                {readError && (
                  // 列表非空 + 这次重读失败 = 屏幕上是一批**旧的**草稿，而且看起来完全正常。
                  // 只靠一条会消失的 toast 等于没说
                  <div className="notice notice-warn" style={{ marginBottom: 12 }}>
                    <div>
                      草稿箱这次没重新读回来（{readError}）—— 下面列的是上一次读到的结果，
                      刚生成的草稿可能不在里面。
                      <button className="btn btn-quiet" style={{ marginLeft: 8 }} onClick={() => reload()}>
                        重新读取
                      </button>
                    </div>
                  </div>
                )}
                {/* 只有一组时不加分组壳（showGroups），否则平铺能一眼看完的东西要多点一次 */}
                {showGroups
                  ? groups.map(renderGroup)
                  : <div className="list">{list.map(d => renderDraft(d, false))}</div>}
              </>
            )}

      {editOpen && (
        <Modal
          title={`批量改正文：已选的 ${pickedIds.length} 条`}
          onClose={() => setEditOpen(false)}
          busy={editBusy}
          width={660}
          footer={
            <>
              <button className="btn btn-quiet" onClick={() => setEditOpen(false)} disabled={editBusy}>
                取消
              </button>
              {/* 数字来自 core 的那次 dryRun，不是界面数出来的 —— 所以按下去之前
                  用户看到的条数就是按下去之后的条数。预览还没回来时按钮按不动，
                  宁等一秒也不给一个猜出来的数 */}
              <button className="btn btn-primary" onClick={applyBatchEdit}
                disabled={editBusy || !editPatchNow || !editData}>
                {editBusy && <Spinner size={12} />}
                {editBusy ? '改其中…' : `确认改动 ${editData ? editData.changed : '…'} 条`}
              </button>
            </>
          }
        >
          <div className="seg" style={{ marginBottom: 12 }}>
            <button
              className={`seg-item ${editMode === 'assign' ? 'seg-item-active' : ''}`}
              onClick={() => setEditMode('assign')}
            >
              整批替换成同一句
            </button>
            <button
              className={`seg-item ${editMode === 'find' ? 'seg-item-active' : ''}`}
              onClick={() => setEditMode('find')}
            >
              在每条里查找替换
            </button>
          </div>

          {editMode === 'assign' ? (
            <>
              <textarea
                className="input reply-box"
                rows={4}
                value={editAssign}
                placeholder="新的正文 —— 勾到的每一条都会变成这一句"
                onChange={e => setEditAssign(e.target.value)}
              />
              <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
                这是<b>覆盖</b>不是追加：各条原来的句子改完就不在了。想留着改，先取消、用搜索缩小范围。
              </div>
            </>
          ) : (
            <>
              <input
                className="input"
                style={{ width: '100%' }}
                value={editFind}
                placeholder="查找：要被换掉的那几个字"
                onChange={e => setEditFind(e.target.value)}
              />
              <input
                className="input"
                style={{ width: '100%', marginTop: 8 }}
                value={editReplace}
                placeholder="替换成：留空就是把这些字删掉"
                onChange={e => setEditReplace(e.target.value)}
              />
              <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
                按<b>字面量</b>匹配，不是正则：找 (1) 就只换写着括号的那一处，
                替换串里的 $&amp; 也只是三个字符。每条只改自己正文里出现的那几处，没有命中的那条不动。
              </div>
            </>
          )}

          <div className="notice" style={{ margin: '12px 0 0' }}>
            <div>
              {!editPatchNow
                ? (editMode === 'assign'
                  ? '新的正文还空着 —— 现在一次都不会改。要把正文清空请用「在每条里查找替换」。'
                  : '「查找」还空着 —— 现在一次都不会改。')
                : editPreview && editPreview.busy
                  ? <>正在库里算会改动几条…<Spinner size={12} /></>
                  : editPreview && editPreview.error
                    ? <>算不出来：{editPreview.error}</>
                    : editData
                      ? <>
                        会改动 <b className="num">{editData.changed}</b> 条
                        {editData.requested > editData.changed
                          && <>，另有 <b className="num">{editData.requested - editData.changed}</b> 条不动</>}。
                      </>
                      : '正在算…'}
            </div>
            {editData && skipNotes(editData.skipped).length > 0 && (
              <div className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>
                {skipNotes(editData.skipped).join('；')}。
              </div>
            )}
          </div>

          {/* 确认的是"这些句子会变成什么样"，不是"改不改"这个抽象动作 */}
          {editData && editData.changed > 0 && editMode === 'assign' && (
            <div className="bulk-result">
              <div className="bulk-result-row">
                <b className="muted">全部 {editData.changed} 条</b>
                <span>{editAssign}</span>
              </div>
            </div>
          )}
          {editData && editMode === 'find' && editData.preview.length > 0 && (
            <div className="bulk-result">
              {editData.preview.slice(0, EDIT_PREVIEW_ROWS).map(p => (
                <div className="bulk-result-row" key={`ep-${p.id}`}>
                  <b className="muted">#{p.id}</b>
                  <span>
                    <span className="muted">{p.from || '（原来的正文是空的）'}</span>
                    <span className="muted">　→　</span>
                    {p.to || '（改完是空的：这条带附图）'}
                  </span>
                </div>
              ))}
              {editData.preview.length > EDIT_PREVIEW_ROWS && (
                <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                  另外 {editData.preview.length - EDIT_PREVIEW_ROWS} 条没有列出，会一起改。
                </div>
              )}
            </div>
          )}

          {/* 三句"这一改做不到什么"，写在明面上而不是悬停才看得到 */}
          <div className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>
            <div>
              · 已经排进队列的发布<b>不会跟着变</b>：任务带的是入队那一刻的正文。
              要让新文案发出去，先「取消剩下的」再重新发布一次。
            </div>
            <div>
              · 这里<b>没有</b>「统一换人格」。草稿行上那个人格名是"这句话当初由谁生成"的溯源，
              发布只发正文；把标签改掉不会让口吻变成另一个人格。要换口吻得回工作台重新生成。
            </div>
            {hidden > 0 && pickedIds.length === list.length && (
              <div>
                · 这一勾只覆盖已载入的 {list.length} 条，同条件的还有 <span className="num">{hidden}</span> 条
                没载入，<b>这次改不到它们</b> —— 要一次做完先用搜索缩小范围。
              </div>
            )}
          </div>
        </Modal>
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
