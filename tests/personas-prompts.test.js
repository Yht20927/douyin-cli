// tests/personas-prompts.test.js — P4.3 人格配置化 + 提示词编辑器
//
// 不变量：
// 1. 人格 = 内置 + 覆盖 + 自定义 - 停用；未覆盖的字段跟着内置走（不是复制一份）
// 2. 提示词覆盖是**逐文件**的 —— 只改一个模板，其余五个必须仍能读到
// 3. 保存模板会清 prompt-builder 的缓存（否则"改了不生效"，且没有任何提示）
// 4. 恢复默认 = 删掉用户目录那份，而不是写回一份内置副本（否则内置更新永远进不来）
// 5. 模板名不能穿越目录

const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../core/config');
const paths = require('../core/paths');

/**
 * 独立的 dataDir + config.json。人格与提示词都受 dataDir 影响，
 * 所以两者共用这一个环境夹具。
 */
function withTempEnv(fn) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-p43-'));
    const origCfg = process.env.DOUYIN_CONFIG;
    const origData = process.env.DOUYIN_DATA_DIR;
    process.env.DOUYIN_CONFIG = path.join(tmp, 'config.json');
    process.env.DOUYIN_DATA_DIR = tmp;
    config.reset();
    require('../core/personas').resetState();

    try {
      await fn(tmp);
    } finally {
      try { config.reset(); } catch (_) { /* */ }
      try { require('../core/reply-engine/prompt-builder').clearTemplateCache(); } catch (_) { /* */ }
      if (origCfg == null) delete process.env.DOUYIN_CONFIG; else process.env.DOUYIN_CONFIG = origCfg;
      if (origData == null) delete process.env.DOUYIN_DATA_DIR; else process.env.DOUYIN_DATA_DIR = origData;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

describe('人格 / 内置 + 覆盖 + 自定义 - 停用', () => {
  it('默认就是全部内置人格', withTempEnv(async () => {
    const personas = require('../core/personas');
    const eff = personas.effectivePersonas();
    expect(eff.map(p => p.id)).toEqual(personas.BUILTIN.map(p => p.id));
    expect(config.getWarnings()).toEqual([]);
  }));

  it('停用的人格从生效列表里消失，但仍在 includeDisabled 里', withTempEnv(async () => {
    const personas = require('../core/personas');
    const victim = personas.BUILTIN[1].id;

    config.set({ personas: { disabled: [victim] } });

    expect(personas.effectivePersonas().map(p => p.id)).not.toContain(victim);
    expect(personas.effectivePersonas({ includeDisabled: true }).map(p => p.id)).toContain(victim);
  }));

  it('覆盖只作用于写了的字段，未写的仍跟内置走', withTempEnv(async () => {
    const personas = require('../core/personas');
    const target = personas.BUILTIN[0];

    config.set({ personas: { overrides: [{ id: target.id, temperature: 0.99 }] } });

    const got = personas.findPersona(target.id);
    expect(got.temperature).toBe(0.99);
    // 关键：没覆盖的字段必须还是内置值，而不是被整份替换掉
    expect(got.promptPrefix).toBe(target.promptPrefix);
    expect(got.examples).toEqual(target.examples);
    expect(got.weight).toBe(target.weight);
  }));

  it('编辑器看到的是叠加后的生效值，而不是内置原值', withTempEnv(async () => {
    const personas = require('../core/personas');
    const target = personas.BUILTIN[0];
    config.set({ personas: { overrides: [{ id: target.id, name: '改过的名字' }] } });

    // 这正是"展开一个被改过的人格、却看到内置原值，一编辑就把改动盖掉"那个坑
    const all = personas.effectivePersonas({ includeDisabled: true });
    expect(all.find(p => p.id === target.id).name).toBe('改过的名字');
  }));

  it('自定义人格被追加进来，且补齐缺省字段', withTempEnv(async () => {
    const personas = require('../core/personas');
    config.set({ personas: { custom: [{ id: 'mine', promptPrefix: '说话简短' }] } });

    const got = personas.findPersona('mine');
    expect(got).toBeTruthy();
    expect(got.name).toBe('mine');          // 缺省用 id
    expect(got.lengthRange).toEqual([10, 45]);
    expect(got.examples).toEqual([]);
  }));

  it('自定义人格的 id 撞上内置时被忽略（内置优先）', withTempEnv(async () => {
    const personas = require('../core/personas');
    const target = personas.BUILTIN[0];
    config.set({ personas: { custom: [{ id: target.id, name: '冒名顶替', promptPrefix: 'x' }] } });

    const matches = personas.effectivePersonas().filter(p => p.id === target.id);
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe(target.name);
    expect(matches[0].promptPrefix).toBe(target.promptPrefix);
  }));

  it('全部停用时生成仍有人格可用（回退内置全部）', withTempEnv(async () => {
    const personas = require('../core/personas');
    config.set({ personas: { disabled: personas.BUILTIN.map(p => p.id) } });
    expect(personas.effectivePersonas()).toEqual([]);

    const picked = personas.pickPersona();
    expect(picked).toBeTruthy();
    expect(picked.promptPrefix).toBeTruthy();
  }));

  it('pickPersona 的 excludeIds（复数）真的会排除', withTempEnv(async () => {
    const personas = require('../core/personas');
    const banned = personas.effectivePersonas().slice(0, 3).map(p => p.id);

    const seen = new Set();
    for (let i = 0; i < 120; i++) seen.add(personas.pickPersona({ excludeIds: banned }).id);

    // 改造前这里传的 excludeIds 根本没被读过，于是"这批别再用这几个"是空承诺
    for (const id of banned) expect(seen.has(id)).toBe(false);
  }));

  it('写坏的人格设置被逐条丢弃并告警，其余照常生效', withTempEnv(async () => {
    const personas = require('../core/personas');
    const target = personas.BUILTIN[0];

    const r = config.set({
      personas: {
        custom: [
          { id: 'good', promptPrefix: 'ok' },
          { id: 'no_prefix' },                       // 缺少 promptPrefix
          { promptPrefix: '缺 id' },                 // 缺少 id
          { id: 'bad_range', promptPrefix: 'x', lengthRange: [50, 10] },
        ],
      },
    });

    expect(r.warnings.map(w => w.key)).toContain('personas.custom');
    expect(personas.effectivePersonas().map(p => p.id)).toContain('good');
    expect(personas.findPersona('no_prefix')).toBeNull();
    expect(personas.findPersona('bad_range')).toBeNull();
    // 内置的没受影响
    expect(personas.findPersona(target.id)).toBeTruthy();
  }));
});

describe('提示词 / 写入生效但不遮蔽其它模板', () => {
  it('默认全部来自打包目录', withTempEnv(async () => {
    const prompts = require('../core/prompts');
    const list = prompts.list();
    expect(list.length).toBeGreaterThan(0);
    expect(list.every(f => !f.overridden)).toBe(true);
    expect(prompts.read('reply.md').source).toBe('bundled');
  }));

  it('只改一个模板，其余模板仍能读到（逐文件回退）', withTempEnv(async () => {
    const prompts = require('../core/prompts');
    const before = prompts.list().map(f => f.name).sort();

    prompts.save('reply.md', '# 改过的模板\n=== SYSTEM ===\n你是测试\n=== USER ===\n内容');

    const after = prompts.list();
    expect(after.map(f => f.name).sort()).toEqual(before);

    // 这一个变成用户的
    expect(prompts.read('reply.md').source).toBe('user');
    // 其余的仍然读得到，且还是内置的 ——
    // 改造前这里会整目录遮蔽，其余模板读不到 → 生成时静默退化成"没有模板"
    for (const name of before) {
      if (name === 'reply.md') continue;
      const d = prompts.read(name);
      expect(d.exists).toBe(true);
      expect(d.source).toBe('bundled');
    }
  }));

  it('保存会清模板缓存 —— 否则改了要重启才生效', withTempEnv(async () => {
    const prompts = require('../core/prompts');
    const { loadTemplate } = require('../core/reply-engine/prompt-builder');

    // 先读一次，把内置版本缓存起来
    const original = loadTemplate('reply.md');
    expect(original.user).toContain('{');

    prompts.save('reply.md', '=== SYSTEM ===\n新的系统提示\n=== USER ===\n新的用户提示');

    const after = loadTemplate('reply.md');
    expect(after.system).toBe('新的系统提示');
    expect(after.user).toBe('新的用户提示');
  }));

  it('第二次保存会备份上一版；恢复默认后回退到内置', withTempEnv(async () => {
    const prompts = require('../core/prompts');

    expect(prompts.save('reply.md', '=== SYSTEM ===\n第一版\n=== USER ===\nx').backedUp).toBeNull();
    const second = prompts.save('reply.md', '=== SYSTEM ===\n第二版\n=== USER ===\nx');
    expect(second.backedUp).toBeTruthy();
    expect(prompts.listBackups('reply.md')).toHaveLength(1);

    const r = prompts.resetToDefault('reply.md');
    expect(r.removed).toBe(true);
    // 关键：恢复默认是**删掉**用户那份，不是写回一份内置副本 ——
    // 写副本的话内置模板以后更新了永远进不来
    expect(fs.existsSync(path.join(paths.userPromptsDir(), 'reply.md'))).toBe(false);
    const d = prompts.read('reply.md');
    expect(d.source).toBe('bundled');
    expect(d.text).toBe(d.defaultText);
  }));

  it('可以从历史备份恢复', withTempEnv(async () => {
    const prompts = require('../core/prompts');
    prompts.save('reply.md', '=== SYSTEM ===\n旧版\n=== USER ===\nx');
    const { backedUp } = prompts.save('reply.md', '=== SYSTEM ===\n新版\n=== USER ===\nx');

    prompts.restoreBackup('reply.md', backedUp);
    expect(prompts.read('reply.md').text).toContain('旧版');
  }));

  it('拒绝路径穿越的文件名', withTempEnv(async () => {
    const prompts = require('../core/prompts');
    for (const bad of ['../../etc/passwd', '../config.json', 'a/b.md', 'reply.txt', '']) {
      expect(() => prompts.read(bad)).toThrow(/非法的模板文件名/);
      expect(() => prompts.save(bad, 'x')).toThrow(/非法的模板文件名/);
    }
  }));

  it('拒绝空内容（要清空请用"恢复默认"）', withTempEnv(async () => {
    const prompts = require('../core/prompts');
    expect(() => prompts.save('reply.md', '   ')).toThrow(/不能为空/);
  }));

  it('保存时校验格式：缺 === USER === 会被标出来', withTempEnv(async () => {
    const prompts = require('../core/prompts');
    const r = prompts.save('reply.md', '=== SYSTEM ===\n只有系统提示\n');
    expect(r.validated.ok).toBe(false);
    expect(r.validated.issues.some(i => i.message.includes('USER'))).toBe(true);
  }));

  it('备份文件名必须属于该模板才让恢复', withTempEnv(async () => {
    const prompts = require('../core/prompts');
    prompts.save('reply.md', '=== SYSTEM ===\na\n=== USER ===\nx');
    const b = prompts.save('reply.md', '=== SYSTEM ===\nb\n=== USER ===\nx').backedUp;

    // 用一个"格式对但属于别的模板"的名字
    expect(() => prompts.restoreBackup('suggest.md', b)).toThrow(/不是该模板的备份/);
    // 带路径分隔符的名字更早被拒（在 Windows 上 basename 比较挡不住，
    // 所以这里是直接拒绝 '/' 与 '\\'）
    expect(() => prompts.restoreBackup('reply.md', '../../config.json')).toThrow(/不能包含路径/);
    expect(() => prompts.restoreBackup('reply.md', 'reply.md.\\..\\..\\x.bak')).toThrow(/不能包含路径/);
  }));
});

describe('提示词 / 与 validatePrompts 的清单一致', () => {
  it('validatePrompts 列出的是两个目录的并集，不是某一个目录', withTempEnv(async () => {
    const prompts = require('../core/prompts');
    const all = prompts.list().map(f => f.name);
    prompts.save('reply.md', '=== SYSTEM ===\na\n=== USER ===\nx');

    const after = prompts.list().map(f => f.name);
    expect(after.sort()).toEqual(all.sort());

    // 让命令真的跑一遍：它以前是 readdir(promptsDir())，逐文件覆盖下
    // 用户目录只有 1 个文件，会漏掉其余模板
    const validatePrompts = require('../core/commands/validatePrompts');
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.map(String).join(' '));
    try {
      await validatePrompts({}, []);
    } finally {
      console.log = orig;
    }
    const out = lines.join('\n');
    expect(out).toContain('suggest.md');
    expect(out).toContain('reply.md');
  }));
});
