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
