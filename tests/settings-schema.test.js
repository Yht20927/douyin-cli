// tests/settings-schema.test.js — 设置页字段表的覆盖性
//
// 这个测试存在的理由
// ----------------
// 需求(2) 是"尽可能多的人工可配置项"。最容易出的问题不是界面写错，
// 而是**加了配置项却忘了做界面**——它不会报错，只会表现为"这一项在界面上找不到"，
// 而用户根本不知道它存在过。
//
// 所以规则是硬的：core/config 的 DEFAULTS 里每个叶子路径，要么出现在
// GROUPS（界面上能改），要么出现在 NOT_EXPOSED（写明为什么不给改）。
// 两者都没有 → 测试失败。新增配置项时会被强制回答一次"用户能不能改这个"。
//
// 另外这里还钉住两件事：
//   - schema 里不能出现 DEFAULTS 里不存在的路径（拼错的表现是"改了不生效"）
//   - 敏感字段的补丁构造不会把打码值写回去

const config = require('../core/config');

const SCHEMA_URL = '../app/renderer/src/settings/schema.js';
const PATCH_URL = '../app/renderer/src/settings/patch.js';

/**
 * 只有这一个不是配置项，而是一个带副作用的操作按钮（重置循环进度）。
 *
 * 注意别把 fixedItems / imagePaths 也归进来：它们用的是专用控件，
 * 但**确实对应配置路径**，一样要参与覆盖性核对 —— 否则这两个最关键、
 * 最容易忘记做界面的配置项恰好会被漏掉。
 */
const ACTION_TYPES = new Set(['resetCycle']);
/** 取出真正对应配置项的那些字段 */
const configFields = (GROUPS) => GROUPS.flatMap(g => g.fields).filter(f => !ACTION_TYPES.has(f.type));

/**
 * 专用组件（人格 / 提示词编辑器）覆盖的配置路径。
 *
 * 它们不走通用字段渲染，所以覆盖性测试看不到它们 —— 但"看不到"不等于"没做界面"。
 * 各组用 `covers` 显式声明自己负责哪些路径，测试据此放行。
 * 声明了却不改、和改了却不声明，都会在下面被分别抓出来。
 */
const componentCovered = (GROUPS) => GROUPS.flatMap(g => g.covers || []);

async function loadSchema() {
  return import(SCHEMA_URL);
}

function allDraftLeaves() {
  return config.listLeafPaths();
}

function allFieldPaths(GROUPS) {
  return GROUPS.flatMap(g => g.fields.map(f => ({ group: g.key, field: f })));
}

describe('设置页字段表 / 覆盖性', () => {
  it('DEFAULTS 里的每个叶子路径都做了交代（能改，或写明为什么不给改）', async () => {
    const { GROUPS, NOT_EXPOSED } = await loadSchema();

    const exposed = new Set([...configFields(GROUPS).map(f => f.path), ...componentCovered(GROUPS)]);
    const missing = allDraftLeaves().filter(p => !exposed.has(p) && !(p in NOT_EXPOSED));

    expect(missing).toEqual([]);
  });

  it('schema 里的路径都真实存在于 DEFAULTS（拼错会表现为"改了不生效"）', async () => {
    const { GROUPS } = await loadSchema();
    const valid = new Set(allDraftLeaves());

    const bogus = [...configFields(GROUPS).map(f => f.path), ...componentCovered(GROUPS)]
      .filter(p => !valid.has(p));

    expect(bogus).toEqual([]);
  });

  it('同一个路径不会既在界面上又在"不暴露"清单里', async () => {
    const { GROUPS, NOT_EXPOSED } = await loadSchema();
    const exposed = new Set([...allFieldPaths(GROUPS).map(f => f.field.path), ...componentCovered(GROUPS)]);

    const conflict = Object.keys(NOT_EXPOSED).filter(p => exposed.has(p));
    expect(conflict).toEqual([]);
  });

  it('专用组件声明的 covers 不会与 fields 重复', async () => {
    const { GROUPS } = await loadSchema();
    const fieldPaths = new Set(allFieldPaths(GROUPS).map(f => f.field.path));

    const dup = componentCovered(GROUPS).filter(p => fieldPaths.has(p));
    expect(dup).toEqual([]);
  });

  it('有 component 的分组必须显式声明 covers（哪怕是空数组）', async () => {
    const { GROUPS } = await loadSchema();
    const missing = GROUPS
      .filter(g => g.component && !Array.isArray(g.covers))
      .map(g => g.key);
    expect(missing).toEqual([]);
  });

  it('"不暴露"清单里的路径也真实存在，且每条都写了理由', async () => {
    const { NOT_EXPOSED } = await loadSchema();
    const valid = new Set(allDraftLeaves());

    for (const [path, reason] of Object.entries(NOT_EXPOSED)) {
      expect(valid.has(path)).toBe(true);
      // 理由要是一句能看懂的话，不是占位符
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(15);
    }
  });

  it('路径与分组 key 都不重复', async () => {
    const { GROUPS } = await loadSchema();

    const groupKeys = GROUPS.map(g => g.key);
    expect(new Set(groupKeys).size).toBe(groupKeys.length);

    const paths = allFieldPaths(GROUPS).map(f => f.field.path);
    expect(new Set(paths).size).toBe(paths.length);

    const covered = componentCovered(GROUPS);
    expect(new Set(covered).size).toBe(covered.length);
  });

  it('每个字段都有标签；枚举类型必须有可选项', async () => {
    const { GROUPS } = await loadSchema();

    for (const { field } of allFieldPaths(GROUPS)) {
      expect(field.label).toBeTruthy();
      if (field.type === 'enum') {
        expect(Array.isArray(field.options)).toBe(true);
        expect(field.options.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('设置页字段表 / 与实际消费点一致', () => {
  it('回复模式的枚举值就是核心认的那三种', async () => {
    const { GROUPS } = await loadSchema();
    const field = allFieldPaths(GROUPS).find(f => f.field.path === 'reply.mode').field;
    expect(field.options.map(o => o.value).sort()).toEqual([...config.REPLY_MODES].sort());
  });

  it('循环方式的枚举值就是取样器实现的那四种（两处不能各写一份）', async () => {
    const { GROUPS } = await loadSchema();
    const { CYCLE_NAMES } = require('../core/reply-source/cycles');

    for (const path of ['reply.fixed.cycle', 'reply.image.pick']) {
      const field = allFieldPaths(GROUPS).find(f => f.field.path === path).field;
      expect(field.options.map(o => o.value).sort()).toEqual([...CYCLE_NAMES].sort());
    }
  });

  it('敏感字段用的是密码控件，不会明文回显', async () => {
    const { GROUPS } = await loadSchema();
    for (const key of config.SENSITIVE_KEYS) {
      const found = allFieldPaths(GROUPS).find(f => f.field.path === key);
      if (!found) continue; // 没做界面的敏感项由"不暴露"清单兜着
      expect(found.field.type).toBe('password');
    }
  });
});

describe('设置页 / 补丁构造（打码值绝不回写）', () => {
  async function patchModule() {
    return import(PATCH_URL);
  }

  it('敏感字段在草稿里留空，不会被提交', async () => {
    const { buildPatch } = await patchModule();
    const draft = { 'llm.api_key': '', 'llm.model': 'gpt-4o-mini' };
    const patch = buildPatch(['llm.api_key', 'llm.model'], draft, ['llm.api_key']);

    expect(patch.llm.api_key).toBeUndefined();
    expect(patch.llm.model).toBe('gpt-4o-mini');
  });

  it('敏感字段填了新值就会被提交', async () => {
    const { buildPatch } = await patchModule();
    const patch = buildPatch(['llm.api_key'], { 'llm.api_key': 'sk-new' }, ['llm.api_key']);
    expect(patch.llm.api_key).toBe('sk-new');
  });

  it('flatten 不把打码文案预填进草稿', async () => {
    const { flatten } = await patchModule();
    const described = {
      llm: { api_key: '***已设置（48 字符）***', model: 'gpt-4o-mini' },
      bridge: { token: '***已设置（40 字符）***' },
    };
    const draft = flatten(described, ['llm.api_key', 'bridge.token']);

    expect(draft['llm.api_key']).toBe('');
    expect(draft['bridge.token']).toBe('');
    expect(draft['llm.model']).toBe('gpt-4o-mini');
  });

  it('补丁按点号路径拼成嵌套对象，数组整体替换', async () => {
    const { buildPatch } = await patchModule();
    const draft = { 'intervals.write': [60, 90], 'reply.fixed.items': [{ text: 'A' }] };
    const patch = buildPatch(['intervals.write', 'reply.fixed.items'], draft);

    expect(patch).toEqual({
      intervals: { write: [60, 90] },
      reply: { fixed: { items: [{ text: 'A' }] } },
    });
  });
});

describe('core/config 侧的打码值防线', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  function withTempConfig(fn) {
    return () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-cfg-settings-'));
      const orig = process.env.DOUYIN_CONFIG;
      process.env.DOUYIN_CONFIG = path.join(tmp, 'config.json');
      config.reset();
      try { return fn(tmp); } finally {
        config.reset();
        if (orig == null) delete process.env.DOUYIN_CONFIG; else process.env.DOUYIN_CONFIG = orig;
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    };
  }

  it('把打码文案当 api_key 提交会被拒绝', withTempConfig(() => {
    config.set({ llm: { api_key: 'sk-real-key' } });
    expect(() => config.set({ llm: { api_key: '***已设置（11 字符）***' } }))
      .toThrow(/打码后的占位符/);
    // 原值必须还在 —— 拒绝要是真的拒绝，不能"抛错了但已经写进去"
    expect(config.get('llm.api_key')).toBe('sk-real-key');
  }));

  it('describe() 给出的打码值同样挡住 bridge.token', withTempConfig(() => {
    config.set({ bridge: { token: 'abcdef123456' } });
    const d = config.describe();
    expect(() => config.set({ bridge: { token: d.config.bridge.token } })).toThrow(/打码后的占位符/);
  }));

  it('describe() 会下发默认值，供界面逐项恢复默认', withTempConfig(() => {
    const d = config.describe();
    expect(d.defaults.intervals.write).toEqual([40, 55]);
    expect(d.defaults.reply.mode).toBe('ai');
    // 敏感项的默认值是空串，不泄露任何东西
    expect(d.defaults.llm.api_key).toBe('');
  }));
});
