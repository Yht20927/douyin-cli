// tests/renderer-static.test.js — 渲染层的静态一致性护栏
//
// 为什么是"静态比对"而不是组件测试
// ---------------------------------
// 本仓没有 ESLint，也没有 jsdom / testing-library，而这里最贵的一类缺陷
// 恰恰是**运行时看不见的**：类名写了但 CSS 里没有规则（表现是"排版有点怪"，
// 没人会去查），actions 里同一个键写两遍（后者静默覆盖前者，表现是
// "退出确认框永远不出现"）。这两类都可以用纯文本比对钉死，成本低、不会脆。
//
// 棘轮（ratchet）写法
// -------------------
// 已知欠债列在下面各 KNOWN_* 常量里，断言用的是 **集合相等** 而不是"子集"：
//   - 新增一处欠债 → 红
//   - 修掉一处但没删清单里的条目 → 也红（提示你把它从欠债表里划掉）
// 所以这两张表只会变短，而且短了必须被看见。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RENDERER_SRC = path.join(ROOT, 'app', 'renderer', 'src');
const STYLES = path.join(RENDERER_SRC, 'styles.css');
const APP = path.join(RENDERER_SRC, 'App.jsx');

function collectSources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectSources(p, out);
    else if (/\.jsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * styles.css 中**被声明过**的类名。
 *
 * "声明"取的是严格的那种意思：类必须出现在某条规则选择器的首位复合选择器里
 * （`.row:hover`、`.btn.btn-primary` 都算，因为样式确实会作用到它身上）。
 * 只要文本里出现过就算的话，`.row` 会被算成已定义 —— 而它在整张表里唯一的
 * 露面是 `.settings-savebar .row { gap: 8px }`，一条离开设置页就完全不生效的
 * 后代规则。那正是这个测试要抓的东西，不能在读选择器这一步又放过去。
 */
function parseCssClasses(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const set = new Set();
  // 每条规则：选择器列表 { 声明 }。@media 之类的 at-rule 其"选择器"不以 . 开头，自然被跳过
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = rule.exec(stripped)) !== null) {
    const [, selectorList, decls] = m;
    // 空声明块（`@media (…) {` 这种外层）不算一条规则
    if (!decls.trim() && !selectorList.includes('.')) continue;
    for (const sel of selectorList.split(',')) {
      // 首个组合器 / 伪类之前的那一串类，就是这条规则真正作用的对象
      const leading = sel.trim().split(/[\s>+~:[]/)[0];
      const cls = /\.(-?[A-Za-z_][-\w]*)/g;
      let c;
      while ((c = cls.exec(leading)) !== null) set.add(c[1]);
    }
  }
  return set;
}

/**
 * JSX 里 className 用到的裸 token。
 *
 * 三种写法都要覆盖：
 *   className="btn btn-quiet"
 *   className={`tag ${x ? 'on' : ''}`}   ← 只取模板里的静态片段
 *   className={'btn'}                    ← 少见，但也别漏
 * 含 ${…} 的整段跳过 —— 变量拼出来的类名没法静态判定，
 * 宁可少管，也不要长出一堆 false positive 之后被人整个注掉。
 */
function parseUsedClasses(code) {
  const set = new Set();
  const add = (raw) => {
    for (const tok of raw.split(/\s+/)) {
      if (!tok) continue;
      // 剥掉 ${…} 之后剩下的半截前缀（`barlist-fill-`、`-bg`）不是类名，
      // 而把它们当类名来报错会让这张欠债表里混进永远修不掉噪音。
      if (!/^[A-Za-z_][-\w]*[A-Za-z0-9_]$/.test(tok) && !/^[A-Za-z_]$/.test(tok)) continue;
      set.add(tok);
    }
  };
  let m;
  const dquote = /className\s*=\s*"([^"]*)"/g;
  while ((m = dquote.exec(code)) !== null) add(m[1]);
  const squote = /className\s*=\s*\{\s*'([^']*)'\s*\}/g;
  while ((m = squote.exec(code)) !== null) add(m[1]);
  // 模板字符串：整段抓下来后再按 ${…} 切掉动态部分
  const tpl = /className\s*=\s*\{\s*`([^`]*)`\s*\}/g;
  while ((m = tpl.exec(code)) !== null) add(m[1].replace(/\$\{[^}]*\}/g, ' '));
  return set;
}

/** 取出对象字面量的**内部**文本（按大括号配对，不做词法分析） */
function sliceObjectBody(code, startMarker) {
  const at = code.indexOf(startMarker);
  if (at === -1) return null;
  const open = at + startMarker.length - 1;   // 标记以 `{` 结尾
  let depth = 0;
  for (let j = open; j < code.length; j++) {
    if (code[j] === '{') depth++;
    else if (code[j] === '}') {
      depth--;
      if (depth === 0) return code.slice(open + 1, j);
    }
  }
  return null;
}

/**
 * 对象字面量的顶层键。
 *
 * 顶层 = 块内**最小缩进**那一层（嵌套成员必然更深），因此先把对象体切出来
 * 再按缩进筛，而不是从标记处一路扫到文件尾 —— 后者会把对象后面的语句
 * 也算进来，还会因为标记出现在行中间而把整块缩进读错一级。
 * 支持 `key(...)` 方法简写与 async / get / set 前缀。
 */
function parseTopLevelKeys(body) {
  if (body == null) return [];
  const lines = body.split('\n').map(l => l.replace(/\/\/.*$/, '')).filter(l => l.trim());
  if (!lines.length) return [];
  const indent = Math.min(...lines.map(l => l.search(/\S/)));
  const re = /^\s*(?:async\s+|get\s+|set\s+|\*\s*)?([A-Za-z_$][\w$]*)\s*[:(]/;
  const out = [];
  for (const line of lines) {
    if (line.search(/\S/) !== indent) continue;
    const m = line.match(re);
    if (m) out.push(m[1]);
  }
  return out;
}

const cssClasses = parseCssClasses(fs.readFileSync(STYLES, 'utf8'));
const appCode = fs.readFileSync(APP, 'utf8');

describe('className 必须有对应的 CSS 规则', () => {
  // 写了类名但样式表里没有**作用于它本身**的规则。审计时手工数出 7 个，
  // 让解析器跑一遍实际是 10 个 —— 这类债靠人是数不住的。
  //
  // 分三种情况，修法不一样：
  //   完全没有声明          → 补规则
  //   只在某个祖先下声明过   → 提出来做独立声明（现在这些类一旦挪出那个祖先就
  //                            完全没样式，是埋着的雷）
  //   队列任务行的 row-*    → 一起补，它们是同一批改造里新写的类名
  const KNOWN_UNSTYLED = [
    'prompts',            // settings/PromptsField.jsx 的根容器
    'sidebar-status',     // 侧栏底部那条状态行
    'row',                // 8 处在用；表里唯一的 .row 是 .settings-savebar .row
    'sub',                // 只有 .kv dd .sub
    'path-line',          // 只有 .kv dd .path-line
    'row-progress',
    'row-blockers',
    'row-blocker',
    'row-warnings',
    'section-meta',
  ];

  const used = new Set();
  for (const file of collectSources(RENDERER_SRC)) {
    for (const cls of parseUsedClasses(fs.readFileSync(file, 'utf8'))) used.add(cls);
  }

  it('确实扫到了类名（解析器本身要有效）', () => {
    expect(used.size).toBeGreaterThan(60);
    expect(used.has('btn')).toBe(true);
    expect(cssClasses.size).toBeGreaterThan(80);
  });

  it('欠债清单与实际情况一致（只会变短，修完要来这里划掉）', () => {
    const missing = [...used].filter(c => !cssClasses.has(c)).sort();
    expect(missing).toEqual([...KNOWN_UNSTYLED].sort());
  });
});

describe('App 的 actions 表不能有重复键', () => {
  // 回归背景（D3）：`quit` 在这里写过两次，后一个 `async quit() { await window.dy.quit(); }`
  // 静默覆盖前一个 —— 于是"有任务在跑时先弹确认框"那段逻辑连同它下面整个 Modal
  // 一起成了死代码，批量生成跑到一半点退出会直接强杀进程。
  // 症状是"功能做了但不生效"，读代码的人只看得到那个还在的确认框，谁也想不到
  // 它被 40 行之外的一次重名覆盖掉了。
  const KNOWN_DUPLICATES = [];

  const keys = parseTopLevelKeys(sliceObjectBody(appCode, 'const actions = {'));

  it('解析到了 actions 的键（解析器本身要有效）', () => {
    expect(keys.length).toBeGreaterThan(5);
    expect(keys).toContain('quit');
  });

  it('重复项与已知欠债一致', () => {
    const seen = new Set();
    const dupes = new Set();
    for (const k of keys) { if (seen.has(k)) dupes.add(k); seen.add(k); }
    expect([...dupes].sort()).toEqual([...KNOWN_DUPLICATES].sort());
  });
});

describe('图表里不许写颜色字面量', () => {
  // 回归背景：条形图的填充、环形的底槽、柱子的渐变曾经各写一套相近但不同的棕
  // （#6b6156 / #857968 / #8a7d6a / #5c5348），再外加三处裸写的 rgba(0,0,0,.22)。
  // 值几乎一样，所以没人看得出来它们不是同一个东西 —— 改画布深浅时
  // 也不会有人记得四处都改。这与"颜色只表示状态"是同一条纪律的两面：
  // 图表里代表"普通量"的那部分必须是**表面色**，而表面色只能来自 :root。
  //
  // 为什么只钉 charts.jsx 而不是全仓：视图里还有少量装饰性内联色（顶栏光晕等），
  // 一次全禁会红一片、然后被整体注掉 —— 那样的护栏等于没有。
  // 这里只钉住最该守规矩的那一个文件，范围小到可以一直保持零欠债。
  const CHART_FILES = ['components/charts.jsx'];
  const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\s*\(/;

  it('charts.jsx 里没有 #hex / rgb() / rgba() 字面量', () => {
    for (const rel of CHART_FILES) {
      const code = fs.readFileSync(path.join(RENDERER_SRC, rel), 'utf8')
        // 注释里常常正是在解释"以前这里是写死的 #xxxxxx"，不该被当成违规
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const hits = code.split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => COLOR_RE.test(line));
      expect({ file: rel, hits }).toEqual({ file: rel, hits: [] });
    }
  });

  it('图表用的中性刻度都在 :root 里声明过（没有孤儿值）', () => {
    const css = fs.readFileSync(STYLES, 'utf8');
    for (const tok of ['--chart-lo', '--chart-mid', '--chart-hi', '--sunken']) {
      expect(css).toContain(`${tok}:`);
    }
    // charts.jsx 引用的图表类，必须在样式表里真的存在（动态类名被上面的
    // 解析器跳过，所以这里手工钉一遍最要紧的那个）
    expect(css).toContain('.donut-track');
  });
});

describe('拼出来的类名也必须有样式', () => {
  // 回归背景：`.tag-bad` 在队列页的拦截标签（BLOCK_TAG.stop）与工作台的负面情感
  // 标签里**一直在用**，而样式表里从来没有这条规则 —— 那些「不能发」标签实际上
  // 一直没有样式。静态棘轮抓不到，因为类名是拼在模板字符串里的
  // （`tag-${tone}`），而解析器会主动跳过含 ${…} 的整段（见它的注释）。
  //
  // 这里用一张**显式的表**把这个盲区补上：凡是"前缀 + 变量"的类名，
  // 变量可能的取值列出来，逐个要求样式表里有对应规则。
  // 表要人工维护 —— 新增一族动态类名时加一行，这正是它存在的意义。
  const FAMILIES = [
    // { 前缀, 变量可能的取值 } —— 取值来自代码里实际的枚举（DECISION / SENTIMENT /
    // BLOCK_TAG / replyParts / trend series 等），不是凭空列的
    { prefix: 'tag-', suffixes: ['ok', 'warn', 'dim', 'bad'] },
    { prefix: 'barlist-fill-', suffixes: ['neutral'] },
    { prefix: 'donut-seg-', suffixes: ['ok', 'wait', 'bad', 'neutral'] },
    { prefix: 'trend-line-', suffixes: ['neutral', 'ok', 'wait', 'bad'] },
    { prefix: 'trend-area-', suffixes: ['neutral', 'ok', 'wait'] },
    { prefix: 'trend-swatch-', suffixes: ['neutral', 'ok', 'wait'] },
    // settings-status 只列 inactive：`advisory` 与 `active` **故意**不加规则 ——
    // 基础 `.settings-status` 的等待色就是按它们设计的（见 styles.css 那段注释），
    // 再加一条只是把同样的值抄第二遍。这条界限值得写下来：
    // 表里列 = "这个取值必须有自己的一条规则"，不是"这个取值必须被用到"。
    { prefix: 'settings-status-', suffixes: ['inactive'] },
  ];

  it('每一族的每个取值都有规则', () => {
    const missing = [];
    for (const { prefix, suffixes } of FAMILIES) {
      for (const suf of suffixes) {
        const cls = prefix + suf;
        // 用已经**去过注释**的类名集合，不要拿原始文本做正则 ——
        // 第一版就是那么写的，于是它在注释里匹配到 `.tag-bad` 这句说明，
        // 把规则删掉测试照样绿。护栏本身失效比没有护栏更糟。
        if (!cssClasses.has(cls)) missing.push(cls);
      }
    }
    expect(missing).toEqual([]);
  });

  it('这些前缀确实还在源码里被拼出来（别留着一张过期的表）', () => {
    const used = collectSources(RENDERER_SRC)
      .map(f => fs.readFileSync(f, 'utf8')).join('\n');
    const stale = FAMILIES
      .map(f => f.prefix)
      .filter(p => !used.includes(`${p}\${`) && !used.includes(`${p}'`) && !used.includes(`${p}\``));
    // donut-seg- 的 -bg 变体写成 `donut-seg-${…}-bg`，上面那个 includes 能覆盖
    expect(stale).toEqual([]);
  });
});

describe('core 返回的明细必须在界面里被读出来（写链路的结果接线）', () => {
  // 背景：补全 / 删除回复 / 私信这三条链路各自都往返回值里塞了明细
  // （failedCount、localRemoved/localUnmarked、conversation_id），而三个视图以前
  // 只判"任务成没成"。core 算出来了 ≠ 用户看得见 —— 与 className 写了没样式
  // 是同一类债，运行时没有任何症状，只能在静态这一步钉住。
  const CHAIN_VIEWS = [
    { view: 'TargetsView.jsx', field: 'failedCount', helper: 'describeEnrich' },
    { view: 'WorkspaceView.jsx', field: 'localRemoved', helper: 'describeDelete' },
    { view: 'UserView.jsx', field: 'conversation_id', helper: null },
  ];

  /**
   * 去掉注释之后的源码。
   *
   * 必须先剥注释再匹配：这些字段名在**注释**里出现得比在代码里还勤
   * （"core 早就把 localRemoved 返回了"这种话），拿原始文本做正则的话
   * 护栏会被自己的注释喂饱 —— 视图删掉读取逻辑它照样绿。
   * 行注释的粗剥会把 URL 字符串的后半截一起削掉，这里只匹配标识符与调用，
   * 那种损失不影响判定。
   */
  function codeOfView(name) {
    return fs.readFileSync(path.join(RENDERER_SRC, 'views', name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  it('三个视图都渲染 Notice，并在任务完成后把结果取回来', () => {
    for (const { view } of CHAIN_VIEWS) {
      const code = codeOfView(view);
      expect(code, `${view} 应引入 Notice`).toMatch(/import\s+Notice\s+from/);
      expect(code, `${view} 应渲染 <Notice`).toMatch(/<Notice\s/);
      // 只看"取回结果"这一次调用：任务状态本身不含明细
      expect(code, `${view} 应在任务完成后读 queue.result()`).toMatch(/queue\.result\(/);
    }
  });

  it('每个视图都读到自己那条链路的明细字段', () => {
    for (const { view, field } of CHAIN_VIEWS) {
      expect(codeOfView(view), `${view} 没读 ${field}`).toContain(field);
    }
  });

  it('翻译结果的 helper 真的被调用（不是写了没用）', () => {
    for (const { view, helper } of CHAIN_VIEWS) {
      if (!helper) continue;
      const calls = (codeOfView(view).match(new RegExp(`\\b${helper}\\s*\\(`, 'g')) || []).length;
      // 1 = 只有那句 function 定义
      expect(calls, `${view} 里的 ${helper} 只有定义、没人调用`).toBeGreaterThanOrEqual(2);
    }
  });
});
