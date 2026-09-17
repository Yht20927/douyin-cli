// app/main/data-dir.js — 运行时数据目录的定位（计划 D10）
//
// 目标：安装目录下的 data/（便携、跟应用走），但 Windows 上若装到
// C:\Program Files\ 那个目录是只读的，SQLite 写不进去 —— 必须能回退。
//
// 注意打包配置必须用 perMachine: false，让安装包默认装到
// %LOCALAPPDATA%\Programs\（用户可写），这样 data/ 方案才成立。
// 万一用户手动改到 Program Files，这里会检测到不可写并回退到 userData，
// 同时把原因回传，由界面明确告知（不能静默换地方，否则用户找不到自己的数据）。

const path = require('path');
const paths = require('../../core/paths');

/**
 * 解析并应用数据目录。
 *
 * @param {import('electron').App} app
 * @returns {{dir:string, source:string, fellBack:boolean}}
 */
function applyDataDir(app) {
  const result = resolve(app);
  paths.setDataDir(result.dir);
  paths.ensureDir(result.dir);
  return result;
}

function resolve(app) {
  // 开发模式：数据留在仓库根目录，与 CLI 共用同一份 DB，便于对照调试
  if (!app.isPackaged) {
    return { dir: paths.appRoot(), source: '开发模式（仓库根目录）', fellBack: false };
  }

  const installDir = path.dirname(app.getPath('exe'));
  const portableDir = path.join(installDir, 'data');

  if (paths.isWritable(portableDir)) {
    return { dir: portableDir, source: '安装目录/data', fellBack: false };
  }

  const fallback = path.join(app.getPath('userData'), 'data');
  paths.ensureDir(fallback);
  return {
    dir: fallback,
    source: `安装目录不可写（${portableDir}），已回退到用户数据目录`,
    fellBack: true,
  };
}

module.exports = { applyDataDir, resolve };
