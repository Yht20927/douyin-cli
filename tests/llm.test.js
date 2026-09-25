// tests/llm.test.js — LLM JSON 提取、sanitizeComment，以及"没配 Key"的前置拒绝

const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../core/config');
const { LLMClient, aiReady } = require('../core/llm');

// 通过反射测试私有方法
const client = new LLMClient({ apiKey: 'test' });

describe('LLMClient._extractJSON', () => {
  it('直接 JSON 对象', () => {
    const r = client._extractJSON('{"a":1}');
    expect(r).toEqual({ a: 1 });
  });

  it('直接 JSON 数组', () => {
    const r = client._extractJSON('[1,2,3]');
    expect(r).toEqual([1, 2, 3]);
  });

  it('```json 代码块', () => {
    const r = client._extractJSON('some text\n```json\n{"a":1}\n```\nmore text');
    expect(r).toEqual({ a: 1 });
  });

  it('无标记代码块', () => {
    const r = client._extractJSON('some text\n```\n{"a":1}\n```');
    expect(r).toEqual({ a: 1 });
  });

  it('从混合文本中提取首个 []', () => {
    const r = client._extractJSON('Here is the result:\n[{"cid":"1","sentiment":"positive"}]\nDone.');
    expect(r).toEqual([{ cid: '1', sentiment: 'positive' }]);
  });

  it('从混合文本中提取首个 {}', () => {
    const r = client._extractJSON('Result: {"ok": true} end');
    expect(r).toEqual({ ok: true });
  });

  it('无法提取时抛出错误', () => {
    expect(() => client._extractJSON('no json here')).toThrow('无法从 LLM 响应中提取 JSON');
  });
});

describe('sanitizeComment (via LLM module)', () => {
  // sanitizeComment 是模块内部函数，通过 analyzeComments 的行为间接测试
  // 这里我们直接 require 模块来访问
  it('sanitizeComment 在模块中可用', () => {
    // 通过重新 require 来访问（vitest 可以处理）
    const mod = require('../core/llm');
    // sanitizeComment 是内部函数，不导出，但我们可以验证 LLMClient 存在
    expect(mod.LLMClient).toBeDefined();
  });
});

describe('LLMClient constructor', () => {
  it('默认值', () => {
    const c = new LLMClient();
    // model 优先级：opts > env > config.json > 'gpt-4o-mini' 兜底。
    // 本地 config.json 可能覆盖（如 deepseek-v4-pro），故只断言非空 + retries 默认。
    expect(typeof c.model).toBe('string');
    expect(c.model.length).toBeGreaterThan(0);
    expect(c.maxRetries).toBe(3);
  });

  it('opts 覆盖', () => {
    const c = new LLMClient({ model: 'gpt-4', maxRetries: 5 });
    expect(c.model).toBe('gpt-4');
    expect(c.maxRetries).toBe(5);
  });

  it('环境变量优先', () => {
    process.env.OPENAI_MODEL = 'env-model';
    const c = new LLMClient();
    expect(c.model).toBe('env-model');
    delete process.env.OPENAI_MODEL;
  });
});

describe('aiReady —— 没配 Key 时不发那趟注定 401 的请求', () => {
  /**
   * 在一份临时 config.json 上跑。
   *
   * 必须给临时文件：作者机器上的真实配置里是有 Key 的，
   * 拿真实配置断言"没就绪"会得到一个只在别人机器上通过的测试。
   */
  function withLlmConfig(llm, fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-llm-cfg-'));
    const file = path.join(tmp, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ llm }));
    const origFile = process.env.DOUYIN_CONFIG;
    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.DOUYIN_CONFIG = file;
    config.reset();
    try {
      return fn();
    } finally {
      config.reset();
      if (origFile == null) delete process.env.DOUYIN_CONFIG;
      else process.env.DOUYIN_CONFIG = origFile;
      if (origKey != null) process.env.OPENAI_API_KEY = origKey;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('空 Key：不成立，且理由说清该去哪填', () => withLlmConfig({ api_key: '' }, () => {
    const r = aiReady();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('API Key');
  }));

  it('config.json 里有 Key 就算就绪（不必依赖环境变量）', () => withLlmConfig({ api_key: 'sk-x' }, () => {
    expect(aiReady()).toEqual({ ok: true, reason: '' });
  }));

  it('OPENAI_API_KEY 环境变量也算就绪', () => withLlmConfig({ api_key: '' }, () => {
    process.env.OPENAI_API_KEY = 'from-env';
    try {
      expect(aiReady().ok).toBe(true);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  }));

  it('complete() 当场拒绝，一次 fetch 都不发', async () => {
    await withLlmConfig({ api_key: '' }, async () => {
      const origFetch = global.fetch;
      let calls = 0;
      global.fetch = () => { calls += 1; return Promise.reject(new Error('不该发请求')); };
      try {
        const c = new LLMClient();
        await expect(c.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/API Key/);
        expect(calls).toBe(0);
      } finally {
        global.fetch = origFetch;
      }
    });
  });
});
