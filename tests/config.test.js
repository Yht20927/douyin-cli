// tests/config.test.js — 配置单一真源
//
// 不变量（对应改造前的三个问题）：
// 1. 缺字段时从 DEFAULTS 补齐，不再各处自己写 `|| 兜底`
// 2. 非法值回退默认**并产生告警**，不再静默回退
// 3. 改配置立即生效（改造前 risk-control 有模块级 _config 缓存，不重启进程读不到）

const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../core/config');
const paths = require('../core/paths');

/** 在独立的临时 config.json 上跑，避免污染真实配置 */
function withTempConfig(initial, fn) {
  return () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-cfg-'));
    const file = path.join(tmp, 'config.json');
    if (initial !== undefined) {
      fs.writeFileSync(file, typeof initial === 'string' ? initial : JSON.stringify(initial, null, 2));
    }
    const orig = process.env.DOUYIN_CONFIG;
    process.env.DOUYIN_CONFIG = file;
    config.reset();
    try {
      return fn(file, tmp);
    } finally {
      config.reset();
      if (orig == null) delete process.env.DOUYIN_CONFIG;
      else process.env.DOUYIN_CONFIG = orig;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

function readFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('默认值合并', () => {
  it('配置文件不存在时全部走默认值，不抛错', withTempConfig(undefined, () => {
    expect(config.get('bridge.port')).toBe(19422);
    expect(config.get('llm.model')).toBe('gpt-4o-mini');
    expect(config.get('intervals.write')).toEqual([40, 55]);
    expect(config.getWarnings()).toEqual([]);
  }));

  it('用户只写部分字段，其余从默认值补齐（深合并）', withTempConfig({
    llm: { model: 'my-model' },
  }, () => {
    expect(config.get('llm.model')).toBe('my-model');
    // 同层的其他字段仍从默认值来
    expect(config.get('llm.max_tokens')).toBe(4096);
    expect(config.get('llm.base_url')).toBe('https://api.openai.com/v1');
    // 其他分支不受影响
    expect(config.get('bridge.port')).toBe(19422);
  }));

  it('config.json 内容非法 JSON 时不抛错，回退默认并告警', withTempConfig('{ 这不是 json', () => {
    expect(config.get('bridge.port')).toBe(19422);
    expect(config.getWarnings().some(w => w.key === '(file)')).toBe(true);
  }));
});

describe('校验与告警', () => {
  it('intervals 全 0 → 回退默认并告警（改造前是静默回退）', withTempConfig({
    intervals: { write: [0, 0] },
  }, () => {
    expect(config.get('intervals.write')).toEqual([40, 55]);
    const w = config.getWarnings().find(x => x.key === 'intervals.write');
    expect(w).toBeTruthy();
    expect(w.message).toContain('两个正数');
  }));

  it('intervals 顺序颠倒 → 自动纠正并告警', withTempConfig({
    intervals: { write: [55, 40] },
  }, () => {
    expect(config.get('intervals.write')).toEqual([40, 55]);
    expect(config.getWarnings().some(w => w.key === 'intervals.write')).toBe(true);
  }));

  it('端口越界 → 回退默认', withTempConfig({ bridge: { port: 99999 } }, () => {
    expect(config.get('bridge.port')).toBe(19422);
    expect(config.getWarnings().some(w => w.key === 'bridge.port')).toBe(true);
  }));

  it('multimodal.mode 非法枚举 → 回退 text-only', withTempConfig({
    multimodal: { mode: 'telepathy' },
  }, () => {
    expect(config.get('multimodal.mode')).toBe('text-only');
    expect(config.getWarnings().length).toBeGreaterThan(0);
  }));
});

describe('get 返回深拷贝（调用方改动不污染缓存）', () => {
  it('改返回的对象不影响后续读取', withTempConfig({ intervals: { write: [10, 20] } }, () => {
    const a = config.get('intervals.write');
    a[0] = 999;
    expect(config.get('intervals.write')).toEqual([10, 20]);
  }));

  it('改整份快照也不影响缓存', withTempConfig({ bridge: { port: 12345 } }, () => {
    const snap = config.get();
    snap.bridge.port = 1;
    expect(config.get('bridge.port')).toBe(12345);
  }));
});

describe('set() 写入行为', () => {
  it('深合并写入并立即生效（无需重启进程）', withTempConfig({ llm: { model: 'old' } }, (file) => {
    expect(config.get('llm.model')).toBe('old');
    config.set({ llm: { model: 'new' } });
    expect(config.get('llm.model')).toBe('new');
    expect(readFile(file).llm.model).toBe('new');
    // 同层未提及的字段不被清掉
    expect(config.get('llm.base_url')).toBe('https://api.openai.com/v1');
  }));

  it('不把默认值固化进文件（便于以后调整默认值）', withTempConfig(undefined, (file) => {
    config.set({ llm: { model: 'x' } });
    const onDisk = readFile(file);
    expect(onDisk).toEqual({ llm: { model: 'x' } });
    expect(onDisk.bridge).toBeUndefined();
    expect(onDisk.intervals).toBeUndefined();
  }));

  it('保留用户自己加的未知字段', withTempConfig({
    myOwnField: { a: 1 },
  }, (file) => {
    config.set({ llm: { model: 'x' } });
    expect(readFile(file).myOwnField).toEqual({ a: 1 });
  }));

  it('非法值被修正后才落盘（文件里不留非法值）', withTempConfig(undefined, (file) => {
    const { warnings } = config.set({ intervals: { write: [-1, -2] } });
    // 内存里是回退后的合法值
    expect(config.get('intervals.write')).toEqual([40, 55]);
    // 落盘的也是修正后的值
    expect(readFile(file).intervals.write).toEqual([40, 55]);
    // 调用方被告知改了什么（设置页据此提示用户）
    expect(warnings.some(w => w.key === 'intervals.write')).toBe(true);
  }));

  it('修正只影响非法键，不动 patch 里的其他字段', withTempConfig(undefined, (file) => {
    config.set({ intervals: { write: [0, 0] }, llm: { model: 'keep-me' } });
    const onDisk = readFile(file);
    expect(onDisk.intervals.write).toEqual([40, 55]);
    expect(onDisk.llm.model).toBe('keep-me');
  }));

  it('set 非对象参数抛 TypeError', withTempConfig(undefined, () => {
    expect(() => config.set('nope')).toThrow(TypeError);
  }));
});

describe('reload()', () => {
  it('外部改动文件后 reload 能读到新值', withTempConfig({ llm: { model: 'before' } }, (file) => {
    expect(config.get('llm.model')).toBe('before');
    fs.writeFileSync(file, JSON.stringify({ llm: { model: 'after' } }));
    // 未 reload 前仍是缓存值
    expect(config.get('llm.model')).toBe('before');
    config.reload();
    expect(config.get('llm.model')).toBe('after');
  }));
});

describe('describe() 脱敏', () => {
  it('api_key 与 bridge.token 被打码，不泄露原文', withTempConfig({
    llm: { api_key: 'sk-super-secret-value' },
    bridge: { token: 'tok-abcdef' },
  }, () => {
    const d = config.describe();
    expect(d.config.llm.api_key).toContain('***');
    expect(d.config.llm.api_key).not.toContain('sk-super-secret-value');
    expect(d.config.bridge.token).toContain('***');
    expect(d.config.bridge.token).not.toContain('tok-abcdef');
    // 非敏感字段正常展示
    expect(d.config.llm.model).toBe('gpt-4o-mini');
    expect(d.file).toBe(paths.configFile());
  }));

  it('未设置的敏感字段不打码成占位符', withTempConfig(undefined, () => {
    const d = config.describe();
    expect(d.config.llm.api_key).toBe('');
  }));
});

describe('与其他模块的联动（回归：改造前的缓存 bug）', () => {
  it('risk-control.getIntervals() 随配置热更新，无需重启', withTempConfig({
    intervals: { write: [40, 55] },
  }, () => {
    const rc = require('../core/risk-control');
    expect(rc.getIntervals().write).toEqual([40, 55]);

    config.set({ intervals: { write: [90, 120] } });

    // 改造前 risk-control 有模块级 _config 缓存，这里会仍然返回 [40,55]
    expect(rc.getIntervals().write).toEqual([90, 120]);
  }));

  it('LLMClient 每次构造重新读配置', withTempConfig({
    llm: { model: 'model-a', api_key: 'k' },
  }, () => {
    // LLMClient 的优先级是 环境变量 > config，测试期间需排除环境变量干扰
    const origModel = process.env.OPENAI_MODEL;
    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    delete process.env.OPENAI_API_KEY;
    try {
      const { LLMClient } = require('../core/llm');
      expect(new LLMClient().model).toBe('model-a');
      config.set({ llm: { model: 'model-b' } });
      expect(new LLMClient().model).toBe('model-b');
    } finally {
      if (origModel != null) process.env.OPENAI_MODEL = origModel;
      if (origKey != null) process.env.OPENAI_API_KEY = origKey;
    }
  }));
});
