import React, { useEffect, useState } from 'react';
import ProgressBar from '../components/ProgressBar.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Spinner from '../components/Spinner.jsx';

/** 秒 → mm:ss */
function mmss(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const STATUS_TEXT = {
  pending: '排队中',
  running: '执行中',
  waiting: '等待中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  blocked: '被拦下',
};

/** 状态 → 是否属于"出问题了"。只有这几种才用状态色。 */
const PROBLEM = new Set(['failed', 'blocked']);

/**
 * 拦下动作 → 人话标签。
 *
 * `task.blockers` 里每条带 `action`：stop 是"这条就到此为止"，
 * wait 是"等一会儿还能发"，rewrite 是"内容得改"。三者的处置完全不同 ——
 * 改造前只渲染拼好的 `task.error`，把 action 丢了，
 * 用户看到"被拦下"却不知道是该等、该改、还是该放弃。它们本身就是状态，所以上色。
 */
const BLOCK_LABEL = { stop: '不能发', wait: '要等待', rewrite: '要改写' };
const BLOCK_TAG = { stop: 'tag-bad', wait: 'tag-warn', rewrite: 'tag-warn' };

/** 未连接时状态条上的一句话：区分"从没连上过"与"连过又断了" */
function everConnectedNote(status) {
  return status && status.offlineForMs > 0
    ? '抖音页面断开了'
    : '还没有抖音页面连上来';
}

/** 毫秒 → "1 分 20 秒" / "12 秒"。任务耗时比绝对时刻更有用 */
function duration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s ? `${m} 分 ${s} 秒` : `${m} 分`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/**
 * 把 policy 上的提示统一成数组。
 *
 * core 现在给的是 `warning`（单个字符串或 null），渲染层早先读的是 `warnings`。
 * 两种都接住 —— 这类"名字差一个字母、值恒为 undefined、界面静默不显示"
 * 的问题在这个项目里已经出现过好几次，代价都是"承诺过的提示从来没出现过"。
 */
function warningsOf(policy) {
  if (!policy) return [];
  const w = policy.warning != null ? policy.warning : policy.warnings;
  if (!w) return [];
  return Array.isArray(w) ? w.filter(Boolean) : [String(w)];
}

/**
 * 距下次可写 —— 本页、也是整个应用最重要的一个数字。
 *
 * 这个工具的存在意义就是让人守在发布节奏里，所以把"还要等多久"做成整页最大的
 * 元素，而不是藏在某个小角标里。倒计时在本地每秒重算，不靠主进程推。
 *
 * 连接状态必须排在策略前面：浏览器没连上时策略再"可以发"也是发不出去的 ——
 * 改造前这里只看策略，首次打开应用会显示绿色「可以发」，而实际上什么都没连，
 * 同屏的侧栏却写着"等待连接"，用户没法判断该信哪个。
 */
function WriteGate({ policy, status, onGotoConnection }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const disconnected = status && status.listening && !status.online;

  if (disconnected) {
    const word = everConnectedNote(status);
    return (
      <section className="band" data-state="offline">
        <div className="band-head">
          <div className="band-main">
            <div className="band-word">
              <span className="band-dot" />
              未连接
            </div>
            <p className="band-note">
              {word}。发布类操作暂时发不出去 —— 到「连接」页接上抖音再回来。
            </p>
          </div>
          {onGotoConnection && (
            <div className="band-actions">
              <button className="btn" onClick={onGotoConnection}>去连接页</button>
            </div>
          )}
        </div>
      </section>
    );
  }

  if (!policy) return null;

  const blocked = policy.risk.blocked || policy.circuit.open;
  const remainingMs = Math.max(policy.nextWriteAllowedInMs || 0, policy.cooldownRemainingMs || 0);
  const quotaFull = policy.writesToday >= policy.dailyWriteQuota;

  let state, word, note;
  if (policy.risk.blocked) {
    state = 'offline';
    word = '已熔断';
    note = `近 ${Math.round(policy.risk.windowMs / 60000)} 分钟内出现过风控拦截，已全局停止发布`;
  } else if (policy.circuit.open) {
    state = 'offline';
    word = '已熔断';
    note = `近期失败 ${policy.circuit.recentFailures} 次（阈值 ${policy.circuit.threshold}），已暂停自动发布`;
  } else if (quotaFull) {
    state = 'offline';
    word = '额度用尽';
    note = `今日发布已达上限 ${policy.writesToday}/${policy.dailyWriteQuota}，明天再继续`;
  } else if (remainingMs > 0) {
    state = 'waiting';
    word = '等待中';
    note = policy.cooldownRemainingMs > 0
      ? `本轮已发 ${policy.roundWrites}/${policy.roundMaxWrites} 条，冷却后开启新一轮`
      : '距上次发布不足最小间隔';
  } else {
    state = 'online';
    word = '可以发';
    note = '距上次发布已超过最小间隔';
  }

  return (
    <section className="band" data-state={state}>
      <div className="band-head">
        <div className="band-main">
          <div className="band-word">
            <span className="band-dot" />
            {word}
          </div>
          <p className="band-note">{note}</p>
        </div>
        {remainingMs > 0 && (
          <div className="countdown num" title="距下次可以写操作">
            {mmss(remainingMs)}
          </div>
        )}
      </div>
    </section>
  );
}

/** 配额条：今日总量 / 本轮 / 轮次 */
function QuotaRow({ policy }) {
  if (!policy) return null;
  const cells = [
    { label: '今日发布', used: policy.writesToday, max: policy.dailyWriteQuota },
    { label: '本 轮', used: policy.roundWrites, max: policy.roundMaxWrites },
    { label: '轮 次', used: policy.roundsToday, max: policy.dailyRounds },
  ];
  return (
    <div className="quota-row">
      {cells.map((c) => {
        const pct = c.max > 0 ? Math.min(100, Math.round((c.used / c.max) * 100)) : 0;
        const full = c.used >= c.max;
        return (
          <div className="quota-cell" key={c.label}>
            <div className="quota-head">
              <span className="quota-label">{c.label}</span>
              <span className="quota-value num">
                {c.used}<span className="quota-max">/{c.max}</span>
              </span>
            </div>
            <div className="quota-bar">
              <div
                className="quota-fill"
                style={{ width: `${pct}%`, background: full ? 'var(--bad)' : 'var(--text-2)' }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function QueueView({ state, status, actions, busy }) {
  const tasks = (state && state.tasks) || [];
  const policy = state && state.policy;
  const counts = (state && state.stats && state.stats.counts) || {};
  const active = tasks.filter(t => ['running', 'waiting', 'pending'].includes(t.status));
  const pendingCount = tasks.filter(t => t.status === 'pending').length;
  const failedCount = (counts.failed || 0) + (counts.blocked || 0);

  return (
    <div className="main-col">
      <h1 className="page-title">队列</h1>
      <p className="page-sub">
        所有命令都排成一条队列逐条执行 —— 并发或过快间隔会触发抖音风控，
        这一步由代码兜住，不靠自觉。
      </p>

      <WriteGate policy={policy} status={status} onGotoConnection={actions.gotoConnection} />

      {/* 风控升级提示。
          core 的 stats() 返回的是 `warning`（单个字符串或 null），不是数组 ——
          这里此前读的是 `policy.warnings`，恒为 undefined，于是**这条黄条永远不会出现**：
          设置页承诺的"超过 N 轮后本日不建议继续"从来没兑现过。
          两种形状都接住，将来 core 改成数组也不会又静默失效。 */}
      {warningsOf(policy).map((w, i) => (
        <div className="notice notice-warn" key={i}><div>{w}</div></div>
      ))}

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">配额</h2>
          <span className="section-meta">
            {policy ? `每日上限 ${policy.dailyWriteQuota} 条 · ${policy.dailyRounds} 轮` : ''}
          </span>
        </div>
        {/* 这里原本有一行「连续 N 条评论未匹配回复条件（达到 M 条建议停止本轮）」。
            已删除：N 恒为 0，所以那行**永远不会渲染**。
            原因见 开发进度.md 的 P4.4 一节 —— 评论筛选走的是 filters.classify
            （界面展示判定用），不走 policy 的 classifyBatch，后者才累计跳过数，
            而它目前没有任何调用方。设置页已把 stopAfterConsecutiveSkips 标为「不生效」。
            哪天把批量筛选接到 policy 上，这行可以照原样加回来。 */}
        <QuotaRow policy={policy} />
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">常用操作</h2>
        </div>
        <div className="row">
          <button
            className="btn btn-primary"
            disabled={busy || !actions.canQueue}
            title={!actions.canQueue ? '浏览器未连接 —— 先到「连接」页接上抖音' : '从抖音拉取作品列表（不产生发布）'}
            onClick={() => actions.runCommand({
              command: 'my', argv: ['--count', '50'], label: '拉取我的作品',
              // 跑完自动刷新作品列表。改造前这里没传 afterDone：用户在队列页点
              // 「拉取我的作品」、看到"已完成"、切到「我的作品」依然是旧列表，
              // 会以为根本没拉到。
              afterDone: 'refreshVideos',
            })}>
            拉取我的作品
          </button>
          {/* 节奏自检只读本地策略，不需要浏览器在线，不受连接状态限制 */}
          <button className="btn" disabled={busy}
            onClick={() => actions.runCommand({ command: 'preflight', label: '节奏自检' })}>
            节奏自检
          </button>
        </div>
        <p className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>
          这两条都是只读操作，不会发布任何内容。回复相关的操作在「我的作品」里 ——
          点进任意作品就是评论工作台。
        </p>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">任务</h2>
          <span className="section-meta">
            {active.length > 0 ? `${active.length} 个进行中` : `共 ${counts.done || 0} 个已完成`}
            {failedCount > 0 && ` · ${failedCount} 个未成功`}
          </span>
          {/* 排队中的任务此前没有取消入口 —— 队列排了十几条想收手时，
              只能等每条真正开始跑才能一条条取消，而写操作之间还隔着几十秒。
              queue.cancelPending() 一直存在（CLI 侧在用），渲染层从没调过。 */}
          {pendingCount > 0 && (
            <button className="btn btn-quiet" onClick={() => actions.cancelPending()}>
              取消排队中的 {pendingCount} 条
            </button>
          )}
        </div>

        {tasks.length === 0
          ? <EmptyState title="队列是空的。" hint="上面挑一个操作试试。" />
          : (
            <div className="list">
              {tasks.slice().reverse().map((t) => (
                <TaskRow key={t.id} task={t} onCancel={() => actions.cancelTask(t.id)} />
              ))}
            </div>
          )}
      </section>
    </div>
  );
}

/**
 * 已完成任务的执行结果。
 *
 * 队列的 resultSummary 是 core 专门为界面产出的（task-queue.js 里有注释），
 * 但渲染层从来没引用过 —— 于是「生成回复」这类任务一旦离开工作台页面，
 * 结果就再也看不到，队列里只剩"已完成"三个字。
 *
 * 完整结果按需取（queue.getResult），不塞进常规推送 —— 大结果（拉评论那种）
 * 每次队列变化都过一遍 IPC 会把界面拖垮，这也是 core 那边不在 list() 里带 result 的原因。
 */
function ResultPeek({ task }) {
  const [full, setFull] = useState(undefined);
  const [busy, setBusy] = useState(false);

  if (task.status !== 'done' || !task.resultSummary) return null;

  const s = task.resultSummary;
  const hint = s.kind === 'array' ? `${s.count} 项`
    : s.kind === 'object' ? `包含 ${s.keys.length} 个字段`
      : String(s.value || '').slice(0, 60);

  async function load() {
    if (full !== undefined) { setFull(undefined); return; }
    // 拉评论这类结果可能几十上百 KB，取出与序列化都要时间。
    // 改造前这里点下去毫无反应，用户会以为按钮坏了而连点。
    setBusy(true);
    try {
      const r = await window.dy.queue.result(task.id);
      setFull(r && r.result !== undefined ? r.result : null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn btn-quiet" onClick={load} disabled={busy} title="查看这个任务的执行结果">
        {busy && <Spinner size={12} />}
        {full === undefined ? '查看结果' : '收起'}
      </button>
      {full !== undefined && (
        <pre className="task-result">
          {full === null
            ? `结果没有保留（可能过大或无法序列化），摘要：${hint}`
            : JSON.stringify(full, null, 2)}
        </pre>
      )}
    </>
  );
}

function TaskRow({ task, onCancel }) {
  const [now, setNow] = useState(Date.now());
  // 只在有等待任务时才开定时器，避免空闲时也在跑
  useEffect(() => {
    if (task.status !== 'waiting') return undefined;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [task.status]);

  const problem = PROBLEM.has(task.status);
  // 「排队中」也要能取消：队列排了十几条想收手时，此前只能等每条真正开始跑
  // （中间还隔着几十秒的写间隔）才能一条条取消。queue.cancel 本来就支持 pending。
  const cancellable = ['pending', 'running', 'waiting'].includes(task.status);

  return (
    <div className={`row-item ${problem ? 'row-problem' : ''}`}>
      <span
        className="state-dot"
        style={
          task.status === 'running' ? { background: 'var(--text)' }
            : task.status === 'waiting' ? { background: 'var(--wait)' }
              : task.status === 'done' ? { background: 'var(--ok)' }
                : problem ? { background: 'var(--bad)' }
                  : undefined
        }
      />
      <div className="row-main">
        <div className="row-title">{task.label}</div>
        <div className="row-sub">
          {STATUS_TEXT[task.status] || task.status}
          {task.status === 'pending' && ' · 前面的任务做完才会开始'}
          {task.status === 'waiting' && task.wait && ` · ${task.wait.reason}`}
          {/* 进度不再拼进这行小字 —— 见下面的进度条 */}
          {problem && task.error && ` · ${task.error}`}
          {/* 跑完的任务显示用了多久。"这条到底卡了还是在跑"靠它才看得出来 */}
          {task.endedAt && task.startedAt && ` · 用时 ${duration(task.endedAt - task.startedAt)}`}
        </div>

        {/* 任务进度条。
            `current` / `total` 一直在 `task.progress` 里（core 的 logger.progress
            上报 → task-queue 落库 → 随 queue:changed 推到界面），
            改造前渲染层**从没读过这两个字段** —— 批量生成 50 条只有一行 12px 小字。 */}
        {task.progress && (task.progress.text || task.progress.total > 0) && (
          <div className="row-progress">
            <ProgressBar
              current={task.progress.current}
              total={task.progress.total}
              label={task.progress.text}
              tone={problem ? 'bad' : 'neutral'}
            />
          </div>
        )}

        {/* 被拦下的原因。task.blockers 是**结构化**的（带 action: stop/wait/rewrite），
            改造前只读了拼好的 task.error，把 action 丢了 —— 而"这是永久拦下
            还是等一会儿就行"正是用户最需要知道的那一点。 */}
        {problem && task.blockers && task.blockers.length > 0 && (
          <div className="row-blockers">
            {task.blockers.map((b, i) => (
              <div className="row-blocker" key={i}>
                <span className={`tag ${BLOCK_TAG[b.action] || 'tag-dim'}`}>
                  {BLOCK_LABEL[b.action] || '拦下'}
                </span>
                <span>{b.reason}</span>
              </div>
            ))}
          </div>
        )}

        {/* 任务级告警（策略给出的提醒）。task.warnings 一直被推给界面，从没渲染过 */}
        {task.warnings && task.warnings.length > 0 && (
          <div className="row-warnings">
            {task.warnings.map((w, i) => <div key={i}>{w}</div>)}
          </div>
        )}

        <ResultPeek task={task} />
      </div>
      {task.status === 'waiting' && task.wait && (
        <div className="row-meta num">{mmss(task.wait.until - now)}</div>
      )}
      {cancellable && (
        <button className="btn btn-quiet" onClick={onCancel}>取消</button>
      )}
    </div>
  );
}
