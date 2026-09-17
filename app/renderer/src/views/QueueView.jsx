import React, { useEffect, useState } from 'react';

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
 * 距下次可写 —— 本页、也是整个应用最重要的一个数字。
 *
 * 这个工具的存在意义就是让人守在发布节奏里，所以把"还要等多久"做成整页最大的
 * 元素，而不是藏在某个小角标里。倒计时在本地每秒重算，不靠主进程推。
 */
function WriteGate({ policy }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  if (!policy) return null;

  const blocked = policy.risk.blocked || policy.circuit.open;
  const remainingMs = Math.max(policy.nextWriteAllowedInMs || 0, policy.cooldownRemainingMs || 0);
  const quotaFull = policy.writesToday >= policy.dailyWriteQuota;

  let state, word, note;
  if (policy.risk.blocked) {
    state = 'offline';
    word = '已熔断';
    note = `近 ${Math.round(policy.risk.windowMs / 60000)} 分钟内出现过风控拦截，已全局停止写操作`;
  } else if (policy.circuit.open) {
    state = 'offline';
    word = '已熔断';
    note = `近期失败 ${policy.circuit.recentFailures} 次（阈值 ${policy.circuit.threshold}），已暂停自动发布`;
  } else if (quotaFull) {
    state = 'offline';
    word = '额度用尽';
    note = `今日写操作已达上限 ${policy.writesToday}/${policy.dailyWriteQuota}，明天再继续`;
  } else if (remainingMs > 0) {
    state = 'waiting';
    word = '等待中';
    note = policy.cooldownRemainingMs > 0
      ? `本轮已写 ${policy.roundWrites}/${policy.roundMaxWrites} 条，冷却后开启新一轮`
      : '距上次写操作不足最小间隔';
  } else {
    state = 'online';
    word = '可以发';
    note = '距上次写操作已超过最小间隔';
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
    { label: '今日写操作', used: policy.writesToday, max: policy.dailyWriteQuota },
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

export default function QueueView({ state, actions, busy }) {
  const tasks = (state && state.tasks) || [];
  const policy = state && state.policy;
  const counts = (state && state.stats && state.stats.counts) || {};
  const active = tasks.filter(t => ['running', 'waiting', 'pending'].includes(t.status));

  return (
    <div className="main-col">
      <h1 className="page-title">队列</h1>
      <p className="page-sub">
        所有命令都排成一条队列逐条执行 —— 并发或过快间隔会触发抖音风控，
        这一步由代码兜住，不靠自觉。
      </p>

      <WriteGate policy={policy} />

      {policy && policy.warnings && policy.warnings.length > 0 && (
        <div className="notice notice-warn">
          <div>
            {policy.warnings.map((w, i) => <div key={i}>{w}</div>)}
          </div>
        </div>
      )}

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">配额</h2>
          <span className="section-meta">
            {policy ? `每日上限 ${policy.dailyWriteQuota} 条 · ${policy.dailyRounds} 轮` : ''}
          </span>
        </div>
        <QuotaRow policy={policy} />
        {policy && policy.consecutiveSkips > 0 && (
          <p className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
            连续 {policy.consecutiveSkips} 条评论未匹配回复条件
            （达到 {policy.stopAfterConsecutiveSkips} 条建议停止本轮）
          </p>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">常用操作</h2>
        </div>
        <div className="row">
          <button className="btn btn-primary" disabled={busy}
            onClick={() => actions.runCommand({ command: 'my', argv: ['--count', '20'], label: '拉取我的作品' })}>
            拉取我的作品
          </button>
          <button className="btn" disabled={busy}
            onClick={() => actions.runCommand({ command: 'preflight', label: '节奏自检' })}>
            节奏自检
          </button>
        </div>
        <p className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>
          这两条都是只读操作，不会产生任何写动作。评论相关的页面在后续版本里补上。
        </p>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">任务</h2>
          <span className="section-meta">
            {active.length > 0 ? `${active.length} 个进行中` : `共 ${counts.done || 0} 个已完成`}
          </span>
        </div>

        {tasks.length === 0
          ? <div className="empty">队列是空的。上面挑一个操作试试。</div>
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

function TaskRow({ task, onCancel }) {
  const [now, setNow] = useState(Date.now());
  // 只在有等待任务时才开定时器，避免空闲时也在跑
  useEffect(() => {
    if (task.status !== 'waiting') return undefined;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [task.status]);

  const problem = PROBLEM.has(task.status);
  const running = task.status === 'running' || task.status === 'waiting';

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
          {task.status === 'waiting' && task.wait && ` · ${task.wait.reason}`}
          {task.status === 'running' && task.progress && task.progress.text && ` · ${task.progress.text}`}
          {problem && task.error && ` · ${task.error}`}
        </div>
      </div>
      {task.status === 'waiting' && task.wait && (
        <div className="row-meta num">{mmss(task.wait.until - now)}</div>
      )}
      {running && (
        <button className="btn btn-quiet" onClick={onCancel}>取消</button>
      )}
    </div>
  );
}
