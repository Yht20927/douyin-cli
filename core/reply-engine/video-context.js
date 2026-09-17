// lib/reply-engine/video-context.js — 抖音视频上下文加载器
//
// 职责：
// 1. 通过 Bridge 获取视频详情（标题、描述、作者、统计、封面）
// 2. 可选：下载视频并用 ffmpeg 截取多帧截图（screenshot 模式）
// 3. 可选：推送视频 URL 给支持视频输入的 LLM（video 模式）
// 4. 生成文本摘要（briefing）供纯文本模式使用
//
// 用法：
//   const ctx = await loadVideoContext(bridgeCall, awemeId, { mode: 'screenshots', screenshotCount: 4 });

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { escapeExpression } = require('../commands/helpers');

// ── 配置 ──

const SCREENSHOT_DIR = path.join(__dirname, '..', '..', '.screenshots');
const SCREENSHOT_BASE64_LIMIT = 6; // 最多编码多少帧送 LLM
const DOWNLOAD_TIMEOUT_MS = 120000;

// ── 类型定义（JSDoc）──

/**
 * @typedef {object} VideoContext
 * @property {string} awemeId
 * @property {string} title            - 视频标题/描述文本
 * @property {string} desc             - 完整描述
 * @property {object} author           - { nickname, uid, sec_uid }
 * @property {string|null} coverUrl    - 封面图 URL
 * @property {object} stats            - { diggCount, commentCount, shareCount, playCount }
 * @property {number|null} duration    - 视频时长（秒）
 * @property {string} briefing         - LLM 生成的文本摘要（始终生成）
 * @property {string[]} screenshotB64  - Base64 编码的截图（screenshots 模式下可用）
 * @property {string|null} videoUrl    - 视频播放 URL（video 模式下可传递给 LLM）
 * @property {string} mode             - 实际使用的模式
 */

// ── 临时目录管理 ──

function ensureScreenshotDir() {
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function cleanupScreenshots(awemeId) {
  try {
    for (const f of fs.readdirSync(SCREENSHOT_DIR)) {
      if (f.startsWith(awemeId + '_')) fs.unlinkSync(path.join(SCREENSHOT_DIR, f));
    }
  } catch (_) { /* ignore */ }
}

// ── 核心：加载视频上下文 ──

/**
 * 获取抖音视频的完整上下文。
 *
 * @param {Function} bridgeCall - 调用 Bridge 的方法 (expr) => data
 * @param {string} awemeId
 * @param {object} [opts]
 * @param {string} [opts.mode='text-only'] - 'text-only' | 'screenshots' | 'video'
 * @param {number} [opts.screenshotCount=4] - 截图数量（screenshots 模式有效）
 * @param {boolean} [opts.forceRefresh=false] - 忽略缓存重新获取
 * @returns {Promise<VideoContext>}
 */
async function loadVideoContext(bridgeCall, awemeId, opts = {}) {
  const mode = opts.mode || 'text-only';
  const screenshotCount = Math.max(2, Math.min(opts.screenshotCount || 4, 10));
  const forceRefresh = !!opts.forceRefresh;

  // Step 1: 获取视频详情
  const detail = await fetchVideoDetail(bridgeCall, awemeId);

  // Step 2: 构建基础文本上下文
  const ctx = buildBaseContext(detail, awemeId);

  // Step 3: 根据模式补充视觉信息
  if (mode === 'screenshots' && ctx.videoUrl) {
    try {
      const screenshots = await extractScreenshots(ctx.videoUrl, awemeId, screenshotCount);
      ctx.screenshotB64 = screenshots;
      console.error(`[video-context] 截图模式: 已提取 ${screenshots.length} 帧`);
    } catch (e) {
      console.error(`[video-context] 截图提取失败，回退到 text-only: ${e.message}`);
      ctx.mode = 'text-only'; // 降级
    }
  } else if (mode === 'video' && ctx.videoUrl) {
    // video 模式：保留 videoUrl 供 LLM 使用
    console.error(`[video-context] 视频模式: URL 已就绪`);
  } else if (mode === 'text-only' || !ctx.videoUrl) {
    ctx.mode = 'text-only';
  }

  // Step 4: 生成 briefing（纯文本摘要）
  ctx.briefing = buildBriefing(detail);

  return ctx;
}

// ── 获取视频详情（Bridge API）──

async function fetchVideoDetail(bridgeCall, awemeId) {
  const expr = `window.__bridge.getDetail('${escapeExpression(awemeId)}')`;
  const data = await bridgeCall(expr);
  const detail = data.aweme_detail;
  if (!detail) {
    throw new Error(`无法获取视频详情: ${awemeId}`);
  }
  return detail;
}

// ── 从 detail 构建基础上下文 ──

function buildBaseContext(detail, awemeId) {
  const video = detail.video || {};
  const author = detail.author || {};
  const music = detail.music || {};
  const stats = detail.statistics || {};
  const desc = detail.desc || '';

  // 提取视频 URL
  let videoUrl = '';
  const playUrls = video.play_addr?.url_list || [];
  const dlUrls = video.download_addr?.url_list || [];
  if (playUrls.length > 0) videoUrl = playUrls[0];
  else if (dlUrls.length > 0) videoUrl = dlUrls[0];

  // bit_rate 可能有更高质量
  const bitRates = video.bit_rate || [];
  if (bitRates.length > 0) {
    const best = bitRates.sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))[0];
    if (best.play_addr?.url_list?.length > 0) videoUrl = best.play_addr.url_list[0];
  }

  return {
    awemeId,
    title: desc.substring(0, 120),
    desc,
    author: {
      nickname: author.nickname || 'unknown',
      uid: String(author.uid || ''),
      sec_uid: author.sec_uid || '',
    },
    coverUrl: video.origin_cover?.url_list?.[0] || video.cover?.url_list?.[0] || null,
    stats: {
      diggCount: Number(stats.digg_count || 0),
      commentCount: Number(stats.comment_count || 0),
      shareCount: Number(stats.share_count || 0),
      playCount: Number(stats.play_count || 0),
    },
    duration: video.duration ? Math.round(Number(video.duration) / 1000) : null,
    music: {
      title: music.title || '',
      author: music.author || '',
    },
    briefing: '',
    screenshotB64: [],
    videoUrl: videoUrl || null,
    mode: 'text-only',
  };
}

// ── 截图提取（ffmpeg）──

/**
 * 从视频 URL 中提取 N 帧截图，编码为 base64 data URI。
 * 使用 ffmpeg 流式读取（不下载完整视频）。
 *
 * @param {string} videoUrl - 视频播放 URL
 * @param {string} awemeId - 用于临时文件命名
 * @param {number} count - 截图数量
 * @returns {Promise<string[]>} base64 编码数组
 */
async function extractScreenshots(videoUrl, awemeId, count) {
  ensureScreenshotDir();
  cleanupScreenshots(awemeId);

  const outputPattern = path.join(SCREENSHOT_DIR, `${awemeId}_%02d.jpg`);
  const probeCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoUrl}"`;

  // 获取视频时长
  let duration = 30; // fallback
  try {
    const out = execSync(probeCmd, { timeout: 15000, encoding: 'utf8' }).trim();
    if (out) duration = parseFloat(out);
  } catch (_) { /* 使用 fallback */ }

  // 计算均匀取帧时间点（跳过开头 1s 和结尾 1s）
  if (duration <= 2) duration = 3;
  const startOffset = Math.min(1, duration * 0.1);
  const effectiveEnd = duration - Math.min(1, duration * 0.1);
  const effectiveDuration = effectiveEnd - startOffset;
  const interval = effectiveDuration / (count + 1);

  // ffmpeg: fps 均匀取帧 + scale 到 1024 宽
  const ffmpegCmd = [
    `ffmpeg -y -ss ${startOffset} -i "${videoUrl}"`,
    `-vf "fps=1/${interval},scale=1024:-1:flags=lanczos"`,
    `-frames:v ${count} -q:v 5`,
    `"${outputPattern}"`,
    `-loglevel error`,
  ].join(' ');

  try {
    execSync(ffmpegCmd, { timeout: DOWNLOAD_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`ffmpeg 截图失败: ${e.stderr?.toString()?.substring(0, 200) || e.message}`);
  }

  // 读取截图并编码为 base64
  const files = fs.readdirSync(SCREENSHOT_DIR)
    .filter(f => f.startsWith(awemeId + '_') && f.endsWith('.jpg'))
    .sort();

  const b64List = [];
  for (const f of files.slice(0, SCREENSHOT_BASE64_LIMIT)) {
    const fp = path.join(SCREENSHOT_DIR, f);
    try {
      const buf = fs.readFileSync(fp);
      const b64 = buf.toString('base64');
      b64List.push(`data:image/jpeg;base64,${b64}`);
    } catch (_) { /* skip */ }
  }

  return b64List;
}

// ── 文本摘要生成 ──

function buildBriefing(detail) {
  const parts = [];
  const desc = detail.desc || '';
  if (desc) parts.push(desc.substring(0, 200));

  const video = detail.video || {};
  if (video.duration) {
    const secs = Math.round(Number(video.duration) / 1000);
    if (secs > 0) parts.push(`时长${Math.floor(secs / 60)}分${secs % 60}秒`);
  }

  const author = detail.author || {};
  if (author.nickname) parts.push(`作者: ${author.nickname}`);

  const stats = detail.statistics || {};
  const statParts = [];
  if (stats.digg_count) statParts.push(`${stats.digg_count}赞`);
  if (stats.comment_count) statParts.push(`${stats.comment_count}评论`);
  if (statParts.length > 0) parts.push(`数据: ${statParts.join('/')}`);

  return parts.join(' | ');
}

// ── 工具函数 ──

/**
 * 将 VideoContext 格式化为文本块（供 prompt 注入）。
 * @param {VideoContext} vctx
 * @returns {string}
 */
function formatVideoBlock(vctx) {
  if (!vctx || !vctx.title) return '暂无视频信息';

  const lines = [];
  lines.push(`## 视频信息`);
  lines.push(`标题：${vctx.title.substring(0, 150)}`);

  if (vctx.briefing && vctx.briefing !== vctx.title) {
    lines.push(`内容摘要：${vctx.briefing.substring(0, 200)}`);
  }

  if (vctx.author?.nickname) lines.push(`作者：${vctx.author.nickname}`);
  if (vctx.stats) {
    const stats = [];
    if (vctx.stats.playCount) stats.push(`${formatNum(vctx.stats.playCount)}次播放`);
    if (vctx.stats.diggCount) stats.push(`${formatNum(vctx.stats.diggCount)}赞`);
    if (vctx.stats.commentCount) stats.push(`${formatNum(vctx.stats.commentCount)}条评论`);
    if (stats.length) lines.push(`数据：${stats.join('，')}`);
  }
  if (vctx.duration) {
    const m = Math.floor(vctx.duration / 60);
    const s = vctx.duration % 60;
    lines.push(`时长：${m}分${s}秒`);
  }
  if (vctx.music?.title) lines.push(`BGM：${vctx.music.title}${vctx.music.author ? ' - ' + vctx.music.author : ''}`);
  if (vctx.coverUrl) lines.push(`封面：${vctx.coverUrl}`);

  return lines.join('\n');
}

function formatNum(n) {
  if (!n || n === 0) return '0';
  if (n >= 100000) return (n / 10000).toFixed(1) + '万';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

module.exports = {
  loadVideoContext,
  formatVideoBlock,
  buildBriefing,
  cleanupScreenshots,
};
