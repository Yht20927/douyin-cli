// core/reply-source/image.js — 图片回复的选图决策
//
// D9：只支持**本地文件路径**，不做图库也不做 URL。
// 这里只决定"这一条回复要不要带图、带哪张"，上传链路原样复用
// core/comment-image.js 的分块上传（见 post 命令的 --image 处理）。

const { checkImage } = require('../comment-image');
const { pickIndex, isValidCycle } = require('./cycles');

/**
 * 过滤出真正可用的图片路径，并保留下标映射。
 *
 * 检查在这里做（而不是等上传）的理由：一条路径可能因为文件被删、被移动、
 * 或者选的时候就是超限的大图而不可用。等到用户点了发布才失败，
 * 会把"配置问题"和"平台风控问题"混在一起，排查方向完全不同。
 * 这里先筛掉，并把原因回传给界面。
 *
 * @param {string[]} paths
 * @returns {{usable:Array<{path:string,index:number}>, rejected:Array<{path:string,reason:string}>}}
 */
function usableImages(paths) {
  const list = Array.isArray(paths) ? paths : [];
  const usable = [];
  const rejected = [];
  list.forEach((p, i) => {
    const r = checkImage(p);
    if (r.ok) usable.push({ path: p, index: i });
    else rejected.push({ path: p, reason: r.reason });
  });
  return { usable, rejected };
}

/**
 * 判断这一次是否应该带图。
 * @param {object} config - config.get('reply').image
 * @param {object} comment - { text }
 * @param {Function} rng
 * @returns {{want:boolean, reason:string}}
 */
function wantsImage(config, comment, rng = Math.random) {
  if (!config || config.enabled !== true) return { want: false, reason: '图片回复未启用' };

  const mode = config.mode || 'ratio';
  if (mode === 'always') return { want: true, reason: '模式=每条都带' };

  if (mode === 'keyword') {
    const keywords = Array.isArray(config.keywords) ? config.keywords : [];
    if (!keywords.length) return { want: false, reason: '模式=关键词，但没有配置关键词' };
    const text = String((comment && comment.text) || '');
    const hit = keywords.find(k => k && text.includes(k));
    return hit
      ? { want: true, reason: `命中关键词「${hit}」` }
      : { want: false, reason: '未命中关键词' };
  }

  // ratio（含未知模式，按 ratio 处理）
  const ratio = Number.isFinite(config.ratio) ? Math.min(1, Math.max(0, config.ratio)) : 0;
  return rng() < ratio
    ? { want: true, reason: `按比例 ${ratio} 命中` }
    : { want: false, reason: `按比例 ${ratio} 未命中` };
}

/**
 * 为一条回复挑一张图。
 *
 * @param {object} opts
 * @param {object} opts.config  - config.get('reply').image
 * @param {object} opts.comment - { cid, text }
 * @param {object} opts.state   - 循环状态（调用方负责持久化）
 * @param {Function} [opts.rng]
 * @returns {{path:string, reason:string}|null} 不带图时返回 null
 */
function pickImage(opts) {
  const { config = {}, comment, state, rng } = opts;

  const { want, reason } = wantsImage(config, comment, rng);
  if (!want) return null;

  const { usable, rejected } = usableImages(config.paths);
  if (!usable.length) {
    // 想带图却一张可用都没有：返回 null 而不是抛错 ——
    // 配错图不应该让"生成一条回复"整个失败，只让这条不带图。
    const why = rejected.length
      ? `配置的图片都不可用（例：${rejected[0].reason}）`
      : '配置的图片列表为空';
    return { path: null, reason: `${reason}，但${why}` };
  }

  const cycle = isValidCycle(config.pick) ? config.pick : 'shuffle-no-repeat';
  const idx = pickIndex({ len: usable.length, cycle, state, rng });
  if (idx < 0) return null;

  const chosen = usable[idx];
  const note = rejected.length ? `（${rejected.length} 张不可用已跳过）` : '';
  return { path: chosen.path, reason: `${reason}${note}` };
}

module.exports = { pickImage, wantsImage, usableImages };
