// lib/commands/download.js — 下载视频（含音频）

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { escapeExpression, getFlag } = require('./helpers');

/**
 * 发起 HTTP(S) 下载请求（跟随重定向）
 */
function httpGet(url, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 5;
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        const next = new URL(res.headers.location, url).href;
        httpGet(next, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} — ${url.substring(0, 120)}`));
        return;
      }
      const total = parseInt(res.headers['content-length'], 10) || 0;
      resolve({ stream: res, total });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('下载超时（120s）')); });
  });
}

/**
 * 下载文件并显示进度
 */
async function downloadFile(url, dest) {
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { stream, total } = await httpGet(url);
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    let downloaded = 0;
    let lastPct = -1;

    stream.on('data', (chunk) => {
      downloaded += chunk.length;
      if (total > 0) {
        const pct = Math.floor(downloaded / total * 100);
        if (pct !== lastPct && pct % 10 === 0) {
          lastPct = pct;
          process.stderr.write(`\r  下载进度: ${pct}%  (${(downloaded / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB)`);
        }
      }
    });
    stream.pipe(ws);
    ws.on('finish', () => {
      process.stderr.write('\n');
      resolve({ path: dest, size: downloaded });
    });
    ws.on('error', reject);
    stream.on('error', reject);
  });
}

/**
 * 提取视频下载地址
 * @param {object} detail - aweme detail API 返回的 aweme_detail 对象
 * @returns {object} { videoUrl, audioUrl, title, author, awemeId }
 */
function extractMediaInfo(detail) {
  const video = detail.video || {};
  const title = (detail.desc || 'untitled').replace(/[\x00-\x1f\x7f<>:"/\|?*]/g, '_').substring(0, 80);
  const author = detail.author?.nickname || 'unknown';
  const awemeId = detail.aweme_id || '';

  // 视频 URL：优先 play_addr（无水印可能），fallback download_addr
  let videoUrl = '';
  const playUrls = video.play_addr?.url_list || [];
  const dlUrls = video.download_addr?.url_list || [];
  // play_addr 通常有更好的质量
  if (playUrls.length > 0) {
    videoUrl = playUrls[0];
  } else if (dlUrls.length > 0) {
    videoUrl = dlUrls[0];
  }

  // 某些情况下 bit_rate 列表有更高质量
  const bitRates = video.bit_rate || [];
  if (bitRates.length > 0) {
    const best = bitRates.sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))[0];
    if (best.play_addr?.url_list?.length > 0) {
      videoUrl = best.play_addr.url_list[0];
    }
  }

  // 音频：通常包含在视频流中，单独音频地址不常见
  let audioUrl = '';
  const music = detail.music || {};
  if (music.play_url?.uri) {
    audioUrl = music.play_url.uri;
  } else if (music.play_url?.url_list?.length > 0) {
    audioUrl = music.play_url.url_list[0];
  }

  return { videoUrl, audioUrl, title, author, awemeId };
}

/**
 * 安全文件名
 */
function safeFilename(s) {
  return s.replace(/[<>:"/\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_');
}

/**
 * 下载视频
 * @param {object} ctx - { bridge, audit, bridgeCall }
 * @param {string[]} args - [aweme_id, --audio-only, --out <dir>]
 */
async function cmdDownload(ctx, args) {
  const awemeId = args[0];
  if (!awemeId) throw new Error('用法: node cli.js download <aweme_id> [--audio-only] [--out <dir>]');

  const audioOnly = args.includes('--audio-only');
  const outDir = getFlag(args, '--out', './downloads');

  ctx.audit.startOperation('download', { aweme_id: awemeId, audioOnly });

  // Step 1: 获取视频详情
  console.error(`正在获取视频详情: ${awemeId} ...`);
  const expr = `window.__bridge.getDetail('${escapeExpression(awemeId)}')`;
  const data = await ctx.bridgeCall(expr);

  const detail = data.aweme_detail;
  if (!detail) {
    const err = new Error('未获取到视频详情 — 可能视频已删除或无权限访问');
    ctx.audit.endOperation('error', {}, null, err.message);
    throw err;
  }

  const info = extractMediaInfo(detail);
  console.error(`标题: ${info.title}`);
  console.error(`作者: ${info.author}`);

  const baseName = safeFilename(`${awemeId}_${info.author}_${info.title}`);
  const result = { awemeId, title: info.title, author: info.author, files: [] };

  // Step 2: 下载视频
  if (!audioOnly && info.videoUrl) {
    const videoPath = path.join(outDir, `${baseName}.mp4`);
    console.error(`正在下载视频: ${info.videoUrl.substring(0, 100)}...`);
    try {
      const dl = await downloadFile(info.videoUrl, videoPath);
      console.error(`✓ 视频已保存: ${dl.path} (${(dl.size / 1024 / 1024).toFixed(2)} MB)`);
      result.files.push({ type: 'video', path: dl.path, size: dl.size });
    } catch (e) {
      console.error(`✗ 视频下载失败: ${e.message}`);
      result.files.push({ type: 'video', error: e.message });
    }
  } else if (!audioOnly && !info.videoUrl) {
    console.error('未找到视频下载地址');
    result.files.push({ type: 'video', error: 'no_url' });
  }

  // Step 3: 下载音频（BGM）
  if (info.audioUrl) {
    const audioPath = path.join(outDir, `${baseName}_audio.mp3`);
    console.error(`正在下载音频: ${info.audioUrl.substring(0, 100)}...`);
    try {
      const dl = await downloadFile(info.audioUrl, audioPath);
      console.error(`✓ 音频已保存: ${dl.path} (${(dl.size / 1024 / 1024).toFixed(2)} MB)`);
      result.files.push({ type: 'audio', path: dl.path, size: dl.size });
    } catch (e) {
      console.error(`✗ 音频下载失败: ${e.message}`);
      result.files.push({ type: 'audio', error: e.message });
    }
  } else {
    console.error('未找到音频下载地址（BGM 通常已包含在视频文件中）');
  }

  if (result.files.length === 0) {
    const err = new Error('下载失败 — 未获取到任何媒体地址');
    ctx.audit.endOperation('error', {}, null, err.message);
    throw err;
  }

  ctx.audit.endOperation('success', { files: result.files.length }, { result });
  return result;
}

module.exports = cmdDownload;
module.exports.extractMediaInfo = extractMediaInfo;
