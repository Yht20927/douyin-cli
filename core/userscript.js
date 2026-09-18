// core/userscript.js — 油猴脚本渲染（占位符替换）
//
// 为什么单独成模块
// ----------------
// 同一段替换逻辑有两个消费者：
//   1. scripts/build-userscript.js —— 命令行构建，产物写 dist/
//   2. Bridge Server 的 GET /install.user.js —— 桌面应用提供的一键安装端点
// 两处必须产出完全一致的结果，否则"命令装好的能用、应用里装的不能用"这类问题
// 极难排查。所以只留一份实现。
//
// 占位符
// ------
//   {{BRIDGE_TOKEN}} —— Bridge Server 访问令牌
//   {{SITE_KEY}}     —— 站点/账号标识（多账号预留，见计划 D4）

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const PLACEHOLDERS = ['{{BRIDGE_TOKEN}}', '{{SITE_KEY}}'];

/** 源模板位置（打包后位于 asar 内，只读 —— 我们只读不写） */
function sourcePath() {
  return path.join(paths.appRoot(), 'scripts', 'douyin.user.js');
}

/**
 * 渲染可安装的油猴脚本。
 *
 * @param {object} opts
 * @param {string} opts.token        - Bridge 访问令牌（必填）
 * @param {string} [opts.site]       - 站点/账号标识，缺省 douyin.com
 * @param {string} [opts.sourceFile] - 覆盖源模板路径（测试用）
 * @returns {string} 渲染好的脚本全文
 * @throws {Error} 缺 token、源模板不可读、或替换不干净时
 */
function renderUserscript(opts = {}) {
  const { token, site = 'douyin.com' } = opts;

  if (!token) {
    throw new Error('renderUserscript: 缺少 token');
  }

  const file = opts.sourceFile || sourcePath();
  let out;
  try {
    out = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`油猴脚本源模板不可读 (${file}): ${e.message}`);
  }

  // ── 前置校验：源文件必须**还是模板** ──
  //
  // 这一步看着多余（下面已经查"替换后有没有残留占位符"了），但它挡的是另一件事：
  // 源模板一旦被"渲染后的产物"覆盖（比如有人 `--out scripts/douyin.user.js`，
  // 或者手滑把 dist 里的产物拷了回来），文件里就没有占位符可换了 ——
  // 下面的替换会**什么都不做**，然后把那份产物原样发出去。
  //
  // 而那份产物里嵌着的是**上一个渲染它的人的真实 bridge token**。
  // 于是每一位装机用户拿到的都是同一个 token，且没有任何报错。
  // 实测发生过一次：工作区里的 scripts/douyin.user.js 就是带真实 token 的产物，
  // 而当时 renderUserscript 照常返回"成功"。
  //
  // 宁可拒绝渲染、让安装端点报 500，也不能把别人的凭证发出去。
  const missing = PLACEHOLDERS.filter(p => !out.includes(p));
  if (missing.length) {
    throw new Error(
      `油猴脚本源模板缺少占位符: ${missing.join(', ')}（${file}）。` +
      '这个文件必须保持为模板，不能被渲染后的产物覆盖 —— ' +
      '否则会把上一次渲染时写入的真实 token 原样发给所有装机用户。' +
      '请用 git 还原该文件（git checkout HEAD -- scripts/douyin.user.js）。'
    );
  }

  out = out.split('{{BRIDGE_TOKEN}}').join(token);
  out = out.split('{{SITE_KEY}}').join(site);

  // 防呆：带着未替换的占位符发出去，脚本会以诡异方式失败，排查成本极高
  const leftover = PLACEHOLDERS.filter(p => out.includes(p));
  if (leftover.length) {
    throw new Error(`油猴脚本仍有未替换的占位符: ${leftover.join(', ')}`);
  }

  return out;
}

/** 源模板是否存在（桌面应用启动时自检用） */
function sourceExists() {
  try {
    return fs.existsSync(sourcePath());
  } catch (e) {
    return false;
  }
}

module.exports = {
  PLACEHOLDERS,
  sourcePath,
  sourceExists,
  renderUserscript,
};
