// core/policy/rounds.js — 把写操作时间线切成"轮次"
//
// 为什么需要
// ----------
// 几条运营红线都建立在"轮"这个单位上（见 运营规则说明.md §1）：
//   - 每日 ≤ 3 轮
//   - 单轮连续操作 ≤ 10 次，之后暂停 3–5 分钟
//   - 超过 2 轮后风控概率显著上升
//
// 「轮」是什么：一批连续的写操作
// ------------------------------
// **一轮 = 一批连续写操作。** 写满 `roundMaxWrites` 条这一轮就结束，之后强制冷却
// `roundCooldownSec` 秒；冷却结束后的第一条写操作开启新一轮。
//
// ⚠️ 空闲**不是**一轮。这里改过两次，两次都错，记下来当反面教材：
//
//   第一次：轮的分界与触顶冷却共用同一个 300 秒 —— 隔一小时各点一次发布 = 三次就
//           "轮次用尽"（误报），而每条都慢过 300 秒则永远凑不满一轮、永远不冷却（漏网）。
//   第二次：把分界拆出来单独给 1800 秒。两个数确实分开了，但**定义没改**，于是：
//           误报照旧 —— 19:12 / 20:16 / 21:02 各发一条（真库里实测的那组数据）
//                       依然切成 3 轮，因为 61 分钟和 46 分钟都超过 30 分钟分界；
//           漏网照旧 —— 守规矩的连续作业（每 45 秒一条、每写满 10 条冷却 5 分钟）
//                       永远撑不出 30 分钟的空隙 → 整天恒为 1 轮 →
//                       "每日 ≤3 轮"与"超 2 轮风控升级"**在任何一天的连续作业下都不可达**。
//
//   教训：**把参数拆成两个数 ≠ 修好了定义。** 判定"轮"的规则与切"轮"的规则必须是
//   同一条，否则改动只是把误差挪个位置。
//
// 没有单独的表，也不需要
// ----------------------
// 批次边界可以从写操作的时间分布**惰性推出来** —— 扫描升序时间线，扫到某一笔时
// 若"当前这一批已经写满"且"它距上一笔已超过冷却时长"，就地收轮。纯函数、可测，
// 且天然跨进程持久（数据来自 events 表），不引入任何新的存储与进程内状态。

/** 过滤非法时间戳并升序排列。两个入口都要用，抽出来避免各写一遍。 */
function normTimestamps(timestamps) {
  return Array.isArray(timestamps)
    ? timestamps.filter(t => typeof t === 'number' && Number.isFinite(t)).sort((a, b) => a - b)
    : [];
}

/**
 * 归一化两个参数，把"配成 0 或没传"这种边角挡在入口。
 *
 * `maxPerRound` 兜到 1：0 与 1 在这里本来就是同一件事（当前批次非空时
 * `length >= 0` 与 `>= 1` 恒同真），兜一下省得读代码的人以为 0 是"不限量"。
 * `cooldownMs` 兜到 0 是有意义的取值 —— 它表示"写满即收轮、不额外歇"。
 *
 * 两个都传成非数字（比如老调用方按位置传了 `roundGapSec*1000`）时取最严的一组：
 * 每来一笔就独立成轮。这样错了也是**看起来就不对**（轮数≈条数），
 * 不会静默地退化成"全天只有一轮、冷却永不生效"那种查不出来的样子。
 */
function normOpts(opts = {}) {
  const { maxPerRound, cooldownMs } = opts;
  return {
    maxPerRound: Number.isFinite(maxPerRound) ? Math.max(1, Math.floor(maxPerRound)) : 1,
    cooldownMs: Number.isFinite(cooldownMs) ? Math.max(0, cooldownMs) : 0,
  };
}

/**
 * 按批次把时间戳序列切成轮次。
 *
 * @param {number[]} timestamps - 毫秒时间戳（不必有序）
 * @param {object} opts
 * @param {number} opts.maxPerRound - 一轮最多几条（policy.roundMaxWrites）
 * @param {number} opts.cooldownMs  - 一轮写满后的强制冷却（policy.roundCooldownSec × 1000）
 * @returns {number[][]} 轮次数组，每轮是该轮内的时间戳（升序）
 */
function splitRounds(timestamps, opts = {}) {
  const { maxPerRound, cooldownMs } = normOpts(opts);
  const ts = normTimestamps(timestamps);
  if (ts.length === 0) return [];

  const rounds = [];
  let cur = [];
  for (const t of ts) {
    if (cur.length > 0) {
      // 收轮要同时满足两条：这一批已经写满，**且**距这一批的最后一笔已歇够冷却时长。
      // 只有"写满"没有"冷却"时，后面那一笔仍然并入本批 —— 它是一次绕过闸门的超额写，
      // 不该凭空多算一轮（那是把违规记成"多干了一轮"，方向反了）。
      const full = cur.length >= maxPerRound;
      const rested = t - cur[cur.length - 1] >= cooldownMs;
      if (full && rested) {
        rounds.push(cur);
        cur = [];
      }
    }
    cur.push(t);
  }
  if (cur.length > 0) rounds.push(cur);
  return rounds;
}

/**
 * 从写操作时间线汇总轮次状态。
 *
 * @param {number[]} timestamps - 毫秒时间戳（不必有序）
 * @param {object} opts
 * @param {number} opts.maxPerRound - 一轮最多几条（policy.roundMaxWrites）
 * @param {number} opts.cooldownMs  - 触顶后的强制冷却（policy.roundCooldownSec × 1000）
 * @param {number} [opts.now]       - 参考时刻。**不传时取最后一个时间戳**，
 *                                    向后兼容那些只关心"这批写了几条"的老调用。
 * @returns {{rounds:number[][], count:number, currentSize:number, currentStartedAt:number|null,
 *            lastTs:number, currentFull:boolean, cooldownRemainingMs:number, startingNewRound:boolean}}
 */
function summarizeRounds(timestamps, opts = {}) {
  const { maxPerRound, cooldownMs } = normOpts(opts);
  const ts = normTimestamps(timestamps);
  const rounds = splitRounds(ts, { maxPerRound, cooldownMs });
  const last = rounds.length ? rounds[rounds.length - 1] : [];
  const lastTs = last.length ? last[last.length - 1] : 0;
  const ref = Number.isFinite(opts.now) ? opts.now : lastTs;

  /** 当前这一批是否已经写满 —— 触顶判定的唯一依据 */
  const currentFull = last.length >= maxPerRound;
  // 冷却从**这一批的最后一笔**起算（不是从写满的那一刻），与闸门那句
  // "距上次写超过冷却时长即可开新一轮"是同一条规则的两个说法。
  //
  // ⚠️ 上面那层 `Math.min(cooldownMs, ...)` 是在挡时钟回拨：`now` 早于最后一笔
  // （改系统时间、跨机器同步的库）时，裸减法会得出"还要等 8 小时"这种数，
  // 而 assertWritable 会**真的睡满它**。冷却在语义上不可能超过它自己的时长，
  // 所以这一夹没有任何正常路径会碰到，纯属兜底。
  const cooldownRemainingMs = currentFull && lastTs
    ? Math.min(cooldownMs, Math.max(0, lastTs + cooldownMs - ref))
    : 0;

  return {
    rounds,
    /** 今日已进行的轮次数（含当前这一批） */
    count: rounds.length,
    /** 当前（最后一批）已写多少条 */
    currentSize: last.length,
    /** 当前轮次的起始时间（这一批的第一笔）；无轮次时为 null */
    currentStartedAt: last.length ? last[0] : null,
    /** 最近一次写操作时间；无记录时为 0 */
    lastTs,
    /** 当前这一批是否已写满（满则需冷却，冷却后下一次写开启新一轮） */
    currentFull,
    /** 当前这一批写满后还需冷却多久（毫秒，0 = 不需要冷却） */
    cooldownRemainingMs,
    /**
     * 下一次写操作是否会**开启新一轮** —— 要么今天还没写过，要么当前这一批
     * 已写满且已歇够冷却时长。界面据此区分"还在本轮里继续写"与"要开新的一轮"。
     */
    startingNewRound: rounds.length === 0 || (currentFull && ref - lastTs >= cooldownMs),
  };
}

module.exports = { splitRounds, summarizeRounds };
