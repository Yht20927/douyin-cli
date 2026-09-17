// lib/reply-engine/persona-binder.js — 人格绑定器
//
// 视频级人格绑定 + 微调，替代全局随机 pickPersona()。
// 核心规则：
// - 同一绑定 key（默认 awemeId）复用同人格
// - 新 key 自动轮换人格（排除最近 3 个使用过的人格）
// - 同 key 内连续生成回复时，microAdjust 微妙改变温度/emoji 倾向
// - 第 8 条起切换到相似人格，避免单一风格疲劳
//
// 从 xiaohongshu-cli 移植，平台无关通用设计。

const { pickPersona, findPersona } = require('../personas');

class PersonaBinder {
  constructor() {
    this._bindings = new Map();   // key → persona
    this._recentKeys = [];        // 最近绑定的 key（用于跨 key 轮换）
    this._indices = new Map();    // key → 已生成回复数
  }

  /**
   * 为指定 key 绑定人格。
   * @param {string} key — 绑定键，默认用 awemeId
   * @param {object} [opts]
   * @param {string} [opts.forcePersona] — 强制指定人格 id
   * @param {string[]} [opts.excludeIds] — 额外排除的人格
   * @returns {object} persona
   */
  bind(key, opts = {}) {
    // 强制指定人格
    if (opts.forcePersona) {
      const p = findPersona(opts.forcePersona);
      if (p) {
        this._bindings.set(key, p);
        if (!this._recentKeys.includes(key)) {
          this._recentKeys.push(key);
          this._trimRecentKeys();
        }
        if (!this._indices.has(key)) this._indices.set(key, 0);
        return p;
      }
      // 人格不存在时告警
      console.warn(`[PersonaBinder] 人格 "${opts.forcePersona}" 不存在，回退到自动选择`);
    }

    // 已绑定 → 复用
    if (this._bindings.has(key)) {
      return this._bindings.get(key);
    }

    // 新绑定 → 轮换人格
    const recentIds = this._recentKeys.slice(-3)
      .map(k => this._bindings.get(k)?.id)
      .filter(Boolean);

    const excludeIds = [...new Set([...recentIds, ...(opts.excludeIds || [])])];
    const persona = pickPersona({ excludeIds: excludeIds.length ? excludeIds : undefined });

    this._bindings.set(key, persona);
    this._recentKeys.push(key);
    this._trimRecentKeys();
    this._indices.set(key, 0);

    return persona;
  }

  /** 裁剪 _recentKeys，只保留最近 20 个（防止内存泄漏） */
  _trimRecentKeys() {
    if (this._recentKeys.length > 20) {
      const removed = this._recentKeys.splice(0, this._recentKeys.length - 20);
      for (const k of removed) {
        this._indices.delete(k);
      }
      const recentSet = new Set(this._recentKeys);
      for (const k of this._bindings.keys()) {
        if (!recentSet.has(k)) {
          this._bindings.delete(k);
        }
      }
    }
  }

  /**
   * 获取已绑定的人格（不创建新绑定）。
   */
  getActive(key) {
    return this._bindings.get(key) || null;
  }

  /**
   * 批量推进：跳过 N 条而不实际执行微调，仅更新内部计数器。
   * 用于子批次场景——一次 LLM 调用生成了 N 条回复，不需要逐条微调。
   */
  bulkAdvance(key, count) {
    const idx = this._indices.get(key) || 0;
    this._indices.set(key, idx + count);
    return this.getActive(key);
  }

  /**
   * 同 key 内微调：连续生成回复时微妙改变温度/emoji 倾向。
   * - 前 3 条：基准 persona
   * - 第 4-6 条：微调温度（+0.02/条）
   * - 第 7+ 条：切换到相似人格（第8次调用触发）
   */
  microAdjust(key) {
    const base = this._bindings.get(key);
    if (!base) return null;

    const idx = this._indices.get(key) || 0;
    this._indices.set(key, idx + 1);

    // 第 8 条起（idx >= 7），切换到相似人格避免疲劳
    if (idx >= 7) {
      const newPersona = pickPersona({ excludeId: base.id });
      this._bindings.set(key, newPersona);
      this._indices.set(key, 0); // 重置计数
      return newPersona;
    }

    // 第 4-6 条，微调温度
    if (idx >= 3) {
      return {
        ...base,
        temperature: Math.min(0.95, (base.temperature || 0.7) + 0.02 * (idx - 2)),
        emojiChance: Math.max(0.1, (base.emojiChance || 0.5) - 0.03 * (idx - 2)),
      };
    }

    return base;
  }

  /**
   * 获取当前计数（用于外部判断是否需要微调）。
   */
  getCount(key) {
    return this._indices.get(key) || 0;
  }

  /**
   * 重置所有状态。
   */
  reset() {
    this._bindings.clear();
    this._recentKeys.length = 0;
    this._indices.clear();
  }
}

module.exports = { PersonaBinder };
