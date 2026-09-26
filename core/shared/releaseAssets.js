// core/shared/releaseAssets.js — 「这个发布文件是不是给我这台机器用的」
//
// 为什么在 core 而不是 app/main/ipc.js 里：这条判据有两个读者 ——
// 主进程（真回答检查更新）与 `scripts/_probe.js`（渲染核对时得摆出同一套形状）。
// 判据写在任何一边，另一边就只能在心里复述一遍；而"复述"正是这几轮一直在清的债
// （见 开发进度.md §2.36：能算出来的就不要抄）。放这里之后两边 require 同一个函数。
//
// 命名匹配是**启发式**，不是标准：GitHub 的 release 文件名由上传方自己起，
// electron-builder 的常见产物能用，别的打包方式不一定。所以这里只回答
// "认得出适配本机"与"认不出"两种，绝不猜第三个 —— 界面据此能说
// 「我认不出哪个适配你的系统」，而下错安装包的那一个不能。

/** 发布文件名里代表各个系统的写法 */
const PLATFORM_TAGS = {
  win32: [/win/i, /\.exe$/i, /\.msi$/i],
  darwin: [/mac/i, /darwin/i, /osx/i, /\.dmg$/i],
  linux: [/linux/i, /appimage/i, /\.deb$/i, /\.snap$/i],
};

/** 只有文件名里明确写了架构时才用来排除，缺省不算冲突（多数发布只出一个包） */
const ARCH_TAGS = {
  x64: [/x64/i, /x86_64/i, /amd64/i],
  arm64: [/arm64/i, /aarch64/i],
};

/**
 * @param {string} name - 发布文件名
 * @param {string} platform - process.platform
 * @param {string} arch - process.arch
 * @returns {boolean}
 */
function assetForThisMachine(name, platform, arch) {
  const n = String(name || '');
  const tags = PLATFORM_TAGS[platform] || [];
  if (!tags.some(re => re.test(n))) return false;
  const otherArch = Object.keys(ARCH_TAGS).filter(k => k !== arch);
  if (otherArch.some(k => ARCH_TAGS[k].some(re => re.test(n)))) return false;
  return true;
}

/**
 * 从一批发布文件里挑出认得出适配本机的。
 *
 * @param {Array<{name:string}>} assets
 * @param {string} platform
 * @param {string} arch
 * @returns {Array<{name:string}>} 原样返回挑中的那些（不重排、不改字段）
 */
function pickLocalAssets(assets, platform, arch) {
  return (Array.isArray(assets) ? assets : [])
    .filter(a => a && assetForThisMachine(a.name, platform, arch));
}

module.exports = { assetForThisMachine, pickLocalAssets, PLATFORM_TAGS, ARCH_TAGS };
