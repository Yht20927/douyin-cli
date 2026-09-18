// lib/risk-control.js — 请求节奏守卫（rate-limit pacing）
//
// 设计动机
// --------
// 把"命令间随机间隔"从 prose 规则变成代码强制。
// 过去间隔只写在 7 份 .md 里（且漂移出 40-55s / 45-180s / 60s 三套数字），
// agent 受 harness 默认（并行、避免长 sleep）影响会跳过。现在写命令入口直接 enforceDelay，
// 即便 agent 裸调 `node cli.js post`，命令自己也阻塞到达标 —— 跳不掉。
//
// 间隔的单一事实源 = config.json:intervals（经 core/config 读取，支持热重载）。
//
// 语义边界（重要）
// ----------------
// 这是 rate-limit pacing：尊重接口频控、维护账号健康，**不是"逃避检测"**。
// 内容真实性 / 反刷量 由 内容禁令 + corpus 去重 + factcheck 保证，节奏守卫只管"多快发一次"。
//
// 强制范围
// --------
// - 写操作（post / like / unlike / delete-comment）：硬强制，入口阻塞。
// - 读操作（get / search / my / replies / download）：仅 advisory，不阻塞。
//   原因：读操作的风控敏感度远低于写操作，且机械阻塞会让交互式查询每次卡 30s，得不偿失。
//   读间隔仍由 agent 在命令间自行遵守（preflight 会给出建议）。

const config = require('./config');
const logger = require('./runtime/logger');
const { sleepAbortable } = require('./runtime/abort');

// 默认间隔（秒）。单一真源已迁到 core/config 的 DEFAULTS.intervals，
// 这里保留同名导出仅为向后兼容（外部无引用，见 grep DEFAULT_INTERVALS）。
const DEFAULT_INTERVALS = config.DEFAULTS.intervals;

// 写操作命令名（对应 events.command 列；like 与 unlike 分开记录）
const WRITE_COMMANDS = new Set(['post', 'like', 'unlike', 'delete_comment']);

/**
 * 读取间隔配置。
 *
 * 改造前这里有模块级 `_config` 缓存（原 :35-45），导致改完 config.json 不重启进程
 * 永远读不到新值。现在每次从 config 单一真源取值，设置页改完立即生效。
 * 取值/纠正顺序/非法值回退都在 config.validate() 里完成，此处不再重复处理。
 */
function getIntervals() {
  return {
    write: config.get('intervals.write'),
    read: config.get('intervals.read'),
  };
}


function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** 读操作命令名（对应 events.command 列） */
const READ_COMMANDS = new Set(['get', 'search', 'my', 'replies', 'user', 'analyze']);

/**
 * 查 events 表最近一次指定命令集合的成功时间戳（ms）。
 * 无记录或 SQL 失败返回 0。
 * @param {Set<string>|string[]} commands
 */
function lastOpTs(commands) {
  const list = Array.from(commands);
  if (list.length === 0) return 0;
  try {
    const { getDb } = require('./memory/db');
    const db = getDb();
    const placeholders = list.map(() => '?').join(',');
    const row = db.prepare(`
      SELECT max(ts) AS ms FROM events
      WHERE platform = 'douyin'
        AND command IN (${placeholders})
        AND status = 'success'
    `).get(...list);
    return (row && row.ms) || 0;
  } catch (e) {
    logger.debug('[risk-control.lastOpTs] failed: ' + e.message);
    return 0;
  }
}

/** 最近一次写操作（post/like/unlike/delete_comment）的成功时间戳（ms） */
function lastWriteTs() {
  return lastOpTs(WRITE_COMMANDS);
}

/** 最近一次读操作的成功时间戳（ms） */
function lastReadTs() {
  return lastOpTs(READ_COMMANDS);
}

/**
 * 返回距下次允许某类操作还需等待的毫秒数（0 = 可立即执行）。
 * @param {'write'|'read'} type
 */
function msUntilNext(type = 'write') {
  const [minSec] = getIntervals()[type] || DEFAULT_INTERVALS.write;
  const last = type === 'read' ? lastReadTs() : lastWriteTs();
  if (!last) return 0;
  return Math.max(0, minSec * 1000 - (Date.now() - last));
}

/** 距下次允许写还需等待的毫秒数（0 = 可立即执行） */
/**
 * 本次写操作的目标总间隔（秒）—— 从 [min, max] 里随机取一个。
 *
 * **同一个"上次写时刻"永远得到同一个值**（结果按 lastWriteTs 记忆）。
 * 这一点很重要：队列会反复调用 beforeWrite 来刷新倒计时，如果每次都重新随机，
 * 界面上的倒计时就会来回跳（42s → 51s → 44s），看起来像坏了。
 * 每次真正写完之后 lastWriteTs 变了，才会重新抽一个新的。
 */
let _targetCache = { key: null, value: 0 };
function jitteredWriteTargetSec() {
  const last = lastWriteTs();
  const [min, max] = getIntervals().write || DEFAULT_INTERVALS.write;
  if (_targetCache.key !== last || _targetCache.value < min || _targetCache.value > max) {
    _targetCache = { key: last, value: randomInt(min, max) };
  }
  return _targetCache.value;
}

/**
 * 距"可以写"还差多少毫秒 —— **含随机量**，与 enforceDelay 的口径一致。
 *
 * 与 msUntilNext('write') 的区别：那个只算硬下限（intervals[0]），
 * 这个是算到随机目标为止。桌面队列要用它来画倒计时，否则它会只等硬下限，
 * 等完再给命令补 --no-throttle —— 于是 enforceDelay 里那段随机抖动被整个跳过，
 * 每一笔写操作都精确间隔 40.0 秒，比命令行还机械（也违反了自己文档写的 40–55s）。
 */
function msUntilNextWriteJittered() {
  const last = lastWriteTs();
  if (!last) return 0;
  const target = jitteredWriteTargetSec();
  return Math.max(0, target * 1000 - (Date.now() - last));
}

function msUntilNextWrite() {
  return msUntilNext('write');
}

function shouldBypass(opts = {}) {
  return opts.force === true || process.env.DOUYIN_NO_THROTTLE === '1';
}

/**
 * 强制等待到下次同类操作允许。被命令入口 await 调用。
 *
 * 可观测 / 可取消（GUI 需要）
 * -------------------------
 * 改造前这里是裸 `await sleep(need)`：CLI 下没问题，但 GUI 里既看不到还要等多久，
 * 也无法取消。现在等待过程通过 onWait 回调上报，并支持 AbortSignal 打断：
 *
 *   onWait({ phase, waitMs, deadline, reason })   等待开始/更新时调用一次
 *   opts.signal                                   取消时抛 AbortError
 *
 * onWait 缺省时按原样打印到 stderr —— **CLI 输出与改造前逐字节一致**。
 *
 * 读操作是否强制
 * --------------
 * 默认仍为 advisory（不阻塞），保持 CLI 交互式查询不被卡 30s 的既有语义。
 * 但 config.intervals.readEnforce 置 true 时读操作也强制 —— GUI 下会打开，
 * 因为那里没有 agent 自觉遵守间隔，必须由代码兜住。
 *
 * @param {'write'|'read'} type
 * @param {object} opts - { force, signal, onWait }
 * @returns {Promise<{skipped:boolean, waitedMs:number, lastWriteTs:number, intervals:number[]}>}
 * @throws {AbortError} signal 在等待期间被 abort
 */
async function enforceDelay(type = 'write', opts = {}) {
  const intervals = getIntervals()[type] || DEFAULT_INTERVALS.write;
  const { signal, onWait } = opts;

  if (shouldBypass(opts)) {
    return { skipped: true, waitedMs: 0, lastWriteTs: lastWriteTs(), intervals };
  }

  // 读操作：默认 advisory，不阻塞（见文件头说明）
  const readEnforced = type === 'read' && config.get('intervals.readEnforce') === true;
  if (type !== 'write' && !readEnforced) {
    return { skipped: false, waitedMs: 0, advisory: true, intervals };
  }

  const label = type === 'read' ? '读' : '写';
  const lastOf = () => (type === 'read' ? lastReadTs() : lastWriteTs());

  // 上报一次等待信息：CLI 走默认打印，GUI 走回调画倒计时
  const reportWait = (phase, waitMs, reason) => {
    if (onWait) {
      onWait({ phase, waitMs, deadline: Date.now() + waitMs, reason, type });
    } else {
      logger.info(`⏳ [risk-control] ${reason}...`);
    }
  };

  const t0 = Date.now();
  const last = lastOf();

  // 1) 硬性下限：距上次同类操作至少 minSec 秒
  const need = msUntilNext(type);
  if (need > 0) {
    const sinceLast = last ? Math.round((Date.now() - last) / 1000) : 0;
    reportWait(
      'min_interval',
      need,
      `距上次${label}仅 ${sinceLast}s，强制等待 ${Math.ceil(need / 1000)}s（下限 ${intervals[0]}s）`
    );
    await sleepAbortable(need, signal);
  }

  // 2) 叠加随机量，让总间隔落在 [min, max]
  const lastAfterFloor = lastOf();
  const elapsedSec = lastAfterFloor ? (Date.now() - lastAfterFloor) / 1000 : intervals[1];
  if (elapsedSec < intervals[1]) {
    // 用与 jitteredWriteTargetSec() 相同的目标：队列若已经按它等过了，
    // 这里自然算出 0 秒额外等待（不会双重等待）；命令行下则由这里完成整段随机。
    const targetTotal = jitteredWriteTargetSec();
    const extra = Math.max(0, Math.round(targetTotal - elapsedSec));
    if (extra > 0) {
      reportWait('jitter', extra * 1000, `叠加随机节奏，再等 ${extra}s（目标总间隔 ${targetTotal}s）`);
      await sleepAbortable(extra * 1000, signal);
    }
  }

  return { skipped: false, waitedMs: Date.now() - t0, lastWriteTs: last || lastAfterFloor, intervals };
}

/**
 * preflight 自检：不阻塞，只报告状态。供 `node cli.js preflight <cmd>` 与 agent 自检用。
 * @param {string} command
 */
function preflight(command) {
  const isWrite = ['post', 'like', 'unlike', 'delete-comment', 'delete_comment'].includes(command);
  const intervals = getIntervals();

  if (!isWrite) {
    return {
      command, type: 'read', ok: true,
      message: `读操作，建议命令间间隔 ${intervals.read[0]}-${intervals.read[1]}s（advisory，由 agent 自行遵守）`,
      intervals: intervals.read,
    };
  }

  const need = msUntilNextWrite();
  const last = lastWriteTs();
  const sinceLast = last ? Math.round((Date.now() - last) / 1000) : null;

  if (need === 0) {
    return {
      command, type: 'write', ok: true,
      message: `可执行（距上次写 ${sinceLast === null ? '无记录' : sinceLast + 's'}）`,
      intervals: intervals.write,
    };
  }
  return {
    command, type: 'write', ok: false,
    message: `需等待 ${Math.ceil(need / 1000)}s（距上次写 ${sinceLast}s，下限 ${intervals.write[0]}s）`,
    waitMs: need,
    intervals: intervals.write,
  };
}

// ═══════════════════════════════════════════════════════════
// 风控信号与发布前预检
//
// 注：原 P4 的 dailyQuotaUsage / adaptiveInterval 依赖 campaigns.campaign_tasks，
// 已随推广引擎一并移除。发布节奏的配额判断改由 PolicyEngine 用全局计数（events 表）实现。
// hasRecentRiskBlock 与 preflightPublish 是通用能力，保留。
// ═══════════════════════════════════════════════════════════

/**
 * 近 windowMs 内是否有 post 失败且错误码为风控拦截（status_code=8/2053）。
 */
function hasRecentRiskBlock(windowMs = 300000) {
  try {
    const { getDb } = require('./memory/db');
    const db = getDb();
    const since = Date.now() - windowMs;

    // 风控码来自配置，不再硬编码。改造前 SQL 里写死 status_code=8 / 2053，
    // 于是 policy.riskCodeStopList 这个配置项**只用于错误文案**（界面提示"错误码 8/2053"），
    // 改它不影响判断 —— 用户按设置页的说明加一个码不会生效，去掉一个也不会放行，
    // 而界面提示会显示成改过之后的样子，排查方向直接被带偏。
    const codes = (config.get('policy.riskCodeStopList') || []).filter(Number.isInteger);
    if (!codes.length) return false;

    // 写操作族全部纳入。改造前只看 command='post'，
    // 于是连续 like 命中风控码不触发那 30 分钟的全局停写。
    // 注意 WRITE_COMMANDS 是个 **Set**（不是数组）：直接 .map 会抛
    // "map is not a function"，而这里整段包在 try 里 —— 结果就是静默返回 false，
    // 风控熔断永远不触发。先转成数组。
    const writeCommands = [...WRITE_COMMANDS];
    const cmdPlaceholders = writeCommands.map(() => '?').join(', ');

    // SQL 只做粗筛（错误串里出现过这些数字），精判在 JS 里做。
    // 直接在 SQL 里表达"status_code 后面的数字要完整相等"会写得又长又容易错
    // （第一版就是这么写的，参数顺序一乱就全不命中，而且静默返回 false）。
    const numConds = codes.map(() => "error LIKE ?").join(' OR ');
    const numParams = codes.map(n => `%status_code=${n}%`);

    const rows = db.prepare(`
      SELECT error FROM events
      WHERE platform = 'douyin' AND status = 'error'
        AND command IN (${cmdPlaceholders})
        AND (${numConds})
        AND ts >= ?
      LIMIT 200
    `).all(...writeCommands, ...numParams, since);

    // 精确判定：`status_code=8` 命中，`status_code=80`、`status_code=801` 不命中
    return rows.some(r => codes.some(n => new RegExp(`status_code=${n}(?![0-9])`).test(r.error || '')));
  } catch (e) {
    logger.debug('[risk-control.hasRecentRiskBlock] failed: ' + e.message);
    return false;
  }
}

// 这里原本有一个 preflightPublish()，做四类发布前检查（贴纸 / 黑名单 / 语料查重 /
// 近期风控）。已删除，原因有二：
//
//   1. **它全仓没有任何调用方** —— 也就是说这四条护栏从来没生效过，
//      同一句话可以重复发出去。改造计划 §3.1 却明确承诺过"发布前代码拦截"。
//   2. 它里面读的是 `c.is_sticker`，而 comments.get() 返回的是驼峰 `isSticker`，
//      所以即便接上调用方，贴纸那条判断也是恒假的。
//
// 前三条的判定已并入真正的发布闸门（core/policy 的 beforeWrite），
// 那里是 post/like/delete-comment 实际经过的地方，CLI 裸调也跳不掉。
// 第四条（近期风控）本来就已经在 policy 的熔断判定里。
//
// 留这段说明而不是留一份死代码：死代码会被后来的人当成"还在生效"，
// 然后照着它去排查问题 —— 那比没有更糟。


module.exports = {
  enforceDelay,
  preflight,
  msUntilNext,
  msUntilNextWrite,
  msUntilNextWriteJittered,
  jitteredWriteTargetSec,
  lastWriteTs,
  lastReadTs,
  lastOpTs,
  getIntervals,
  DEFAULT_INTERVALS,
  WRITE_COMMANDS,
  READ_COMMANDS,
  // 风控信号与发布前预检
  hasRecentRiskBlock,
};
