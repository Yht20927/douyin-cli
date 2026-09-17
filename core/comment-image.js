// lib/comment-image.js — 评论图片：本地文件读取、校验、分块传输
//
// 上传本体在油猴脚本侧（ImageX + AWS SigV4，见 scripts/douyin.user.js 的 imageUpload）。
// 这里只负责 Node 侧的脏活：读文件、校验大小/格式、把 base64 切成小块递过去。
// 之所以分块：单条 eval 表达式要塞进数 MB base64，会拖垮 WebSocket 与页面 eval。

const fs = require('fs');
const path = require('path');

/** 抖音评论图片上限（对齐前端图片上传的 10MB 限制） */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 超过此大小给出压缩提示（不阻断） */
const WARN_IMAGE_BYTES = 4 * 1024 * 1024;
/** 单次 eval 递送的 base64 分片大小 */
const CHUNK_SIZE = 512 * 1024;

const FORMAT_BY_EXT = {
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.webp': 'webp',
  '.gif': 'gif',
  '.bmp': 'bmp',
  '.heic': 'heic',
};

/** base64 合法字符集——用于断言分片可安全嵌入单引号字符串 */
const BASE64_RE = /^[A-Za-z0-9+/=]+$/;

function extOf(filePath) {
  return path.extname(String(filePath)).toLowerCase();
}

/**
 * 读取并校验一张本地图片
 * @returns {{path:string, format:string, size:number, base64:string, large:boolean}}
 */
function loadImage(filePath) {
  if (!filePath) throw new Error('图片路径为空');
  const ext = extOf(filePath);
  const format = FORMAT_BY_EXT[ext];
  if (!format) {
    throw new Error(`不支持的图片格式: ${ext || '(无扩展名)'} — 支持 ${Object.keys(FORMAT_BY_EXT).join(' / ')}`);
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    throw new Error(`图片不存在或不可读: ${filePath}`);
  }
  if (!stat.isFile()) throw new Error(`不是文件: ${filePath}`);
  if (stat.size === 0) throw new Error(`图片为空: ${filePath}`);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大: ${(stat.size / 1048576).toFixed(1)}MB — 上限 ${MAX_IMAGE_BYTES / 1048576}MB`);
  }

  const base64 = fs.readFileSync(filePath).toString('base64');
  if (!base64) throw new Error(`图片编码失败: ${filePath}`);

  return { path: filePath, format, size: stat.size, base64, large: stat.size > WARN_IMAGE_BYTES };
}

/** 把 base64 切成可分片递送的数组 */
function chunkBase64(base64, size = CHUNK_SIZE) {
  if (typeof base64 !== 'string') throw new Error('chunkBase64 需要字符串');
  const out = [];
  for (let i = 0; i < base64.length; i += size) out.push(base64.slice(i, i + size));
  return out;
}

/**
 * 收集 --image 参数（支持重复 flag 与逗号分隔）
 * @param {string[]} args
 * @returns {string[]}
 */
function collectImageArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--image') continue;
    const val = args[i + 1];
    if (val === undefined || typeof val !== 'string' || val.startsWith('--')) {
      throw new Error('--image 需要一个文件路径');
    }
    for (const part of val.split(',')) {
      const p = part.trim();
      if (p) out.push(p);
    }
  }
  return out;
}

/**
 * 通过 Bridge 把一张本地图片上传到抖音 ImageX，返回可直接用于评论的图片信息
 *
 * @param {(expr:string, awaitPromise?:boolean)=>Promise<any>} call - bridge 调用器（ctx.bridgeCall）
 * @param {string} filePath - 本地图片路径
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<{uri:string,width:number,height:number,format:string,size:number,path:string,bytes:number}>}
 */
async function uploadImageViaBridge(call, filePath, onProgress) {
  if (typeof call !== 'function') throw new Error('uploadImageViaBridge 需要 bridge 调用器');

  const img = loadImage(filePath);
  const chunks = chunkBase64(img.base64);

  for (const c of chunks) {
    if (!BASE64_RE.test(c)) throw new Error('图片分片含非法字符，已中止上传');
  }

  await call(`window.__bridge.imageBegin(${img.base64.length})`);
  try {
    for (let i = 0; i < chunks.length; i++) {
      await call(`window.__bridge.imageAppend('${chunks[i]}')`);
      if (onProgress) onProgress(i + 1, chunks.length);
    }
    const res = await call('window.__bridge.imageUpload()');
    if (!res || !res.uri) throw new Error('图片上传未返回 uri');
    return {
      uri: res.uri,
      width: res.width || 0,
      height: res.height || 0,
      format: res.format || img.format,
      size: res.size || img.size,
      path: filePath,
      bytes: img.size,
    };
  } catch (e) {
    // 上传失败要清掉页面侧缓冲，否则残留数据会污染下一次上传
    try { await call('window.__bridge.imageReset()'); } catch (_) {}
    throw e;
  }
}

module.exports = {
  MAX_IMAGE_BYTES,
  WARN_IMAGE_BYTES,
  CHUNK_SIZE,
  FORMAT_BY_EXT,
  extOf,
  loadImage,
  chunkBase64,
  collectImageArgs,
  uploadImageViaBridge,
};
