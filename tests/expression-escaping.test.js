// tests/expression-escaping.test.js — 拼进 Bridge 表达式的文本必须安全
//
// 回归背景
// --------
// 命令把「一段 JS 表达式」经 Bridge 发到浏览器页面里 eval，参数是拼进这段
// 表达式字符串的。escapeExpression 原本只转义 `\` 和 `'`，**漏了换行**，
// 于是任何含换行的回复内容都会让表达式出现未转义的换行，浏览器侧报
//   SyntaxError: string literal contains an unescaped line break
// 发布直接失败。而 AI 生成的回复里带换行相当常见。
//
// 这里不只测转义函数本身，更要**把命令真正拼出来的表达式拿去解析** ——
// 转义函数再对，只要调用点绕过它就白搭。

const fs = require('fs');
const path = require('path');
const os = require('os');

const { escapeExpression } = require('../core/commands/helpers');
const config = require('../core/config');

// ═══════════════════════════════════════════════════════════
// 转义函数本身
// ═══════════════════════════════════════════════════════════

/** 模拟调用方的用法：把转义结果放进单引号里，解析回来应完全等于原文 */
function roundTrip(value) {
  const src = `f('${escapeExpression(value)}')`;
  return new Function('f', `return ${src}`)((x) => x);
}

describe('escapeExpression 往返', () => {
  const cases = {
    '普通文本': '谢谢支持',
    '换行': '第一行\n第二行',
    '回车换行': 'a\r\nb',
    '单引号': "it's fine",
    '双引号': 'he said "hi"',
    '反斜杠': 'C:\\path\\to',
    '制表符': 'a\tb',
    '换行分隔符 U+2028': 'a\u2028b',
    '段落分隔符 U+2029': 'a\u2029b',
    '反引号': 'a ` b',
    '模板占位符 ${}': 'a ${x} b',
    '混合': "多行'文本'\\带引号\n第二行\t结束",
    'emoji': '感谢支持 🌹❤️',
    '空字符串': '',
  };

  for (const [name, input] of Object.entries(cases)) {
    it(name, () => {
      expect(roundTrip(input)).toBe(input);
    });
  }

  it('非字符串输入不炸，且保持原有语义', () => {
    expect(() => escapeExpression(123)).not.toThrow();
    expect(escapeExpression(123)).toBe('123');
    // null/undefined 走 String() 得到字面量 'null'/'undefined' —— 这是改造前就有的行为，
    // 本次只修换行转义，不顺手改动它（调用方传 null 是它自己的 bug，应显式暴露）
    expect(escapeExpression(null)).toBe('null');
    expect(escapeExpression(undefined)).toBe('undefined');
  });

  it('结果里不含裸换行（否则单引号字面量必然断裂）', () => {
    const out = escapeExpression('a\nb\r\nc\u2028d');
    expect(out).not.toMatch(/[\n\r\u2028\u2029]/);
  });
});

// ═══════════════════════════════════════════════════════════
// 命令实际拼出的表达式
// ═══════════════════════════════════════════════════════════

const ENV_KEYS = ['DOUYIN_STORAGE_DIR', 'DOUYIN_LOG_DIR', 'DOUYIN_CONFIG'];

function withTempEnv(fn) {
  return async () => {
    const saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-esc-'));
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    process.env.DOUYIN_LOG_DIR = path.join(tmp, 'logs');
    const cfgFile = path.join(tmp, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ policy: { dailyWriteQuota: 999, dailyRounds: 99 } }));
    process.env.DOUYIN_CONFIG = cfgFile;
    process.env.DOUYIN_NO_THROTTLE = '1';
    config.reset();
    try {
      await fn(tmp);
    } finally {
      try { require('../core/memory/db').closeDb(); } catch (e) { /* ignore */ }
      config.reset();
      for (const k of ENV_KEYS) {
        if (saved[k] == null) delete process.env[k];
        else process.env[k] = saved[k];
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

/**
 * 跑一次 cmdPost，把它发给 Bridge 的那段表达式抓出来，
 * 再真的解析一遍 —— 能解析说明浏览器 eval 也不会报错。
 */
async function capturePostExpression(text) {
  const cmdPost = require('../core/commands/post');
  const seen = [];
  const ctx = {
    audit: { startOperation() {}, endOperation() {}, logApiCall() {}, setNoLog() {}, _currentOp: null },
    config: config.get(),
    bridgeCall: async (expr) => { seen.push(expr); return { uri: 'u', width: 1, height: 1, format: 'jpeg' }; },
    loggedCall: async (endpoint, params, expr) => {
      seen.push(expr);
      return { status_code: 0, comment: { cid: 'new-cid', text } };
    },
  };
  await cmdPost(ctx, ['v1', text, '--reply-to', 'c1']);
  // 最后一条是真正调用 publish 的表达式
  return seen[seen.length - 1];
}

describe('发布命令拼出的表达式是合法 JS', () => {
  it('普通回复', withTempEnv(async () => {
    const expr = await capturePostExpression('谢谢支持');
    expect(() => new Function('window', `return ${expr}`)).not.toThrow();
  }));

  it('含换行的回复（用户实际遇到的失败场景）', withTempEnv(async () => {
    const expr = await capturePostExpression('第一行\n第二行');
    // 关键断言：能解析。改造前这里会抛 SyntaxError。
    expect(() => new Function('window', `return ${expr}`)).not.toThrow();

    // 再确认参数值确实带上了换行，而不是被截断成两行
    const captured = new Function('window', `return ${expr}`)(
      { __bridge: { publish: (...args) => args } }
    );
    expect(captured[1]).toBe('第一行\n第二行');
  }));

  it('含引号与反斜杠的回复', withTempEnv(async () => {
    // 不能含策略禁用词（如「不错」），否则会先被闸门拦下、走不到表达式拼接
    const tricky = "他说 \"这个方案可以\"，'真的'，路径 C:\\tmp\n换行后";
    const expr = await capturePostExpression(tricky);
    const captured = new Function('window', `return ${expr}`)(
      { __bridge: { publish: (...args) => args } }
    );
    expect(captured[1]).toBe(tricky);
  }));

  it('两三行的回复（用户实际遇到的形态）', withTempEnv(async () => {
    // 注意行数上限：策略里有「过长段落：最多三行」（来自 评论风格指南.md），
    // 4 行以上会被闸门拦下、走不到表达式拼接这一步。
    // 而 2–3 行能过闸门 —— 正是用户那次失败的情形：
    // 策略放行，却在浏览器 eval 时因换行未转义而报 SyntaxError。
    const twoLine = '第一行，带 emoji 🌹\n第二行结束。';
    const expr = await capturePostExpression(twoLine);
    const captured = new Function('window', `return ${expr}`)(
      { __bridge: { publish: (...args) => args } }
    );
    expect(captured[1]).toBe(twoLine);
  }));

  it('超过三行的回复会被策略拦下（与行数上限规则一致）', withTempEnv(async () => {
    await expect(capturePostExpression('一\n二\n三\n四')).rejects.toThrow(/行/);
  }));
});

// ═══════════════════════════════════════════════════════════
// 别的拼接点
// ═══════════════════════════════════════════════════════════

describe('其它把文本拼进表达式的地方', () => {
  it('私信同样安全', () => {
    const text = '你好\n第二行';
    const expr = `window.__bridge.sendDM('${escapeExpression('conv')}', '${escapeExpression(text)}')`;
    const captured = new Function('window', `return ${expr}`)(
      { __bridge: { sendDM: (...args) => args } }
    );
    expect(captured[1]).toBe(text);
  });

  it('搜索关键词同样安全', () => {
    const kw = "AI\nAgent";
    const expr = `window.__bridge.search('${escapeExpression(kw)}', 0, 10)`;
    const captured = new Function('window', `return ${expr}`)(
      { __bridge: { search: (...args) => args } }
    );
    expect(captured[0]).toBe(kw);
  });

  it('图片分片有独立的白名单校验（base64 之外直接中止）', () => {
    // 不解析语句，只确认那条防线存在：comment-image 在拼接前会逐个校验分片
    const src = fs.readFileSync(path.resolve(__dirname, '../core/comment-image.js'), 'utf8');
    expect(src).toMatch(/BASE64_RE\.test/);
    expect(src).toMatch(/图片分片含非法字符/);
  });
});
