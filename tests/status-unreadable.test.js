// tests/status-unreadable.test.js — 「读失败了」必须在屏幕上与「还在读」和「没有」都不同形
//
// 这一轮改的不是一句文案，是一条判据：
// 主进程那份读数**失败**时，界面不能继续停留在启动时的那一个形状上。
// 改造前 `bridge:status` 没包 safe()，失败是一个 reject，而调用点只有一个
// `.then()` —— 于是侧栏与状态条永远说「检测中」：一句承诺了答案的话，
// 而答案不会再来了。比"没连上"更糟，因为它把用户留在等一秒就有结果的心态里。
//
// 判据只有一份：status.js 的 `describeStatus(status, readError)`。
// 侧栏、状态条、诊断页各写一遍 if/else，下一张页面一定会漏掉其中一支 ——
// 所以这里钉的是**这一份实现**的行为，各页只是传参数（谁没传由
// renderer-static.test.js 那条跨文件比对盯着）。
//
// 这里不 require('vitest') —— v4 起它不支持 CommonJS require，
// describe/it/expect 由 vitest.config.js 的 globals: true 提供（同 errors-humanize.test.js）。

/** 走 dynamic import：被测的是渲染层的 ESM 模块，仓库根 package.json 不是 ESM */
const load = () => import('../app/renderer/src/status.js');

/**
 * 真链路里这一支会见到的原文：外层是 Electron 的 `ipcRenderer.invoke` 失败形状，
 * 内层三条都取自 `errors-humanize.test.js` 里那份**真库里出现过的原文**清单。
 * ⚠️ 不拿没证据的英文串当夹具 —— 翻译层对认不出的串按设计原样放过，
 * 用一条编出来的串去断言"它被翻译了"，只会逼着别人加一条没依据的规则。
 */
const REAL_REJECTS = [
  ["Error invoking remote method 'bridge:status': Error: Bridge Server 未启动 (127.0.0.1:19422) — 请先运行 node server.js", '桥接'],
  ["Error invoking remote method 'queue:state': Error: GM_xmlhttpRequest failed", '浏览器'],
  ["Error invoking remote method 'app:info': TypeError: this._isAnthropicProvider is not a function", '工具自己'],
].map(([msg, word]) => Object.assign(new Error(msg), { expectWord: word }));

describe('describeStatus：读失败自成一支', () => {
  it('没读回来也没有失败理由时才是「检测中」（这一支不许被吃掉）', async () => {
    const { describeStatus } = await load();
    const d = describeStatus(null);
    expect(d.state).toBe('unknown');
    expect(d.word).toBe('检测中');
    // 「还在读」这一支不许带出口按钮：它唯一该做的是等，而它确实会在下一秒有答案
    expect(d.actions).toEqual([]);
  });

  it.each(REAL_REJECTS)('读失败时说法换成「读不到状态」，且给出出口（%s）', async (err) => {
    const { describeStatus } = await load();
    const d = describeStatus(null, err);
    expect(d.state).toBe('unreadable');
    expect(d.word).toBe('读不到状态');
    // 失败支必须带得出口，否则这一页只是在报告坏了
    expect(d.actions).toContain('refresh');
    expect(d.hint && d.hint.steps.length).toBeGreaterThan(0);
  });

  it('三种实参形状（Error / 字符串 / 空值）走同一支', async () => {
    const { describeStatus } = await load();
    expect(describeStatus(null, new Error('x')).state).toBe('unreadable');
    expect(describeStatus(null, 'x').state).toBe('unreadable');
    // ⚠️ 空串与 null 都不算失败：否则"没有失败"会被翻译成"读不到"
    expect(describeStatus(null, '').state).toBe('unknown');
    expect(describeStatus(null, null).state).toBe('unknown');
    expect(describeStatus(null, undefined).state).toBe('unknown');
  });

  it('外层包装不许上屏，剥掉之后要落回既有的中文映射', async () => {
    const { describeStatus } = await load();
    for (const err of REAL_REJECTS) {
      const note = describeStatus(null, err).note;
      expect(note, err.message).not.toMatch(/Error invoking remote method/);
      expect(note, err.message).toContain(err.expectWord);
    }
  });

  it('note 与 hint 里不许有 Markdown 强调（这一页是纯文本，星号会露出来）', async () => {
    const { describeStatus } = await load();
    const cases = [
      describeStatus(null, new Error('x')),
      describeStatus({ listening: false }),
      describeStatus({ listening: true, online: false, offlineForMs: 5000 }),
      describeStatus({ listening: true, online: false, offlineForMs: 0 }),
      describeStatus({ listening: true, online: true, totalConnections: 1, connections: [] }),
    ];
    for (const d of cases) {
      const text = [d.word, d.note, d.hint && d.hint.title, ...((d.hint && d.hint.steps) || [])]
        .filter(Boolean).join('\n');
      expect(text).not.toMatch(/\*\*/);
      expect(text).not.toMatch(/^#/m);
    }
  });

  it('已经有一份读回来的数据时，仍以那份数据说话（失败不覆盖事实）', async () => {
    const { describeStatus } = await load();
    const good = { listening: true, online: true, totalConnections: 1, connections: [] };
    const d = describeStatus(good, new Error("Error invoking remote method 'bridge:status': Error: x"));
    // 上一份数据仍然是在屏上能看到的最好依据。「最近一次没读回来」那句话由
    // 各页顶部的失败条来说（App 的 readErrors 账本），不在这条判据里
    expect(d.state).toBe('online');
  });

  it('这一支的措辞必须明说"不是还没连上"（两种处境不能混）', async () => {
    const { describeStatus } = await load();
    const d = describeStatus(null, new Error('x'));
    expect(d.note).toMatch(/未知/);
    expect(d.note).toMatch(/这句不是/);
    expect(d.note).toMatch(/还没连上/);
  });
});

/**
 * navBadge —— 第二十三轮收进同一份文件的第二个判据。
 *
 * 改造前侧栏写的是 `count > 0 && <span className="nav-badge">{count}</span>`。
 * 这个条件本身没错，错在它让**角标消失**成了一句话：`queue:state` / `data:drafts`
 * 读失败时那两个数恰好停在初值 0，于是屏幕上「这次没读回来」与「队列是空的」
 * 「箱里没草稿」长得一模一样，而草稿箱那一屏同一时刻还在说「草稿箱是空的。」——
 * 两处互相印证同一个错误结论。
 */
describe('navBadge：读失败时角标不许消失', () => {
  it('没有失败时维持原行为：有数才画，0 就是真的没有', async () => {
    const { navBadge } = await load();
    expect(navBadge(3, null)).toEqual({ text: '3', title: '' });
    expect(navBadge(0, null)).toBe(null);
    expect(navBadge(null, null)).toBe(null);
  });

  it('读失败而数停在 0 时，角标必须继续站着并带一个问号', async () => {
    const { navBadge } = await load();
    const b = navBadge(0, new Error("Error invoking remote method 'queue:state': Error: x"));
    expect(b).toBeTruthy();
    expect(b.text).toBe('?');
    expect(b.warn).toBe(true);
    expect(b.title).toMatch(/不等于没有/);
  });

  it('读失败但手里还有一个旧数时，那个数要带着问号一起留着', async () => {
    const { navBadge } = await load();
    const b = navBadge(7, '主进程没有返回草稿箱');
    expect(b.text).toBe('7?');
    expect(b.warn).toBe(true);
    expect(b.title).toMatch(/上一次读到的/);
  });

  it('非数字的 count 按 0 处理，不许把 NaN 画上屏幕', async () => {
    const { navBadge } = await load();
    expect(navBadge('abc', null)).toBe(null);
    expect(navBadge(undefined, null)).toBe(null);
    expect(navBadge('abc', 'x').text).toBe('?');
  });

  it('角标那一格是纯文本：不许出现 Markdown 强调', async () => {
    const { navBadge } = await load();
    for (const b of [navBadge(1, null), navBadge(0, 'x'), navBadge(9, 'x')]) {
      expect(`${b.text}\n${b.title}`).not.toMatch(/\*\*/);
    }
  });
});
