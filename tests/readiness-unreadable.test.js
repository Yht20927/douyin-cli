// tests/readiness-unreadable.test.js — 「读不到」不许退成"能生成"
//
// 这一轮改的是一句假设。工作台里三颗按钮的 disabled、两处 title、一块提示区
// 原来都从同一句出发：`replyDesc 还没回来时先当作可用`。那句话在**还在读**的时候
// 是对的（中间态不该把按钮灰掉），在**读失败**的时候是假话 —— 因为两种情况下
// `replyDesc` 都是 null，而屏幕上它们长得一模一样。
// 后果不是难看：读失败那一屏「批量生成」是亮的，按下去占掉一个串行任务位、
// 等过一轮读间隔，才换回 core 的一句报错；而第十七轮加的那颗「改用固定内容」
// 出口按钮此时按 `fixedUsable > 0` 判断，那个数也是猜的。
//
// 判据只有一份：readiness.js 的 `replyReadiness(desc, error)`。
// 这里钉的是它的行为 —— 尤其钉两件事：
//   1. 非错误路径与改造前逐字等价（抽函数不许顺手改规则）；
//   2. 错误路径自成一支，且拦下按钮时必须同时给出一条走得完的下一步。
//
// 这里不 require('vitest') —— v4 起它不支持 CommonJS require，
// describe/it/expect 由 vitest.config.js 的 globals: true 提供（同 errors-humanize.test.js）。

const fs = require('fs');
const path = require('path');
const os = require('os');

/** 走 dynamic import：被测的是渲染层的 ESM 模块，仓库根 package.json 不是 ESM */
const load = () => import('../app/renderer/src/readiness.js');

/**
 * `reply:describe` 的真返回形状（core/reply-source/index.js 的 describe()）：
 * mode / modes / hybridRatio / fixed{total,usable,disabled,blank,zeroWeight,cycle}
 * / ai{ok,reason} / image{enabled,mode,usable,rejected}。
 *
 * ⚠️ 键名与嵌套一层都不能省：判据读的是 `desc.fixed.usable` 与 `desc.ai.reason`，
 * 喂一个扁平夹具会让"界面读不到 core 的数"这种断链绿着过去（§夹具必须喂真形状）。
 * 最后那条端到端用例现场调一次真的 describe() 来证明这份形状没走样。
 */
function desc(over = {}) {
  return {
    mode: 'ai',
    modes: ['ai', 'fixed', 'hybrid'],
    hybridRatio: 0.4,
    fixed: { total: 5, usable: 3, disabled: 1, blank: 1, zeroWeight: 0, cycle: 'round-robin' },
    ai: { ok: true, reason: '' },
    image: { enabled: false, mode: null, usable: 0, rejected: [] },
    ...over,
  };
}

/**
 * 失败理由的夹具取自 tests/errors-humanize.test.js 那份**真库里出现过的原文**清单。
 *
 * 为什么喂的是中文裸串而不是 `Error invoking remote method …`：`reply:describe`
 * 走 safe()，它坏掉的形状是 `{ok:false, error}`；工作台把 `error` 先过一遍
 * failText 再存进 replyError，所以 readiness 收到的已经是翻译过的句子。
 * 外壳那一种（不包 safe() 的通道）由 status-unreadable.test.js 钉。
 */
const REAL_REASONS = [
  'Bridge Server 未启动 (127.0.0.1:19422) — 请先运行 node server.js',
  'this._isAnthropicProvider is not a function',
];

describe('replyReadiness：三支各不相同形', () => {
  it('还没读回来 / 读失败了 / 读到了 —— 三种 state 不许撞成同一个', async () => {
    const { replyReadiness } = await load();
    expect(replyReadiness(null, null).state).toBe('loading');
    expect(replyReadiness(null, new Error(REAL_REASONS[0])).state).toBe('unreadable');
    expect(replyReadiness(desc(), null).state).toBe('ready');
    // 读回来过、这次重读失败：仍按那一份结果说话，但必须标出来
    expect(replyReadiness(desc(), new Error(REAL_REASONS[0])).state).toBe('stale');
  });

  it('「还在读」这一支的行为与改造前逐字一致（不许顺手把按钮灰掉）', async () => {
    const { replyReadiness } = await load();
    const d = replyReadiness(null, null);
    expect(d.aiOk).toBe(true);
    expect(d.fixedReady).toBe(true);
    expect(d.fixedDisabled).toBe(false);
    expect(d.genBlock).toBe(null);
    expect(d.modeHint).toBe(null);
    expect(d.fixedUsable).toBe(0);
  });

  it('读失败时 AI 那两颗必须拦下来，并把原因带进那一句话', async () => {
    const { replyReadiness } = await load();
    const d = replyReadiness(null, REAL_REASONS[0]);
    expect(d.aiOk).toBe(false);
    expect(d.genBlock).toBeTruthy();
    expect(d.aiReason).toBeTruthy();
    // 原因必须过翻译层（Bridge 那条命中规则），且真带进句子里
    expect(d.genBlock).toContain('桥接');
    expect(d.genBlock.length).toBeGreaterThan(20);
  });

  it('读失败时「用固定回复存草稿」不拦 —— 它不调 AI，成不成本地就能知道', async () => {
    const { replyReadiness } = await load();
    const d = replyReadiness(null, REAL_REASONS[0]);
    expect(d.fixedDisabled).toBe(false);
    // 但不能假装知道列表里有没有货：那句话必须说"不知道"
    expect(d.fixedHint).toMatch(/不知道/);
    expect(d.fixedUsable).toBe(0);
  });

  it('拦下一颗按钮必须同时给出一条下一步，不许只留一句"生成不了"', async () => {
    const { replyReadiness } = await load();
    const d = replyReadiness(null, REAL_REASONS[1]);
    // 这一轮的下一步是"再读一次"，而它要求屏幕上真有一颗重读键
    expect(d.genBlock).toMatch(/重新读取/);
  });

  it('读失败不许把失败本身弄丢：三支里都要能看见原因', async () => {
    const { replyReadiness } = await load();
    for (const raw of REAL_REASONS) {
      const d = replyReadiness(null, raw);
      const text = [d.genBlock, d.aiReason, d.fixedHint].join('\n');
      expect(text, raw).not.toMatch(/Error invoking remote method/);
      // 一句都不许是空的 —— 空字符串意味着"失败了但屏幕上没人知道"
      expect(d.genBlock.length, raw).toBeGreaterThan(0);
      expect(d.aiReason.length, raw).toBeGreaterThan(0);
    }
  });

  it('读回来过之后重读失败，仍按那一份结果判（失败不覆盖事实）', async () => {
    const { replyReadiness } = await load();
    // 真配置：模式 ai、AI 可用、固定列表 3 条能用
    const d = replyReadiness(desc(), '主进程没有返回回复来源');
    expect(d.state).toBe('stale');
    expect(d.aiOk).toBe(true);
    expect(d.genBlock).toBe(null);
    expect(d.fixedUsable).toBe(3);
    // 反过来：那份结果本来就拦着，失败不额外改变结论
    const off = replyReadiness(desc({ ai: { ok: false, reason: '还没有配置模型 API Key' } }), 'x');
    expect(off.aiOk).toBe(false);
    expect(off.genBlock).toContain('还没有配置模型 API Key');
  });
});

describe('replyReadiness：非错误路径的四条规则（与改造前同一口径）', () => {
  it('mode=fixed 且固定列表一条都不能用 → 拦，并且说的是列表的事不是 AI 的事', async () => {
    const { replyReadiness, FIXED_EMPTY } = await load();
    const d = replyReadiness(desc({
      mode: 'fixed',
      fixed: { total: 2, usable: 0, disabled: 2, blank: 0, zeroWeight: 0, cycle: null },
      ai: { ok: false, reason: '还没有配置模型 API Key' },
    }), null);
    expect(d.fixedUsable).toBe(0);
    expect(d.fixedReady).toBe(false);
    expect(d.fixedDisabled).toBe(true);
    expect(d.fixedHint).toBe(FIXED_EMPTY);
    // AI 那条腿不通也不能把话头引到 AI 上：这一批根本不调它
    expect(d.genBlock).toBe(FIXED_EMPTY);
    expect(d.genBlock).not.toMatch(/API Key/);
  });

  it('mode=ai 且 AI 不通 → 拦，并带上「改成固定内容不需要它」这条出路', async () => {
    const { replyReadiness } = await load();
    const d = replyReadiness(desc({
      mode: 'ai',
      ai: { ok: false, reason: '还没有配置模型 API Key —— 到「设置」页的「AI 模型」分组填' },
    }), null);
    expect(d.aiOk).toBe(false);
    expect(d.genBlock).toContain('还没有配置模型 API Key');
    expect(d.genBlock).toContain('把「回复模式」改成「固定内容」不需要它');
  });

  it('mode=hybrid 且 AI 不通但固定列表有货 → 不拦（固定能兜底，降级由结果里的来源标签说）', async () => {
    const { replyReadiness } = await load();
    const d = replyReadiness(desc({
      mode: 'hybrid',
      ai: { ok: false, reason: '还没有配置模型 API Key' },
    }), null);
    expect(d.genBlock).toBe(null);
    // 但「批量生成」那颗不因此变成"AI 能用"：aiOk 仍要说出不通
    expect(d.aiOk).toBe(false);
  });

  it('mode=hybrid 且 AI 不通、固定列表也空 → 拦（两条腿都没有）', async () => {
    const { replyReadiness } = await load();
    const d = replyReadiness(desc({
      mode: 'hybrid',
      fixed: { total: 0, usable: 0, disabled: 0, blank: 0, zeroWeight: 0, cycle: null },
      ai: { ok: false, reason: '还没有配置模型 API Key' },
    }), null);
    expect(d.genBlock).toContain('还没有配置模型 API Key');
  });

  it('modeHint 三种模式各说一句，hybrid 那句带真实比例', async () => {
    const { replyReadiness } = await load();
    expect(replyReadiness(desc({ mode: 'ai' }), null).modeHint).toBe('AI 生成较慢');
    expect(replyReadiness(desc({ mode: 'fixed' }), null).modeHint).toBe('当前是固定内容模式，秒回');
    expect(replyReadiness(desc({ mode: 'hybrid', hybridRatio: 0.35 }), null).modeHint)
      .toBe('当前是混合模式（AI 占 35%）');
  });

  it('core 没给 ai 这一段时按"通"处理（这是 old 行为，不许顺手改成拦）', async () => {
    const { replyReadiness } = await load();
    const d = replyReadiness({ mode: 'ai', hybridRatio: 0, fixed: { usable: 1 } }, null);
    expect(d.aiOk).toBe(true);
    expect(d.genBlock).toBe(null);
  });

  it('屏幕上这几句不许出现 Markdown 强调（这一页是纯文本，星号会露出来）', async () => {
    const { replyReadiness } = await load();
    const cases = [
      replyReadiness(null, null),
      replyReadiness(null, 'x'),
      replyReadiness(desc()),
      replyReadiness(desc({ mode: 'fixed', fixed: { total: 0, usable: 0 } })),
      replyReadiness(desc({ mode: 'ai', ai: { ok: false, reason: '还没有配置模型 API Key' } })),
    ];
    for (const d of cases) {
      const text = [d.modeHint, d.fixedHint, d.aiReason, d.genBlock].filter(Boolean).join('\n');
      expect(text).not.toMatch(/\*\*/);
      expect(text).not.toMatch(/^#/m);
    }
  });
});

describe('replyReadiness ← core 真链路：现场问一次真的 describe()', () => {
  /**
   * 这条用例存在的理由：上面所有夹具都是我手写的形状。形状对不对，
   * 只有拿真的 core 走一遍才知道 —— 尤其 `desc.fixed.usable` 这个数，
   * 它是 core 判过"被禁用/正文空白/权重 0"之后剩下的条数，界面不许自己重算。
   */
  function withTempEnv(setup, fn) {
    return async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-readiness-'));
      const origCfg = process.env.DOUYIN_CONFIG;
      const origData = process.env.DOUYIN_DATA_DIR;
      const origKey = process.env.OPENAI_API_KEY;
      process.env.DOUYIN_CONFIG = path.join(tmp, 'config.json');
      process.env.DOUYIN_DATA_DIR = tmp;
      delete process.env.OPENAI_API_KEY;   // 默认这台机器没配 Key —— 要钉的正是这一刻

      const config = require('../core/config');
      const replySource = require('../core/reply-source');
      config.reset();
      replySource.state.reset();
      if (setup) setup(config);

      try {
        await fn({ tmp, config, replySource });
      } finally {
        try { config.reset(); } catch (_) { /* */ }
        if (origCfg == null) delete process.env.DOUYIN_CONFIG; else process.env.DOUYIN_CONFIG = origCfg;
        if (origData == null) delete process.env.DOUYIN_DATA_DIR; else process.env.DOUYIN_DATA_DIR = origData;
        if (origKey == null) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = origKey;
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    };
  }

  it('开箱状态（没配 Key、模式默认 ai）：真的 describe() 喂进判据，按钮必须拦', async () => {
    const { replyReadiness } = await load();
    await withTempEnv(null, async () => {
      const replySource = require('../core/reply-source');
      // core 的 describe() 直接返回那份数据本身；`{ok:true, data}` 是主进程 safe()
      // 加的外壳，不在这一层 —— 界面拿到的是外壳里的 data
      const real = replySource.describe();
      expect(real.mode).toBeTruthy();
      const d = replyReadiness(real, null);
      expect(d.state).toBe('ready');
      expect(d.mode).toBeUndefined();               // 判据不另立一份模式清单
      // 这条最容易漏：core 的 reason 里那句「去哪补」必须原样出现在拦下的那句话里
      expect(d.genBlock).toContain(real.ai.reason);
      expect(d.fixedUsable).toBe(real.fixed.usable);
    })();
  });

  it('把固定内容喂进真配置后：core 说几条能用，判据就说几条（界面不重算）', async () => {
    const { replyReadiness } = await load();
    await withTempEnv(
      (config) => config.set({
        reply: {
          mode: 'fixed',
          fixed: {
            cycle: 'round-robin',
            items: [
              { text: '在的，私信你', enabled: true },
              { text: '　', enabled: true },        // 正文只剩空白：config 校验阶段就丢掉
              { text: '有货', enabled: false },     // 被禁用：core 判可用时会剔掉
            ],
          },
        },
      }),
      async () => {
        const real = require('../core/reply-source').describe();
        const d = replyReadiness(real, null);
        // 现场量到的：正文只剩空白那一条在 config.set 的校验阶段就被整条丢掉了，
        // 所以 describe() 根本看不到它 —— total 是 2 而不是喂进去的 3。
        // 这正是要钉住的事：界面连原始条目都拿不到，"几条能用"只能读 core 的数。
        expect(real.fixed.total).toBe(2);
        expect(real.fixed.usable).toBe(1);
        expect(real.fixed.disabled).toBe(1);
        expect(d.fixedUsable).toBe(1);
        expect(d.fixedDisabled).toBe(false);
        expect(d.genBlock).toBe(null);              // 模式 fixed 且列表有货 → 放行
      }
    )();
  });
});
