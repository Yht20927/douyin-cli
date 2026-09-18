// core/prompts.js — prompt 模板的读取、编辑、备份、恢复默认
//
// 为什么要有这一层（而不是让 IPC 直接读写文件）
// -------------------------------------------
// 编辑 prompt 是**改代码行为**，不是改个数字。几个必须一起做的事，
// 散在 IPC 里迟早会漏掉其中一个，而漏掉的表现都是静默的：
//
//   1. 写完必须清 prompt-builder 的模板缓存，否则"改了不生效"
//      （正是改造前 config 那个 C4 问题的同一形状）
//   2. 改前必须备份，否则用户改坏了没有任何退路
//   3. 保存后应当跑一次格式校验，把"少写了 === USER ==="这种问题
//      在保存时就指出来，而不是等下次生成时静默出问题
//   4. 恢复默认 = 删掉用户目录里那份，而不是写回一份内置副本
//      （写副本会让内置更新永远进不来）
//
// 这四个是一组，所以放在一起。

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const logger = require('./runtime/logger');

/** 允许编辑的文件名白名单形状：防目录穿越（../../etc/passwd） */
const SAFE_NAME = /^[A-Za-z0-9._-]+\.md$/;

function assertSafeName(name) {
  if (typeof name !== 'string' || !SAFE_NAME.test(name) || name.includes('..')) {
    throw new Error(`非法的模板文件名: ${JSON.stringify(name)}`);
  }
  return name;
}

/** 列出所有模板及其状态 */
function list() {
  return paths.listPromptFiles();
}

/**
 * 读一个模板。
 * 同时把内置版本一并带出来，界面上的"恢复默认"要能预览差异，
 * 而不是先删了才看得到原来长什么样。
 *
 * @param {string} name
 */
function read(name) {
  assertSafeName(name);
  const r = paths.resolvePrompt(name);
  let text = null;
  let exists = false;
  try {
    text = fs.readFileSync(r.path, 'utf8');
    exists = true;
  } catch (e) {
    logger.debug(`[prompts] 读取失败 ${r.path}: ${e.message}`);
  }

  // 内置原文。用户没覆盖时与 text 相同 —— 明确区分"内置原文"和"当前生效"，
  // 界面才能正确显示"已覆盖/未覆盖"
  let defaultText = null;
  try {
    defaultText = fs.readFileSync(r.bundledPath, 'utf8');
  } catch (e) { /* 打包目录里没有这个文件：可能是用户自建的新模板 */ }

  return {
    name,
    text,
    exists,
    source: r.source,
    overridden: r.source === 'user',
    defaultText,
    hasDefault: defaultText !== null,
    path: r.path,
    userPath: r.userPath,
    bundledPath: r.bundledPath,
    // 内置模板通常带 === SYSTEM === / === USER === 分隔符；partial-* 没有
    isPartial: name.startsWith('partial-'),
  };
}

/** 备份目录：与模板同级的 .backup/，不污染模板列表 */
function backupDir() {
  return path.join(paths.userPromptsDir(), '.backup');
}

/** 备份文件名带上时间戳，多次编辑不互相覆盖 */
function backupName(name, at = new Date()) {
  // 精确到毫秒。截到秒的话同一秒内的两次保存会算出同一个文件名，
  // copyFileSync 默认覆盖 —— 用户连点两次"保存"（或保存后立刻"从备份恢复"）
  // 时，第一份历史副本会被静默吃掉。注释写的是"多次编辑不互相覆盖"，
  // 但只到秒的话它保证不了。
  const stamp = at.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 23);
  return `${name}.${stamp}.bak`;
}

/**
 * 保存模板。
 *
 * @param {string} name
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.backup=true] - 覆盖已有内容前是否备份
 * @returns {{name:string, path:string, backedUp:string|null, validated:object|null}}
 */
function save(name, text, opts = {}) {
  assertSafeName(name);
  if (typeof text !== 'string') throw new Error('模板内容必须是字符串');
  if (!text.trim()) throw new Error('模板内容不能为空（要恢复默认请用"恢复默认"按钮）');

  const userPath = path.join(paths.userPromptsDir(), name);
  paths.ensureDir(paths.userPromptsDir());

  // 备份的是"改之前用户目录里那份"。只有在确实会覆盖掉内容时才备份 ——
  // 第一次编辑没有旧内容，备份个空文件没有意义。
  let backedUp = null;
  if (opts.backup !== false) {
    try {
      if (fs.existsSync(userPath)) {
        paths.ensureDir(backupDir());
        backedUp = backupName(name);
        fs.copyFileSync(userPath, path.join(backupDir(), backedUp));
      }
    } catch (e) {
      // 备份失败不阻断保存，但要留痕 —— 用户需要知道这次没有退路
      logger.warn(`[prompts] 备份失败，本次编辑没有历史副本：${e.message}`);
      backedUp = null;
    }
  }

  const tmp = `${userPath}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, userPath);

  // 关键：清缓存。prompt-builder 有模块级模板缓存，
  // 不清的话这次编辑要等重启应用才生效。
  invalidateCache();

  return { name, path: userPath, backedUp, validated: validate(name) };
}

/**
 * 恢复默认：删掉用户目录里那份，回退到打包目录。
 *
 * 不是"把内置内容写回用户目录" —— 那样内置模板以后更新了就永远进不来，
 * 用户会以为自己用的是默认值、实际是一份陈旧的副本。
 *
 * @returns {{name:string, removed:boolean, backedUp:string|null}}
 */
function resetToDefault(name) {
  assertSafeName(name);
  const userPath = path.join(paths.userPromptsDir(), name);
  let removed = false;
  let backedUp = null;

  if (fs.existsSync(userPath)) {
    try {
      paths.ensureDir(backupDir());
      backedUp = backupName(name);
      fs.copyFileSync(userPath, path.join(backupDir(), backedUp));
    } catch (e) {
      // 备份失败就**不要删**。save() 里同样的 catch 是安全的（保存本身不销毁数据），
      // 但这里删的是用户精心改过的模板 —— 没有退路就不该执行破坏性动作。
      // 改造前会继续 unlink，返回 {removed:true, backedUp:null}，
      // 界面只提示"已恢复为内置默认版本"，用户自定义的内容不可恢复。
      logger.warn(`[prompts] 备份失败，已取消恢复默认以免丢失内容：${e.message}`);
      throw new Error(`备份失败（${e.message}），为免丢失内容已取消恢复默认。请检查数据目录是否可写。`);
    }
    fs.unlinkSync(userPath);
    removed = true;
  }

  invalidateCache();
  return { name, removed, backedUp };
}

/** 列出某个模板的历史备份（新→旧） */
function listBackups(name) {
  assertSafeName(name);
  try {
    return fs.readdirSync(backupDir())
      .filter(f => f.startsWith(`${name}.`) && f.endsWith('.bak'))
      .sort()
      .reverse()
      .map(f => ({ file: f, path: path.join(backupDir(), f), at: fs.statSync(path.join(backupDir(), f)).mtimeMs }));
  } catch (e) { return []; }
}

/**
 * 把某个备份恢复成当前内容（恢复前会把当前内容再备份一次）。
 *
 * 备份文件名是 `${模板名}.${时间戳}.bak`，形状由 backupName() 决定；
 * 这里校验的是"这个文件名属于这个模板"而不是文件名本身合法 ——
 * 后者会放行 `../../etc/passwd` 这类路径。
 */
function restoreBackup(name, file) {
  assertSafeName(name);
  const raw = String(file || '');
  // 直接拒绝路径分隔符，而不是"比较 basename 是否等于原值"。
  // 后者在 Windows 上不成立：path.basename('reply.md.\\..\\..\\x.bak')
  // 会剥掉目录部分得到 'x.bak'，于是 base !== file 这个判断**不能**证明
  // 原串里没有目录分量，path.join 就会跳出备份目录。
  if (raw.includes('/') || raw.includes('\\')) {
    throw new Error(`备份文件名不能包含路径: ${JSON.stringify(file)}`);
  }
  const base = path.basename(raw);
  if (base !== raw || !base.startsWith(`${name}.`) || !base.endsWith('.bak')) {
    throw new Error(`不是该模板的备份文件: ${JSON.stringify(file)}`);
  }
  const src = path.join(backupDir(), base);
  if (!fs.existsSync(src)) throw new Error(`备份不存在: ${base}`);
  const text = fs.readFileSync(src, 'utf8');
  return save(name, text, { backup: true });
}

/**
 * 校验模板格式。复用 validatePrompts 命令里的解析逻辑会引入命令依赖，
 * 这里只做**保存时该拦的最小检查**（分隔符与占位符），完整校验仍由
 * 诊断页的 validatePrompts 负责。
 */
function validate(name) {
  const r = read(name);
  if (r.text === null) return null;
  const issues = [];
  const isPartial = r.isPartial;

  if (!isPartial) {
    const hasUser = /=== USER ===/.test(r.text);
    if (!hasUser) {
      issues.push({ severity: 'warn', message: '缺少 === USER === 分隔符（这个模板会被当成整篇 user 内容）' });
    }
    // 只写了 SYSTEM 而没写 USER：读出来 user 段是空的，生成时模型收不到内容
    if (/=== SYSTEM ===/.test(r.text) && !hasUser) {
      issues.push({ severity: 'error', message: '有 === SYSTEM === 但没有 === USER ===，user 部分会变成空' });
    }
  }

  // 占位符 {{XXX}} 的括号是否成对（写成 {XXX} 会被原样送进模型）
  const singles = (r.text.match(/(?<!\{)\{[A-Z_]{3,}\}(?!\})/g) || []);
  if (singles.length) {
    issues.push({ severity: 'warn', message: `疑似占位符少了一个大括号：${singles.slice(0, 3).join('、')}` });
  }

  return { name, issues, ok: !issues.some(i => i.severity === 'error') };
}

/**
 * 清掉 prompt-builder 的模板缓存，让改动立即生效。
 *
 * prompt-builder 顶层 require 会拉进 llm.js / reply-engine 一整串模块，
 * 而这个函数在"保存一个模板"这条路径上用得到、别处用不到。延迟到调用时
 * require，是为了让 core/prompts 保持轻量、且不依赖那串模块的加载顺序。
 */
function invalidateCache() {
  try {
    require('./reply-engine/prompt-builder').clearTemplateCache();
  } catch (e) {
    logger.warn(`[prompts] 模板缓存清理失败，改动可能要重启后才生效：${e.message}`);
  }
}

module.exports = {
  list,
  read,
  save,
  resetToDefault,
  validate,
  listBackups,
  restoreBackup,
  invalidateCache,
  backupDir,
};
