// lib/commands/upload-image.js — 单独上传图片到 ImageX，返回 uri（不发布评论）
//
// 用途：调试/预检。post --image 内部走同一条链路，但会直接发出去；
// 这个命令只上传，方便先确认图片没问题、或复用 uri 到别处。

const { collectImageArgs, uploadImageViaBridge } = require('../comment-image');
const { withAudit } = require('./helpers');

/**
 * @param {object} ctx - { bridgeCall, audit }
 * @param {string[]} args - [--image <路径>]...
 */
async function cmdUploadImage(ctx, args) {
  const paths = collectImageArgs(args);
  if (!paths.length) {
    throw new Error('用法: node cli.js upload-image --image <路径> [--image <路径2>]');
  }

  return withAudit(ctx, 'upload-image', { count: paths.length }, async () => {
    const images = [];
    for (const p of paths) {
      images.push(await uploadImageViaBridge(ctx.bridgeCall, p));
    }
    return {
      summary: { count: images.length },
      result: { images },
      output: images.length === 1 ? images[0] : images,
    };
  });
}

module.exports = cmdUploadImage;
