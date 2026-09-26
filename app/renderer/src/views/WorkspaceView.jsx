import React, { useCallback, useEffect, useRef, useState } from 'react';
import Modal from '../components/Modal.jsx';
import PublishDialog from '../components/PublishDialog.jsx';
import EmptyState from '../components/EmptyState.jsx';
import LoadingState from '../components/LoadingState.jsx';
import Spinner from '../components/Spinner.jsx';
import TaskActivity from '../components/TaskActivity.jsx';
import Notice from '../components/Notice.jsx';
import { ago, fileNameOf } from '../format.js';
import { failText } from '../errors.js';
import { replyReadiness, FIXED_EMPTY } from '../readiness.js';
import useAutoRefresh from '../useAutoRefresh.js';

/**
 * LLM 分析结果的展示用词（`analyze` 命令写回 comments.sentiment / .priority）。
 *
 * 与 DECISION 是**两套不同的东西**，不要混：
 *   DECISION   —— 本地决策树算的"该不该回"（建议回复 / 表情回复 / 跳过）
 *   SENTIMENT  —— LLM 读出来的情绪（正面 / 中性 / 负面）
 * 前者是我们怎么处理它，后者是这条评论本身什么调性。
 */
const SENTIMENT = {
  positive: { label: '正面', tone: 'ok' },
  neutral: { label: '中性', tone: 'dim' },
  negative: { label: '负面', tone: 'bad' },
};

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

/**
 * 工作台。
 *
 * `memo` / `onMemo`：这一页的浏览状态（标签 / 搜索 / 排序 / 勾选）存在 App 里、
 * 按 awemeId 分份。理由是这个组件会被整个卸载（去草稿箱、回列表页），
 * 全清的话运营者来回一趟就要重敲搜索词、重选排序、把评论一条条重新勾上。
 */
export default function WorkspaceView({ awemeId, queueState, actions, onBack, memo, onMemo }) {
  const [video, setVideo] = useState(null);
  const [stats, setStats] = useState(null);
  /**
   * 「这个视频的统计这一次没读回来」的理由（读成功时置 null）。
   *
   * 为什么不能只看 `stats === null`：那是个三态合一的值 —— 还在读、读失败、
   * 真没有统计，屏幕上都是同一句话「统计还在读」，而它是个会一直挂着不动的
   * 承诺。列表空态是这一页最常被看到的一块，见 ListEmpty。
   */
  const [statsError, setStatsError] = useState(null);
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
  const [tab, setTab] = useState(() => (memo && memo.tab) || 'pending');
  const [search, setSearch] = useState(() => (memo && memo.search) || '');
  /** 输入框的即时值；防抖后才写进 search 触发查询 */
  const [searchInput, setSearchInput] = useState(() => (memo && memo.searchInput) || '');
  const [order, setOrder] = useState(() => (memo && memo.order) || 'priority');
  const [orders, setOrders] = useState([]);
  /** 列表的元信息：截断前的真实条数、是否被截断 */
  const [listMeta, setListMeta] = useState(null);
  const [selectedCid, setSelectedCid] = useState(null);
  const [draftText, setDraftText] = useState('');
  const [genTaskId, setGenTaskId] = useState(null);
  const [publishing, setPublishing] = useState(null);
  /**
   * 待确认的删除。`{ cid, kind: 'reply' | 'comment', text }`
   *
   * 删除**不可撤销**，所以要二次确认；而确认框里必须写清"删的是什么、后果是什么"
   * —— 只说一句"确认删除？"等于没确认。
   */
  const [deleting, setDeleting] = useState(null);
  const [notice, setNotice] = useState(null);
  /** 生成结果的来源信息：来自 AI 还是固定内容、带了哪张图、是否降级 */
  const [genInfo, setGenInfo] = useState(null);
  /**
   * 查重结果，连同"查的是哪段文本"。
   *
   * 必须把被查的文本一起存下来：否则用户改了回复内容之后，屏幕上那条
   * "没发过，可以放心用"仍然挂着 —— 它说的是上一段文本，却看起来像在给
   * 当前这段背书。
   */
  const [dup, setDup] = useState(null);
  const [dupChecking, setDupChecking] = useState(false);
  /**
   * 这条视频在本工具里的点赞状态：null（不知道）/ 'liked' / 'unliked'。
   *
   * ⚠️ 只反映**本工具**干过什么。你在抖音 App 或网页里手动点的赞，本地
   * 没有任何记录 —— 所以 null 时按钮显示「点赞」而不是「已点赞」，
   * tooltip 里也把这件事说清楚，不让一个猜的状态冒充事实。
   */
  const [liked, setLiked] = useState(null);
  /** 当前的回复来源配置（模式 / 固定内容条数 / 图片开关），用于在按钮旁讲清楚会怎么生成 */
  const [replyDesc, setReplyDesc] = useState(null);
  /**
   * 这一次读回复来源 / 读排序选项**失败**的理由。
   *
   * 必须有这一个状态：两份读数都由 safe() 包着，失败长的是 `{ok:false}` 而不是异常，
   * 原来那句 `if (r && r.ok) setX(...)` 等于把失败扔掉 —— 屏幕上就只剩初值。
   * 初值不是中性的：`orders=[]` 让排序下拉变成空的，`replyDesc=null` 让三颗按钮
   * 按"能生成"画。所以失败必须说出来，见 readiness.js。
   */
  const [replyError, setReplyError] = useState(null);
  const [ordersError, setOrdersError] = useState(null);
  const [replyBusy, setReplyBusy] = useState(false);
  /**
   * 固定回复的复用间隔（「同一条至少隔几条才再用」）。
   *
   * reply:describe 不带这个数，而它恰好决定"勾了 30 条、列表只有 3 条"时
   * 后面那些取不取得到 —— 提示要说准，不能笼统写"会循环使用"。
   */
  const [fixedMinGap, setFixedMinGap] = useState(0);

  // ── 批量 ──
  /** 勾选的评论 cid（Set，用新对象替换触发重渲染） */
  const [picked, setPicked] = useState(() => new Set((memo && memo.picked) || []));
  /** 正在跑的批量生成任务 id */
  const [bulkTaskId, setBulkTaskId] = useState(null);
  /**
   * 这个批量任务走的是哪条来源：
   *   'setting' —— 按全局 reply.mode 生成（可能是 AI，可能要等十几分钟）
   *   'fixed'   —— 只这一批用固定回复列表（--mode 覆盖，不调 AI）
   * 结果面板要按它措辞，否则那句"批量生成完成"永远在说另一条链路的话。
   */
  const [bulkKind, setBulkKind] = useState('setting');
  /** 批量生成的结果摘要（生成/跳过/失败各多少条 + 明细） */
  const [bulk, setBulk] = useState(null);
  /** 「改用「固定内容」」那颗按钮的进行中状态（它会写配置，防连点） */
  const [switchingMode, setSwitchingMode] = useState(false);
  const bulkHandled = useRef(null);

  // ── 全量拉取 ──
  /** 正在跑的全量拉取任务 id */
  const [fullTaskId, setFullTaskId] = useState(null);
  /**
   * 正在跑的普通「拉取新评论」任务 id。
   *
   * 单独一个而不是复用上面那个：这两颗按钮的量级差几十倍，共用一个状态会让
   * 「拉取新评论」把页头那颗按钮的文案改成「全量拉取中…」。
   * 存在这里的理由与 fullTaskId 一样 —— **这一页要看得见自己发起的动作**。
   * 普通拉取也要等一次读间隔（30–50 秒），而此前本页只有一句会消失的 toast。
   */
  const [fetchTaskId, setFetchTaskId] = useState(null);
  /** 全量拉取的结果（本次拿到多少条 / 用时 / 失败原因） */
  const [full, setFull] = useState(null);
  const fullHandled = useRef(null);
  /** 发起全量拉取那一刻的本地条数，用来算"这次新增了多少" */
  const fullBefore = useRef(0);

  /**
   * 正在等待结果的队列任务。
   *
   * { id, kind: 'fetch' | 'publish' | 'analyze' | 'delete', text?, cid? } —— 带 kind 是有原因的：
   * 此前这里只存一个 id，于是**发布**失败时也报"拉取未完成"，
   * 而且用户手写的那段话已经因为"入队成功"被清空了，再也找不回来。
   * 现在按 kind 分别处理，发布的失败会把内容还给编辑框；
   * 删除连成功也要单独处理 —— 它得去读结果里的本地回退明细。
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
    } catch (e) {
      // ⚠️ 改造前这里只有 finally。Promise.all 一 reject，loading 复位而
      // stats 仍是 null，于是这一页停在「统计还在读」那句话上**永远不动** ——
      // 比说"没有数据"更糟，因为它承诺了一个不会再来的答案。
      // 单通道失败（{ok:false}）走不到这里，是 doReload 里分支处理的。
      setStatsError(failText(e && e.message, '本地数据没读回来'));
      setNotice(`读取本地数据失败：${failText(e && e.message, '未知错误')}`);
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
    setStatsError(s.ok ? null : failText(s.error, '这个视频的统计没读回来'));
    if (c.ok) {
      setComments(c.data.items || []);
      setListMeta(c.data);
      // 勾选以列表为准，看不见的一条都不留 —— 换筛选、切页回来（从 App 恢复）、
      // 以及别的任务改过本地数据，三种情况共用这一条规则。
      // 以前是 effect 里无脑清空，代价是"去草稿箱看一眼回来，20 条勾选全没了"。
      setPicked((prev) => {
        if (prev.size === 0) return prev;
        const visible = new Set((c.data.items || []).map(i => i.cid));
        const kept = [...prev].filter(cid => visible.has(cid));
        return kept.length === prev.size ? prev : new Set(kept);
      });
    } else {
      setNotice(`读取本地数据失败：${failText(c.error, '未知错误')}`);
      setComments([]);
      setListMeta(null);
      // 「勾选 ⊆ 当前列表」这条不变量两个分支都要守：列表都空了还留着
      // "已勾选 N 条"，那颗批量按钮就是在处理屏幕上不存在的评论
      setPicked(new Set());
    }
    if (!v.ok || !s.ok) setNotice(`读取失败：${failText(v.error || s.error, '未知错误')}`);
  }

  // 搜索防抖：改造前 search 一变就跑 reload()，而 reload 会取 5000 行跑判定树
  // 并逐 uid 查用户表 —— 敲一个字符就是上万次分类，输入框直接卡住。
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [awemeId, tab, search, order]);

  // 定时重读（间隔在设置页里配）。**这一页默认是关的** —— 有编辑区，
  // 自动重读会在用户正打字/正选评论时替换列表；要开由用户在设置页开。
  useAutoRefresh('workspace', () => reload());

  /**
   * 排序选项由 core 提供，界面不自己写一份 —— 但**读不到必须说出来**。
   * 原来这句 `if (r && r.ok) setOrders(r.data)` 失败时被整条丢掉，
   * `orders` 停在 `[]`，屏幕上那颗排序下拉变成一个空壳：
   * 「这个应用只有一种排序」与「排序没读回来」同形（§2.44 同一类）。
   */
  const reloadOrders = useCallback(() => window.dy.data.commentOrders()
    .then((r) => {
      if (r && r.ok) {
        setOrders(r.data || []);
        setOrdersError(null);
        return;
      }
      setOrdersError(failText(r && r.error, '主进程没有返回排序选项'));
    })
    .catch((e) => setOrdersError(failText(e && e.message, '排序选项没读回来'))), []);

  useEffect(() => { reloadOrders(); /* eslint-disable-next-line */ }, []);

  useEffect(() => { selectedCidRef.current = selectedCid; }, [selectedCid]);
  useEffect(() => { draftTextRef.current = draftText; }, [draftText]);

  // 换筛选 / 换排序之后，上一批明细里说的评论可能已经不在眼前这个列表里了 ——
  // 面板继续挂着就是给看不见的东西背书。勾选不在这里清，doReload 会与列表求交集。
  useEffect(() => { setBulk(null); }, [tab, search, order]);

  // 浏览状态交回 App（按 awemeId 存）。onMemo 每次渲染都是新函数，所以不进依赖：
  // 它只是把当前值写进 App 里的一张表，晚一帧没有影响。
  useEffect(() => {
    if (onMemo) onMemo({ tab, search, searchInput, order, picked: [...picked] });
  }, [tab, search, searchInput, order, picked]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 回复来源配置随设置页改动而变，进工作台时取一次就够（切视频会重新挂载）。
   *
   * 失败要留在 `replyError` 里，而不是把 `replyDesc` 清空：
   * 第一次就失败 → readiness 走 `unreadable`（按钮拦下来）；
   * 读回来过、这次重读失败 → 走 `stale`（上面的说法仍按上一次的结果，但要标出来）。
   */
  const reloadReply = useCallback(() => {
    setReplyBusy(true);
    return window.dy.reply.describe()
      .then((r) => {
        if (r && r.ok) {
          setReplyDesc(r.data);
          setReplyError(null);
          return true;
        }
        setReplyError(failText(r && r.error, '主进程没有返回回复来源'));
        return false;
      })
      .catch((e) => {
        setReplyError(failText(e && e.message, '回复来源没读回来'));
        return false;
      })
      .finally(() => setReplyBusy(false));
  }, []);

  useEffect(() => {
    reloadReply();
    window.dy.config.describe().then((r) => {
      const gap = r && r.ok && r.data.config && r.data.config.reply
        && r.data.config.reply.fixed && r.data.config.reply.fixed.minGapBetweenReuse;
      if (Number.isInteger(gap) && gap > 0) setFixedMinGap(gap);
    });
  }, [awemeId]); // eslint-disable-line react-hooks/exhaustive-deps

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
          if (p.kind === 'delete') {
            // 删除的"成功"有两半：抖音那边没了 + 本地账目跟着回退。
            // 回退可能只做了一半（移除那行成功、把父评论放回未回复失败），
            // 而 core 早就把 localRemoved/localUnmarked/localError 返回了 ——
            // 之前界面只看任务状态，一律报"已删除"，用户于是对着一条
            // 抖音上根本不存在、本地仍显示「已回复」的评论纳闷。
            window.dy.queue.result(t.id)
              .then((r) => setNotice(describeDelete(r && r.result)))
              // queue:result 是**没包 safe()** 的通道之一，它坏掉是一个 reject。
              // 只有 .then() 的话这次删除在界面上一个字都不变 —— 连"明细没取回来"都没有
              .catch((e) => setNotice(describeDelete(null, failText(e && e.message, '未知原因'))));
          }
          reload();
        } else if (p.kind === 'publish') {
          // 发布没成（失败/被策略拦下/取消），把内容还给编辑框 ——
          // 用户手写的一段回复不该因为一次队列失败就消失。
          // 只在编辑框是空的时候放回，免得覆盖用户后来输入的内容。
          if (p.text && !draftTextRef.current.trim()) setDraftText(p.text);
          setNotice(`发布未完成：${failText(t.error, '未知原因')} —— 内容已放回编辑框`);
        } else if (p.kind === 'analyze') {
          setNotice(`分析未完成：${failText(t.error, '未知原因')}`);
        } else if (p.kind === 'delete') {
          // 删除失败最常见的原因是策略闸门（写间隔没到、当日额度用完、或账号不一致），
          // 这些理由本身就写在 t.error 里、已经是人话 —— failText 认不出来的串原样过。
          // 走它是因为剩下的那一类（桥接没连上、超时）是英文工程串，不该直接端上屏。
          setNotice(`删除未完成：${failText(t.error, '未知原因')}`);
        } else {
          setNotice(failText(t.error, '拉取未完成'));
        }
      }
    }

    // 普通拉取跑完撤掉本页那一行实时状态。**只负责让行消失** ——
    // 刷新列表是上面那段的事，两件事混在一起会导致"行还在但数据是新的"。
    if (fetchTaskId) {
      const t = tasks.find(x => x.id === fetchTaskId);
      if (t && ['done', 'failed', 'blocked', 'cancelled'].includes(t.status)) setFetchTaskId(null);
    }

    // 全量拉取：跑完说清楚"这次拿到多少条"。
    //
    // 条数取 `resultSummary.count`（task-queue.js 一直在维护、任务结束后仍然保留），
    // **不取 queue.result()** —— 队列有 MAX_RESULT_BYTES=64KB 上限，几千条评论的返回值
    // 会被整个丢掉，那时取结果只会拿到 null，界面就会把一次成功的拉取报成失败。
    if (fullTaskId && fullHandled.current !== fullTaskId) {
      const t = tasks.find(x => x.id === fullTaskId);
      if (t && ['done', 'failed', 'blocked', 'cancelled'].includes(t.status)) {
        fullHandled.current = fullTaskId;
        setFullTaskId(null);
        if (t.status === 'done') {
          setFull({
            count: (t.resultSummary && t.resultSummary.count) || 0,
            ms: (t.endedAt || 0) - (t.startedAt || 0),
          });
          // 拉到的新评论要出现在列表里 —— 本地库才是这一页的数据源
          reload();
        } else {
          setFull({ error: failText(t.error, '全量拉取未完成') });
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
          }).catch((e) => {
            // 取结果被拒时批量那一屏必须有个收尾：不写这一支的话 setBulk 永远不执行，
            // 而草稿其实**已经存进去了** —— 屏幕停在"进行中"，用户以为要再点一次
            setBulk({
              error: `批量生成跑完了，但结果明细没取回来（${failText(e && e.message, '未知原因')}）`
                + ' —— 生成的草稿应该已经在草稿箱里，去那里确认，不要重复点这一颗。',
            });
            if (actions.refreshDrafts) actions.refreshDrafts();
          });
        } else {
          setBulk({ error: failText(t.error, '批量生成失败') });
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
          }).catch((e) => setNotice(
            `生成跑完了，但结果没取回来（${failText(e && e.message, '未知原因')}）`
            + ' —— 编辑框里是空的，这一次已经调用过一趟 AI。要再用一次得重新生成。'
          ));
        } else {
          setNotice(failText(t.error, '生成失败'));
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
    setFetchTaskId(id);
    setNotice('已加入队列 —— 拉取完成后列表会自动刷新');
  }

  /**
   * 全量拉取：把这个作品的评论从头翻到尾。
   *
   * 和上面「拉取新评论」的区别是**量级**，不是口味：
   *   - 「拉取新评论」= 一页（最多 20 条），拿的是最新那批，秒回
   *   - 「全量拉取」  = 翻到服务端说没有为止。评论多的作品要翻几十上百页，
   *     页与页之间按 intervals.commentPage 等 1-3 秒，跑几分钟很正常，
   *     而且**期间的串行队列被它占着**（别的命令要排队）
   *
   * `--depth 0`：不展开嵌套回复。几千条主评论每条再拉一次 replies 是上千次请求，
   * 和"拉主评论"不是一个量级。需要回复时在命令行用 `get <id> --all --depth 1`。
   */
  async function fullPull() {
    const id = await actions.enqueue({
      command: 'get',
      argv: [awemeId, '--all', '--depth', '0'],
      label: '全量拉取评论',
    });
    if (!id) return;
    fullHandled.current = null;
    fullBefore.current = (stats && stats.total) || 0;
    setFullTaskId(id);
    setFull(null);
    setNotice('已加入队列 —— 全量拉取会逐页慢慢拉，期间队列被它占着');
  }

  /**
   * 查重：这句以前发过没有。
   *
   * 走 data 视图（纯本地读）而不是 `dedup` 命令 —— 那要占串行队列、等读间隔，
   * 而这是一个想立刻知道答案的小动作。
   */
  async function checkDuplicate() {
    const text = draftText.trim();
    if (!text) return;
    setDupChecking(true);
    try {
      const r = await window.dy.data.checkDup(text);
      if (r && r.ok) setDup({ ...r.data, forText: text });
      else setDup({ error: failText(r && r.error, '查重失败'), forText: text });
    } finally {
      setDupChecking(false);
    }
  }

  /** 点赞 / 取消点赞这条视频（写操作，走队列与策略闸门） */
  async function toggleLike() {
    const unlike = liked === 'liked';
    const id = await actions.enqueue({
      command: 'like',
      argv: unlike ? [awemeId, '--unlike'] : [awemeId],
      label: unlike ? '取消点赞' : '点赞视频',
    });
    if (!id) return;
    setNotice(unlike
      ? '已加入队列 —— 取消点赞同样是写操作，要等写间隔'
      : '已加入队列 —— 点赞是写操作，要等写间隔');
    const un = window.dy.queue.onChanged((payload) => {
      const t = (payload.tasks || []).find(x => x.id === id);
      if (t && ['done', 'failed', 'blocked', 'cancelled'].includes(t.status)) {
        un();
        if (t.status === 'done') setLiked(unlike ? 'unliked' : 'liked');
        else setNotice(`${unlike ? '取消点赞' : '点赞'}未完成：${failText(t.error, '未知原因')}`);
      }
    });
  }

  /**
   * 用 AI 分析这个视频下的评论（情感 / 优先级，写回本地库）。
   *
   * 与工作台已有的判定树是两回事：判定树决定"该不该回"，analyze 给的是
   * 评论本身的情绪与优先级。跑完之后「优先级」排序才真的按优先级排
   * （此前只有 54/1912 条有值，那个排序实际上一直在按点赞排）。
   */
  async function analyzeComments() {
    const id = await actions.enqueue({
      command: 'analyze',
      argv: [awemeId],
      label: '用 AI 分析评论',
    });
    if (!id) return;
    pendingRefresh.current = { id, kind: 'analyze' };
    setNotice('已加入队列 —— 逐条调用 AI，跑完列表会自动刷新（并按优先级重排）');
  }

  /**
   * 删除一条评论（我们发出的回复，或我们自己发的顶级评论）。
   *
   * 删除是**写操作**：走队列、受写间隔与策略闸门约束，不是点一下就发出去。
   * 命令内部还会做本地账目回退（移除那行、把父评论放回未回复），
   * 完成后这里重新读一次列表，界面上的「已回复」与待回复数才会跟着回退。
   */
  async function deleteComment(target) {
    const id = await actions.enqueue({
      command: 'delete-comment',
      argv: [target.cid],
      label: target.kind === 'reply' ? '删除我的回复' : '删除我的评论',
    });
    if (!id) return;
    pendingRefresh.current = { id, kind: 'delete' };
    setNotice('已加入队列 —— 删除完成后列表会自动刷新（发布类操作要等写间隔）');
  }

  /**
   * 批量生成期间发布不排队：front 让发布任务插到所有待执行任务之前。
   * 风控上没有额外代价（生成不发写请求，写间隔闸门在执行时照常生效），
   * 而批量生成几十条要跑十几分钟，让一条手写的回复排在它后面是不合理的。
   */
  async function publishNow(target) {
    const argv = [target.awemeId, target.text, '--reply-to', target.cid];
    if (target.imagePath) argv.push('--image', target.imagePath);
    // 勾了「跳过本次等待」就告诉队列这一次别等；策略拦截照旧生效
    const meta = { awemeId: target.awemeId, cid: target.cid, uid: target.uid, text: target.text };
    if (target.skipWait) meta.skipWait = true;
    return actions.enqueue({ command: 'post', argv, label: '发布回复', meta, front: true });
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
   * 批量把选中的评论做成草稿。两种来源共用这一条链路：
   *
   *   startBulk('setting')  按全局 reply.mode 生成（AI / 固定 / 混合都生效）
   *   startBulk('fixed')    **只这一批**用固定回复列表 —— 用 getReply 的 `--mode fixed`
   *                         覆盖，不改全局设置。用户平时要 AI 逐条写、此刻只想给
   *                         一堆评论统一回一句准备好的话，这是常态而不是例外。
   *
   * 都走 getReply 的 --cids + --to-draft：每条结果单独存进草稿箱，
   * 发布不在这里做 —— 生成的产物全部进草稿箱，由人逐条确认后发布（D7）。
   *
   * 之所以不在界面上循环入队 N 个单条任务：那样队列里会多出 N 条互不相干的任务，
   * 而且每条都要自己传 cid、自己认领结果，进度也只能看到"1 条正在跑"。
   * 一条任务内部逐条处理，界面上就是干净的一条进度。
   *
   * @param {'setting'|'fixed'} kind
   */
  async function startBulk(kind) {
    const cids = [...picked];
    if (!cids.length || bulkTaskId) return;
    const argv = [awemeId, '--cids', cids.join(','), '--to-draft'];
    if (kind === 'fixed') argv.push('--mode', 'fixed');
    const id = await actions.enqueue({
      command: 'getReply',
      argv,
      label: `${kind === 'fixed' ? '固定回复存草稿' : '批量生成'} ${cids.length} 条回复`,
    });
    if (!id) return;
    bulkHandled.current = null;
    setBulkKind(kind);
    setBulkTaskId(id);
    setBulk(null);
    setNotice(kind === 'fixed'
      ? `已加入队列 —— ${cids.length} 条各取一条固定回复存进草稿箱（不调 AI，只用当前这个按钮这一次）`
      : `已加入队列 —— ${cids.length} 条逐条生成，完成后全部进草稿箱`);
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
    setNotice(r.ok ? `已存入草稿箱（#${r.data.id}）` : `保存失败：${failText(r.error, '未知原因')}`);
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

  /** 正在跑的全量拉取。理由同上：翻页要几分钟，进度得留在这一页看得见。 */
  const fullTask = fullTaskId
    ? ((queueState && queueState.tasks) || []).find((t) => t.id === fullTaskId)
    : null;

  /**
   * 正在跑的普通「拉取新评论」。
   *
   * 空态里那句"进度在上方那一行看得见"必须有东西承接它 —— 普通拉取过去只发一条
   * toast，读间隔要等几十秒时页面上没有任何东西在动，那句话就是假话。
   */
  const fetchTask = fetchTaskId
    ? ((queueState && queueState.tasks) || []).find((t) => t.id === fetchTaskId)
    : null;

  // 纯图回复没有文字，发布按钮不能按"有没有文字"来禁用
  const canPublish = !!(draftText.trim() || (genInfo && genInfo.imagePath));

  /**
   * 「现在点这颗按钮有没有结果」的唯一判据（在 readiness.js 里）。
   *
   * 以前这里是六个各自写一遍的常量，共同的一句假设是"replyDesc 还没回来时先当作可用"
   * —— 那句话只在**还在读**时成立。读失败时 `replyDesc` 同样停在 null，
   * 于是屏幕上「读不到」与「一切正常」是同一个形状，用户按下「批量生成」，
   * 等一轮间隔才换回 core 的一句报错，而第十七轮加的那颗出口按钮此时根本画不出来
   * （它按 `genBlock !== FIXED_EMPTY && fixedUsable > 0` 判断，而 fixedUsable 也是猜的）。
   */
  const ready = replyReadiness(replyDesc, replyError);
  const { modeHint, fixedUsable, fixedReady, fixedDisabled, fixedHint, aiOk, aiReason, genBlock } = ready;

  /**
   * 只把「回复模式」改成「固定内容」。
   *
   * 补丁里只有这一项，别的配置一律不动 —— 用户点的是一颗具体的出口，
   * 不是一次"保存设置"。改完必须重新读 reply.describe()，否则界面上那三颗
   * 按钮还按旧的模式灰着，看起来像没生效。
   */
  async function useFixedMode() {
    setSwitchingMode(true);
    try {
      const r = await window.dy.config.set({ reply: { mode: 'fixed' } });
      if (!r || !r.ok) {
        setNotice(`没能改成「固定内容」：${failText(r && r.error, '未知原因')}`);
        return;
      }
      const confirmed = await reloadReply();
      setNotice(confirmed
        ? '已改用「固定内容」生成 —— 不再需要 AI。想换回来在设置页的「回复策略」里。'
        : '「回复模式」已经写进配置了，但界面没能重新读回来确认 —— '
          + '所以下面那几颗按钮还按上一次读到的结果画。点旁边的「重新读取」补一次就准了。');
    } catch (e) {
      // 上面那句 `!r || !r.ok` 才是这个通道的主要失败形状（handler 自己带 try/catch）。
      // 这一支接的是 IPC 外壳层面的 reject：结果序列化不了、通道没注册上。
      // 不接住的话这一颗按钮按下去毫无回应 —— 用户只会再点一次，
      // 而这一次和上一次一样没写进配置
      setNotice(`没能改成「固定内容」：${failText(e && e.message, '未知原因')}`
        + ' —— 「回复模式」没有被写进去，下面那几颗按钮仍按上一次读到的结果画。');
    } finally {
      setSwitchingMode(false);
    }
  }

  return (
    <div className="workspace">
      <div className="ws-head">
        <button className="btn btn-quiet" onClick={onBack}>‹ 返回</button>
        <div className="ws-title">
          <div className="ws-title-main">{video ? (video.title || '（无标题）') : '…'}</div>
          {stats && (
            <div className="ws-title-sub">
              <span className="ws-statgroup">
                待处理 <b className="text-strong num">{stats.pending}</b>
                {' · '}已回 <span className="num">{stats.replied}</span>
                {' · '}我发的 <span className="num">{stats.mine}</span>
                {' · '}本地 <span className="num">{stats.total}</span>
              </span>
              <span className="ws-statgroup">
                工具判定：建议回复 <span className="num">{stats.byDecision.reply}</span>
                {' · '}表情 <span className="num">{stats.byDecision.emoji_reply}</span>
                {' · '}跳过 <span className="num">{stats.byDecision.skip}</span>
              </span>
              {/* 两组数确实对不上，因为它们数的是不同的事。不说这一句，
                  运营者只会怀疑数据错了 —— 而"我发的"与"已回"互斥这件事，
                  只有跟"待处理怎么算"一起讲才读得出来。 */}
              <span className="muted">
                待处理 = 本地 − 已回 − 我发的；「工具判定」是逐条判该不该回，
                已回和我发的也算在内，所以跟上面那组不是同一口径。
                {search && '当前有搜索词，下面列表里的条数与这些数字无关。'}
              </span>
            </div>
          )}
        </div>
        <div className="ws-actions">
          <button className="btn" onClick={reload} disabled={loading}>
            {loading && <Spinner size={12} />}刷新
          </button>
          <button className="btn btn-primary" onClick={fetchComments}
            disabled={!actions.canQueue || !!fetchTaskId}
            title={!actions.canQueue
              ? '浏览器未连接 —— 先到「连接」页接上抖音'
              : '从抖音拉取这条视频的最新评论'}>
            {fetchTaskId ? <><Spinner size={12} />拉取中…</> : '拉取新评论'}
          </button>
          {/* 全量拉取和「拉取新评论」是两条量级完全不同的路径，所以按钮并列而不是合并成
              一个带下拉的入口 —— 点错一次的代价是几分钟的队列占用 */}
          <button className="btn" onClick={fullPull} disabled={!actions.canQueue || !!fullTaskId}
            title={!actions.canQueue
              ? '浏览器未连接 —— 先到「连接」页接上抖音'
              : '把这个作品的评论从头翻到尾。评论多的作品要翻几十上百页、跑几分钟，期间队列被它占着'}>
            {fullTaskId ? <><Spinner size={12} />全量拉取中…</> : '全量拉取'}
          </button>
          {/* AI 分析：读评论 + 逐条调 LLM，跑得比较久（见数据页的"单次生成平均耗时"）。
              跑完把 sentiment/priority 写回本地，列表按优先级重排 */}
          <button
            className="btn"
            onClick={toggleLike}
            disabled={!actions.canQueue}
            title={!actions.canQueue
              ? '浏览器未连接 —— 先到「连接」页接上抖音'
              : '本工具里记的状态：在抖音 App 或网页里手动点的赞，这里看不到'}
          >
            {liked === 'liked' ? '♥ 已点赞' : '♡ 点赞'}
          </button>
          <button className="btn" onClick={analyzeComments} disabled={!actions.canQueue || !aiOk}
            title={!actions.canQueue
              ? '浏览器未连接 —— 先到「连接」页接上抖音'
              : !aiOk ? aiReason
                : '用 AI 逐条分析本视频的评论（情绪 / 优先级），跑完列表会按优先级重排。要调用 AI，会花时间与 token'}>
            用 AI 分析
          </button>
        </div>
      </div>

      <Notice data={notice} style={{ margin: '0 0 12px' }} />

      {/* 普通拉取也要有这一行：读间隔几十秒时，页面上得有个东西在动，
          否则「进度在上方看得见」那句话（空态里写的）就是假话。 */}
      {fetchTask && (
        <TaskActivity
          task={fetchTask}
          note="只拉最新一页（最多 20 条）。等的是读间隔，不是卡住了。"
          onCancel={async (id) => {
            await actions.cancelTask(id);
            setNotice('已请求取消 —— 已经发出去的那一个请求打不断');
          }}
          cancelNote="取消在下一个等待边界生效：已经在浏览器里跑的那一个请求打不断，它回来后队列会直接丢掉这次的结果。"
        />
      )}

      {/* 全量拉取：进度、等待、取消都留在这一页。
          翻页要几分钟，用户多半就停在这里看着；只把进度丢进队列页等于逼他去别处找。 */}
      {fullTask && (
        <TaskActivity
          task={fullTask}
          note="这一条不标百分比：服务端报的总数与真能拉到的条数对不上"
          onCancel={async (id) => {
            await actions.cancelTask(id);
            setNotice('已请求取消 —— 当前这一页会先收完');
          }}
          cancelNote="取消在下一个等待边界生效：已经发出去的那一页会先收完，不会开始下一页。"
        />
      )}

      {full && (
        <div className={`notice ${full.error ? 'notice-warn' : ''}`} style={{ margin: '0 0 12px' }}>
          <div>
            {full.error
              ? `全量拉取没做成：${full.error}`
              : (
                <>
                  <b>全量拉取完成：本次拿到 {full.count} 条</b>
                  {stats && (
                    <>
                      ，本地 {stats.total} 条
                      {stats.total > fullBefore.current
                        && `（新增 ${stats.total - fullBefore.current} 条）`}
                    </>
                  )}
                  {full.ms > 0 && `，用时 ${Math.round(full.ms / 1000)} 秒`}
                  <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                    翻页期间服务端会重复给同一批评论，已按 cid 去重，所以这个数会比抖音上显示的评论数少。
                  </div>
                </>
              )}
          </div>
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
        {orders.length === 0 && ordersError ? (
          // 读失败时不画那颗没有选项的下拉：一个空壳下拉在屏幕上等于
          // "这个应用只有一种排序"，而真相是"排序选项没读回来"
          <span className="ws-ordersfail">
            排序方式没读回来 —— 列表仍按现在的排序排（默认「最多点赞 + 最新」）。
            <button className="btn btn-quiet" onClick={reloadOrders}>重新读取</button>
          </span>
        ) : (
          <select
            className="input tab-sort"
            value={order}
            onChange={e => setOrder(e.target.value)}
            disabled={orders.length === 0}
            title={order === 'priority' && listMeta && !listMeta.priorityReady
              ? '排序方式 —— 「优先级」要用 AI 分析写回的那一列，而这个视频的评论还没分析过：现在它等同「点赞最多 + 最新」'
              : '排序方式'}
          >
            {orders.length === 0 && <option value={order} disabled>排序读取中…</option>}
            {orders.map(o => <option key={o.name} value={o.name}>{o.label}</option>)}
          </select>
        )}
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
            {/* 排序说"优先级"而那一列全是 NULL，是一件会说谎的事：
                列表看起来真的按某种顺序排着，没人会怀疑。悬停提示没人找，所以这句必须可见。 */}
            {order === 'priority' && listMeta.priorityReady === false && comments.length > 0 && (
              <span className="text-bad">
                · 「优先级」现在没有数据（这些评论还没跑过 AI 分析），实际是按点赞与时间排的
                —— 用页头的「用 AI 分析」补上
              </span>
            )}
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
            已勾选 <b className="text-strong num">{picked.size}</b>
            {/* 上限要在动手前就看得见。以前只有勾到第 51 条才会蹦出一句话，
                而那之前用户以为自己是随便勾的 */}
            <span className="muted num"> / {MAX_PICK}</span> 条
            {picked.size >= MAX_PICK && <span className="text-bad">（已到一次能生成的上限，先取消几条或分两批）</span>}
            {ready.state === 'unreadable' ? (
              // 这一段必须存在：readiness 把「批量生成」拦下来了，
              // 而拦下一颗按钮却不说话，对不懂技术的人等于"这个应用坏了"
              <span className="muted">
                　·　回复来源没读回来，所以现在不知道「批量生成」会按什么走 ——
                这一颗先拦下来，免得等一轮间隔才换回一句报错。
                「用固定回复存草稿」不调 AI、仍然可以点，但固定列表里这次有没有可用条目同样没读到。
                <b className="text-bad">　原因：{replyError}。</b>
                <button className="btn btn-quiet drafts-pickall" onClick={reloadReply} disabled={replyBusy}>
                  {replyBusy ? '读取中…' : '重新读取'}
                </button>
              </span>
            ) : replyDesc && (
              <span className="muted">
                　·　「批量生成」按当前设置走（
                {replyDesc.mode === 'ai' ? 'AI 生成'
                  : replyDesc.mode === 'fixed' ? '固定内容'
                    : `混合，AI 占 ${Math.round(replyDesc.hybridRatio * 100)}%`}
                ）；「用固定回复存草稿」只这一批用固定列表
                {fixedUsable > 0 && `（${fixedUsable} 条可用${fixedMinGap > 0 ? `，同一条至少隔 ${fixedMinGap} 条才再用` : ''}）`}
                。两者都只进草稿箱，发布由你在草稿箱里确认。
                {!fixedReady && (
                  <b className="text-bad">　{FIXED_EMPTY}。</b>
                )}
                {/* 拦下生成这件事必须写在明面上：灰掉的按钮配一句悬停提示，
                    对不懂技术的人等于没有 —— 他不会去悬停一颗他不敢点的按钮 */}
                {!aiOk && replyDesc.mode !== 'fixed' && (
                  <b className="text-bad">　{aiReason}。</b>
                )}
                {/* 读回来过、这次重读失败：上面的说法仍按上一次那份结果，必须标出来 */}
                {ready.state === 'stale' && (
                  <b className="text-bad">
                    　这一次没能重新读回来（{replyError}），上面是按上一次读到的结果说的。
                  </b>
                )}
                {genBlock && (
                  <button className="btn btn-quiet drafts-pickall" onClick={() => actions.goto('settings')}>
                    去「设置」
                  </button>
                )}
                {ready.state === 'stale' && (
                  <button className="btn btn-quiet drafts-pickall" onClick={reloadReply} disabled={replyBusy}>
                    {replyBusy ? '读取中…' : '重新读取'}
                  </button>
                )}
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
          <button className="btn" onClick={() => startBulk('fixed')}
            disabled={!!bulkTaskId || fixedDisabled} title={fixedHint}>
            用固定回复存草稿
          </button>
          <button className="btn btn-primary" onClick={() => startBulk('setting')}
            disabled={!!bulkTaskId || !!genBlock}
            title={genBlock || '按当前「回复模式」逐条生成，结果进草稿箱，发布由你确认'}>
            {bulkTaskId
              ? <><Spinner size={12} />生成中…</>
              : `批量生成 ${picked.size} 条`}
          </button>
        </div>
      )}

      {/* 批量生成的实时进度。留在工作台不动也能看到跑到第几条、还要等多久
          （取消按钮在上方批量条上，这里不重复给一颗） */}
      {bulkTask && <TaskActivity task={bulkTask} />}

      {/* 批量结果：生成多少、跳过多少、失败多少，以及失败的原因 */}
      {bulk && (
        <div className={`notice ${bulk.error || (bulk.failed && bulk.failed.length) ? 'notice-warn' : ''}`}>
          <div>
            {bulk.error
              ? `${bulkKind === 'fixed' ? '固定回复没能存进草稿箱' : '批量生成没做成'}：${bulk.error}`
              : (
                <>
                  <b>
                    {bulkKind === 'fixed' ? '固定回复已批量存好' : '批量生成完成'}：生成 {bulk.generated.length} 条
                    （存入草稿箱 {bulk.saved} 条）
                    {bulk.skipped.length > 0 && `、跳过 ${bulk.skipped.length} 条`}
                    {bulk.failed.length > 0 && `、失败 ${bulk.failed.length} 条`}
                  </b>
                  {bulk.saved > 0 && (
                    <>
                      —— 可以勾选多条一次发完。
                      {/* 光说"到草稿箱里确认"等于没说：用户还得自己想起侧栏里有这么一页，
                          进去再凭正文认出刚生成的那几条。所以现在把 draftId 一并带过去。 */}
                      <button
                        className="btn btn-quiet drafts-pickall"
                        onClick={() => actions.gotoDrafts(
                          bulk.generated.filter(g => g.draftId).map(g => g.draftId))}
                      >
                        去「草稿箱」并勾上这 {bulk.saved} 条
                      </button>
                    </>
                  )}
                  <div className="bulk-result">
                    {bulk.generated.map(g => (
                      <div className="bulk-result-row" key={g.cid}>
                        <b className="text-ok">{g.draftId ? '已存草稿' : '未存草稿'}</b>
                        <span>{g.text || '（无文字，纯图）'}</span>
                        {g.draftError && <span className="text-bad">{failText(g.draftError, '存草稿失败')}</span>}
                      </div>
                    ))}
                    {bulk.skipped.map(s => (
                      <div className="bulk-result-row" key={`s-${s.cid}`}>
                        <b className="muted">跳过</b><span>{s.reason}</span>
                      </div>
                    ))}
                    {bulk.failed.map(f => (
                      <div className="bulk-result-row" key={`f-${f.cid}`}>
                        <b className="text-bad">失败</b><span>{failText(f.error, '未知原因')}</span>
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
            ? <div className="ws-list-pad"><LoadingState rows={6} /></div>
            : comments.length === 0
              ? (
                <div className="ws-list-pad">
                  <ListEmpty
                    stats={stats}
                    statsError={statsError}
                    tab={tab}
                    search={search}
                    canQueue={actions.canQueue}
                    onRetry={() => reload()}
                    onClearSearch={() => { setSearchInput(''); setSearch(''); }}
                    onTab={(key) => { setTab(key); setSelectedCid(null); }}
                    onFetch={fetchComments}
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
                      {/* LLM 分析结果（analyze 写回）。没分析过就不显示 ——
                          摆一个"未分析"的标签只是噪音 */}
                      {c.sentiment && SENTIMENT[c.sentiment] && (
                        <span className={`tag tag-${SENTIMENT[c.sentiment].tone}`}>
                          {SENTIMENT[c.sentiment].label}
                        </span>
                      )}
                      {c.priority > 0 && <span className="cmt-prio num" title="AI 给的优先级（1–5）">P{c.priority}</span>}
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
                    {/* 点作者名看他的全部留痕 —— 决定"值不值得认真回"的关键是
                        "这个人以前来过没有、我们回过他几次" */}
                    <button
                      className="linklike"
                      onClick={() => selected.uid && actions.openUser(selected.uid)}
                      title={selected.uid ? '看这个人的全部评论与互动记录' : undefined}
                    >
                      {(selected.user && selected.user.nickname) || '匿名'}
                    </button>
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

                {(selected.sentiment || selected.priority > 0) && (
                  <div className="detail-decision">
                    AI 分析：
                    {selected.sentiment && SENTIMENT[selected.sentiment] && (
                      <b> {SENTIMENT[selected.sentiment].label}</b>
                    )}
                    {selected.priority > 0 && <span className="muted"> · 优先级 {selected.priority}/5</span>}
                  </div>
                )}

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
                  <button
                    className="btn btn-quiet reply-dupcheck"
                    onClick={checkDuplicate}
                    disabled={!draftText.trim() || dupChecking}
                    title="查一下这句以前是不是发过（纯本地查语料库，不联网）"
                  >
                    {dupChecking ? '查重中…' : '查重'}
                  </button>
                </div>

                {/* 查重结果。只在"查的还是当前这段文本"时显示 —— 否则用户改了内容，
                    屏幕上那句"没发过"仍然挂着，看起来像在给新内容背书 */}
                {dup && dup.forText === draftText.trim() && (
                  <div className={`notice ${dup.duplicate ? 'notice-warn' : ''} reply-dupresult`}>
                    <div>
                      {dup.error
                        ? dup.error
                        : dup.duplicate
                          ? (
                            <>
                              <b>这句以前发过</b>
                              {dup.match.postedAt ? ` · ${ago(dup.match.postedAt)}` : ''}
                              {dup.match.awemeTitle ? ` · 在《${dup.match.awemeTitle.slice(0, 20)}》` : ''}
                              <div className="reply-dupold">{dup.match.replyText}</div>
                            </>
                          )
                          : '没发过，可以放心用。'}
                    </div>
                  </div>
                )}

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

                {/* 生成被前置条件拦住时，理由要落在这一页上：批量条那句只有勾了评论
                    才出现，而单条「生成回复」根本不需要勾选 */}
                {genBlock && (
                  <div className="notice notice-warn reply-genblock">
                    <div>
                      {ready.state === 'unreadable' ? '现在不知道能不能生成：' : '现在生成不了：'}{genBlock}。
                      {/* 只在"确实是被 AI 挡住"且"固定列表真的有货"时给这条路：
                          固定列表本身空着时改模式只是把同一个坑换个位置踩。 */}
                      {genBlock !== FIXED_EMPTY && fixedUsable > 0 && replyDesc && replyDesc.mode !== 'fixed' && (
                        <button
                          className="btn btn-quiet drafts-pickall"
                          disabled={switchingMode}
                          onClick={useFixedMode}
                          title={`只改「回复模式」这一项，其它设置不动；固定内容列表里有 ${fixedUsable} 条可用`}
                        >
                          {switchingMode ? '改中…' : `改用「固定内容」（${fixedUsable} 条可用）`}
                        </button>
                      )}
                      {/* 读不到时这条路只有一个动作：再读一次。「改用固定内容」不能出现 ——
                          那颗按钮上的条数是这次没读回来的数 */}
                      {ready.state === 'unreadable' && (
                        <button
                          className="btn btn-quiet drafts-pickall"
                          onClick={reloadReply}
                          disabled={replyBusy}
                        >
                          {replyBusy ? '读取中…' : '重新读取'}
                        </button>
                      )}
                      <button className="btn btn-quiet drafts-pickall" onClick={() => actions.goto('settings')}>
                        去「设置」
                      </button>
                    </div>
                  </div>
                )}

                {/* 删除入口。只在对得上的时候出现：
                      · 这条评论我回过 → 删**我发的那条回复**（最常用：发错了要撤）
                      · 这条评论是我自己发的 → 删这条评论
                      · 都不是 → 不显示（放一个点了会失败、或者删别人评论的按钮
                        比不放置更糟，见 DESIGN.md 的 Don't）
                    删除不可撤销，走二次确认。 */}
                <div className="detail-actions">
                  {selected.replied && selected.replyCid ? (
                    <button
                      className="btn btn-quiet text-bad"
                      onClick={() => setDeleting({
                        cid: selected.replyCid, kind: 'reply', text: selected.replyText,
                      })}
                      title="删除你发出的这条回复"
                    >
                      删除我的回复
                    </button>
                  ) : selected.isMine ? (
                    <button
                      className="btn btn-quiet text-bad"
                      onClick={() => setDeleting({
                        cid: selected.cid, kind: 'comment', text: selected.text,
                      })}
                      title="删除你发出的这条评论"
                    >
                      删除这条评论
                    </button>
                  ) : null}
                  <button className="btn" onClick={generate}
                    disabled={genRunning || selected.replied || !!genBlock}
                    title={genBlock || '按当前「回复模式」给这一条生成回复'}>
                    {genRunning ? '生成中…' : '生成回复'}
                  </button>
                  <button className="btn" onClick={saveDraft} disabled={!canPublish || saving}>
                    {saving && <Spinner size={12} />}{saving ? '保存中…' : '存草稿'}
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={!canPublish || selected.replied}
                    title={selected.replied ? '这条已经回复过了 —— 策略会拦下重复回复' : undefined}
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

      {deleting && (
        <Modal
          title={deleting.kind === 'reply' ? '删除这条回复？' : '删除这条评论？'}
          onClose={() => setDeleting(null)}
        >
          <div style={{ marginBottom: 14 }}>
            会从抖音上<b className="text-bad">真的删掉</b>
            {deleting.kind === 'reply' ? '你发出的这条回复' : '你发出的这条评论'}，<b>无法恢复</b>。
            {deleting.kind === 'reply' && '被回复的那条评论会回到「待回复」。'}
          </div>
          {deleting.text && (
            <div className="detail-reply-text" style={{ marginBottom: 14 }}>{deleting.text}</div>
          )}
          {/* ⚠️ 内容必须包一层 div：.notice 是 flex 容器，直接放文字的话
              每个文本节点、每个内联标签都会变成独立的 flex 子项（"写操作"
              被挤到自己一行）。见 styles.css 里 .notice 的注释。 */}
          <div className="notice notice-warn" style={{ marginBottom: 14 }}>
            <div>
              删除同样是一次<b>写操作</b>：要等写间隔、占用当日额度，被策略闸门拦下时会在队列里说明原因。
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setDeleting(null)}>取消</button>
            <button
              className="btn btn-primary text-bad"
              onClick={() => { const t = deleting; setDeleting(null); deleteComment(t); }}
            >
              仍然删除
            </button>
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
            // 发布统一走 publishNow：front 插队 + 失败留内容的处理都在里面
            const id = await publishNow({ ...t, skipWait: !!(opts && opts.skipWait) });
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
 * 删除结果的说明。
 *
 * 抖音侧删掉之后，本地还要回退：移除我们那行回复、把被回复的父评论放回未回复。
 * 三种情况分开说，因为用户下一步该做的事完全不同：
 *   - 回退没干净：**不能**说"刷新一下就好了"。实测下一次「拉取评论」只会
 *     upsert 已有行，`replied` 标记不会被纠正回来，那条仍显示「已回复」。
 *   - 本地没有这一行（命令行删的、或从没拉过）：列表本来就不变，别报成失败。
 */
function describeDelete(res, reason) {
  if (!res || typeof res !== 'object') {
    return {
      text: '抖音那边已删除；本地回退明细没取回来'
        + `${reason ? `（${reason}）` : ''}，看这条评论是否已从「已回复」里消失即可确认。`,
      warn: !!reason,
    };
  }
  if (res.localError) {
    return { text: `抖音那边已删除，但本地没回退干净：${res.localError} —— 列表里那条可能仍显示「已回复」，重新拉取也不会自动纠正`, warn: true };
  }
  const removed = Number(res.localRemoved) || 0;
  const unmarked = Number(res.localUnmarked) || 0;
  if (!removed && !unmarked) {
    return { text: '已删除。本地没有这条的记录，所以列表不变（常见于命令行删过的评论）', warn: false };
  }
  const parts = [];
  if (removed) parts.push(`移除 ${removed} 条`);
  if (unmarked) parts.push(`${unmarked} 条回到待回复`);
  return { text: `已删除，本地已同步：${parts.join('、')}`, warn: false };
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

/**
 * 评论列表的空态。
 *
 * 换掉的是页面上最浪费的两句话：`这个筛选下没有评论。` + `换个筛选标签看看。`
 * —— 这一页头顶就摆着每个筛选各有多少条，它**知道**该去哪一个，
 * 却把"找过去"这一步推回给用户手动点标签。而另一半更糟：
 * 「如果从来没拉到过评论」是一句猜测，`stats.total` 就是答案 ——
 * 猜错的代价是白等一整个读间隔。
 *
 * 三种空态的出路完全不同，所以分开写：
 *   本地一条都没有 → 只能先拉。这是读操作，未连接时按不动，都要说出口
 *   这一筛为空     → 一颗点得动的按钮，直接把筛选切到真有数据的那一个
 *   搜索没命中     → 清词。⚠️ 这一支**不报各筛选的条数**：那些数是不带搜索词的
 *                    全量口径，摆在"没匹配到"旁边就是"数字各说各的"那一类缺陷
 *
 * `stats` 还没读回来时不给任何结论 —— 没有 total 就说不清"这条视频本地有几条"。
 * 而"还没读回来"本身又有两种：还在读（等一下就有答案）与读失败（等多久都没有，
 * 必须给出原因和重读的那一步），改造前这两支共用一句话。
 */
function ListEmpty({ stats, statsError, tab, search, canQueue, onClearSearch, onTab, onFetch, onRetry }) {
  const tabName = (TABS.find(t => t.key === tab) || {}).label || tab;
  if (!stats && statsError) {
    return (
      <EmptyState
        title={`「${tabName}」这一筛下现在没有评论 —— 但这句话说不出依据。`}
        hint={<>这个视频的统计没读回来：{statsError}。列表与统计是两次读取，
          所以"列表为空"和"统计为空"哪一条是真的，要重读一次才知道。</>}
        action={<button className="btn" onClick={onRetry}>重新读取</button>}
      />
    );
  }
  if (!stats) {
    return (
      <EmptyState
        title={`「${tabName}」这一筛下现在没有评论。`}
        hint="这个视频的统计还在读。读回来之后这里会直接告诉你数据在哪个筛选下。"
      />
    );
  }
  if (search) {
    return (
      <EmptyState
        title={`没有匹配「${search}」的评论。`}
        hint={<>搜索是在<b>当前这个筛选</b>里做的，所以「全部」或别的筛选下可能有，而这个筛选下确实没有。</>}
        action={<>
          <button className="btn" onClick={onClearSearch}>清空搜索词</button>
          {' '}
          <button className="btn btn-quiet" onClick={() => { onClearSearch(); onTab('all'); }}>
            清空并看全部 {stats.total} 条
          </button>
        </>}
      />
    );
  }
  if (stats.total === 0) {
    return (
      <EmptyState
        title="这条视频本地还没有一条评论。"
        hint="评论要先从抖音拉一次才会在本地存在 —— 拉之前这一页确实无事可做。"
        action={<>
          <button
            className="btn btn-primary"
            onClick={onFetch}
            disabled={!canQueue}
            title={!canQueue ? '浏览器未连接 —— 先到「连接」页接上抖音' : '从抖音拉取这条视频的最新评论'}
          >
            拉取新评论
          </button>
          {' '}
          <span className="muted">
            {canQueue
              ? '这是读操作：要等一次读间隔，进度在上方那一行看得见'
              : '浏览器还没连接，这颗按钮现在按不动'}
          </span>
        </>}
      />
    );
  }
  const counts = [
    { key: 'pending', label: '待处理', n: stats.pending },
    { key: 'reply', label: '建议回复', n: stats.byDecision.reply },
    { key: 'emoji_reply', label: '表情回复', n: stats.byDecision.emoji_reply },
    { key: 'skip', label: '跳过', n: stats.byDecision.skip },
    { key: 'replied', label: '已回复', n: stats.replied },
    { key: 'all', label: '全部', n: stats.total },
  ];
  const elsewhere = counts.filter(c => c.n > 0 && c.key !== tab);
  // 「这一筛之外全是 0 条」只剩一种可能：本地统计说有、列表却没读到东西
  // （两次查询之间的瞬时失败）。此时说得出口的出路还是回「全部」再读一次，
  // 所以给它一颗按钮，而不是留一句"那就先回「全部」"下面什么也没有。
  const exits = elsewhere.length ? elsewhere : counts.filter(c => c.key === 'all');
  return (
    <EmptyState
      title={<>「{tabName}」这一筛下没有评论 —— 这个视频本地有 <b className="num">{stats.total}</b> 条</>}
      hint={<>
        {elsewhere.length
          ? '数据在别的筛选下，点一下直接过去：'
          : '别的筛选下也没有（这一筛之外全是 0 条）—— 那多半是列表这一次没读到，回「全部」再看一眼。'}
        {stats.scanCapped && ' · ⚠ 条数是在扫描上限内算的，评论很多时可能偏小'}
      </>}
      action={exits.length > 0 && (
        <div className="empty-chips-row">
          {exits.map(c => (
            <button key={c.key} className="btn btn-quiet empty-chip" onClick={() => onTab(c.key)}>
              {c.label}
              <span className="empty-chip-meta num">{c.n}</span>
            </button>
          ))}
        </div>
      )}
    />
  );
}
