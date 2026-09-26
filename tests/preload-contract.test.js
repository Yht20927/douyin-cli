// tests/preload-contract.test.js — 渲染层用到的 API 必须都被 preload 暴露
//
// 这里管的是**跨进程边界上的交接**：preload 暴露面 ↔ 渲染层调用、IPC 通道 ↔ 主进程
// handler、handler 转发的参数键、以及任务队列交给主进程的 ctx 装配通道。
// 它们的共同点是两端隔得远、中间没有任何东西会替你检查。
//
// 回归背景
// --------
// 主进程加了 `ipcMain.handle('queue:result', ...)`，preload 里却漏了对应的方法。
// 渲染层在 AI 生成完成后的 effect 里调用 `window.dy.queue.result(...)`，
// 抛 `TypeError: ... is not a function`。React 在 effect 阶段遇到未捕获异常且没有
// 错误边界时会**卸载整棵树** —— 用户看到的是一片空白（"黑屏"），且毫无线索。
//
// 这类"主进程有、preload 没有"的漂移没法被运行时发现（调用点离定义很远），
// 所以在这里做静态比对：从渲染层源码里抽出所有 window.dy.* 的调用路径，
// 再与实际暴露的 preload API 对照。
//
// 同一份接口其实有**三处**副本：ipc.js 的通道、preload 的暴露面、以及
// scripts/_probe.js 里给浏览器用的桩。第二版只比对了前两对，于是
// 主进程加 data:analytics 时探针没跟上 —— 数据页在探针里永久"正在统计…"，
// 而探针"能跑起来"看起来一切正常。现在三对全比。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RENDERER_SRC = path.join(ROOT, 'app', 'renderer', 'src');
const PRELOAD = path.join(ROOT, 'app', 'preload', 'index.js');
const MAIN_IPC = path.join(ROOT, 'app', 'main', 'ipc.js');
const PROBE = path.join(ROOT, 'scripts', '_probe.js');

/** 递归收集渲染层源文件 */
function collectSources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectSources(p, out);
    else if (/\.jsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 从源码里抽出 `window.dy.a.b(...)` 形式的方法路径。
 * 只统计调用形式（后面跟括号），避免把纯引用的路径也算进来。
 */
function extractUsedPaths(code) {
  const paths = new Set();
  const re = /window\.dy((?:\.[A-Za-z_$][\w$]*)+)\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    paths.add(m[1].replace(/^\./, ''));
  }
  return paths;
}

/**
 * 解析 preload 暴露的 API 形状。
 * 不执行 preload（它依赖 electron 运行时），而是按缩进层级静态解析对象字面量。
 *
 * 同一个解析器也用于探针桩（`window.dy = { … }`）—— 两边必须是**同一套解析规则**，
 * 否则比对结果只是两套不同的错误互相抵消。
 */
function parseExposedApi(code, startMarker = 'contextBridge.exposeInMainWorld(') {
  const start = code.indexOf(startMarker);
  if (start === -1) return new Set();
  let body = code.slice(start);

  const paths = new Set();
  const stack = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '');           // 去行注释
    const indent = line.search(/\S/);
    if (indent === -1) continue;
    // 收尾：preload 是 `});`，探针桩是 `};`
    if (/^\s*\}\s*\)?\s*;?\s*$/.test(line)) { stack.length = 0; break; }

    const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;

    // 弹掉比当前缩进更深的层级
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const prefix = stack.map(s => s.key).join('.');
    const full = prefix ? `${prefix}.${key}` : key;

    if (/^\(\s*[^)]*\)\s*=>/.test(rest.trim()) || /^function\b/.test(rest.trim())) {
      // 叶子：一个方法
      paths.add(full);
    } else if (rest.includes('{')) {
      // 命名空间：继续往下走
      paths.add(full);
      stack.push({ key, indent });
    } else {
      paths.add(full);
    }
  }
  return paths;
}

/** 主进程注册的所有 IPC 通道 */
function parseMainChannels(code) {
  const set = new Set();
  const re = /ipcMain\.handle\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(code)) !== null) set.add(m[1]);
  return set;
}

/**
 * 从 _probe.js 源码里抠出 window.dy 桩的模板字符串。
 *
 * 读 **源文件而不是 dist/__stub.js**：后者是生成物，跑一次探针才有，
 * 而且 `vite build` 会把 dist 清空 —— 测试不能依赖构建产物。
 * 桩里没有嵌套反引号，所以首个 `;` 就是模板结束。
 */
function extractStubLiteral(code) {
  const m = code.match(/const stub = `([\s\S]*?)`;/);
  return m ? m[1] : '';
}

/** 桩转发出去的通道（`call('chan…')` 的第一个参数） */
function parseStubChannels(stub) {
  const set = new Set();
  const re = /call\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(stub)) !== null) set.add(m[1]);
  return set;
}

/** preload 里 invoke 的通道 */
function parsePreloadChannels(code) {
  const set = new Set();
  const re = /ipcRenderer\.invoke\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(code)) !== null) set.add(m[1]);
  return set;
}

/** 两个集合的对称差，带上方向说明 —— 失败时要一眼看出是谁缺了什么 */
function diff(a, b, aName, bName) {
  const out = [];
  for (const x of a) if (!b.has(x)) out.push(`仅 ${aName} 有：${x}`);
  for (const x of b) if (!a.has(x)) out.push(`仅 ${bName} 有：${x}`);
  return out.sort();
}

const preloadCode = fs.readFileSync(PRELOAD, 'utf8');
const mainCode = fs.readFileSync(MAIN_IPC, 'utf8');
const probeCode = fs.readFileSync(PROBE, 'utf8');
const exposed = parseExposedApi(preloadCode);
const channels = parseMainChannels(mainCode);
const stubCode = extractStubLiteral(probeCode);
const stubExposed = parseExposedApi(stubCode, 'window.dy = {');
const stubChannels = parseStubChannels(stubCode);
const preloadChannels = parsePreloadChannels(preloadCode);

describe('preload 暴露面', () => {
  it('解析出的接口不是空的（解析器本身要有效）', () => {
    expect(exposed.size).toBeGreaterThan(8);
    expect(exposed.has('bridge.status')).toBe(true);
    expect(exposed.has('queue.enqueue')).toBe(true);
  });

  it('主进程注册的通道能被解析到', () => {
    expect(channels.size).toBeGreaterThan(8);
    expect(channels.has('queue:result')).toBe(true);
  });
});

describe('渲染层用到的每个方法都必须被暴露', () => {
  const files = collectSources(RENDERER_SRC);

  it('确实扫到了渲染层源码', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('没有漏暴露的方法', () => {
    const missing = [];
    for (const file of files) {
      const code = fs.readFileSync(file, 'utf8');
      for (const used of extractUsedPaths(code)) {
        // 定义处（preload 自身）的 const 声明不会被这个正则匹配，无需排除
        if (!exposed.has(used)) {
          missing.push(`${path.relative(ROOT, file)} → window.dy.${used}`);
        }
      }
    }
    // 失败时把缺的方法全列出来，一眼能看出漏了哪个命名空间的哪个方法
    expect(missing).toEqual([]);
  });
});

describe('preload 里调用的通道都必须在主进程注册', () => {
  it('没有指向不存在的 IPC 通道', () => {
    const missing = [...preloadChannels].filter(c => !channels.has(c));
    expect(missing).toEqual([]);
  });

  it('推送通道都必须在 preload 与主进程两侧对上', () => {
    // 主进程用 webContents.send 推的通道，preload 必须 subscribe
    const pushed = new Set();
    const re = /webContents\.send\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(mainCode)) !== null) pushed.add(m[1]);

    const subscribed = new Set();
    const re2 = /subscribe\(\s*'([^']+)'/g;
    while ((m = re2.exec(preloadCode)) !== null) subscribed.add(m[1]);

    expect([...pushed].filter(c => !subscribed.has(c))).toEqual([]);
    // 反方向同样要成立：preload 订了一个主进程从不发的通道，
    // 表现是"界面挂了一个永远不触发的回调" —— 与漏暴露是同一类失效，
    // 只是安静得多。
    expect(diff(subscribed, pushed, 'preload 订阅', '主进程推送')).toEqual([]);
  });
});

describe('探针桩必须是 preload 的完整镜像', () => {
  // 回归背景：主进程加了 `ipcMain.handle('data:analytics')` 并在 preload 里暴露了
  // 对应方法，唯独探针的桩没跟上。于是用探针打开数据页，
  // `window.dy.data.analytics` 是 undefined → TypeError → 页面永久停在"正在统计…"，
  // 而整套 ECharts / 口径重构都打算在这个探针上验证。
  // 上面那两条比对（渲染层↔preload、preload↔主进程）都抓不到它，
  // 因为探针是**第三份**清单 —— 三份清单里少比一对，就一定会漂。
  it('桩源码解析得出来（解析器对模板字符串同样有效）', () => {
    expect(stubCode.length).toBeGreaterThan(200);
    expect(stubExposed.size).toBeGreaterThan(8);
    expect(stubExposed.has('data.analytics')).toBe(true);
  });

  it('桩暴露的方法与 preload 一一对应', () => {
    expect(diff(exposed, stubExposed, 'preload', '探针桩')).toEqual([]);
  });

  it('两份清单都不用单行嵌套对象（解析器的盲区）', () => {
    // parseExposedApi 是按缩进走层级的。`personas: { describe: () => … },`
    // 这种写法只会产出 `personas` 而**丢掉 describe**，于是两边同时少算一个、
    // 比对照样"通过" —— 一份会漏算的清单比没有清单更危险。
    const oneLine = /^\s*[A-Za-z_$][\w$]*\s*:\s*\{.*\}/;
    const strip = (s) => s.split('\n').filter(l => oneLine.test(l));
    const block = (s, marker) => s.slice(s.indexOf(marker));
    expect({
      preload: strip(block(preloadCode, 'exposeInMainWorld')),
      probeStub: strip(block(stubCode, 'window.dy = {')),
    }).toEqual({ preload: [], probeStub: [] });
  });

  it('桩转发的通道与 preload invoke 的通道一一对应', () => {
    expect(diff(preloadChannels, stubChannels, 'preload', '探针桩')).toEqual([]);
  });

  it('桩不会转发主进程没注册的通道', () => {
    const ghost = [...stubChannels].filter(c => !channels.has(c));
    expect(ghost).toEqual([]);
  });

  it('桩能把指定通道改成 reject（界面那些"读失败"分支唯一的可重放手段）', () => {
    // 背景：主进程没包 safe() 的通道失败形式是 reject，而浏览器里永远读得到
    // 服务端的响应 —— 于是界面上为失败写的那几支在探针里一次都走不到，
    // 改完对不对只能靠想。?fail=<channel,channel> 就是补这个的。
    expect(stubCode).toMatch(/new URLSearchParams\(self\.location\.search\)\.get\('fail'\)/);
    // ⚠️ 必须紧跟箭头：只找 `failSet.has(ch)` 这个子串时，把它短路成
    // `=> false && failSet.has(ch)` 也照样"通过"（整条开关从此是死的）
    expect(stubCode).toMatch(/=>\s*failSet\.has\(ch\)\s*\?/);
    // 必须是 **reject**，不是返回 {ok:false} —— 后者是 safe() 的形状，
    // 用它验出来的"失败分支"是另一条分支，等于白验
    expect(stubCode).toMatch(/Promise\.reject\(new Error\("Error invoking remote method '/);
  });
});

describe('界面传的参数必须被主进程接住', () => {
  // 回归背景：渲染层的 `data.analytics({ scope, dayWindow })` 只被主进程转发了
  // scope，dayWindow 被丢掉。表现是数据页上「最近 90 天」点了以后**标签变了、
  // 数字一个没动** —— 两端都不报错，探针也照样"跑得起来"。
  //
  // 上面那几对比对（渲染层↔preload、preload↔主进程、探针桩）都只看**通道名**，
  // 参数有没有转发**不在任何一条护栏里**。这里补上：渲染层用对象字面量传的每个
  // 键，主进程那段 handler 里都必须出现。
  //
  // 两条限定，都是为了不误报：
  //
  // 1. 只查 `data:*`。这些 handler 的写法是**逐个转发**选项
  //    （`views.analytics({ scope: o && o.scope, dayWindow: o && o.dayWindow })`），
  //    漏一个就是一个真 bug。别的域不这么写 —— 比如 `policy:check` 是
  //    把整个 meta 原样交给策略引擎（`beforeWrite(meta)`），键有哪些由
  //    core/policy 决定，ipc.js 里当然找不到它们。
  // 2. 只查对象字面量实参。位置参数（`data.comments(awemeId, opts)`）
  //    静态对应不上，硬查也是误报。
  const mainCode = fs.readFileSync(MAIN_IPC, 'utf8');

  /** 取出某个 channel 的 handler 文本：从注册处到下一个注册处 */
  function handlerBlock(channel) {
    const at = mainCode.indexOf(`ipcMain.handle('${channel}'`);
    if (at === -1) return null;
    const next = mainCode.indexOf('ipcMain.handle(', at + 10);
    return mainCode.slice(at, next === -1 ? mainCode.length : next);
  }

  /** 渲染层里 window.dy.data.xxx({ a, b }) 形式的调用 → [{method, keys}] */
  function objectArgCalls() {
    const out = [];
    const re = /window\.dy\.data\.(\w+)\(\s*\{([^}]*)\}\s*\)/g;
    let m;
    for (const file of collectSources(RENDERER_SRC)) {
      const code = fs.readFileSync(file, 'utf8');
      let hit;
      while ((hit = re.exec(code)) !== null) {
        const [, method, body] = hit;
        const keys = body.split(',')
          .map(s => s.split(':')[0].trim())
          .filter(k => /^[A-Za-z_$][\w$]*$/.test(k));
        if (keys.length) out.push({ domain: 'data', method, keys, file: file.replace(ROOT, '') });
      }
    }
    return out;
  }

  const calls = objectArgCalls();

  it('解析到了这类调用（解析器本身要有效）', () => {
    expect(calls.length).toBeGreaterThan(0);
    // 这一条就是当初漏掉的那个参数，它必须被解析出来
    const analytics = calls.find(c => c.method === 'analytics');
    expect(analytics).toBeTruthy();
    expect(analytics.keys).toContain('dayWindow');
  });

  it('渲染层传的每个键都能在主进程的 handler 里找到', () => {
    const missing = [];
    for (const { domain, method, keys, file } of calls) {
      const block = handlerBlock(`${domain}:${method}`);
      // 通道不存在由上面那几条比对负责，这里只管参数
      if (!block) continue;
      for (const k of keys) {
        if (!block.includes(k)) missing.push({ file, channel: `${domain}:${method}`, key: k });
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('队列交给主进程的每个通道，都必须被接进 ctx', () => {
  // 回归背景
  // --------
  // 任务队列建 ctx 时一次交下三个通道：signal（取消）、extraSinks（进度）、
  // onWait（节奏等待，含读间隔那 30–50 秒）。前两个一开始就接了，第三个没人接。
  // 于是命令内部清清楚楚地等了 40 秒，界面上只有一个空转的「执行中」——
  // 而找视频页那句「队列页能看到还剩多久」指的正是这个不存在的倒计时。
  //
  // 这种"多给一个参数、装配处没接"的漂移运行时一点动静都没有：`o.onWait` 是
  // undefined，`ctx.onWait` 也就是 undefined，命令里那句 `if (ctx.onWait)` 安静地不走。
  // 所以只能静态钉 —— 与上面几对"通道名/参数键"的比对是同一类护栏。
  //
  // 通道清单**从 task-queue 那一侧解析出来**，不写死在这份文件里：
  // 以后队列再交新通道，主进程忘了接会立刻红，而不需要谁来记得更新这张表。
  const QUEUE = path.join(ROOT, 'core', 'runtime', 'task-queue.js');
  const MAIN_INDEX = path.join(ROOT, 'app', 'main', 'index.js');
  const REAL_CHAIN = path.join(ROOT, 'tests', 'server', 'real-chain.test.js');

  /** createContext(task, { … }) 第二个实参的键名 */
  function channelsQueued() {
    const code = fs.readFileSync(QUEUE, 'utf8');
    const marker = 'createContext(task, {';
    const at = code.indexOf(marker);
    expect(at, `找不到队列建 ctx 的调用处：${marker}`).toBeGreaterThan(-1);
    const rest = code.slice(at + marker.length);
    // marker 把开头的 { 一起吃掉了，补回来 —— 否则第一个键前面没有 { 也没有逗号，会漏
    const literal = '{' + rest.slice(0, rest.indexOf('})'));
    // 只认"紧跟 { 或逗号"的键，避免把三元表达式里的 `x ? 1 : 2` 当成键
    return [...literal.matchAll(/[{,]\s*(\w+)\s*:/g)].map(x => x[1]);
  }

  /** 某个装配处把队列交下来的哪些通道读进了 ctx（返回 o.* 的名字集合） */
  function channelsWired(file) {
    const code = fs.readFileSync(file, 'utf8');
    const marker = 'createContext: (task, o = {}) => {';
    const at = code.indexOf(marker);
    expect(at, `找不到 ctx 的装配处：${file.replace(ROOT, '')}`).toBeGreaterThan(-1);
    const body = code.slice(at, code.indexOf('bindCommands', at));
    return new Set([...body.matchAll(/\bo\.(\w+)/g)].map(x => x[1]));
  }

  const channels = channelsQueued();

  it('解析器解析得出队列交下的三个通道（护栏本身要先有效）', () => {
    expect(channels).toEqual(expect.arrayContaining(['signal', 'extraSinks', 'onWait']));
  });

  it('主进程装配 ctx 时一个都不漏', () => {
    const wired = channelsWired(MAIN_INDEX);
    expect(channels.filter(c => !wired.has(c))).toEqual([]);
  });

  it('端到端用例里那份镜像接的是同一批通道（否则它测的是一份不存在的装配）', () => {
    const wired = channelsWired(REAL_CHAIN);
    expect(channels.filter(c => !wired.has(c))).toEqual([]);
  });
});

describe('策略闸门的等待：每个调用点都必须把 ctx.onWait 递下去', () => {
  // 回归背景
  // --------
  // assertWritable 里"单轮写满后冷却 300 秒"那一段，此前在四条写命令里各抄了一遍上报：
  //   { signal: ctx.signal, onWait: ({ waitMs, reason }) => logger.info('[post] …') }
  // 这个内联回调把 **ctx.onWait 整个顶掉了** —— 队列好容易把倒计时通道接到 ctx 上，
  // 命令入口一伸手就把它换成只会打印日志的那个。于是界面上任务挂在「执行中」、
  // 没有倒计时也没有截止时刻，看着像卡死。第二十轮接上的是 enforceDelay 与 pace
  // 两段，唯独闸门这段漏了（同一根线的三处里最容易漏的一处：它离 logger 最近）。
  //
  // 为什么只能静态钉：四条命令的行为测试都是"给它一个 ctx，看它调没调 assertWritable"，
  // 传进去的是不是 ctx.onWait 那一根线在行为上完全等价 —— 少一根线什么都不抛。
  // 与本文件上面那几条"通道名 / 参数键"的比对是同一类护栏：两端都对，中间断线。
  //
  // ⚠️ 扫的是**整个 core/commands 目录**，不是点名那四个文件（§2.47 同一条教训：
  // 只核对已知位置，新增的调用点就永远在名单外）。
  const CMDS_DIR = path.join(ROOT, 'core', 'commands');
  const cmdFiles = () => fs.readdirSync(CMDS_DIR).filter(n => /\.js$/.test(n)).sort();
  const readCmd = (f) => fs.readFileSync(path.join(CMDS_DIR, f), 'utf8');

  /**
   * 抽出 `name(...)` 的每处调用，按**顶层逗号**切成实参数组。
   *
   * 必须真解析，不能只找子串（§2.42：`false &&` 那种写法能骗过任何 includes 断言）：
   * 括号不闭合就直接红，免得解析器哪天悄悄退化成"什么都没找到"。
   */
  function callArgs(code, name) {
    const out = [];
    let at = code.indexOf(name);
    while (at >= 0) {
      const open = at + name.length - 1;          // name 末尾的那个 '('
      let depth = 0, close = -1;
      for (let i = open; i < code.length; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')' && --depth === 0) { close = i; break; }
      }
      expect(close, `${name} 的括号没有闭合`).toBeGreaterThan(open);
      out.push(splitTopLevel(code.slice(open + 1, close)));
      at = code.indexOf(name, at + name.length);
    }
    return out;
  }

  /** 按深度 0 处的逗号切分；括号/方括号/花括号/引号内部的逗号不算分隔 */
  function splitTopLevel(inner) {
    const parts = [];
    let depth = 0, start = 0, q = null;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (ch === ',' && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1; }
    }
    parts.push(inner.slice(start));
    return parts.map(s => s.trim());
  }

  /** 取 `onWait:` 后面那个值表达式的源码：深度 0 处遇 , ; ) } 或文件尾结束 */
  function valueAfter(src) {
    let i = 0, depth = 0, q = null;
    while (i < src.length && /\s/.test(src[i])) i++;
    const start = i;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
      if ('([{'.includes(ch)) { depth++; continue; }
      if (')]}'.includes(ch)) { if (depth === 0) break; depth--; continue; }
      if ((ch === ',' || ch === ';') && depth === 0) break;
    }
    return src.slice(start, i);
  }

  /**
   * 这一处命中是不是注释。注释里抄着旧写法是有意的（helpers.js 文件头那段就是
   * 写给下一个改这里的人看的），所以扫描必须只认代码 —— 否则护栏会因为**文档**而红，
   * 而那恰好是"把文档改成假样子来骗过测试"的邀请函。
   */
  function isComment(code, idx) {
    const lineStart = code.lastIndexOf('\n', idx) + 1;
    const head = code.slice(lineStart, idx).trimStart();
    return head.startsWith('*') || head.startsWith('//') || head.startsWith('/*');
  }

  const sites = [];
  for (const f of cmdFiles()) {
    for (const args of callArgs(readCmd(f), 'policy.assertWritable(')) {
      sites.push({ file: f, opts: (args[1] || '').replace(/\s+/g, ' ') });
    }
  }

  it('解析器找得出四条写命令的闸门调用（护栏自己先要有效）', () => {
    expect(sites.length).toBeGreaterThanOrEqual(4);
    expect([...new Set(sites.map(s => s.file))]).toEqual(
      expect.arrayContaining(['post.js', 'like.js', 'delete-comment.js', 'dm.js']),
    );
  });

  it('每一处的第二个实参都是那份共用的 policyWaitOpts（不许退回各写一遍的内联回调）', () => {
    const bad = sites.filter(s => !/^policyWaitOpts\('[\w.-]+',\s*ctx\)$/.test(s.opts));
    expect(bad, JSON.stringify(bad)).toEqual([]);
  });

  it('core/commands 里每一处 onWait: 收到的都是 ctx.onWait', () => {
    // 这条管的是**其余**等待点（pace / enforceDelay 的调用处）：同一个错法换个地方
    // 再犯一次，不该要人重新想一遍怎么写断言。
    const orphans = [];
    let seen = 0;
    for (const f of cmdFiles()) {
      const code = readCmd(f);
      let at = code.indexOf('onWait:');
      while (at >= 0) {
        if (!isComment(code, at)) {
          seen++;
          const value = valueAfter(code.slice(at + 'onWait:'.length));
          if (!/ctx\.onWait/.test(value)) {
            orphans.push({ file: f, line: code.slice(0, at).split('\n').length, value: value.slice(0, 70) });
          }
        }
        at = code.indexOf('onWait:', at + 7);
      }
    }
    // 先确认这个扫描不是空转：helpers 的两处 + get/enrich 各一处
    expect(seen).toBeGreaterThanOrEqual(4);
    expect(orphans, JSON.stringify(orphans)).toEqual([]);
  });

  it('helpers 那份 policyWaitOpts 同时透传 signal 与 ctx.onWait，并且确实导出了', () => {
    const code = readCmd('helpers.js');
    const at = code.indexOf('function policyWaitOpts(');
    expect(at, 'helpers.js 里找不到 policyWaitOpts').toBeGreaterThan(-1);
    const body = code.slice(at, code.indexOf('\n}', at));
    expect(body).toMatch(/signal:\s*ctx\s*\?\s*ctx\.signal/);   // 漏了就等于界面上取消不掉
    expect(body).toMatch(/ctx\.onWait\(/);                      // 漏了就回到"只打印、不报队列"
    const exports = (code.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/) || [, ''])[1];
    expect(/\bpolicyWaitOpts\b/.test(exports), 'policyWaitOpts 没导出').toBe(true);
  });
});
