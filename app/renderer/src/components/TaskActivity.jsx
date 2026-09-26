import React from 'react';
import ProgressBar from './ProgressBar.jsx';
import Spinner from './Spinner.jsx';
import { mmss } from '../format.js';
import { useNow } from '../useNow.js';

/** 与队列页同一份清单：这几个状态之后任务不会再变 */
const FINISHED = ['done', 'failed', 'blocked', 'cancelled'];

/**
 * 一个队列任务在**触发它的那一页上**的实时状态：在做什么 · 还要等多久 · 取消。
 *
 * 为什么要它在页上，而不是让用户跳去队列页看：
 *   - 找视频 / 运营对象 / 工作台点下「搜索」「补全」「全量拉取」「批量生成」之后，
 *     等的是 30–50 秒的读间隔（批量时是 N × 间隔）。有的页面只把按钮变灰、
 *     或者只有一个静止的「执行中」，用户唯一的办法是切去队列页守着；
 *   - 而队列页那句"还剩多久"以前根本没有本地时钟可走 —— `ctx.onWait` 那根线
 *     在主进程建 ctx 时没接上，读操作的 `task.wait` 永远是空的。
 *     现在 core 会把每一次节奏等待的**截止时刻**报上来（`task.wait.until`）。
 *
 * 三条规则收在这里，免得四个页面各写一遍各漏一遍：
 *   1. 倒计时走 `task.wait.until − 本地 now`，不读推过来的 `remainingMs` 快照；
 *   2. 截止时刻一过就不显示数字 —— 停在 00:00 的读数与"数字冻住"在屏幕上同形；
 *   3. 任务跑完（FINISHED）就整个不渲染：留着一行「执行中」是假话。
 *
 * @param {object} props
 * @param {object} [props.task]   - 队列视图对象（window.dy.queue 推的那些字段）
 * @param {function} [props.onCancel] - (id) => void；缺省不给取消按钮
 * @param {React.ReactNode} [props.note] - 行尾的补充说明（如"还有 3 条在排队"）
 * @param {string} [props.cancelNote] - 取消之后那句提醒（各命令"打断到哪一步"不一样）
 */
export default function TaskActivity({ task, onCancel, note, cancelNote }) {
  const live = !!task && !FINISHED.includes(task.status);
  const now = useNow({ enabled: live });

  if (!live) return null;

  const waiting = task.status === 'waiting' || (task.wait && task.wait.until > now);
  const waitLeft = task.wait && task.wait.until > now ? task.wait.until - now : 0;
  const prog = task.progress || {};
  const known = Number.isFinite(prog.total) && prog.total > 0;

  // 一句话说清"现在在干什么"：排队 → 节奏等待 → 有进度 → 这一条不报进度。
  // 顺序不能反：等待期间 `progress` 里停的是**上一条**的文案，
  // 拿它当"现在"会说错 —— enrich 特意把 progress 放在等待之前就是为了这个。
  let text;
  if (task.status === 'pending') text = '排在队列里 · 前面的任务做完才开始';
  else if (waitLeft > 0) text = task.wait.reason || '节奏等待';
  else if (prog.text) text = prog.text;
  else text = '执行中 · 这一条不报总数';

  return (
    <div className="task-activity">
      <div className="task-activity-row">
        <span className="task-activity-text">
          <Spinner size={12} />
          {text}
        </span>
        {waitLeft > 0 && (
          <span className="task-activity-count num">还需等待 {mmss(waitLeft)}</span>
        )}
        {note && <span className="muted task-activity-note">{note}</span>}
        {onCancel && (
          <button className="btn btn-quiet" onClick={() => onCancel(task.id)}>取消</button>
        )}
      </div>
      {/* 有总数就画确定进度；没有总数只画滚动条表示"在跑、还要多久不知道"。
          不编分母：全量拉取时服务端报的总数与真能拉到的条数对不上
          （实测 903 条的视频报 1180），拿它当分母那个条永远停不满。 */}
      {task.status !== 'pending' && (
        <ProgressBar
          current={prog.current}
          total={prog.total}
          tone={waiting ? 'wait' : 'neutral'}
        />
      )}
      {onCancel && cancelNote && (
        <div className="task-activity-hint muted">{cancelNote}</div>
      )}
    </div>
  );
}
