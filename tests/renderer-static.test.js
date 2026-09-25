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
    'section-meta',
    // row-progress / row-blockers / row-blocker / row-warnings 已经一起补上规则
    // （第十七轮随"失败下一步"这批明细一并做的），按本表的规矩从这里划掉。
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

describe('views.js 返回的字段必须有人读', () => {
  // 回归背景：`targets()` 一直返回 accountUid / accountCertain，注释写着
  // "界面必须显示它 —— 用户报的正是换了号数据没变"，而**整个渲染层没有任何一处读它**。
  // 于是那个用户报过的问题在屏幕上完全没有痕迹：数据到底有没有按账号过滤，只有天知道。
  //
  // 这一类缺陷的共同点是**它不报错**：字段照常算、照常过 IPC、照常进 JSON，
  // 只是没有人把它画出来。单元测试甚至会因为"返回结构里有这个键"而更容易通过。
  // 所以这里做的是最粗也最难绕开的一条：字段名在全仓（除定义处与测试）一次都没出现，
  // 就等于没人读它 —— 那要么把它画出来，要么删掉它，不该继续留在返回结构里骗人。
  //
  // 已知欠债：
  const KNOWN_UNREAD = [
    // 抖音原始的秒级时间戳。归一化后的毫秒值界面在用，这个原值是**故意**留给排查的
    // （tests/data-views.test.js 明确断言它保留），不画到界面上是有意的，不算缺陷。
    'createdAtRaw',
  ];

  const VIEWS = path.join(ROOT, 'core', 'data', 'views.js');
  const viewsCode = fs.readFileSync(VIEWS, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  // 逐个 `return {` 块取顶层键。同一份数据常常拆在几个构建函数里，
  // 所以按"整份文件里 return 过的键"求并集，不追到具体某个函数。
  //
  // 这里没有复用上面那个 parseTopLevelKeys：它要求键名后面紧跟 `:` 或 `(`，
  // 于是 `items, total, matched,` 这种一行并排的简写属性只会被认出第一个 ——
  // 对本表来说漏检等于没有护栏。所以按逗号再拆一层。
  function returnedKeys(body) {
    const lines = body.split('\n').map(l => l.replace(/\/\/.*$/, '')).filter(l => l.trim());
    if (!lines.length) return [];
    const indent = Math.min(...lines.map(l => l.search(/\S/)));
    const out = [];
    for (const line of lines) {
      if (line.search(/\S/) !== indent) continue;
      for (const piece of line.trim().replace(/,$/, '').split(',')) {
        const p = piece.trim();
        if (p.startsWith('...')) continue;      // 展开进来的字段没法静态判定
        const m = p.match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/);
        if (m) out.push(m[1]);
      }
    }
    return out;
  }

  const returned = new Set();
  const retRe = /return\s*\{/g;
  let rm;
  while ((rm = retRe.exec(viewsCode)) !== null) {
    const open = rm.index + rm[0].length - 1;
    let depth = 0, end = -1;
    for (let j = open; j < viewsCode.length; j++) {
      if (viewsCode[j] === '{') depth++;
      else if (viewsCode[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) continue;
    for (const k of returnedKeys(viewsCode.slice(open + 1, end))) returned.add(k);
  }

  // 消费方 = 全仓源码，**不含测试**：测试里 `expect(r.x).toBe(...)` 断言过某个键，
  // 只说明它被算出来了，不说明有任何人把它端给用户 —— 那正是本表要抓的情形。
  const consumerDirs = ['app', 'core', 'scripts', 'native'];
  const consumerFiles = ['cli.js', 'server.js'];
  let consumerCode = consumerFiles
    .filter(f => fs.existsSync(path.join(ROOT, f)))
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  for (const dir of consumerDirs) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of collectSources(abs)) {
      if (file === VIEWS) continue;
      consumerCode += '\n' + fs.readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    }
  }
  // views.js 自己也要算消费方，否则 `resolveActor()` 这类**内部** helper 的返回字段
  // （certain / scopedUid）会被误报成没人读 —— 它们确实只在本文件里以 `actor.certain`
  // 的形式用掉，从没穿过 IPC。但只认属性读取这一种形式：
  // 把整份 views.js 并进来会让 `unknownOrder,`（写在 return 里的简写）自己把自己算成已读。
  const selfReads = viewsCode;

  it('确实扫到了返回字段（解析器本身要有效）', () => {
    expect(returned.size).toBeGreaterThan(60);
    expect(returned.has('accountCertain')).toBe(true);
  });

  it('无人读取的字段与已知欠债一致（只会变短，修完来这里划掉）', () => {
    const unread = [...returned]
      .filter(k => !new RegExp(`\\b${k}\\b`).test(consumerCode))
      // 本文件内的证据必须是 `.k`（属性读取），前后不能紧跟标识符字符
      .filter(k => !new RegExp(`\\.${k}(?![\\w$])`).test(selfReads))
      .sort();
    expect(unread).toEqual([...KNOWN_UNREAD].sort());
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

describe('界面文案里不许出现命令行指令', () => {
  // 回归背景：「运营对象」页的空态写着"目前往这里添加对象的入口只有命令行
  // （node cli.js get <视频ID>）"，而界面里本来就有「找视频」页 —— 那句话不是
  // 指引，是承认界面做不到。这个产品的用户是不碰终端的批量运营者，
  // 一句 `node cli.js …` 对他们等于"这页没用"。
  //
  // 所以这里要求**零欠债**：界面（视图与组件）里任何一处出现 `node cli.js` /
  // `node server.js`，无论写在 JSX 文本还是字符串里，都是红。
  // 剥注释是必要的 —— errors.js 与 useAutoRefresh.js 的注释里正好在解释
  // 以前那两句英文原话长什么样，那些是**必须保留**的说明。
  const DIRS = ['views', 'components', 'settings'];

  it('视图与组件里没有 node cli.js / node server.js', () => {
    const hits = [];
    for (const dir of DIRS) {
      const abs = path.join(RENDERER_SRC, dir);
      if (!fs.existsSync(abs)) continue;
      for (const file of collectSources(abs)) {
        const code = fs.readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        const m = code.match(/node\s+(?:cli|server)\.js/);
        if (m) hits.push(`${path.relative(ROOT, file)}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('运营对象的空态真的指向「找视频」页（不是只说一句就走）', () => {
    // 上面那条只保证"没有命令行"，不保证换成了能点的地方。
    // 空态若只讲道理不给出口，运营者还是得自己找侧栏。
    const code = fs.readFileSync(path.join(RENDERER_SRC, 'views', 'TargetsView.jsx'), 'utf8');
    expect(code).toMatch(/goto\('discover'\)/);
  });
});

describe('找视频页必须能一次加入多个', () => {
  // 回归背景：这一页以前只有逐行的「加入运营对象」，加十个对象就是十次点击、
  // 十次进队列 —— 而"搜一批、全部收进来"正是批量运营者最常用的动作。
  // 三件事一起钉：有勾选框、批量调用真的把所选递进去、加完有地方可去。
  const code = () => fs.readFileSync(path.join(RENDERER_SRC, 'views', 'DiscoverView.jsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('有勾选框，且批量排入用的是所选那一组', () => {
    expect(code()).toMatch(/type="checkbox"/);
    expect(code()).toMatch(/addTargets\(\s*pickedAddable\s*\)/);
  });

  it('已经在运营的行不给勾选（勾了也只能排一条注定重复的任务）', () => {
    // 不给勾选时那一列仍然要占位，否则封面会左右错位
    expect(code()).toMatch(/mine\s*\?\s*<span className="discover-pick" \/>/);
  });

  it('加完有直达「运营对象」的出口', () => {
    expect(code()).toMatch(/goto\('targets'\)/);
  });
});

describe('工作台的浏览状态要跨页存活，且以当前列表为准', () => {
  // 回归背景：工作台是会被整个卸载的（去草稿箱、回列表页都会），而它以前把
  // 标签 / 搜索 / 排序 / 勾选全放在组件里。运营者勾完 20 条去草稿箱确认，
  // 回来时搜索词、排序、勾选一起没了 —— 只能重敲重勾一遍。
  // 同时"勾选必须与眼前看到的评论一致"这条不能松：所以清空改成了
  // 与列表求交集（看不见的掉出去），而不是无脑清零。
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = () => strip(fs.readFileSync(path.join(RENDERER_SRC, 'views', 'WorkspaceView.jsx'), 'utf8'));
  const appCode = () => strip(fs.readFileSync(APP, 'utf8'));

  it('App 按 awemeId 存这份状态，并真的传给了工作台', () => {
    const app = appCode();
    expect(app).toMatch(/wsMemo = useRef\(new Map\(\)\)/);
    expect(app).toMatch(/memo=\{wsMemo\.current\.get\(workspaceId\)\}/);
    expect(app).toMatch(/onMemo=\{\(m\) => wsMemo\.current\.set\(workspaceId, m\)\}/);
    // 换号要清表：留着就是拿上一个号的勾选去背书新号的列表
    expect(app).toMatch(/wsMemo\.current\.clear\(\)/);
  });

  it('视图从 memo 恢复每一项浏览状态，并把变更写回去', () => {
    const ws = code();
    for (const key of ['tab', 'search', 'searchInput', 'order', 'picked']) {
      expect(ws, `工作台没从 memo 恢复 ${key}`).toContain(`memo.${key}`);
    }
    expect(ws).toMatch(/onMemo\(\{ tab, search, searchInput, order, picked/);
  });

  it('读回列表后把勾选与列表求交集（不是无脑清空）', () => {
    const ws = code();
    expect(ws).toMatch(/const visible = new Set\(\(c\.data\.items \|\| \[\]\)\.map\(i => i\.cid\)\)/);
    expect(ws).toMatch(/visible\.has\(cid\)/);
  });

  it('批量生成完把刚存的那几条带进草稿箱勾上（不是只跳转），上限写在明面上', () => {
    const ws = code();
    expect(ws).toMatch(/\{MAX_PICK\}/);
    // 带过去的必须是"真的存进草稿箱了"的那些 id：生成成功但存失败的条目
    // 到了草稿箱里根本不存在，勾上它就是给下一批埋一个"这条已不在箱里"
    expect(ws).toMatch(/actions\.gotoDrafts\(\s*bulk\.generated\.filter\(g => g\.draftId\)\.map\(g => g\.draftId\)\)/);

    const strip2 = (p) => fs.readFileSync(path.join(RENDERER_SRC, p), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const app = strip2('App.jsx');
    expect(app).toMatch(/gotoDrafts\(draftIds\)/);
    expect(app).toMatch(/presetPicked=\{draftPreset\}/);
    // 用完即弃：不清的话，后台刷新会让用户手动取消掉的勾选自己长回来
    expect(app).toMatch(/onPresetUsed=\{\(\) => setDraftPreset\(null\)\}/);

    const dv = strip2('views/DraftsView.jsx');
    // 关键的一半：勾之前先与**看得见的**那一批求交集，没勾到的条数要说出来
    expect(dv).toMatch(/presetPicked\.filter\(id => visible\.has\(id\)\)/);
    expect(dv).toMatch(/不在这个列表里/);
  });

  it('「优先级」排序没有数据时界面说出来，且 core 真的给了这个标志', () => {
    const ws = code();
    expect(ws).toMatch(/priorityReady === false/);
    // 反向的一半：视图读的字段必须真的在 core 的返回值里。
    // 这个项目的老毛病就是字段名看着像、实际没有 —— 判定恒为假而且不报错。
    const views = strip(fs.readFileSync(path.join(ROOT, 'core', 'data', 'views.js'), 'utf8'));
    expect(views).toMatch(/priorityReady:/);
  });
});

describe('生成这条链路必须有前置检查，且理由看得见', () => {
  // 回归背景：开箱 reply.mode=ai 而 llm.api_key 是空的，第一次点「批量生成」
  // 必定是入队 → 等一轮间隔 → 真发一趟请求 → 拿回 `LLM API 请求失败 (HTTP 401)`。
  // 三处一起做才成立：core 先拒（不占队列）、界面先拦（不让人白等）、
  // 而且理由要写在明面上 —— 灰按钮配悬停提示，对不懂技术的人等于没说。
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const read = (...p) => strip(fs.readFileSync(path.join(...p), 'utf8'));
  const ws = () => read(path.join(RENDERER_SRC, 'views', 'WorkspaceView.jsx'));

  it('core：没有 Key 就不发那趟请求', () => {
    const llm = read(path.join(ROOT, 'core'), 'llm.js');
    expect(llm).toMatch(/if \(!this\.apiKey\) throw new Error\(aiReady\(\)\.reason\)/);
    // 判 Key 的优先级规则只能有一处，构造函数与就绪判定共用它
    expect(llm.match(/resolveApiKey\(\)/g).length).toBeGreaterThanOrEqual(2);
  });

  it('core：aiReady 随 reply-source 的 describe() 一起透出来', () => {
    expect(read(path.join(ROOT, 'core', 'reply-source'), 'index.js')).toMatch(/ai: require\('\.\.\/llm'\)\.aiReady\(\)/);
  });

  it('界面：两颗生成按钮按同一个结论禁用', () => {
    const code = ws();
    expect(code).toMatch(/replyDesc\.ai/);
    expect(code).toMatch(/disabled=\{!!bulkTaskId \|\| !!genBlock\}/);
    expect(code).toMatch(/disabled=\{genRunning \|\| selected\.replied \|\| !!genBlock\}/);
  });

  it('界面：理由写在明面上，并且给一个去「设置」的出口', () => {
    const code = ws();
    expect(code).toMatch(/现在生成不了：\{genBlock\}/);
    expect(code).toMatch(/goto\('settings'\)/);
  });

  it('界面：被 AI 挡住时有颗真的改用「固定内容」的出口', () => {
    const code = ws();
    // 补丁里只有这一项 —— 用户点的是一颗具体的出口，不是一次"保存设置"
    expect(code).toMatch(/config\.set\(\{ reply: \{ mode: 'fixed' \} \}\)/);
    // 改完必须重读结论：否则那三颗按钮还按旧模式灰着，看起来像没生效
    expect(code).toMatch(/await window\.dy\.reply\.describe\(\)/);
    // 固定列表本身空着时不给这条路（改了只是把同一个坑换个位置踩）
    expect(code).toMatch(/genBlock !== FIXED_EMPTY && fixedUsable > 0/);
  });

  it('设置页：API Key 从没填过要看得出来', () => {
    // 敏感字段在草稿里一律是空串，"没填过"与"填过了但不回显"长得一模一样 ——
    // 判据只能读已落盘那份（打码值非空）。写成读 cfg 就恒为"没填过"。
    const schema = read(path.join(RENDERER_SRC, 'settings'), 'schema.js');
    expect(schema).toMatch(/status: \(cfg, saved\) => \(saved\['llm\.api_key'\] \? null : 'unset'\)/);
    expect(read(path.join(RENDERER_SRC, 'views'), 'SettingsView.jsx'))
      .toMatch(/flatten\(described\.config, \[\]\)/);
    const fields = read(path.join(RENDERER_SRC, 'settings'), 'fields.jsx');
    expect(fields).toMatch(/field\.status\(cfg \|\| \{\}, saved \|\| \{\}\)/);
    expect(fields).toMatch(/status === 'unset'/);
  });

  it('那句理由指向的设置分组名，在设置页里真的存在', () => {
    // 否则用户按着提示去找一个界面上没有的分组 —— 提示本身就是新的坑
    expect(read(path.join(ROOT, 'core'), 'llm.js')).toContain('「AI 模型」');
    expect(read(path.join(RENDERER_SRC, 'settings'), 'schema.js')).toMatch(/label: 'AI 模型'/);
  });
});

describe('倒计时必须走表，不能停在推送那一刻', () => {
  // 同一类失效在这个项目里已经出现三次：发布确认框的「还需等待 00:47」、
  // 队列任务行的等待、以及队列页顶部那个全页最大的倒计时。共同点都是
  // 拿"还剩多久"的**快照**去渲染，而主进程只在队列边界（入队/开始/等待/
  // 恢复/结束）推一次 —— 于是数字冻住，状态词也永远停在「等待中」。
  // core 为此在 policy.stats() 里同时给出绝对时刻（*At），界面必须
  // 用「绝对时刻 - 本地 now」。这条护栏就是防止有人再改回快照。
  const queueCode = () => fs.readFileSync(path.join(RENDERER_SRC, 'views', 'QueueView.jsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('队列页读绝对时刻，并减去本地 now', () => {
    const code = queueCode();
    expect(code).toContain('nextWriteAllowedAt');
    expect(code).toContain('cooldownUntil');
    expect(code).toMatch(/nextWriteAllowedAt[^\n]*- now/);
    expect(code).toMatch(/cooldownUntil[^\n]*- now/);
    // 任务行那条等待同理（它用的是队列给的 wait.until）
    expect(code).toMatch(/wait\.until - now/);
    // 截止时刻一过就不再渲染这个数字 —— 停在 00:00 的读数与"冻住"同形
    expect(code).toMatch(/task\.status === 'waiting' && task\.wait && task\.wait\.until > now &&/);
  });

  it('队列页不再用那两个快照时长做显示', () => {
    const code = queueCode();
    expect(code).not.toMatch(/policy\.nextWriteAllowedInMs/);
    expect(code).not.toMatch(/policy\.cooldownRemainingMs/);
  });

  it('正在执行的任务行走表显示已耗时（静止的「执行中」判断不了卡没卡）', () => {
    const code = queueCode();
    expect(code).toMatch(/task\.status !== 'waiting' && task\.status !== 'running'/);
    expect(code).toMatch(/duration\(now - task\.startedAt\)/);
  });

  it('core 确实把绝对时刻发出来了（两个字段与快照同源）', () => {
    const code = fs.readFileSync(path.join(ROOT, 'core', 'policy', 'index.js'), 'utf8');
    expect(code).toMatch(/nextWriteAllowedAt:\s*nextWriteAllowedInMs > 0 \? ts \+ nextWriteAllowedInMs : 0/);
    expect(code).toMatch(/cooldownUntil:\s*cooldownRemainingMs > 0 \? ts \+ cooldownRemainingMs : 0/);
  });
});

describe('同一页上的数字必须各说各的口径', () => {
  // 回归背景：这一组的缺陷都不是"算错了"，而是"算对了但没说是怎么算的"——
  // 于是两个都对的数并排放着，读的人只能得出"界面在撒谎"这一个结论。
  const strip2 = (rel) => fs.readFileSync(path.join(RENDERER_SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('运营对象：不许再说「已回 N（其中我发的 M）」', () => {
    const code = strip2('views/TargetsView.jsx');
    // core 的 statsForVideo 里 mine 要求 replied=0，两个桶互斥，
    // "其中"把它说成 replied 的子集 —— 那是一句假话
    expect(code).not.toMatch(/其中我发的/);
    expect(code).toMatch(/我发的 <span className="num">\{t\.commentStats\.mine\}<\/span>/);
    expect(code).toMatch(/都不算待回复/);
  });

  it('工作台：减项 mine 要显示出来，且两组口径不同这件事写在明面上', () => {
    const code = strip2('views/WorkspaceView.jsx');
    expect(code).toMatch(/我发的 <span className="num">\{stats\.mine\}<\/span>/);
    expect(code).toMatch(/待处理 = 本地 − 已回 − 我发的/);
    // 判定三项与状态两组必须分开成两块，混在一行里就是"六个数挤一起"
    expect(code.match(/ws-statgroup/g).length).toBeGreaterThanOrEqual(2);
  });

  it('连接页：断开的连接不许混进「已连接的账号」那一列', () => {
    const code = strip2('views/ConnectionView.jsx');
    // 旧写法是 connections.map 之后紧跟 stale.map 追加进同一个 list，
    // 于是标题那个 connections.length 与屏幕上的行数不是一回事
    expect(code).not.toMatch(
      /\{connections\.map\(c => <ConnectionRow key=\{c\.id\} c=\{c\} actions=\{actions\} \/>\)\}\s*\n\s*\{stale\.map/);
    // 断开的必须自己成一节：那句话要出现两次（空态下的引导 + 单开的那一节），
    // 且其中一次确实是节标题 —— 只查两个 section-meta 是假护栏，坏版本里它同样成立
    expect((code.match(/之前的连接（已断开）/g) || []).length).toBe(2);
    expect(code).toMatch(/section-title">之前的连接（已断开）<\/h2>/);
    expect(code).toMatch(/<span className="section-meta">\{stale\.length\}<\/span>/);
  });
});
