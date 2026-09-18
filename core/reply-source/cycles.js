// core/reply-source/cycles.js — 循环取样算法（D14 四种）
//
// 这是纯函数模块：**不 require 任何东西**，不读配置、不碰磁盘。
// 固定回复内容列表与图片列表共用同一套算法，只是各自的 items 不同。
// config 的 schema 校验也 require 本模块取 CYCLE_NAMES，保证两处不会漂移。
//
// 状态约定
// --------
// 需要持久化的只有 sequential 的游标、shuffle-no-repeat 的牌堆，以及
// 所有模式共用的"最近取过哪些"（minGapBetweenReuse 用）。它们都放在传入的
// `state` 对象里，由调用方负责存取（core/reply-source/state.js）。
// random 与 weighted 本身是无状态的。
//
// state 形状：
//   { cursor: number, deck: number[], recent: number[] }
// 全部是**在当前候选数组里的下标**。数组本身不落盘 —— 用户改了列表
// 立刻生效，不需要迁移历史状态。

/** 四种循环策略的名字。config 校验与界面下拉框都从这里取 */
const CYCLE_NAMES = ['sequential', 'random', 'shuffle-no-repeat', 'weighted'];

/** 供界面展示的中文名与一句话说明（避免文案在两处各写一份） */
const CYCLE_INFO = [
  { name: 'sequential', label: '顺序', hint: '按列表顺序取，取完回到第一条' },
  { name: 'random', label: '随机', hint: '每次随机抽一条，可能连续重复' },
  { name: 'shuffle-no-repeat', label: '洗牌不重复', hint: '洗牌后依次用完，用尽再洗' },
  { name: 'weighted', label: '加权', hint: '按权重随机；权重为 0 表示这条不参与抽样（等于临时停用）' },
];

function isValidCycle(name) {
  return CYCLE_NAMES.includes(name);
}

/** 空状态。每次 items 长度变化导致状态失效时回到这里 */
function emptyState() {
  return { cursor: 0, deck: [], recent: [] };
}

/** recent 窗口的上限。超过它就不再有用（见 remember） */
const MAX_RECENT = 200;

/** Fisher-Yates。rng 可注入，便于测试确定化 */
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 把可能已经失效的状态规整到当前 items 长度上。
 *
 * 用户随时可能在设置页增删条目，而状态是上一次运行留下的。与其做版本号，
 * 不如每次取样前就地修正：越界的下标丢掉，游标取模。列表变短时 deck 自然
 * 被过滤空，下一轮重新洗牌。
 *
 * @param {object} state - 会被就地修正
 * @param {number} len - 当前可选条目数
 */
function normalize(state, len) {
  const inRange = (i) => Number.isInteger(i) && i >= 0 && i < len;

  state.deck = (Array.isArray(state.deck) ? state.deck : []).filter(inRange);
  state.recent = (Array.isArray(state.recent) ? state.recent : []).filter(inRange);
  state.cursor = inRange(state.cursor) ? state.cursor : 0;
  return state;
}

/**
 * 「同一句至少间隔 N 次才可复用」的过滤。
 *
 * 若过滤后一条不剩（N 大于等于条目数），约束无法满足 —— 此时**放开约束**
 * 而不是报错：配置本身是合法的，只是在这份列表上无解，返回空结果会让
 * 用户看到"生成失败"，比忽略约束更糟。
 *
 * @param {number[]} candidates - 候选下标
 * @param {number[]} recent - 最近取过的下标（旧 → 新）
 * @param {number} minGap
 * @returns {number[]} 过滤后的候选
 */
function applyReuseGap(candidates, recent, minGap) {
  if (!minGap || minGap <= 0) return candidates;
  const blocked = new Set(recent.slice(-minGap));
  const filtered = candidates.filter(i => !blocked.has(i));
  return filtered.length ? filtered : candidates;
}

/** 记录一次取样，维护 recent 环形窗口 */
function remember(state, index, minGap) {
  // 只保留 minGap 个，避免状态文件无限增长。
  // 这里要封顶：minGapBetweenReuse 的校验只拦负数，用户填 100000 是合法的，
  // 而"保留最近 10 万个"等于永不回收 —— 每生成一条回复就往状态文件追加一个数字，
  // 且每次取样都要复制一遍整个数组（累计 O(n²)）。
  // 超过候选数本身就没有意义：间隔要求比列表还长时 applyReuseGap 会自动放开约束。
  const keep = Math.min(Math.max(0, minGap | 0), MAX_RECENT);
  state.recent = keep ? [...state.recent, index].slice(-keep) : [];
}

/**
 * 取一个下标。
 *
 * @param {object} opts
 * @param {number} opts.len        - 可选条目数（<=0 直接返回 -1）
 * @param {string} opts.cycle      - 四种策略之一，非法值按 'sequential' 处理
 * @param {object} opts.state      - 会被就地更新并持久化
 * @param {number} [opts.minGap]   - 同一项至少间隔多少次才可复用
 * @param {number[]} [opts.weights] - weighted 用的权重，下标与 items 对齐
 * @param {Function} [opts.rng]    - 随机源，默认 Math.random
 * @returns {number} 下标；无可选项时为 -1
 */
function pickIndex(opts) {
  const { len, cycle, state, minGap = 0, weights = null, rng = Math.random } = opts;
  if (!len || len <= 0) return -1;

  normalize(state, len);
  const all = Array.from({ length: len }, (_, i) => i);

  switch (cycle) {
    case 'random': {
      const cand = applyReuseGap(all, state.recent, minGap);
      const idx = cand[Math.floor(rng() * cand.length)];
      remember(state, idx, minGap);
      return idx;
    }

    case 'shuffle-no-repeat': {
      if (!state.deck.length) state.deck = shuffle(all, rng);
      // 洗好的牌堆可能整堆都在 recent 里（列表很短时），此时按原顺序取
      const cand = applyReuseGap(state.deck, state.recent, minGap);
      const idx = cand[0];
      // 从牌堆里摘掉这一次取的（哪怕是重复取的，也保证"用尽再洗"）
      state.deck = state.deck.filter(i => i !== idx);
      remember(state, idx, minGap);
      return idx;
    }

    case 'weighted': {
      // 权重 0 = 这一条不参与抽样（等于临时停用的轻量写法）。
      // 过滤在调用方（fixed.js 的 usableItems）做，这样设置页能直接告诉用户
      // "共 N 条、权重为 0 被排除 M 条"，而不是让取样器悄悄跳过。
      // 这里保留一道兜底：万一传进来的候选权重全是 0，退回等概率，不返回空。
      const w = weights || all.map(() => 1);
      const cand = applyReuseGap(all, state.recent, minGap);
      // 权重可能在累加后溢出成 Infinity（配置层只要求 Number.isFinite 且 >= 0，
      // 1e308 是合法值）。此时 r = rng() * Infinity === Infinity，
      // 循环里 `r < wi` 永假 → idx 保持初值 = 最后一条，**第一条永远抽不到**。
      // 归一化：按最大权重缩放，既保留比例又不会溢出。
      const maxW = cand.reduce((m, i) => Math.max(m, w[i] > 0 ? w[i] : 0), 0);
      const scale = Number.isFinite(maxW) && maxW > 0 ? 1 / maxW : 1;
      const total = cand.reduce((s, i) => s + (w[i] > 0 ? w[i] : 0) * scale, 0);

      let idx;
      if (total <= 0) {
        idx = cand[Math.floor(rng() * cand.length)];
      } else {
        let r = rng() * total;
        idx = cand[cand.length - 1];
        for (const i of cand) {
          const wi = (w[i] > 0 ? w[i] : 0) * scale;
          if (r < wi) { idx = i; break; }
          r -= wi;
        }
      }
      remember(state, idx, minGap);
      return idx;
    }

    case 'sequential':
    default: {
      const cand = applyReuseGap(all, state.recent, minGap);
      // 游标落在候选里就接着走，否则跳到候选中最靠后的一个之后
      const idx = cand.find(i => i >= state.cursor) ?? cand[0];
      state.cursor = (idx + 1) % len;
      remember(state, idx, minGap);
      return idx;
    }
  }
}

module.exports = {
  CYCLE_NAMES,
  CYCLE_INFO,
  isValidCycle,
  pickIndex,
  emptyState,
  // 测试用
  _internal: { shuffle, applyReuseGap, normalize },
};
