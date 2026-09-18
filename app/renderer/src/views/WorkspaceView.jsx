import React, { useEffect, useRef, useState } from 'react';
import PublishDialog from '../components/PublishDialog.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Skeleton from '../components/Skeleton.jsx';
import Spinner from '../components/Spinner.jsx';
import ProgressBar from '../components/ProgressBar.jsx';
import { ago, fileNameOf } from '../format.js';

/** 判定结果 → 界面标签与颜色。三种结果对应三种处置，用词保持一致。 */
const DECISION = {
  reply: { label: '建议回复', tone: 'ok' },
  emoji_reply: { label: '表情回复', tone: 'warn' },
  skip: { label: '跳过', tone: 'dim' },
};

/** 一页取多少条。真实总数由服务端返回的 total 给出，页面会显示「共 N 条」 */
const PAGE_SIZE = 300;

/**
 * 一次批量最多勾选几条。
 *
 * 与 core 的 MAX_BATCH 保持一致（那边也会截断，但界面必须**先**拦住 ——
 * 让用户勾了 80 条、点下去只处理 50 条，比一开始就告诉他上限更糟）。
 * 这个数字来自"逐条生成 = 一条一次 LLM 调用"：50 条大约要跑十几分钟。
 */
const MAX_PICK = 50;

/** 筛选标签。前三个走 SQL（按已回复状态），后三个按判定结果在内存里筛。 */
const TABS = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待处理' },
  { key: 'reply', label: '建议回复' },
  { key: 'emoji_reply', label: '表情回复' },
  { key: 'skip', label: '跳过' },
  { key: 'replied', label: '已回复' },
];

export default function WorkspaceView({ awemeId, queueState, actions, onBack }) {
  const [video, setVideo] = useState(null);
  const [stats, setStats] = useState(null);
  const [comments, setComments] = useState([]);
  /**
   * 是否正在读本地库。
   *
   * 改造前没有这个状态，于是 `reload()` 在 IPC 返回之前 `comments` 还是空数组，
   * 界面直接渲染空态文案「这个筛选下没有评论。」—— **把"还在读"显示成了"没有数据"**。
   * 用户切标签页、敲搜索时看到这句话，会以为筛选没生效或者数据没了。
   */
  const [loading, setLoading] = useState(false);
  /** 存草稿的进行中态（与列表刷新是两件事，分开） */
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('pending');
  const [search, setSearch] = useState('');
  /** 输入框的即时值；防抖后才写进 search 触发查询 */
  const [searchInput, setSearchInput] = useState('');
  const [order, setOrder] = useState('priority');
  const [orders, setOrders] = useState([]);
  /** 列表的元信息：截断前的真实条数、是否被截断 */
  const [listMeta, setListMeta] = useState(null);
  const [selectedCid, setSelectedCid] = useState(null);
  const [draftText, setDraftText] = useState('');
  const [genTaskId, setGenTaskId] = useState(null);
  const [publishing, setPublishing] = useState(null);
  const [notice, setNotice] = useState(null);
  /** 生成结果的来源信息：来自 AI 还是固定内容、带了哪张图、是否降级 */
  const [genInfo, setGenInfo] = useState(null);
  /** 当前的回复来源配置（模式 / 固定内容条数 / 图片开关），用于在按钮旁讲清楚会怎么生成 */
  const [replyDesc, setReplyDesc] = useState(null);

  // ── 批量 ──
  /** 勾选的评论 cid（Set，用新对象替换触发重渲染） */
  const [picked, setPicked] = useState(() => new Set());
  /** 正在跑的批量生成任务 id */
  const [bulkTaskId, setBulkTaskId] = useState(null);
  /** 批量生成的结果摘要（生成/跳过/失败各多少条 + 明细） */
  const [bulk, setBulk] = useState(null);
  const bulkHandled = useRef(null);

  /**
   * 正在等待结果的队列任务。
   *
   * { id, kind: 'fetch' | 'publish', text?, cid? } —— 带 kind 是有原因的：
   * 此前这里只存一个 id，于是**发布**失败时也报"拉取未完成"，
   * 而且用户手写的那段话已经因为"入队成功"被清空了，再也找不回来。
   * 现在按 kind 分别处理，发布的失败会把内容还给编辑框。
   */
  const pendingRefresh = useRef(null);

  /** 编辑框内容的镜像：队列回调里要判断"现在框里有没有东西"，直接读 state 会拿到旧值 */
  const draftTextRef = useRef('');
  const genHandled = useRef(null);
  /** 生成任务对应的评论 cid —— 结果只允许填回它自己那条 */
  const genCid = useRef(null);
  /**
   * 当前选中的 cid 的镜像。
   * 队列变化的回调注册在 effect 里，直接读 `selectedCid` 会拿到注册那一刻的旧值
   * （闭包捕获）—— 那样"切没切走"永远判断成"没切走"，白做这个保护。
   */
  const selectedCidRef = useRef(null);

  async function reload() {
    setLoading(true);
    try {
      await doReload();
    } finally {
      setLoading(false);
    }
  }

  async function doReload() {
    const [v, s, c] = await Promise.all([
      window.dy.data.video(awemeId),
      window.dy.data.videoStats(awemeId),
      window.dy.data.comments(awemeId, { filter: tab, search: search || undefined, order, limit: PAGE_SIZE }),
    ]);
    // 失败要说话，而不是伪装成「没有数据」——
    // 改造前 `c.ok ? c.data : []` 让数据库故障看起来像「这个筛选下没有评论」，
    // 用户会去反复点「拉取新评论」，永远查不出真实原因。
    setVideo(v.ok ? v.data : null);
    setStats(s.ok ? s.data : null);
    if (c.ok) {
      setComments(c.data.items || []);
      setListMeta(c.data);
    } else {
      setComments([]);
      setListMeta(null);
      setNotice(`读取本地数据失败：${c.error || '未知错误'}`);
    }
    if (!v.ok || !s.ok) setNotice(`读取失败：${(v.error || s.error || '未知错误')}`);
  }

  // 搜索防抖：改造前 search 一变就跑 reload()，而 reload 会取 5000 行跑判定树
  // 并逐 uid 查用户表 —— 敲一个字符就是上万次分类，输入框直接卡住。
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [awemeId, tab, search, order]);

  // 排序选项由 core 提供，界面不自己写一份
  useEffect(() => {
    window.dy.data.commentOrders().then(r => { if (r && r.ok) setOrders(r.data); });
  }, []);

  useEffect(() => { selectedCidRef.current = selectedCid; }, [selectedCid]);
  useEffect(() => { draftTextRef.current = draftText; }, [draftText]);

  // 换筛选 / 换排序 / 换视频之后，之前勾的 cid 可能已经不在眼前这个列表里了。
  // 留着的话"已选 8 条"与屏幕上看到的东西对不上，点下去还会处理看不见的评论。
  useEffect(() => {
    setPicked(new Set());
    setBulk(null);
  }, [awemeId, tab, search, order]);

  // 回复来源配置随设置页改动而变，进工作台时取一次就够（切视频会重新挂载）
  useEffect(() => {
    window.dy.reply.describe().then(r => { if (r && r.ok) setReplyDesc(r.data); });
  }, [awemeId]);

  // 队列变化 → 完成自己关心的事情
  useEffect(() => {
    if (!queueState) return;
    const tasks = queueState.tasks || [];

    // 等一个任务跑完（拉评论 / 发布回复）
    if (pendingRefresh.current) {
      const p = pendingRefresh.current;
      const t = tasks.find(x => x.id === p.id);
      if (t && ['done', 'failed', 'blocked', 'cancelled'].includes(t.status)) {
        pendingRefresh.current = null;
        if (t.status === 'done') {
          reload();
        } else if (p.kind === 'publish') {
          // 发布没成（失败/被策略拦下/取消），把内容还给编辑框 ——
          // 用户手写的一段回复不该因为一次队列失败就消失。
          // 只在编辑框是空的时候放回，免得覆盖用户后来输入的内容。
          if (p.text && !draftTextRef.current.trim()) setDraftText(p.text);
          setNotice(`发布未完成：${t.error || '未知原因'} —— 内容已放回编辑框`);
        } else {
          setNotice(t.error || '拉取未完成');
        }
      }
    }

    // 批量生成：完成后把明细摆出来，并刷新草稿角标 ——
    // 批量生成的产物在草稿箱里，不刷新的话"已生成 8 条"和侧栏角标对不上，
    // 用户会怀疑到底存没存进去（这个坑单条保存时已经踩过一次）。
    if (bulkTaskId && bulkHandled.current !== bulkTaskId) {
      const t = tasks.find(x => x.id === bulkTaskId);
      if (t && ['done', 'failed', 'blocked', 'cancelled'].includes(t.status)) {
        bulkHandled.current = bulkTaskId;
        setBulkTaskId(null);
        if (t.status === 'done') {
          window.dy.queue.result(bulkTaskId).then((r) => {
            const res = r && r.result;
            setBulk(summarizeBulk(res));
            if (actions.refreshDrafts) actions.refreshDrafts();
          });
        } else {
          setBulk({ error: t.error || '批量生成失败' });
        }
      }
    }

    // 生成回复：拿完整结果（摘要对一段文本没有意义）
    if (genTaskId && genHandled.current !== genTaskId) {
      const t = tasks.find(x => x.id === genTaskId);
      if (t && ['done', 'failed', 'blocked', 'cancelled'].includes(t.status)) {
        genHandled.current = genTaskId;
        setGenTaskId(null);
        // 结果只允给当初那条评论。
        // 改造前不记 cid：生成期间切到另一条评论，这条生成结果会填进当前编辑框，
        // 而发布用的是**当前选中**的 cid —— 会把写给 A 的回复发给 B。
        const forCid = genCid.current;
        genCid.current = null;
        if (forCid && selectedCidRef.current !== forCid) {
          setNotice('生成完成，但你已经切到别的评论了 —— 为避免发错对象，结果没有填进编辑框。切回那条评论再点一次「生成回复」即可。');
        } else if (t.status === 'done') {
          window.dy.queue.result(genTaskId).then((r) => {
            const res = r && r.result;
            const text = extractReplyText(res);
            const info = describeGenResult(res);
            setGenInfo(info);
            if (text) {
              setDraftText(text);
            } else if (info && info.imagePath) {
              // 纯图回复：文字本来就是空的，不是失败
              setDraftText('');
              setNotice('这条按配置只发图不带文字 —— 确认下面的图片后即可发布');
            } else {
              setNotice('生成成功但没解析出文本，请查看队列里的结果');
            }
          });
        } else {
          setNotice(t.error || '生成失败');
          setGenInfo(null);
        }
      }
    }
    /* eslint-disable-next-line */
  }, [queueState]);

  const selected = comments.find(c => c.cid === selectedCid) || null;

  function select(c) {
    setSelectedCid(c.cid);
    setNotice(null);
    setDraftText('');
    // 换一条评论就丢弃上一条的来源信息：留着会让"附图"张冠李戴
    setGenInfo(null);
  }


  async function fetchComments() {
    const id = await actions.enqueue({
      command: 'get',
      argv: [awemeId, '--new', '--depth', '1', '--count', '20'],
      label: '拉取新评论',
    });
    if (!id) return;
    pendingRefresh.current = { id, kind: 'fetch' };
    setNotice('已加入队列 —— 拉取完成后列表会自动刷新');
  }

  async function generate() {
    if (!selected) return;
    // 生成走哪条路（AI / 固定内容 / 混合）由 core/commands/getReply 按 reply.mode
    // 决定，界面不重复这个判断 —— 否则两处规则迟早会不一致。
    const id = await actions.enqueue({
      command: 'getReply',
      argv: [awemeId, selected.cid],
      label: `生成回复（${(selected.user && selected.user.nickname) || '该评论'}）`,
    });
    if (!id) return;
    genHandled.current = null;
    genCid.current = selected.cid;
    setGenTaskId(id);
    setGenInfo(null);
    setNotice(modeHint
      ? `已加入队列 —— ${modeHint}，完成后会自动填进编辑框`
      : '已加入队列 —— 完成后会自动填进编辑框');
  }

  /**
   * 批量生成。
   *
   * 走 getReply 的 --cids + --to-draft：**逐条**按 reply.mode 生成（AI / 固定内容 /
   * 随机循环都生效），每条结果单独存进草稿箱。发布不在这里做 ——
   * 生成的产物全部进草稿箱，由人逐条确认后发布（D7）。
   *
   * 之所以不在界面上循环入队 N 个单条任务：那样队列里会多出 N 条互不相干的任务，
   * 而且每条都要自己传 cid、自己认领结果，进度也只能看到"1 条正在跑"。
   * 一条任务内部逐条处理，界面上就是干净的一条进度。
   */
  async function bulkGenerate() {
    const cids = [...picked];
    if (!cids.length) return;
    const id = await actions.enqueue({
      command: 'getReply',
      argv: [awemeId, '--cids', cids.join(','), '--to-draft'],
      label: `批量生成 ${cids.length} 条回复`,
    });
    if (!id) return;
    bulkHandled.current = null;
    setBulkTaskId(id);
    setBulk(null);
    setNotice(`已加入队列 —— ${cids.length} 条逐条生成，完成后全部进草稿箱`);
  }

  /** 勾选/取消一条 */
  function togglePick(cid) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) { next.delete(cid); return next; }
      if (next.size >= MAX_PICK) {
        setNotice(`一次最多勾选 ${MAX_PICK} 条（逐条生成，再多会跑很久）。先取消几条再选。`);
        return prev;
      }
      next.add(cid);
      return next;
    });
  }

  /**
   * 全选本页。
   *
   * 只勾**工具建议回复的**（reply / emoji_reply），不勾"跳过"。
   * 全选把跳过的也捎上，等于让用户为一批本来判定为不值得回的评论买单 ——
   * 生成要花钱（AI 模式），还得逐条去草稿箱删。
   * 已回复的本来就不在可选范围内（策略会拦重复回复）。
   */
  function pickAllRecommended() {
    const wanted = comments.filter(c => !c.replied
      && c.decision && (c.decision.action === 'reply' || c.decision.action === 'emoji_reply'));
    const capped = wanted.slice(0, MAX_PICK);
    setPicked(new Set(capped.map(c => c.cid)));
    if (wanted.length > MAX_PICK) {
      setNotice(`本页有 ${wanted.length} 条建议回复，一次最多勾 ${MAX_PICK} 条，已勾前 ${MAX_PICK} 条。`);
    }
  }

  async function saveDraft() {
    // 存草稿要跑一次 IPC 写盘。改造前这里没有任何进行中态 ——
    // 点下去到提示出现之间，按钮、文案、界面全都不动，
    // 用户会以为没点上而重复点，于是存出两条一样的草稿。
    setSaving(true);
    let r;
    try {
      r = await window.dy.draft.save({
        awemeId,
        text: draftText,
        replyToCid: selected ? selected.cid : null,
        imagePath: (genInfo && genInfo.imagePath) || null,
      });
    } finally {
      setSaving(false);
    }
    setNotice(r.ok ? `已存入草稿箱（#${r.data.id}）` : `保存失败：${r.error}`);
    // 刷新侧栏的草稿角标 —— 不刷新的话"已存入草稿箱"的提示与角标数字对不上，
    // 用户会怀疑到底存没存进去
    if (r.ok && actions.refreshDrafts) actions.refreshDrafts();
  }

  const genRunning = !!genTaskId;

  /**
   * 正在跑的那个批量任务。
   *
   * 批量生成要逐条调 AI，几十条就是十几分钟。用户发起之后多半就停在这一页，
   * 所以进度必须**在这里**能看到，而不是只让他自己去队列页找。
   */
  const bulkTask = bulkTaskId
    ? ((queueState && queueState.tasks) || []).find((t) => t.id === bulkTaskId)
    : null;
  // 让用户点按钮之前就知道这次会不会真的调 AI（固定内容是秒回的）
  const modeHint = replyDesc && {
    ai: 'AI 生成较慢',
    fixed: '当前是固定内容模式，秒回',
    hybrid: `当前是混合模式（AI 占 ${Math.round(replyDesc.hybridRatio * 100)}%）`,
  }[replyDesc.mode];

  // 纯图回复没有文字，发布按钮不能按"有没有文字"来禁用
  const canPublish = !!(draftText.trim() || (genInfo && genInfo.imagePath));

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
          <button className="btn" onClick={reload} disabled={loading}>
            {loading && <Spinner size={12} />}刷新
          </button>
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
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
        />
        <select
          className="input tab-sort"
          value={order}
          onChange={e => setOrder(e.target.value)}
          title="排序方式"
        >
          {orders.map(o => <option key={o.name} value={o.name}>{o.label}</option>)}
        </select>
      </div>

      {/* 列表的规模如实说清楚：改造前把「取了 300 条」当总数显示，
          有更多数据时用户既看不到也不知道还有更多 */}
      <div className="ws-listmeta muted num">
        {/* 正在刷新但列表里还有旧数据时，用一个行内 spinner 说明"这是上一次的结果"。
            没有它的话，切标签页之后列表纹丝不动（旧数据），用户会以为筛选没生效。 */}
        {loading && comments.length > 0 && <Spinner size={11} label="正在读取" />}
        {listMeta && (
          <>
            共 {listMeta.total} 条 · 当前显示 {listMeta.shown} 条
            {listMeta.truncated && ' · 已截断，缩小筛选范围可看到其余'}
            {listMeta.scanCapped && ' · ⚠ 数据量超出统计上限，计数可能偏小'}
            {listMeta.unknownFilter && ` · ⚠ 未知筛选「${listMeta.unknownFilter}」，已按「全部」显示`}
          </>
        )}
        {comments.some(c => !c.replied && c.decision
          && (c.decision.action === 'reply' || c.decision.action === 'emoji_reply')) && (
          <button
            className="btn btn-quiet ws-pickall"
            onClick={pickAllRecommended}
            disabled={!!bulkTaskId}
            title={`勾选本页所有「建议回复」与「表情回复」的评论（最多 ${MAX_PICK} 条）`}
          >
            全选建议回复的
          </button>
        )}
      </div>

      {/* 批量操作条：没有勾选时不占地方 */}
      {picked.size > 0 && (
        <div className="ws-bulkbar">
          <span className="ws-bulkbar-main">
            已勾选 <b className="text-strong num">{picked.size}</b> 条
            {replyDesc && (
              <span className="muted">
                　·　生成方式：
                {replyDesc.mode === 'ai' ? 'AI 生成'
                  : replyDesc.mode === 'fixed' ? '固定内容'
                    : `混合（AI 占 ${Math.round(replyDesc.hybridRatio * 100)}%）`}
                。生成结果全部进草稿箱，发布仍由你逐条确认。
              </span>
            )}
          </span>
          <button className="btn btn-quiet" onClick={() => setPicked(new Set())} disabled={!!bulkTaskId}>
            清空
          </button>
          {/* 批量生成最长可以跑十几分钟（逐条调用 AI），跑起来必须能中止 ——
              改造前这里只有一颗灰掉的「生成中…」，用户唯一的选择是等。 */}
          {bulkTaskId && (
            <button className="btn" onClick={async () => {
              await actions.cancelTask(bulkTaskId);
              setNotice('已请求取消 —— 当前这一条会先跑完，不会开始下一条');
            }}>
              取消
            </button>
          )}
          <button className="btn btn-primary" onClick={bulkGenerate} disabled={!!bulkTaskId}>
            {bulkTaskId
              ? <><Spinner size={12} />生成中…</>
              : `批量生成 ${picked.size} 条`}
          </button>
        </div>
      )}

      {/* 批量生成的实时进度条。留在工作台不动也能看到跑到第几条了 */}
      {bulkTask && (bulkTask.progress || bulkTask.status === 'waiting') && (
        <div className="ws-bulkprogress">
          <ProgressBar
            current={bulkTask.progress && bulkTask.progress.current}
            total={bulkTask.progress && bulkTask.progress.total}
            label={bulkTask.status === 'waiting'
              ? (bulkTask.wait && bulkTask.wait.reason) || '等待中'
              : (bulkTask.progress && bulkTask.progress.text) || '生成中'}
            tone={bulkTask.status === 'waiting' ? 'wait' : 'neutral'}
          />
        </div>
      )}

      {/* 批量结果：生成多少、跳过多少、失败多少，以及失败的原因 */}
      {bulk && (
        <div className={`notice ${bulk.error || (bulk.failed && bulk.failed.length) ? 'notice-warn' : ''}`}>
          <div>
            {bulk.error
              ? `批量生成没做成：${bulk.error}`
              : (
                <>
                  <b>
                    批量生成完成：生成 {bulk.generated.length} 条
                    （存入草稿箱 {bulk.saved} 条）
                    {bulk.skipped.length > 0 && `、跳过 ${bulk.skipped.length} 条`}
                    {bulk.failed.length > 0 && `、失败 ${bulk.failed.length} 条`}
                  </b>
                  {bulk.saved > 0 && ' —— 到「草稿箱」里逐条确认后发布。'}
                  <div className="bulk-result">
                    {bulk.generated.map(g => (
                      <div className="bulk-result-row" key={g.cid}>
                        <b className="text-ok">{g.draftId ? '已存草稿' : '未存草稿'}</b>
                        <span>{g.text || '（无文字，纯图）'}</span>
                        {g.draftError && <span className="text-bad">{g.draftError}</span>}
                      </div>
                    ))}
                    {bulk.skipped.map(s => (
                      <div className="bulk-result-row" key={`s-${s.cid}`}>
                        <b className="muted">跳过</b><span>{s.reason}</span>
                      </div>
                    ))}
                    {bulk.failed.map(f => (
                      <div className="bulk-result-row" key={`f-${f.cid}`}>
                        <b className="text-bad">失败</b><span>{f.error}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
          </div>
        </div>
      )}

      <div className="ws-body">
        <div className="ws-list">
          {loading && comments.length === 0
            ? <div className="ws-list-pad"><Skeleton rows={6} /></div>
            : comments.length === 0
              ? (
                <div className="ws-list-pad">
                  <EmptyState
                    title={search
                      ? `没有匹配「${search}」的评论。`
                      : '这个筛选下没有评论。'}
                    hint={tab === 'pending' && !search
                      ? '如果从来没拉到过评论，点右上角「拉取新评论」。'
                      : (search ? '换个关键词，或者清空搜索框。' : '换个筛选标签看看。')}
                  />
                </div>
              )
            : comments.map(c => {
              // 已回复的不给勾：批量生成出来的草稿最终会走发布闸门，
              // 而闸门一定会以"已回复过"拦下它 —— 让用户勾一个注定发不出去的东西
              // 只是在制造"生成了一堆废草稿"。
              const selectable = !c.replied;
              return (
                <div className="cmt-row" key={c.cid}>
                  {selectable
                    ? (
                      <label className="cmt-pick" title="勾选后可以批量生成回复">
                        <input
                          type="checkbox"
                          checked={picked.has(c.cid)}
                          onChange={() => togglePick(c.cid)}
                        />
                      </label>
                    )
                    : <span className="cmt-pick" />}
                  <button
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
                    {/* 已回复的评论直接把"我当时回了什么"带在下面。
                        取不到就明说未记录 —— 留空白会被读成"从来没回过"，
                        而它明明带着"已回复"标签。 */}
                    {c.replied && (
                      <div className="cmt-reply">
                        {c.replyText || '（回复内容未记录）'}
                      </div>
                    )}
                  </button>
                </div>
              );
            })}
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
                  {genInfo && genInfo.imagePath && ` · 附 1 张图`}
                </div>

                {genInfo && (
                  <div className="reply-origin">
                    <span className={`tag ${genInfo.source === 'fixed' ? 'tag-dim' : 'tag-ok'}`}>
                      {genInfo.source === 'fixed' ? '固定内容' : 'AI 生成'}
                    </span>
                    {genInfo.degraded && (
                      <span className="reply-origin-note">
                        AI 失败，已降级为固定内容{genInfo.aiError ? `（${genInfo.aiError}）` : ''}
                      </span>
                    )}
                    {genInfo.imagePath && (
                      <span className="reply-origin-note">
                        附图：{fileNameOf(genInfo.imagePath)}
                      </span>
                    )}
                    {!genInfo.imagePath && genInfo.imageReason && (
                      <span className="reply-origin-note">{genInfo.imageReason}</span>
                    )}
                  </div>
                )}

                <div className="detail-actions">
                  <button className="btn" onClick={generate} disabled={genRunning || selected.replied}>
                    {genRunning ? '生成中…' : '生成回复'}
                  </button>
                  <button className="btn" onClick={saveDraft} disabled={!canPublish || saving}>
                    {saving && <Spinner size={12} />}{saving ? '保存中…' : '存草稿'}
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={!canPublish}
                    onClick={() => setPublishing({
                      awemeId,
                      cid: selected.cid,
                      text: draftText,
                      imagePath: (genInfo && genInfo.imagePath) || null,
                      videoTitle: video && video.title,
                      uid: selected.uid,
                      commentText: selected.text,
                      userName: selected.user && selected.user.nickname,
                    })}
                  >
                    发布
                  </button>
                </div>

                {selected.replied && (
                  <>
                    {/* 已回复的评论，最重要的是"我当时到底回了什么"。
                        改造前这里只有一句"已经回复过了"，用户得回评论区自己找。 */}
                    <div className="detail-reply">
                      <div className="detail-reply-label">
                        你回复的内容
                        {selected.replyAt ? ` · ${ago(selected.replyAt)}` : ''}
                      </div>
                      {selected.replyText
                        ? <div className="detail-reply-text">{selected.replyText}</div>
                        : (
                          <div className="detail-reply-text muted">
                            这条评论的回复内容没有记录在本地。
                            {'\n'}（早期版本发出的回复没有留下正文；从「已回复」状态能确认它已被回复过。）
                          </div>
                        )}
                    </div>
                    <div className="notice" style={{ marginTop: 10 }}>
                      策略会拦下对同一条评论的重复回复。
                    </div>
                  </>
                )}
              </>
            )}
        </div>
      </div>

      {publishing && (
        <PublishDialog
          target={publishing}
          onCancel={() => setPublishing(null)}
          onConfirm={async (opts) => {
            const t = publishing;
            setPublishing(null);
            const argv = [t.awemeId, t.text, '--reply-to', t.cid];
            if (t.imagePath) argv.push('--image', t.imagePath);
            // 勾了「跳过本次等待」就告诉队列这一次别等；策略拦截照旧生效
            const meta = { awemeId: t.awemeId, cid: t.cid, uid: t.uid, text: t.text };
            if (opts && opts.skipWait) meta.skipWait = true;
            const id = await actions.enqueue({ command: 'post', argv, label: '发布回复', meta });
            if (!id) {
              // 入队失败就把内容留着。改造前这里无条件清空，
              // 用户手写的一段回复会因为一次入队失败而彻底消失。
              setNotice('入队失败 —— 内容已保留在编辑框里，可以稍后重试');
              return;
            }
            // 发完顺便刷新，让"已回复"标记跟上；失败时把内容还回来（见本文件里的 pendingRefresh 处理）
            pendingRefresh.current = { id, kind: 'publish', text: t.text, cid: t.cid };
            setNotice('已加入队列 —— 队列页可以看到倒计时与执行结果');
            setDraftText('');
            setGenInfo(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * 从 getReply 的结果里取出"这条是怎么来的"。
 *
 * getReply 无论哪种来源都会带上 source，AI 降级时还会带 degraded/aiError，
 * 带图时带 imagePath。取不到就返回 null，界面按"未知来源"处理即可。
 */
function describeGenResult(result) {
  if (!result || typeof result !== 'object') return null;
  if (!result.source) return null;
  return {
    source: result.source,
    degraded: !!result.degraded,
    aiError: result.aiError || null,
    imagePath: result.imagePath || null,
    imageReason: result.imageReason || null,
  };
}

/**
 * 把批量生成的结果整理成界面好用的形状。
 *
 * getReply --cids --to-draft 返回 { requested, generated[], skipped[], failed[] }。
 * 结果可能因为过大而被队列丢弃（keepResult 有 64KB 上限）—— 那时拿不到明细，
 * 但草稿**已经存进去了**，所以不能说"失败"，要说"结果没能取回来，请看草稿箱"。
 */
function summarizeBulk(res) {
  if (!res || typeof res !== 'object') {
    return {
      error: '没取到批量结果明细（结果可能太大）。生成的草稿应该已经在草稿箱里，去那里确认。',
    };
  }
  const generated = Array.isArray(res.generated) ? res.generated : [];
  const skipped = Array.isArray(res.skipped) ? res.skipped : [];
  const failed = Array.isArray(res.failed) ? res.failed : [];
  return {
    requested: res.requested || 0,
    mode: res.mode || null,
    saved: generated.filter(g => g.draftId).length,
    generated,
    skipped,
    failed,
  };
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
