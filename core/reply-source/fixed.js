// core/reply-source/fixed.js — 固定回复内容取样
//
// 「从配置的回复内容列表里按某种循环方式取一条」这件事本身很薄，
// 真正需要小心的是**边界**：列表为空、条目被禁用、用户刚改过列表长度、
// 复用间隔比列表还长。这些都收敛在 cycles.js 与本文件的过滤里，
// 上层（index.js）只需要处理"取到了 / 没取到"两种结果。

const { pickIndex, isValidCycle } = require('./cycles');

/**
 * 过滤出真正可用的条目，并保留下标映射。
 *
 * 过滤在取样**之前**做，于是游标与牌堆都只在下标空间里滑动 ——
 * 用户把某一条禁用掉，其余条目的顺序不会错位。
 *
 * @param {Array<{text:string, weight:number, enabled:boolean}>} items
 * @param {string} [cycle] - 传 'weighted' 时，权重为 0 的条目一并排除。
 *   把这件事做在这里而不是取样器里，是为了让设置页能直接说明"哪几条被排除了"，
 *   用户不会遇到"设置了 5 条却只看到 3 条在轮"的困惑。
 * @returns {Array<{text:string, weight:number, index:number}>}
 */
function usableItems(items, cycle) {
  const out = [];
  const list = Array.isArray(items) ? items : [];
  const weighted = cycle === 'weighted';
  list.forEach((it, i) => {
    if (!it || typeof it !== 'object') return;
    if (it.enabled === false) return;
    const text = typeof it.text === 'string' ? it.text.trim() : '';
    if (!text) return;
    const weight = Number.isFinite(it.weight) ? Math.max(0, it.weight) : 1;
    if (weighted && weight <= 0) return;
    out.push({ text, weight, index: i });
  });
  return out;
}

/**
 * 取一条固定回复。
 *
 * @param {object} opts
 * @param {object} opts.config - config.get('reply').fixed
 * @param {object} opts.state  - 会被就地更新的循环状态（由调用方负责持久化）
 * @param {Function} [opts.rng]
 * @returns {{text:string, itemIndex:number, weight:number, cycle:string}|null}
 *          列表为空时返回 null —— 由调用方决定怎么报错，理由在这里看不到
 */
function nextFixed(opts) {
  const { config = {}, state, rng } = opts;

  // 非法的循环名回退到顺序（保守但总能出结果），不抛错：
  // 用户手改多打一个字母就让功能整个不可用，代价太大。
  const cycle = isValidCycle(config.cycle) ? config.cycle : 'sequential';

  const usable = usableItems(config.items, cycle);
  if (!usable.length) return null;

  const idx = pickIndex({
    len: usable.length,
    cycle,
    state,
    minGap: Number.isInteger(config.minGapBetweenReuse) ? config.minGapBetweenReuse : 0,
    weights: usable.map(u => u.weight),
    rng,
  });
  if (idx < 0) return null;

  const picked = usable[idx];
  return { text: picked.text, itemIndex: picked.index, weight: picked.weight, cycle };
}

/**
 * 设置页要显示"共 N 条，其中 M 条可用"，以及不可用的各自什么原因 ——
 * 否则用户会看到"配了 5 条却只轮 3 条"而找不到原因。
 * @param {Array} items
 * @param {string} [cycle]
 */
function describeItems(items, cycle) {
  const list = Array.isArray(items) ? items : [];
  const usable = usableItems(list, cycle);
  const weighted = cycle === 'weighted';
  return {
    total: list.length,
    usable: usable.length,
    disabled: list.filter(it => it && it.enabled === false).length,
    blank: list.filter(it => it && it.enabled !== false && !(typeof it.text === 'string' && it.text.trim())).length,
    // 仅在 weighted 下才有意义：这些条目会被排除在抽样之外
    zeroWeight: weighted
      ? list.filter(it => it && it.enabled !== false && typeof it.text === 'string' && it.text.trim()
        && Number.isFinite(it.weight) && it.weight <= 0).length
      : 0,
  };
}

module.exports = { nextFixed, usableItems, describeItems };
