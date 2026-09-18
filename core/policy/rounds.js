// core/policy/rounds.js — 把写操作时间线切成"轮次"
//
// 为什么需要
// ----------
// 几条运营红线都建立在"轮"这个单位上（见 运营规则说明.md §1）：
//   - 每日 ≤ 3 轮
//   - 单轮连续操作 ≤ 10 次，之后暂停 3–5 分钟
//   - 超过 2 轮后风控概率显著上升
//
// 但代码里从来没有"轮"这个实体 —— 也没有必要新建一张表去记它：
// **轮次可以从写操作的时间分布直接推出来**。同一轮里的写操作是连续发生的
// （间隔几十秒），轮与轮之间必然有一次长冷却（几分钟）。所以按"间隙超过
// 冷却时长"切分即可，纯函数、可测、且天然跨进程持久（数据来自 events 表）。

/**
 * 按间隙把时间戳序列切成轮次。
 *
 * @param {number[]} timestamps - 升序的毫秒时间戳
 * @param {number} cooldownMs   - 超过这个间隙就算新的一轮
 * @returns {number[][]} 轮次数组，每轮是该轮内的时间戳（升序）
 */
function splitRounds(timestamps, cooldownMs) {
  const ts = Array.isArray(timestamps)
    ? timestamps.filter(t => typeof t === 'number' && Number.isFinite(t)).sort((a, b) => a - b)
    : [];
  if (ts.length === 0) return [];

  const rounds = [];
  let cur = [];
  for (const t of ts) {
    if (cur.length > 0 && t - cur[cur.length - 1] > cooldownMs) {
      rounds.push(cur);
      cur = [];
    }
    cur.push(t);
  }
  if (cur.length > 0) rounds.push(cur);
  return rounds;
}

/**
 * 从写操作时间线汇总轮次状态。
 *
 * @param {number[]} timestamps - 升序毫秒时间戳
 * @param {number} cooldownMs
 * @returns {{rounds:number[][], count:number, currentSize:number, currentStartedAt:number|null, lastTs:number}}
 */
function summarizeRounds(timestamps, cooldownMs) {
  const rounds = splitRounds(timestamps, cooldownMs);
  const last = rounds.length ? rounds[rounds.length - 1] : [];
  const all = rounds.flat();
  return {
    rounds,
    /** 今日已进行的轮次数 */
    count: rounds.length,
    /** 当前（最后一轮）已写多少条 */
    currentSize: last.length,
    /** 当前轮次的起始时间；无轮次时为 null */
    currentStartedAt: last.length ? last[0] : null,
    /** 最近一次写操作时间；无记录时为 0 */
    lastTs: all.length ? all[all.length - 1] : 0,
  };
}

module.exports = { splitRounds, summarizeRounds };
