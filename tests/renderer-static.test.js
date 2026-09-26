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

  it('界面：两颗生成按钮按同一个结论禁用，且这个结论只有一份', () => {
    const code = ws();
    const ready = read(path.join(RENDERER_SRC, 'readiness.js'));
    // 视图只许从这一个函数取判据（第二十三轮抽出去的）
    expect(code).toMatch(/const ready = replyReadiness\(replyDesc, replyError\);/);
    expect(code).toMatch(/const \{[^}]*genBlock[^}]*\} = ready;/);
    // 判据本体在 readiness 里，而且是 core 的那份结果，界面不自己算
    expect(ready).toMatch(/const aiOk = !desc \|\| !desc\.ai \|\| desc\.ai\.ok;/);
    expect(code).not.toMatch(/!replyDesc \|\| !replyDesc\.ai/);
    expect(code).toMatch(/disabled=\{!!bulkTaskId \|\| !!genBlock\}/);
    expect(code).toMatch(/disabled=\{genRunning \|\| selected\.replied \|\| !!genBlock\}/);
  });

  it('界面：理由写在明面上，并且给一个去「设置」的出口', () => {
    const code = ws();
    // 「读到了但被拦住」与「这次没读回来所以不知道」是两句话，两句都必须在，
    // 而且都紧跟 {genBlock} —— 只留一句的话，另一支就又变成没根据的断言了
    expect(code).toMatch(/现在生成不了：'\}\{genBlock\}。/);
    expect(code).toMatch(/ready\.state === 'unreadable' \? '现在不知道能不能生成：'/);
    expect(code).toMatch(/goto\('settings'\)/);
  });

  it('界面：被 AI 挡住时有颗真的改用「固定内容」的出口', () => {
    const code = ws();
    // 补丁里只有这一项 —— 用户点的是一颗具体的出口，不是一次"保存设置"
    expect(code).toMatch(/config\.set\(\{ reply: \{ mode: 'fixed' \} \}\)/);
    // 改完必须重读结论：否则那三颗按钮还按旧模式灰着，看起来像没生效。
    // 第二十三轮起这句在 reloadReply 里，且调用方必须拿它返回值决定收尾怎么说
    expect(code).toMatch(/return window\.dy\.reply\.describe\(\)/);
    expect(code).toMatch(/const confirmed = await reloadReply\(\);/);
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
  const codeOf = (...rel) => fs.readFileSync(path.join(RENDERER_SRC, ...rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('队列页读绝对时刻，并减去本地 now', () => {
    const code = queueCode();
    expect(code).toContain('nextWriteAllowedAt');
    expect(code).toContain('cooldownUntil');
    expect(code).toMatch(/nextWriteAllowedAt[^\n]*- now/);
    expect(code).toMatch(/cooldownUntil[^\n]*- now/);
    // 任务行那条等待同理（它用的是队列给的 wait.until）。
    // ⚠️ 不再限定 status==='waiting'：命令内部等读间隔时任务是 running，
    // 那才是最长的一段等待，限定状态就等于把读间隔的倒计时又关掉。
    expect(code).toMatch(/wait\.until - now/);
    expect(code).toMatch(/task\.wait && task\.wait\.until > now &&/);
  });

  it('页内那条实时状态（TaskActivity）也走绝对时刻，不读快照时长', () => {
    const code = codeOf('components', 'TaskActivity.jsx');
    expect(code).toMatch(/task\.wait\.until > now \? task\.wait\.until - now : 0/);
    expect(code).toMatch(/mmss\(waitLeft\)/);
    // 不许改回读主进程推来的那份剩余时长：它只在推送那一刻成立
    expect(code).not.toMatch(/remainingMs/);
    // 任务跑完就不再渲染这一行 —— 留着一句「执行中」是假话
    expect(code).toMatch(/FINISHED\.includes\(task\.status\)/);
  });

  it('等待读数与走表时钟各只有一份实现', () => {
    // 这一轮之前 mmss 在队列页与发布确认弹窗各一份、走表在三个组件里各一份，
    // 于是"新加一个页面要显示倒计时"必然长成第四种写法。
    expect(codeOf('format.js')).toMatch(/export function mmss/);
    expect(codeOf('format.js')).toMatch(/export function duration/);
    expect(codeOf('useNow.js')).toMatch(/setInterval\(\(\) => setNow\(Date\.now\(\)\), intervalMs\)/);
    for (const rel of [['views', 'QueueView.jsx'], ['components', 'PublishDialog.jsx'], ['components', 'TaskActivity.jsx']]) {
      const code = codeOf(...rel);
      expect(code).not.toMatch(/function mmss/);
      expect(code).not.toMatch(/function duration/);
      expect(code).not.toMatch(/setInterval\(\(\) => setNow/);
    }
  });

  it('队列页不再用那两个快照时长做显示', () => {
    const code = queueCode();
    expect(code).not.toMatch(/policy\.nextWriteAllowedInMs/);
    expect(code).not.toMatch(/policy\.cooldownRemainingMs/);
  });

  it('正在执行的任务行走表显示已耗时（静止的「执行中」判断不了卡没卡）', () => {
    const code = queueCode();
    // 走表的开关是一个 ticking 判据，交给共用的 useNow（不再各写一份 setInterval）
    expect(code).toMatch(/const ticking = task\.status === 'waiting' \|\| task\.status === 'running';/);
    expect(code).toMatch(/useNow\(\{ enabled: ticking \}\)/);
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

describe('切页不会丢掉已经花掉的时间', () => {
  // 回归背景：主区每个页面都是 `{view === 'x' && <X/>}`，切走就是**整个卸载**。
  // 于是"等 30–50 秒读间隔换来的搜索结果""排进队列的 8 条拉取"在切页那一刻蒸发，
  // 而行上的"拉取中…"因为订阅已经退掉而永远停在那里。
  const code = () => strip2b('views/DiscoverView.jsx');

  function strip2b(rel) {
    return fs.readFileSync(path.join(RENDERER_SRC, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  it('App 真的把 memo / onMemo / 队列快照接到了找视频页上', () => {
    const app = strip2b('App.jsx');
    expect(app).toMatch(/const discoverMemo = useRef\(null\);/);
    // 只声明不传等于没接线（这一类"字段存在但没人读"是本仓最常见的 bug 形态）
    expect(app).toMatch(/memo=\{discoverMemo\.current\}/);
    expect(app).toMatch(/onMemo=\{\(m\) => \{ discoverMemo\.current = m; \}\}/);
    expect(app).toMatch(/queueState=\{queueState\}/);
    // 换号必须清掉：行上的「已在运营」与勾选都是按上一个号算的
    expect(app).toMatch(/discoverMemo\.current = null;/);
  });

  it('每一项视图状态都从 memo 起，而不是一进页面就归零', () => {
    for (const f of ['mode', 'keyword', 'userInput', 'results', 'status',
      'pending', 'notice', 'error', 'justDone']) {
      expect(code()).toContain(`useState(() => (memo && memo.${f})`);
    }
    expect(code()).toContain('new Set((memo && memo.picked) || [])');
    // 「拉取中」的那批不另存一份清单：从 pairs 推出来，两处各自更新必然分叉
    expect(code()).toContain('((memo && memo.addingPairs) || []).map(([a]) => a)');
    expect(code()).not.toMatch(/addingIds/);
    expect(code()).toContain("useRef((memo && memo.kind) || 'search')");
  });

  it('写回 memo 的字段必须覆盖读出来的那些（读了不写回 = 下次回来还是旧的）', () => {
    const block = code().match(/if \(onMemo\) \{\s*\n\s*onMemo\(\{([\s\S]*?)\}\);/);
    expect(block).toBeTruthy();
    for (const f of ['mode', 'keyword', 'userInput', 'results', 'status', 'pending',
      'notice', 'error', 'justDone', 'kind', 'picked', 'addingPairs']) {
      expect(block[1]).toMatch(new RegExp(`\\b${f}\\b`));
    }
  });

  it('离开期间已经跑完的任务，靠队列快照补收而不是等事件重发', () => {
    const src = code();
    // 顺序即语义：先照快照判一次，再决定要不要订阅。反过来就是"永远停在正在搜索…"
    expect(src.indexOf('isSettled(snap)')).toBeGreaterThan(-1);
    expect(src.indexOf('isSettled(snap)')).toBeLessThan(src.indexOf('window.dy.queue.onChanged'));
    expect(src).toMatch(/if \(collectAdded\(queueState\.tasks \|\| \[\]\)\) stopWatching\(\);/);
    // 还有在跑的必须把监听重新挂上，否则"拉取中…"同样永远不消失
    expect(src).toMatch(/else watchQueue\(\);/);
  });

  it('批量拉取的账单分开成功与失败，并给出下一步的出口', () => {
    const src = code();
    expect(src).toMatch(/if \(t\.status === 'done'\) ok\.push\(awemeId\); else failedIds\.push\(awemeId\);/);
    expect(src).toMatch(/个没拉到 —— 行上仍是「加入运营对象」/);
    // 单个视频直接进工作台；一批则回「运营对象」。只说"完成了"不给出路，等于没修
    expect(src).toMatch(/actions\.openWorkspace\(justDone\.ok\[0\]\)/);
    expect(src).toMatch(/actions\.goto\('targets'\)/);
  });
});

describe('"有几个号没连上"全仓只能有一个判据', () => {
  const strip3 = (rel) => fs.readFileSync(path.join(RENDERER_SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('侧栏那句与连接页那一节读的是同一个函数', () => {
    expect(strip3('status.js')).toMatch(/export function unconnectedAccounts\(account, status\)/);
    const sidebar = strip3('components/Sidebar.jsx');
    const conn = strip3('views/ConnectionView.jsx');
    expect(sidebar).toMatch(/unconnectedAccounts\(account, status\)/);
    expect(conn).toMatch(/unconnectedAccounts\(account, status\)/);
    // 各自 filter 一遍就是两个 N：侧栏说 2、点进去看到 1，用户开始怀疑所有数字
    expect(sidebar).not.toMatch(/otherAccounts/);
    expect(conn).not.toMatch(/listedUids/);
  });

  it('那句提示是真的入口，不是只多说一句', () => {
    const sidebar = strip3('components/Sidebar.jsx');
    expect(sidebar).toMatch(/onClick=\{\(\) => onNavigate\('connection'\)\}/);
    expect(sidebar).toMatch(/另有 \{unconnected\.length\} 个号未连接 —— 怎么连上/);
  });

  it('「怎么连上」写在明面上，不是悬停才看得到', () => {
    const conn = strip3('views/ConnectionView.jsx');
    expect(conn).toMatch(/新开一个标签页登录那个号/);
    expect(conn).not.toMatch(/title=[^\n]*新开一个标签页/);
    expect(conn).toMatch(/section-title">名册里的其他号（当前没连上）</);
  });
});

describe('「全选」不许承诺它覆盖不到的范围', () => {
  const drafts = fs.readFileSync(path.join(RENDERER_SRC, 'views', 'DraftsView.jsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('按钮说的是可见条数，没载入的那些当场说清楚', () => {
    expect(drafts).not.toMatch(/全选这一页/);
    expect(drafts).toMatch(/全选这 \{list\.length\} 条/);
    expect(drafts).toMatch(/条没载入，这一勾覆盖不到它们/);
    // hidden 的口径只有一个来源：命中数（或整箱数）减去已载入
    expect(drafts).toMatch(/const hidden = Math\.max\(0, \(query \? hitTotal : boxTotal\) - list\.length\)/);
  });

  it('勾满可见的那些时，批量条要说出没覆盖的那部分', () => {
    expect(drafts).toMatch(/hidden > 0 && pickedIds\.length === list\.length/);
    expect(drafts).toMatch(/没勾上/);
  });
});

describe('批量改正文：预览与执行必须是同一次判定', () => {
  // 回归风险（这一轮新写的链路，还没有历史可回归）：草稿的"改"以前根本不存在，
  // 界面是拿 save 新行 + remove 旧行拼出来的 —— 于是 id 变了、created_at 变了、
  // 视频分组顺序也变了。这一轮换成了真 UPDATE，同时新增了一条批量链路。
  // 这条链路上最贵的两种错法都是**不报错**的：
  //   1. 预览的条数由界面自己数（core 说 12 条、实际写 11 条，用户按下去才发现）；
  //   2. 预览与执行各自拼一遍 patch（预览按「整批替换」算，执行按「查找替换」写）。
  // 所以这里钉的不是"有没有这个功能"，而是"这两半是不是同一个东西"。
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const draftsCode = () => strip(fs.readFileSync(
    path.join(RENDERER_SRC, 'views', 'DraftsView.jsx'), 'utf8'));

  it('确认键上的数字来自 core 的 dryRun，不是界面数出来的', () => {
    const code = draftsCode();
    expect(code).toMatch(/draft\.updateMany\(pickedIds, patch, \{ dryRun: true \}\)/);
    // 反向的一半：按钮文案里出现 pickedIds.length 就是"界面自己数的"，
    // 而它必然与 core 的数不同（已发布的、别人号上的、本来就是这样的都不算）
    expect(code).not.toMatch(/确认改动 \$\{pickedIds\.length/);
    expect(code).toMatch(/`确认改动 \$\{editData \? editData\.changed : '…'\} 条`/);
  });

  it('预览没回来之前按不动（宁等一秒也不给一个猜出来的数）', () => {
    expect(draftsCode()).toMatch(/disabled=\{editBusy \|\| !editPatchNow \|\| !editData\}/);
  });

  it('预览与执行发的是同一个 patch 产物', () => {
    const code = draftsCode();
    // 派生只有一处，两处发送各自取用这个变量 —— 再拼一遍就是两个判据
    expect(code).toMatch(/const editPatchNow = editPatch\(editMode, editAssign, editFind, editReplace\)/);
    expect((code.match(/const patch = editPatchNow;/g) || []).length).toBe(2);
    expect((code.match(/\beditPatch\s*\(/g) || []).length).toBe(2); // 定义 + 那一处派生
  });

  it('空着的「整批替换」是还没填完，不是要把正文清空', () => {
    // 探针实测到过：一打开弹窗就报「会改动 1 条」而确认键是亮的
    expect(draftsCode()).toMatch(/String\(assign == null \? '' : assign\)\.trim\(\)/);
  });

  it('三句"这一改做不到什么"是正文，不是悬停才看得到', () => {
    const code = draftsCode();
    for (const phrase of ['不会跟着变', '统一换人格', '这次改不到它们']) {
      expect(code, `少了那一句：${phrase}`).toContain(phrase);
      expect(code, `「${phrase}」被写成了 title`).not.toMatch(new RegExp(`title=[^\\n]*${phrase}`));
    }
    // 「没有统一换人格」必须同时给出真出路，只说"做不到"等于埋一个更深的坑
    expect(code).toMatch(/要换口吻得回工作台重新生成/);
  });

  it('单条编辑走真 UPDATE，不再 save 一条新的删一条旧的', () => {
    const code = draftsCode();
    expect(code).toMatch(/draft\.updateMany\(\[d\.id\], \{ text: editText \}\)/);
    // save 一次都没了才算换干净（remove 仍在，那是"删除"这条链路的正当用法）
    expect(code).not.toMatch(/draft\.save\(/);
    // 而且失败要分原因报：空正文、没变化、已经发掉，是三件不同的事
    expect(code).toMatch(/正文空了/);
  });

  it('core 那一侧：改的是这一行的 text，别的字节都不动', () => {
    const code = strip(fs.readFileSync(path.join(ROOT, 'core', 'memory', 'drafts.js'), 'utf8'));
    expect(code).toMatch(/UPDATE drafts SET text = \? WHERE id = \? AND posted = 0/);
    // created_at / id / aweme_id 一旦被重建，行就会在"按时间分组"的视图里跳位
    expect(code).not.toMatch(/UPDATE drafts SET[^']*created_at/);
    // 查找替换必须是字面量替换：$& 与 (1) 这类用户输入的文本会反过来吃掉替换结果
    expect(code).toMatch(/\.split\(patch\.find\)\.join\(repl\)/);
    expect(code).not.toMatch(/\.replace\(new RegExp|new RegExp\(patch\.find/);
  });

  it('ipc 补上当前账号，探针只做预览、绝不动笔', () => {
    const ipc = strip(fs.readFileSync(path.join(ROOT, 'app', 'main', 'ipc.js'), 'utf8'))
      // 主进程那句是竖排的参数对象（每个键一行），压平再比 ——
      // 把换行写进正则的护栏，一次无关的排版调整就能把它弄红
      .replace(/\s+/g, ' ');
    expect(ipc).toMatch(/'draft:update-many'/);
    // 账号边界只能由主进程补：渲染层传什么 uid 都不算数（换号后它拿的是旧 id）
    expect(ipc).toMatch(/drafts\.updateMany\(ids, patch, \{ \.\.\.opts, accountUid: currentAccountUid\(\), \}\)/);
    const probe = strip(fs.readFileSync(path.join(ROOT, 'scripts', '_probe.js'), 'utf8'));
    expect(probe).toMatch(/if \(!opts \|\| opts\.dryRun !== true\) return refused\(\)/);
  });
});

// ═══════════════════════════════════════════════════════════
// 第二十一轮：两个空态 + 检查更新的"下一步"
//
// 三条都在补同一个毛病：**界面把最后一步推回给用户**。
//   - 找视频的空态放一组"推荐关键词" —— 那组词是这个工具的作者想象中的领域；
//   - 工作台的空态说"换个筛选标签看看" —— 而这一页头顶就摆着每个筛选各有多少条；
//   - 检查更新只给一句"有新版本"加一个浏览器按钮 —— 该下哪个文件、装完数据还在不在，
//     全留给用户猜。
// 三条都能被"改回原样"轻易绕过，所以钉的是**结构**：数据从哪来、分支分了几条、
// 出口是不是真点得动。
// ═══════════════════════════════════════════════════════════
describe('空态与更新指引必须给得出下一步', () => {
  const code = (name) => fs.readFileSync(path.join(RENDERER_SRC, 'views', name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  // ── 1. 找视频：那几个词只能来自真历史 ──
  it('找视频页的关键词来自 data.searchHistory，而不是写死的一组词', () => {
    const c = code('DiscoverView.jsx');
    expect(c).toMatch(/window\.dy\.data\.searchHistory\(/);
    // 内置推荐词是本轮特意不要做的事：一旦出现"看起来像词表"的常量就是回退了
    expect(c).not.toMatch(/(?:RECOMMEND|SUGGEST)_?(?:KEYWORDS|WORDS)\s*=/);
    expect(c).not.toMatch(/推荐关键词|热门关键词|试试搜/);
  });

  it('HistoryChips 四种状态分开（没读回来 / 读失败 / 翻过但没成功 / 真有历史）', () => {
    const fn = code('DiscoverView.jsx');
    const chips = fn.slice(fn.indexOf('function HistoryChips'));
    expect(chips).toMatch(/if \(!history\) return null/);   // 还没读回来不许先说"没有"
    expect(chips).toMatch(/history\.error/);                 // 读失败要说得出来
    expect(chips).toMatch(/history\.scanned > 0/);           // 搜过但都没出结果 ≠ 没搜过
    expect(chips).toMatch(/history\.truncated/);             // 只翻了近 N 条要说明
    expect(chips).toMatch(/onPick\(k\.keyword\)/);           // 而点了确实会再搜一次
  });

  // ── 2. 工作台：空态要能用上这一页已经知道的数 ──
  it('工作台空态不再甩一句"换个筛选标签看看"，而是把筛选切过去', () => {
    const c = code('WorkspaceView.jsx');
    expect(c).not.toMatch(/换个筛选标签看看/);
    const fn = c.slice(c.indexOf('function ListEmpty'));
    // 三种空态的出路完全不同，各自都要有分支
    expect(fn).toMatch(/if \(!stats\)/);                 // 统计还没读回来：不给结论
    expect(fn).toMatch(/if \(search\)/);                 // 搜索没命中：清词
    expect(fn).toMatch(/stats\.total === 0/);            // 本地一条都没有：先拉
    // 出路必须点得动，不是一句话
    expect(fn).toMatch(/onClick=\{\(\) => onTab\(c\.key\)\}/);
    expect(fn).toMatch(/onClick=\{onFetch\}/);
    expect(fn).toMatch(/disabled=\{!canQueue\}/);        // 没连上浏览器时不许假装能点
  });

  it('搜索那一支不报各筛选的条数（两套口径并排就是"数字各说各的"）', () => {
    const fn = code('WorkspaceView.jsx');
    const empty = fn.slice(fn.indexOf('function ListEmpty'));
    const branch = empty.slice(empty.indexOf('if (search)'), empty.indexOf('if (stats.total === 0)'));
    expect(branch).toContain('清空搜索词');
    expect(branch).not.toMatch(/empty-chip/);            // 别的筛选的条数不许出现在这里
    expect(branch).not.toMatch(/byDecision/);
  });

  it('空态里那句"进度看得见"有东西承接（普通拉取也在本页跑）', () => {
    const c = code('WorkspaceView.jsx');
    expect(c).toMatch(/const \[fetchTaskId, setFetchTaskId\] = useState\(null\)/);
    expect(c).toMatch(/const fetchTask = fetchTaskId/);
    // 光有 state 不够：必须真渲染那一行，否则这句话仍是假话
    expect(c).toMatch(/\{fetchTask && \(/);
    expect(c).toMatch(/<TaskActivity\s*\n?\s*task=\{fetchTask\}/);
  });

  // ── 3. 检查更新：两条出路 + 一份说明 + 一个备份 ──
  it('诊断页读的是 releasesUrl，并按 packaged 分两条出路', () => {
    const c = code('DiagnosticsView.jsx');
    expect(c).toMatch(/update\.releasesUrl/);
    expect(c).not.toMatch(/openExternal\(update\.url\)/);   // 主进程已不返回这个字段
    expect(c).toMatch(/runtime\.packaged/);                  // 源码版与安装版是两件事
    expect(c).toMatch(/update\.localAssets/);                // 点名该下哪个文件
    expect(c).toMatch(/认不出/);                             // 认不出时要说认不出
  });

  it('失败分支也有出口，备份那颗按钮接的是真函数', () => {
    const c = code('DiagnosticsView.jsx');
    const fn = c.slice(c.indexOf('function UpdateGuide'), c.indexOf('export default function DiagnosticsView'));
    expect(fn).toMatch(/if \(!update\.ok\)/);
    // 失败时先判 releasesUrl 在不在，再谈"上哪儿自己看一眼"
    expect(fn).toMatch(/update\.releasesUrl && \(/);
    expect(fn).toMatch(/onClick=\{onBackup\}/);
    // 而调用点真的把备份函数与数据目录传进来（只声明 prop 不传 = 按钮是死的）
    expect(c).toMatch(/<UpdateGuide update=\{update\} dataDir=\{info && info\.dataDir\} onBackup=\{backupData\}/);
    // 没有自动更新这件事要说明，否则用户会等一个不会发生的弹窗
    expect(fn).toMatch(/不会自己更新/);
  });

  // ── 4. 读失败不许长成"还在读"（本轮渲染核对时真撞上的） ──
  it('app:info 被拒时诊断页说话，而不是无限转圈', () => {
    const app = fs.readFileSync(path.join(RENDERER_SRC, 'App.jsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // 裸的 .then(...) 没有失败分支 —— 那正是"停在正在读取…"一辈子的形状
    expect(app).not.toMatch(/window\.dy\.info\(\)\.then\(/);
    const loader = app.slice(app.indexOf('const loadInfo = useCallback'));
    expect(loader).toMatch(/try \{/);
    expect(loader).toMatch(/catch/);
    expect(loader).toMatch(/setInfoError\(/);
    // 失败状态必须真的传到那一页（只 setState 不传 = 界面还是看不见）
    // readErrors 是后台读数的失败账本：这一页是"别的地方坏了才来看"的地方，
    // 账本不传过来，它就只能报自己这一块。
    expect(app).toMatch(/<DiagnosticsView\s+info=\{info\}\s+infoError=\{infoError\}\s+onRetryInfo=\{loadInfo\}\s+readErrors=\{readErrors\}/);

    const c = code('DiagnosticsView.jsx');
    expect(c).toMatch(/\(\{ info, infoError, onRetryInfo,/);
    // 「还在读」与「读失败了」分成两支：无限制的那一支只能是还在读
    const branch = c.slice(c.indexOf('if (!info)'), c.indexOf('return (\n    <div className="main-col">\n      <h1 className="page-title">诊断</h1>\n      <p className="page-sub">'));
    expect(branch).toMatch(/infoError \?/);
    expect(branch).toMatch(/读运行环境失败/);
    expect(branch).toMatch(/onClick=\{onRetryInfo\}/);   // 重试接的是真函数，不是摆设
  });

  it('检查更新整个 IPC 没回来时也要说话（按钮不能点下去没反应）', () => {
    const c = code('DiagnosticsView.jsx');
    const fn = c.slice(c.indexOf('async function checkUpdate'), c.indexOf('const loadEvents'));
    expect(fn).toMatch(/catch \(e\)/);
    // 拒了的形状要和"问到了但失败"走同一支渲染，否则多出一条没人看的分支
    expect(fn).toMatch(/setUpdate\(\{ ok: false/);
  });
});

describe('第二十二轮：主进程读数失败在界面上必须有形状', () => {
  // 判据（与 §2.38 那一条同源）：**"还在读"与"读失败了"不许在屏幕上同形。**
  // 这一轮把 App.jsx 里那四份裸着的后台读数（连接状态 / 队列 / 账号 / 作品）
  // 全部接进一份失败账本，并且给每一处原来的空态补了失败支。
  //
  // 为什么静态比对管得住这件事：这些分支**没有任何一条会被单元测试碰到** ——
  // 它们要的是一个 reject 走到 React 里。而漏掉一处（比如新加一页没传 readError）
  // 的症状是"那一页在故障时继续说'什么都没有'"，没有任何红。
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const src = (rel) => stripComments(
    fs.readFileSync(path.join(RENDERER_SRC, rel), 'utf8')
  );
  const app = src('App.jsx');
  // 断言"甲这处写法在乙之前"（分支顺序就是判据本身）
  const before = (hay, a, b, what) => {
    const ia = hay.indexOf(a);
    const ib = hay.indexOf(b);
    expect(ia, `${what}：找不到「${a}」`).toBeGreaterThanOrEqual(0);
    expect(ib, `${what}：找不到「${b}」`).toBeGreaterThanOrEqual(0);
    expect(ia < ib, `${what}：「${a}」必须排在「${b}」之前，否则失败时画出来的是后者`).toBe(true);
  };

  it('App 有一份失败账本，三种结果都落账，而且会自己消失', () => {
    expect(app).toMatch(/const \[readErrors, setReadErrors\] = useState\(\{\}\);/);
    const fn = app.slice(app.indexOf('const readSlot = useCallback'));
    expect(fn.length).toBeGreaterThan(0);
    // 读到值 → 清账（失败支必须会消失，否则用户只能重启应用）
    expect(fn).toMatch(/onOk\(v\);\s*noteRead\(key, null\);/);
    // 读到空 → 也要记，不许当成"读回来一份空的"
    expect(fn).toMatch(/if \(!v\) \{/);
    // 被拒 → 记理由 + 提示一次
    expect(fn.slice(fn.indexOf('.catch('))).toMatch(/noteRead\(key, e\);/);
    // 5 秒一次的轮询不许每轮都换新对象（那会让所有子页面的 props 全部变化）
    expect(app).toMatch(/if \(\(prev\[key\] \|\| null\) === msg\) return prev;/);
  });

  it('四份后台读数一律走账本，界面上不许再留裸的 .then()', () => {
    for (const re of [
      /window\.dy\.bridge\.status\(\)\.then\(/,
      /window\.dy\.queue\.state\(\)\.then\(/,
      /window\.dy\.account\.state\(\)\.then\(/,
      /window\.dy\.data\.videos\([^)]*\)\.then\(/,
    ]) {
      expect(app, `裸 .then()：${re}`).not.toMatch(re);
    }
    expect(app).toMatch(/readSlot\('status', '连接状态', \(\) => window\.dy\.bridge\.status\(\)/);
    expect(app).toMatch(/readSlot\('queue', '队列', \(\) => window\.dy\.queue\.state\(\)/);
    // 推送能到 = 这条通道活着：启动时那一次读失败留下的红条必须跟着消失。
    // 切片按函数边界切，别按「});」—— 回调体第一行就是 setQueueState({…});
    const push = app.slice(app.indexOf('const unQueue = window.dy.queue.onChanged'),
      app.indexOf('function applyStatus'));
    expect(push).toMatch(/noteRead\('queue', null\)/);
    expect(app).toMatch(/function applyStatus\(s\) \{[\s\S]{0,400}noteRead\('status', null\);/);
  });

  it('读数失败时不许把列表清空（那等于把故障画成"没有数据"）', () => {
    const fn = app.slice(app.indexOf('const reloadVideos = useCallback'),
      app.indexOf('const reloadDrafts = useCallback'));
    expect(fn.length).toBeGreaterThan(50);
    expect(fn).not.toMatch(/setVideos\(\[\]\)/);
    expect(fn).not.toMatch(/setVideoTotal\(0\)/);
    expect(fn).toMatch(/noteRead\('videos', r\.error/);
  });

  it('describeStatus 的失败支排在"检测中"之前，两处调用点都传第二个实参', () => {
    const st = src('status.js');
    before(st, "state: 'unreadable'", "state: 'unknown'", '读不到与还在读');
    expect(st).toMatch(/export function describeStatus\(status, readError\)/);
    // 判据只有一份实现：侧栏与状态条都调同一个函数、都传 readError
    for (const f of ['components/Sidebar.jsx', 'components/StatusBand.jsx']) {
      expect(src(f), f).toMatch(/describeStatus\(status, readError\)/);
    }
  });

  it('账本真的传到每一页（只 setState 不传 = 那一页还是看不见）', () => {
    expect(app).toMatch(/<Sidebar[\s\S]{0,400}readError=\{readErrors\.status\}/);
    expect(app).toMatch(/<QueueView\s+state=\{queueState\}\s+readError=\{readErrors\.queue\}/);
    expect(app).toMatch(/<WorksView[\s\S]{0,220}readError=\{readErrors\.videos\}/);
    expect(app).toMatch(/<ConnectionView\s+status=\{status\}\s+readError=\{readErrors\.status\}/);
  });

  /**
   * 「守卫这一支」必须**整行**对得上。
   *
   * 原来这里只 `indexOf(条件子串)`，于是把整支短路成
   * `: false && list.length === 0 && readError` 也照样通过（子串还在、顺序没变）
   * —— 变异检查 M7 就是这么漏的。锚到整行之后，加前缀、改条件、挪位置都会红。
   */
  const guards = (hay, re, after, what) => {
    const m = re.exec(hay);
    expect(m, `${what}：没找到守卫 ${re}`).not.toBeNull();
    const ib = hay.indexOf(after);
    expect(ib, `${what}：找不到「${after}」`).toBeGreaterThanOrEqual(0);
    expect(hay.indexOf(m[0]) < ib,
      `${what}：守卫排在「${after}」之后 —— 失败时会先画出「${after}」`).toBe(true);
  };

  it('每一页的空态都排在失败支之后：失败时不说"没有"', () => {
    guards(src('views/QueueView.jsx'),
      /^\s*\{tasks\.length === 0 && !state && readError$/m, 'title="队列是空的。"', '队列页空态');
    guards(src('views/WorksView.jsx'),
      /^\s*: list\.length === 0 && readError$/m, '还没有作品记录', '作品页空态');
    guards(src('views/WorkspaceView.jsx'),
      /^\s*if \(!stats && statsError\) \{$/m, '统计还在读', '工作台空态');
    guards(src('views/ConnectionView.jsx'),
      /^\s*\{!status && readError \? \($/m, '<SetupGuide', '连接页安装引导');
  });

  it('每条失败支都带一颗真能用的重读按钮（不许只报坏、不给出口）', () => {
    expect(src('views/QueueView.jsx')).toMatch(/<button className="btn" onClick=\{actions\.reloadQueue\}>重新读取<\/button>/);
    expect(src('views/WorksView.jsx')).toMatch(/<button className="btn" onClick=\{onRefresh\}>重新读取<\/button>/);
    const ws = src('views/WorkspaceView.jsx');
    expect(ws).toMatch(/onRetry=\{\(\) => reload\(\)\}/);
    // 传了回调还不够 —— 失败支里那一颗必须真的挂着它（换成一个 <span> 就是死字）
    expect(ws).toMatch(/onClick=\{onRetry\}>重新读取<\/button>/);
    // 列表整体 reject 时也要落账：改造前那里只有 finally，页面会永远停在「还在读」
    const reload = ws.slice(ws.indexOf('async function reload()'), ws.indexOf('async function doReload'));
    expect(reload).toMatch(/catch \(e\) \{/);
    expect(reload).toMatch(/setStatsError\(failText\(e && e\.message/);
    expect(ws).toMatch(/setStatsError\(s\.ok \? null :/);
  });

  it('诊断页汇总的槽位与 App 记的账本是同一批键（两份清单不许漂）', () => {
    const diag = src('views/DiagnosticsView.jsx');
    const slots = [...diag.matchAll(/const READ_SLOTS = \[\s*([\s\S]*?)\n\];/g)]
      .flatMap(m => [...m[1].matchAll(/\{ key: '(\w+)'[^\n]*?retry: '(\w+)'/g)])
      .map(m => ({ key: m[1], retry: m[2] }));
    expect(slots.length).toBe(5);
    const noted = new Set([...app.matchAll(/noteRead\('(\w+)'/g)].map(m => m[1]));
    // 诊断页列的 = App 记的。少一个键 = 那一处坏了没人说；多一个键 = 那一行永远是空的
    expect(slots.map(s => s.key).sort()).toEqual([...noted].sort());
    // 每行那颗「重新读取」必须接在 App 的 actions 上真存在的函数
    const actionKeys = parseTopLevelKeys(sliceObjectBody(appCode, 'const actions = {'));
    for (const s of slots) {
      expect(actionKeys, `READ_SLOTS 的 retry='${s.retry}' 在 App 的 actions 里不存在`)
        .toContain(s.retry);
    }
  });
});

describe('第二十二轮补：探针真渲染抓到的三处（两条数字 + 两处挤压）', () => {
  // 这一批全是**只有真渲染才看得见**的：静态比对 JSX 分支、单测 core 都抓不到。
  // 跑法是 scripts/_probe.js + 真库副本（storage/_verify-r22），
  // 再把 .shell 强行收到 940px —— 那是 app/main/window.js 里的产品最小宽度，
  // 也就是用户把窗口拖到最小时看到的样子。
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const src = (rel) => stripComments(
    fs.readFileSync(path.join(RENDERER_SRC, rel), 'utf8')
  );
  const style = stripComments(fs.readFileSync(STYLES, 'utf8'));
  /** 取某条规则的花括号内容（选择器必须整段对上，`.tab` 不会误配 `.tab-search`） */
  const rule = (sel) => {
    const m = new RegExp(sel + '\\s*\\{([^}]*)\\}').exec(style);
    expect(m, `styles.css 里找不到 ${sel} { … } 这条规则`).not.toBeNull();
    return m[1];
  };

  it('队列页：唯一那次读数没回来时，「共 0 个已完成」是句假话', () => {
    const q = src('views/QueueView.jsx');
    // 「0」是"没有"的形状。state 还没读回来时只能报未知。
    expect(q).toMatch(/state \? `共 \$\{counts\.done \|\| 0\} 个已完成` : '已完成数未知'/);
    // 配额一节同理：QuotaRow 在 policy 为空时整块不渲染，标题下面空着
    expect(q).toMatch(/\{!policy && \(/);
    expect(q).toMatch(/配额未知/);
  });

  it('工作台头部：940 宽度下按钮排不许把标题压成一条竖字', () => {
    // 改前量到 .ws-title 只剩 145px（.ws-actions 要 417px），
    // 「待处理 = 本地 − 已回…」那段解释排成一列一个字，.ws-head 高 992px
    expect(rule('.ws-head')).toMatch(/flex-wrap:\s*wrap/);
    // min-width:0 的 flex:1 永远"放得下"，所以换行必须靠一个真的基准宽度
    expect(rule('.ws-title')).toMatch(/flex:\s*1 1 (3[0-9]{2}|4[0-9]{2})px/);
  });

  it('筛选行：标签不许被压到中文断词', () => {
    expect(rule('.tab')).toMatch(/flex:\s*none/);
    expect(rule('.tab')).toMatch(/white-space:\s*nowrap/);
  });
});

describe('第二十三轮：读失败不许退成乐观的默认值', () => {
  // 判据：**一次读数失败被丢掉时，屏幕停在那个初值上 —— 而初值往往是一句假话。**
  // 这一轮抓到五处同源的丢法：
  //   `if (r && r.ok) setOrders(...)`   → 排序下拉变成一个空壳（"这应用只有一种排序"）
  //   `if (r && r.ok) setReplyDesc(...)` → 三颗按钮按"能生成"画，按下去等一轮间隔才报错
  //   `count > 0 && <角标>`             → 角标消失本身成了"没有"这句话
  //   `if (!history) return null`       → 读失败等于这一节不存在
  //   `queue.result(id).then(...)`      → 取结果被拒时，那一屏的回报整条不出现
  // 共同点：没有任何一处会红。故障时那一屏说的话比平时更可信，因为它带着数字。
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const src = (rel) => stripComments(
    fs.readFileSync(path.join(RENDERER_SRC, rel), 'utf8')
  );
  const style = stripComments(fs.readFileSync(STYLES, 'utf8'));
  /**
   * 「守卫这一支排在 X 之前」必须**整行**对得上。
   *
   * 上一轮栽过：只 `indexOf(条件子串)` 的话，把整支短路成
   * `: false && list.length === 0 && readError` 也照样通过（子串还在、顺序没变），
   * 而屏幕上失败支已经死了（§2.42）。锚到整行之后，加前缀、改条件、挪位置都会红。
   */
  const lineBefore = (hay, re, after, what) => {
    const m = re.exec(hay);
    expect(m, `${what}：没找到守卫 ${re}`).not.toBeNull();
    const ib = hay.indexOf(after);
    expect(ib, `${what}：找不到「${after}」`).toBeGreaterThanOrEqual(0);
    expect(hay.indexOf(m[0]) < ib,
      `${what}：守卫排在「${after}」之后 —— 失败时会先画出「${after}」`).toBe(true);
  };

  it('回复来源的判据只有一份，而「读不到」这一支在页面上真的被用上', () => {
    const ws = src('views/WorkspaceView.jsx');
    // 判据本体在 readiness.js，页面只 destructuring 用（这条与第十七轮那两条同源）
    expect(ws).toMatch(/const ready = replyReadiness\(replyDesc, replyError\);/);
    // 只有一份不够 —— 页面必须真的按这一支画过两处：批量条那一段 + 拦下的那块提示
    const n = (ws.match(/ready\.state === 'unreadable'/g) || []).length;
    expect(n, 'unreadable 这一支在页面上少于两处 = 有一处仍按猜的数画').toBeGreaterThanOrEqual(2);
    // 「重读」这一颗必须挂得上：三处 unreadable/stale 出口都调 reloadReply
    expect((ws.match(/onClick=\{reloadReply\}/g) || []).length).toBeGreaterThanOrEqual(3);
    // 而固定那颗在读不到时不许被顺手灰掉（它不调 AI，灰掉等于把读不到说成不能干活）
    expect(src('readiness.js')).toMatch(/fixedDisabled: false,/);
  });

  it('排序选项读失败时不许留一个空壳下拉', () => {
    const ws = src('views/WorkspaceView.jsx');
    // 三形状：失败那一支必须在 <select 之前，否则失败时先画出空下拉
    lineBefore(ws, /^\s*\{orders\.length === 0 && ordersError \? \($/m, '<select', '排序三形状');
    expect(ws).toMatch(/排序方式没读回来/);
    // 还在读那一支仍要画下拉，但不许能选（初值那一条选项是 disabled 的）
    expect(ws).toMatch(/disabled=\{orders\.length === 0\}/);
    expect(ws).toMatch(/\{orders\.length === 0 && <option value=\{order\} disabled>排序读取中…<\/option>\}/);
    // 而那条被丢掉的裸写法不许回来
    expect(ws).not.toMatch(/commentOrders\(\)\.then\(r => \{ if \(r && r\.ok\)/);
  });

  it('草稿箱：失败支排在两支空态之前，两处角标都从 navBadge 拿', () => {
    const d = src('views/DraftsView.jsx');
    lineBefore(d, /^\s*: list\.length === 0 && readError$/m, '草稿箱是空的', '草稿箱失败支');
    expect(d).toMatch(/这不是"没有草稿"/);
    // 非空但这次没重新读回来时也要说出来（否则用户拿上一次那份列表当现状用）
    expect(d).toMatch(/草稿箱这次没重新读回来/);
    const app = src('App.jsx');
    expect(app).toMatch(/draftsError=\{readErrors\.drafts\}/);
    expect(app).toMatch(/readError=\{readErrors\.drafts\}/);
  });

  it('侧栏角标不许再用「大于 0 才画」—— 消失本身就是一句话', () => {
    const sb = src('components/Sidebar.jsx');
    expect(sb).not.toMatch(/queueCount > 0 &&/);
    expect(sb).not.toMatch(/draftCount > 0 &&/);
    // 两枚都从同一份判据拿（只换一枚 = 另一枚继续在故障时沉默）
    expect(sb).toMatch(/queue: navBadge\(queueCount, queueError\)/);
    expect(sb).toMatch(/draft: navBadge\(draftCount, draftsError\)/);
    expect(sb).toMatch(/warn \? ' nav-badge-warn'/);
  });

  /**
   * 每一个 queue.result 调用点都必须接得住 reject。
   *
   * 全目录扫而不是列名单：`queue:result` 是没包 safe() 的通道，它坏掉是一个 reject，
   * 而"谁调它"会随页面增加变多 —— 名单式护栏对新加的那一处完全无感。
   * 判据是结构性的：这一处调用往后 45 行内必须出现 `.catch(` 或 `catch (e)`。
   */
  it('取任务结果被拒时，那一屏的回报不许整条消失（全目录扫）', () => {
    const bad = [];
    const sites = [];
    for (const f of collectSources(RENDERER_SRC)) {
      const rel = path.relative(RENDERER_SRC, f);
      const lines = src(rel).split('\n');
      lines.forEach((ln, i) => {
        if (!/queue\.result\(/.test(ln)) return;
        sites.push(`${rel}:${i + 1}`);
        const win = lines.slice(i, Math.min(lines.length, i + 45)).join('\n');
        if (!/\.catch\(/.test(win) && !/catch \(/.test(win)) bad.push(`${rel}:${i + 1}`);
      });
    }
    expect(bad, `这些 queue.result 调用点没有接 reject 的那一支：${bad.join('、')}`).toEqual([]);
    // 至少要有 6 处：少一处说明某个页面的取结果被删掉了，这条护栏也就空转了
    expect(sites.length).toBeGreaterThanOrEqual(6);
  });

  it('搜索历史：读失败不许等于"这一节不存在"，也不许等于"这台机器没搜过"', () => {
    const d = src('views/DiscoverView.jsx');
    // 落进同一个形状：{ok:false} 与 reject 都要写出 error，且这一节继续渲染
    expect(d).toMatch(/error: \(r && r\.error\) \|\| '未知原因'/);
    expect(d).toMatch(/error: failText\(e && e\.message, '搜索历史没读回来'\)/);
    expect(d).toMatch(/if \(history\.error\) \{/);
    expect(d).toMatch(/搜索历史这次没读回来/);
    // 裸写法不许回来：那一支会让 history 永远停在 null，而 `if (!history) return null`
    expect(d).not.toMatch(/searchHistory\(\{ limit: 8 \}\)\.then\(\(r\) => \{\s*if \(!alive\) return;\s*if \(r && r\.ok\)/);
    // 取回结果那一步：!r.ok / 结果太大 两种都不能画成"抖音没有返回"
    expect(d).toMatch(/if \(!r \|\| !r\.ok \|\| !r\.result\) \{/);
    expect(d).toMatch(/列表空着不代表抖音没有返回/);
  });

  it('设置页：整页只有一支「正在读取」时，失败必须自成一支', () => {
    const s = src('views/SettingsView.jsx');
    lineBefore(s, /^\s*if \(!described\) \{$/m, 'className="page-sub"', '整页失败支');
    lineBefore(s, /^\s*\{loadError \? \($/m, '<LoadingState', '读失败排在还在读之前');
    expect(s).toMatch(/配置没读回来/);
    expect(s).toMatch(/这不是"配置是空的"/);
    // 那颗重读键必须真挂得上（写成 <span> 就是死字）
    expect(s).toMatch(/onClick=\{\(\) => load\(\)\}>重新读取<\/button>/);
    expect(s).toMatch(/catch \(e\) \{/);
  });

  it('界面文案里不许出现 Markdown 强调（渲染层是纯文本，星号会原样露出来）', () => {
    // 本轮探针渲染抓到三处，其中两处是这一轮自己写的：
    //   「现在**不知道**「批量生成」会按什么走」
    //   「这条**没有重复发送**，但请到抖音的聊天里确认一下」
    // 第三处是旧债：诊断页「三张表都是**只增不减**的」。
    // 屏幕不是 Markdown —— 星号不会被吃掉，只会露出来。
    // 第二十一轮为「检查更新」那一块写过一条局部断言，但它管不到别的页。
    const bad = [];
    for (const f of collectSources(RENDERER_SRC)) {
      const rel = path.relative(RENDERER_SRC, f);
      const hits = (stripComments(fs.readFileSync(f, 'utf8')).match(/\*\*[^*\n]{1,40}\*\*/g) || []);
      if (hits.length) bad.push(`${rel}：${hits[0]}`);
    }
    expect(bad, `这些星号会原样出现在屏幕上：${bad.join(' ｜ ')}`).toEqual([]);
  });

  it('styles.css 里用到的每一个 var(--x) 都必须真的声明过', () => {
    // 本轮真的先写了 `background: var(--warn-soft)` —— 那张表里没有这两个令牌，
    // 于是这一格画出来是**透明的**：类名有规则、拼写也对，只有颜色不见了，
    // 而"className 必须有对应 CSS 规则"那条护栏管不到这一类。
    const root = /:root\s*\{([\s\S]*?)\n\}/.exec(style);
    expect(root, 'styles.css 里找不到 :root { … }').not.toBeNull();
    const declared = new Set([...root[1].matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map(m => m[1]));
    const used = new Set([...style.matchAll(/var\((--[a-zA-Z0-9-]+)\)/g)].map(m => m[1]));
    const missing = [...used].filter(u => !declared.has(u)).sort();
    expect(missing, `这些自定义属性用在样式里但没声明过：${missing.join('、')}`).toEqual([]);
    // 本轮那一枚警告态角标必须真的有色（只加类名不加规则 = 透明的）
    const badge = /(\.nav-badge\.nav-badge-warn|\.nav-badge-warn)\s*\{([^}]*)\}/.exec(style);
    expect(badge, 'styles.css 里找不到 .nav-badge-warn 这条规则').not.toBeNull();
    expect(badge[2]).toMatch(/background:/);
    expect(badge[2]).toMatch(/color:/);
  });

  it('排序那一格在 940 宽度下不许被挤断词', () => {
    // 与上一轮那两条同源：那一格里有一段话 + 一颗按钮，
    // 按钮必须 flex:none + white-space:nowrap，否则 940px 时"重新读取"断成两行
    const m = /\.ws-ordersfail \.btn\s*\{([^}]*)\}/.exec(style);
    expect(m, 'styles.css 里找不到 .ws-ordersfail .btn { … } 这条规则').not.toBeNull();
    expect(m[1]).toMatch(/flex:\s*none/);
    expect(m[1]).toMatch(/white-space:\s*nowrap/);
  });
});
