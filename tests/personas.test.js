// tests/personas.test.js — 人格模板池

const {
  pickPersona, buildSystemPrompt, buildUserPrefix,
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

  it('buildSystemPrompt 含长度区间与 AI 特征词禁令', () => {
    const p = findPersona('casual_friend');
    const s = buildSystemPrompt(p, '自然亲切');
    expect(s).toContain(p.promptPrefix);
    expect(s).toContain(`${p.lengthRange[0]}-${p.lengthRange[1]}`);
    expect(s).toContain('绝对禁止出现以下 AI 特征词');
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

  it('findPersona 未知 id 返回 null', () => {
    expect(findPersona('no_such_persona')).toBeNull();
    expect(findPersona('casual_friend')).not.toBeNull();
  });
});
