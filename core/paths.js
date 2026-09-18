// core/paths.js — 运行时数据路径的统一解析
//
// 为什么需要这一层
// ----------------
// 改造前，全项目有 13 处 `path.join(__dirname, ...)` 和 7 处 `path.join(process.cwd(), ...)`。
// 前者在打包进 app.asar 后指向只读的归档内路径，后者取决于启动时的工作目录 —— 两者在
// 桌面应用里都必然失效，而且失效方式往往是静默的（读不到就当空字符串，写就抛 EROFS）。
//
// 设计要点
// --------
// 1. **函数式 + 惰性求值**：所有路径都是函数而非模块级常量。这样桌面主进程可以在
//    require 任何业务模块之前（或之后）调用 setDataDir()，不依赖 require 顺序。
// 2. **默认值与改造前完全一致**：dataDir 缺省 = 仓库根，于是
//    config.json / storage/ / logs/ 全都在原位，CLI 行为零变化。
// 3. **桌面版通过 setDataDir() 一次性重定向**：主进程启动时设为
//    <安装目录>/data（不可写则回退用户数据目录），此后所有路径自动跟随。
// 4. **保留旧环境变量**：DOUYIN_STORAGE_DIR / DOUYIN_LOG_DIR 仍生效（测试与历史脚本依赖），
//    优先级高于 dataDir 派生值。
//
// 目录布局（dataDir 为 <安装目录>/data 时）
// ----------------------------------------
//   <dataDir>/config.json          用户配置
//   <dataDir>/storage/douyin.db    SQLite（含 .bak.vN 备份）
//   <dataDir>/logs/                审计与结果
//   <dataDir>/prompts/             用户覆盖的 prompt 模板（可选，缺省用仓库内置的）
//
// 注：storage/ 这一级子目录保留了改造前的布局，好处是 dataDir 缺省为仓库根时
// 路径与历史完全一致，不需要任何数据迁移。

const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════
// dataDir — 所有运行时数据的根
// ═══════════════════════════════════════════════════════════

/** 显式覆盖值（由桌面主进程或测试设置） */
let _overrideDataDir = null;

/**
 * 重定向数据目录。桌面主进程在启动时调用一次即可。
 * @param {string|null} dir - 传 null 清除覆盖，回到默认解析
 */
function setDataDir(dir) {
  _overrideDataDir = dir ? path.resolve(dir) : null;
}

/**
 * 解析数据目录。优先级：
 *   1. setDataDir() 显式设置
 *   2. 环境变量 DOUYIN_DATA_DIR
 *   3. 应用根目录（改造前的行为，保证 CLI 零变化）
 * @returns {string} 绝对路径
 */
function dataDir() {
  if (_overrideDataDir) return _overrideDataDir;
  if (process.env.DOUYIN_DATA_DIR) return path.resolve(process.env.DOUYIN_DATA_DIR);
  return appRoot();
}

/**
 * 应用根目录。
 * 开发期 = 仓库根；打包后 = app.asar 根（**只读**，不要往里写东西）。
 * @returns {string}
 */
function appRoot() {
  return path.resolve(__dirname, '..');
}

// ═══════════════════════════════════════════════════════════
// 具体路径
// ═══════════════════════════════════════════════════════════

/** 用户配置。DOUYIN_CONFIG 可覆盖（测试用） */
function configFile() {
  if (process.env.DOUYIN_CONFIG) return path.resolve(process.env.DOUYIN_CONFIG);
  return path.join(dataDir(), 'config.json');
}

/** SQLite 所在目录。DOUYIN_STORAGE_DIR 优先（历史兼容） */
function dbDir() {
  if (process.env.DOUYIN_STORAGE_DIR) return path.resolve(process.env.DOUYIN_STORAGE_DIR);
  return path.join(dataDir(), 'storage');
}

/** SQLite 文件 */
function dbFile() {
  return path.join(dbDir(), 'douyin.db');
}

/** 日志目录。DOUYIN_LOG_DIR 优先（历史兼容） */
function logsDir() {
  if (process.env.DOUYIN_LOG_DIR) return path.resolve(process.env.DOUYIN_LOG_DIR);
  return path.join(dataDir(), 'logs');
}

/** 审计日志文件 */
function auditFile() {
  return path.join(logsDir(), 'audit.json');
}

/** 命令结果落盘目录（get/search/analyze 的大结果） */
function resultsDir() {
  return path.join(logsDir(), 'results');
}

/** 应用运行日志（结构化，取代只有 stderr 无留痕的现状） */
function appLogFile() {
  return path.join(logsDir(), 'app.log');
}

/**
 * 随应用打包的 prompt 模板目录（只读默认值）。
 */
function bundledPromptsDir() {
  return path.join(appRoot(), 'prompts');
}

/**
 * 用户可写的 prompt 覆盖目录（设置页编辑后写这里）。
 * 目录可能不存在 —— 不存在就是"一个都没覆盖"。
 */
function userPromptsDir() {
  return path.join(dataDir(), 'prompts');
}

/**
 * 解析某个模板文件的实际路径：**先看用户目录，没有再回退打包目录**。
 *
 * 这里刻意做成逐文件回退，而不是"用户目录存在就整体顶替"。改造前是后者，
 * 后果很隐蔽：用户在界面上只编辑了一个模板，保存时建出了 data/prompts/，
 * 于是其余五个模板**全部消失**（读不到 → prompt-builder 静默返回 null
 * → 那几类生成悄悄退化成没有模板的状态）。逐文件回退下，只有真正改过的
 * 那个文件被覆盖。
 *
 * @param {string} name - 模板文件名，如 'reply.md'
 * @returns {{path:string, source:'user'|'bundled', userPath:string, bundledPath:string}}
 */
function resolvePrompt(name) {
  const bundledPath = path.join(bundledPromptsDir(), name);
  const userPath = path.join(userPromptsDir(), name);
  try {
    if (fs.existsSync(userPath)) return { path: userPath, source: 'user', userPath, bundledPath };
  } catch (e) { /* 权限问题按未覆盖处理 */ }
  return { path: bundledPath, source: 'bundled', userPath, bundledPath };
}

/**
 * 列出全部可用模板（两个目录的**并集**），标注各自来自哪里、是否被覆盖。
 *
 * @returns {Array<{name:string, path:string, source:string, overridden:boolean,
 *                  userPath:string, editable:boolean, partial:boolean}>}
 */
function listPromptFiles() {
  const seen = new Map();
  const collect = (dir, source) => {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    } catch (e) { return; }
    for (const name of names) {
      if (!seen.has(name)) seen.set(name, { name, source, userPath: path.join(userPromptsDir(), name) });
      else if (source === 'user') seen.get(name).source = 'user';
    }
  };
  // 用户目录优先登记，这样同名文件的 source 是 user
  collect(userPromptsDir(), 'user');
  collect(bundledPromptsDir(), 'bundled');

  return [...seen.values()]
    .map(f => ({
      name: f.name,
      source: f.source,
      overridden: f.source === 'user',
      userPath: f.userPath,
      editable: true,
      // partial-*.md 是跨模板共享的片段，不是完整模板，validatePrompts 会跳过它们
      partial: f.name.startsWith('partial-'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @deprecated 用 resolvePrompt() / listPromptFiles()。
 * 保留是因为它仍在诊断页之类的只读展示里用到；它只回答"用户目录在不在"，
 * **不能**用来拼文件路径（那样会重新引入整目录遮蔽的问题）。
 */
function promptsDir() {
  const override = userPromptsDir();
  try {
    if (fs.existsSync(override)) return override;
  } catch (e) { /* 权限问题则忽略，走默认 */ }
  return bundledPromptsDir();
}

/** 视频截图临时目录（多模态截图用；D11 后默认不启用） */
function screenshotsDir() {
  return path.join(dataDir(), '.screenshots');
}

// ═══════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════

/**
 * 确保目录存在（递归创建）。返回该目录路径，便于链式使用。
 * @param {string} dir
 * @returns {string}
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 判断目录是否可写（桌面版选择数据目录时用）。
 * @param {string} dir
 * @returns {boolean}
 */
function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 当前路径解析结果快照，供诊断页展示。
 * @returns {Record<string,string>}
 */
function describe() {
  return {
    appRoot: appRoot(),
    dataDir: dataDir(),
    dataDirSource: _overrideDataDir ? 'setDataDir()'
      : process.env.DOUYIN_DATA_DIR ? '环境变量 DOUYIN_DATA_DIR'
      : '默认（应用根目录）',
    configFile: configFile(),
    dbFile: dbFile(),
    logsDir: logsDir(),
    resultsDir: resultsDir(),
    promptsDir: promptsDir(),
  };
}

module.exports = {
  // 解析
  setDataDir,
  dataDir,
  appRoot,
  // 路径
  configFile,
  dbDir,
  dbFile,
  logsDir,
  auditFile,
  resultsDir,
  appLogFile,
  promptsDir,
  bundledPromptsDir,
  userPromptsDir,
  resolvePrompt,
  listPromptFiles,
  screenshotsDir,
  // 工具
  ensureDir,
  isWritable,
  describe,
};
