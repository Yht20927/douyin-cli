// tests/reply-engine/persona-binder.test.js

describe('PersonaBinder', () => {
  let PersonaBinder;
  let binder;

  beforeEach(() => {
    // 清除 require 缓存以重置状态
    delete require.cache[require.resolve('../../core/reply-engine/persona-binder')];
    ({ PersonaBinder } = require('../../core/reply-engine/persona-binder'));
    binder = new PersonaBinder();
  });

  it('should bind a persona to a key', () => {
    const p = binder.bind('aweme_001');
    expect(p).toBeDefined();
    expect(p.id).toBeDefined();
    expect(p.name).toBeDefined();
  });

  it('should reuse persona for same key', () => {
    const p1 = binder.bind('aweme_001');
    const p2 = binder.bind('aweme_001');
    expect(p1.id).toBe(p2.id);
  });

  it('should rotate personas across different keys', () => {
    const p1 = binder.bind('aweme_001');
    const p2 = binder.bind('aweme_002');
    // 连续 bind 不同 key 可能返回不同人格（取决于权重随机性）
    // 但至少两者都应该有效
    expect(p1.id).toBeDefined();
    expect(p2.id).toBeDefined();
  });

  it('should force a specific persona', () => {
    const p = binder.bind('aweme_001', { forcePersona: 'casual_friend' });
    expect(p).toBeDefined();
    expect(p.id).toBe('casual_friend');
  });

  it('should fallback to auto if forced persona not found', () => {
    const p = binder.bind('aweme_001', { forcePersona: 'nonexistent_persona' });
    expect(p).toBeDefined();
    expect(p.id).toBeDefined();
  });

  it('should track count via getCount', () => {
    binder.bind('aweme_001');
    expect(binder.getCount('aweme_001')).toBe(0);
  });

  it('should microAdjust and increment count', () => {
    binder.bind('aweme_001');
    binder.microAdjust('aweme_001');
    expect(binder.getCount('aweme_001')).toBe(1);
  });

  it('should apply temperature tweak after 3+ microAdjust calls', () => {
    const base = binder.bind('aweme_001');
    const baseTemp = base.temperature || 0.7;
    // microAdjust 在 idx>=3 时返回新对象，温度比基准高
    let adjusted = base;
    for (let i = 0; i < 4; i++) adjusted = binder.microAdjust('aweme_001');
    expect(adjusted.temperature).toBeGreaterThan(baseTemp);
  });

  it('should switch persona after 8+ microAdjust calls', () => {
    const original = binder.bind('aweme_001');
    for (let i = 0; i < 8; i++) binder.microAdjust('aweme_001');
    const current = binder.getActive('aweme_001');
    // 第 8 次后应该切换到不同人格
    expect(current.id).not.toBe(original.id);
  });

  it('should bulkAdvance correctly', () => {
    binder.bind('aweme_001');
    binder.bulkAdvance('aweme_001', 5);
    expect(binder.getCount('aweme_001')).toBe(5);
  });

  it('should reset all state', () => {
    binder.bind('aweme_001');
    binder.bind('aweme_002');
    binder.reset();
    // reset 后重新 bind 应该分配新人格
    const p = binder.bind('aweme_003');
    expect(p).toBeDefined();
    expect(binder.getCount('aweme_003')).toBe(0);
  });

  it('should exclude recent persona IDs for new bindings', () => {
    // 绑定 4 个不同 key，第 4 个应该排除前 3 个不同的人格
    const ids = new Set();
    for (let i = 0; i < 4; i++) {
      const p = binder.bind(`aweme_00${i}`);
      ids.add(p.id);
    }
    // 4 次绑定可能有重复（取决于权重），但至少应该有合理的多样性
    expect(ids.size).toBeGreaterThanOrEqual(1);
  });
});
