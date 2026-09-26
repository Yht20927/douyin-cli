// tests/errors-humanize.test.js — 失败原因必须说人话
//
// 为什么要有这个测试
// ----------------
// `问题.md` §五 的实测结论是：屏幕上出现的失败原因是 core / 油猴 / Node 三方
// 原始字符串的直通，运营者能做的只有截图发给开发者。而这类缺陷**不会有任何红**——
// 字符串渲染得好好的，只是没人看得懂。所以把它钉成断言。
//
// 用例喂的串**全部是真库里出现过的原文**（取自 storage/douyin.db 的
// `events.error` 与 `failure_patterns.example_text`），不是我编的示例。
// 理由见 开发进度.md §6.6：夹具替下游猜一遍，测试就只是在证明我的假设。
//
// 这里不 require('vitest') —— v4 起它不支持 CommonJS require，
// describe/it/expect 由 vitest.config.js 的 globals: true 提供（同 memory.test.js）。

/**
 * 真库里出现过的失败原文。
 * 新增映射规则时往这里加一条，而不是另起一个只喂理想字符串的用例。
 */
const REAL_ERRORS = [
  'GM_xmlhttpRequest failed',
  'Bridge Server 未启动 (127.0.0.1:19422) — 请先运行 node server.js',
  'Request timeout after 30000ms — no polling client connected',
  'status_code=5 — 评论可能被拦截，请更换内容重试',
  'status_code=2055 — 评论可能被拦截，请更换内容重试',
  'status_code=3002229 — 评论可能被拦截，请更换内容重试',
  'Unauthorized — 无效的 access token',
  '[publish] 网络请求失败: NetworkError when attempting to fetch resource.',
  // 这两条是工具自己的 bug（后者已修），它们最容易被用户误读成"我操作错了"
  'this._isAnthropicProvider is not a function',
  '\'\' string literal contains an unescaped line break',
];

/** 走 dynamic import：被测试的是渲染层的 ESM 模块，仓库根 package.json 不是 ESM */
const load = () => import('../app/renderer/src/errors.js');

describe('errors: 失败原因 → 人话 + 下一步', () => {
  it('真库里出现过的每一条原文，翻译结果里都不再带机器串', async () => {
    const { describeError } = await load();
    for (const raw of REAL_ERRORS) {
      const note = describeError(raw);
      // 面向用户那一句里不能残留英文工程串（返回码的**数字**是刻意保留的，不算）
      expect(note.text, raw).not.toMatch(/status_code\s*=|GM_xmlhttpRequest|ECONNREFUSED|EADDRINUSE|is not a function|string literal|Unauthorized|timeout after/);
      expect(note.text.length, raw).toBeGreaterThan(4);
    }
  });

  it('每一条都说清性质，能给的下一步不给空话', async () => {
    const { describeError } = await load();
    for (const raw of REAL_ERRORS) {
      const note = describeError(raw);
      // 「请重试」式空话：下一步要么真的可执行，要么明确说这是程序错误
      expect(note.next.every(n => !/^(请重试|请稍后再试|重试)$/.test(n.trim())), raw).toBe(true);
    }
  });

  it('原始信息一律留在 detail 里 —— 开发者排查与用户截图都靠它', async () => {
    const { describeError } = await load();
    for (const raw of REAL_ERRORS) {
      expect(describeError(raw).detail, raw).toBe(raw);
    }
  });

  it('抖音返回码：说"没接受"并把码留着，但不编造它的含义', async () => {
    const { describeError } = await load();
    const note = describeError('status_code=2055 — 评论可能被拦截，请更换内容重试');
    expect(note.text).toContain('2055');
    // "可能被拦截"是我们的猜测（开发进度.md §3.1 明确记着未查明），不能写进界面
    expect(note.text).not.toContain('可能');
    expect(note.next.length).toBeGreaterThan(0);
  });

  it('工具自身的程序错误要一眼区别于用户操作错误', async () => {
    const { describeError } = await load();
    for (const raw of ['this._isAnthropicProvider is not a function', 'ReferenceError: x is not defined']) {
      expect(describeError(raw).text).toContain('程序错误');
    }
  });

  it('用户自己取消的不算故障', async () => {
    const { describeError } = await load();
    expect(describeError('已取消（还没开始执行）').text).toBe('已取消');
    expect(describeError('已取消（还没开始执行）').next).toEqual([]);
  });

  it('AI 密钥问题必须把"key 与 base_url 要配套"说出来', async () => {
    const { describeError } = await load();
    const note = describeError('LLM API 请求失败 (HTTP 401) — {"error":{"message":"Incorrect API key"}}');
    expect(note.text).toContain('密钥');
    expect(note.next.join('')).toContain('base_url');
  });

  it('已经是人话的拦截理由原样放过 —— 翻译层不管人话，只管机器串', async () => {
    const { describeError } = await load();
    // 这两句是 policy / risk-control 自己产出的文案（已带具体细节），
    // 要是被统一成"被规则拦下了 / 不能原样再发"，那就是负收益：细节没了。
    for (const raw of [
      '这句话之前已经发给过视频 ····113201（3 天前） —— 同一句话只用一次，改几个字再发',
      '当日写入额度已用尽（30/30），明天再试',
    ]) {
      expect(describeError(raw).text, raw).toBe(raw);
    }
    // 而机器键必须翻
    expect(describeError('dup_text').text).toContain('已经发过');
  });

  it('认不出的串回退原文，不编一句安慰人的假话', async () => {
    const { describeError } = await load();
    const raw = '某种从没见过的原因说明';
    const note = describeError(raw);
    expect(note.text).toBe(raw);
    expect(note.detail).toBe(raw);
  });

  it('空值/异常输入不炸，且仍然给出可读的一句', async () => {
    const { describeError, errorText } = await load();
    for (const v of [null, undefined, '', {}, new Error('桥接断了')]) {
      const note = describeError(v);
      expect(typeof note.text).toBe('string');
      expect(note.text.length).toBeGreaterThan(0);
    }
    expect(errorText(new Error('GM_xmlhttpRequest failed'))).toBe('浏览器里的脚本发不出这个请求');
  });
});

describe('Electron 的 IPC 拒绝外层不许挡住翻译', () => {
  // 这一条是本轮（第二十二轮）撞出来的：以前 reject 从来没被递到翻译层
  // （App.jsx 里那批 .then() 没有 catch），所以外层那圈
  // `Error invoking remote method 'x': Error: 原话` 一直待在没人看的地方。
  // 一旦界面开始如实报失败，它就成天上屏 —— 而且因为前面多了那串英文，
  // RULES 里每一条都匹配不上，本来有中文映射的原因会原样露出。
  const WRAPPED = [
    ["Error invoking remote method 'bridge:status': Error: Bridge Server 未启动 (127.0.0.1:19422) — 请先运行 node server.js", '桥接'],
    ["Error invoking remote method 'app:info': Error: listen EADDRINUSE: address already in use 127.0.0.1:19422", '端口'],
    ["Error invoking remote method 'queue:state': Error: GM_xmlhttpRequest failed", '浏览器'],
  ];

  it('剥掉外层之后仍然命中既有的中文映射', async () => {
    const { describeError } = await load();
    for (const [raw, word] of WRAPPED) {
      const note = describeError(raw);
      expect(note.text, raw).not.toMatch(/Error invoking remote method/);
      expect(note.text, raw).toContain(word);
      // 原文整条留着：频道名对排查有用，展开「原始信息」时应当看得见
      expect(note.detail, raw).toBe(raw);
    }
  });

  it('外层里没带原因时，报出是哪一条调用没成功，而不是"没有返回具体原因"', async () => {
    const { describeError } = await load();
    const note = describeError("Error invoking remote method 'data:drafts': ");
    expect(note.text).toContain('data:drafts');
    expect(note.text).not.toBe('没有返回具体原因');
    expect(note.next.length).toBeGreaterThan(0);
  });

  it('没被包裹的串不走这条路（剥外层不许吃掉正常输入）', async () => {
    const { describeError } = await load();
    const raw = '当日写入额度已用尽（30/30），明天再试';
    expect(describeError(raw).text).toBe(raw);
    expect(describeError(new Error(raw)).text).toBe(raw);
  });
});
