// tests/personas.test.js — 人格模板池

const {
  pickPersona, buildSystemPrompt, buildUserPrefix,
  effectiveLengthRange,
  getTemperature, listPersonas, findPersona, resetState, PERSONAS,
} = require('../core/personas');

describe('personas', () => {
  beforeEach(() => resetState());

  it('共 7 种人格，权重为正且 id 唯一', () => {
    expect(PERSONAS).toHaveLength(7);
    const ids = new Set(PERSONAS.map(p => p.id));
    expect(ids.size).toBe(7);
    for (const p of PERSONAS) expect(p.weight).toBeGreaterThan(0);
  });

  it('pickPersona 不与上一次重复（连续抽取）', () => {
    const seen = [];
    for (let i = 0; i < 50; i++) {
      const p = pickPersona();
      if (seen.length && p.id === seen[seen.length - 1]) {
        // 唯一允许的例外：只剩一个候选
        throw new Error(`连续两次抽到同一人格: ${p.id}`);
      }
      seen.push(p.id);
    }
  });

  it('excludeId 生效', () => {
    for (let i = 0; i < 30; i++) {
      const p = pickPersona({ excludeId: 'casual_friend' });
      expect(p.id).not.toBe('casual_friend');
    }
  });

  it('buildSystemPrompt 含长度区间与禁用词清单', () => {
    const p = findPersona('casual_friend');
    const s = buildSystemPrompt(p, '自然亲切');
    expect(s).toContain(p.promptPrefix);
    // 区间断言必须走 effectiveLengthRange，**不能**直接用人格的 lengthRange：
    // 最终写进 prompt 的是"设置页的期望 ∩ 人格风格 ∩ validateReply 的上下限"，
    // 人格自带的那个数只在三者恰好相容时才等于它 —— 直接断言人格区间会随
    // 操作者改设置页而假红（或更糟：写进去的不是校验会用的那个数）。
    const [lo, hi] = effectiveLengthRange(p);
    expect(s).toContain(`回复长度控制在 ${lo}-${hi} 字之间`);
    // 措辞从「AI 特征词」改成「词」：现在这份清单还把操作者维护的
    // forbiddenPhrases / forbiddenClaims 并了进来，它们不都是"AI 特征词"，
    // 而是 validateReply 发布前真正会拦的那些
    expect(s).toContain('绝对禁止出现以下词');
    for (const w of p.forbiddenWords) expect(s).toContain(w);
    expect(s).toContain('自然亲切');
  });

  it('buildUserPrefix 无示例时返回空串，有示例时含全部样例', () => {
    expect(buildUserPrefix({ examples: [] })).toBe('');
    const p = findPersona('brief_reactor');
    const prefix = buildUserPrefix(p);
    for (const ex of p.examples) expect(prefix).toContain(ex);
  });

  it('getTemperature 在 [0.1, 1.0] 内且围绕人格基础值抖动', () => {
    for (let i = 0; i < 100; i++) {
      const t = getTemperature(findPersona('humor_maker')); // base 0.85
      expect(t).toBeGreaterThanOrEqual(0.1);
      expect(t).toBeLessThanOrEqual(1.0);
    }
  });

  it('listPersonas 只暴露 id/name/weight（不泄漏 prompt 细节）', () => {
    const list = listPersonas();
    expect(list).toHaveLength(7);
    for (const item of list) {
      expect(Object.keys(item).sort()).toEqual(['id', 'name', 'weight']);
    }
  });

  // 界面第一行字就是这些名字，受众是不懂技术的运营者 ——
  // 曾经有一个写成中英混排的 'casual 朋友'，跟其余六个纯中文的并排看像内部 id 泄漏。
  it('内置人格的显示名全是纯中文且互不重复', () => {
    const names = listPersonas().map(p => p.name);
    expect(names).toHaveLength(7);
    for (const n of names) {
      expect(n).toBeTruthy();
      expect(n).not.toMatch(/[A-Za-z]/);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('findPersona 未知 id 返回 null', () => {
    expect(findPersona('no_such_persona')).toBeNull();
    expect(findPersona('casual_friend')).not.toBeNull();
  });
});
