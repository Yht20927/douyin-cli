// tests/preload-contract.test.js — 渲染层用到的 API 必须都被 preload 暴露
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

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RENDERER_SRC = path.join(ROOT, 'app', 'renderer', 'src');
const PRELOAD = path.join(ROOT, 'app', 'preload', 'index.js');
const MAIN_IPC = path.join(ROOT, 'app', 'main', 'ipc.js');

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
 */
function parseExposedApi(code) {
  const start = code.indexOf('contextBridge.exposeInMainWorld(');
  if (start === -1) return new Map();
  let body = code.slice(start);

  const paths = new Set();
  const stack = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '');           // 去行注释
    const indent = line.search(/\S/);
    if (indent === -1) continue;
    if (/^\s*\}\s*\)\s*;?\s*$/.test(line)) { stack.length = 0; break; }

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

const preloadCode = fs.readFileSync(PRELOAD, 'utf8');
const mainCode = fs.readFileSync(MAIN_IPC, 'utf8');
const exposed = parseExposedApi(preloadCode);
const channels = parseMainChannels(mainCode);

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
    const used = new Set();
    const re = /ipcRenderer\.invoke\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(preloadCode)) !== null) used.add(m[1]);

    const missing = [...used].filter(c => !channels.has(c));
    expect(missing).toEqual([]);
  });

  it('推送通道也都在 preload 里订阅了', () => {
    // 主进程用 webContents.send 推的通道，preload 必须 subscribe
    const pushed = new Set();
    const re = /webContents\.send\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(mainCode)) !== null) pushed.add(m[1]);

    const subscribed = new Set();
    const re2 = /subscribe\(\s*'([^']+)'/g;
    while ((m = re2.exec(preloadCode)) !== null) subscribed.add(m[1]);

    expect([...pushed].filter(c => !subscribed.has(c))).toEqual([]);
  });
});
