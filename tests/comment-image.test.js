// tests/comment-image.test.js — 评论图片 Node 侧辅助函数单元测试

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MAX_IMAGE_BYTES,
  CHUNK_SIZE,
  loadImage,
  chunkBase64,
  collectImageArgs,
  uploadImageViaBridge,
} = require('../core/comment-image');

let tmpDir;
const tmpFile = (name, bytes) => {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, bytes);
  return p;
};

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-img-test-'));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadImage — 校验', () => {
  it('读取合法 jpg 并返回 jpeg 格式', () => {
    const p = tmpFile('a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    const img = loadImage(p);
    expect(img.format).toBe('jpeg');
    expect(img.size).toBe(7);
    expect(img.base64).toBe(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64'));
    expect(img.large).toBe(false);
  });

  it('png / webp 扩展名大写也能识别', () => {
    expect(loadImage(tmpFile('b.PNG', Buffer.from([1, 2, 3]))).format).toBe('png');
    expect(loadImage(tmpFile('c.WebP', Buffer.from([1, 2, 3]))).format).toBe('webp');
  });

  it('不支持的扩展名直接报错', () => {
    const p = tmpFile('d.txt', Buffer.from('hello'));
    expect(() => loadImage(p)).toThrow(/不支持的图片格式/);
  });

  it('无扩展名报错', () => {
    expect(() => loadImage(tmpFile('noext', Buffer.from([1])))).toThrow(/不支持的图片格式/);
  });

  it('文件不存在报错', () => {
    expect(() => loadImage(path.join(tmpDir, 'missing.jpg'))).toThrow(/不存在或不可读/);
  });

  it('空文件报错', () => {
    expect(() => loadImage(tmpFile('empty.jpg', Buffer.alloc(0)))).toThrow(/图片为空/);
  });

  it('目录报错', () => {
    expect(() => loadImage(tmpDir)).toThrow(/不支持的图片格式|不是文件/);
  });

  it('超过上限报错', () => {
    const p = path.join(tmpDir, 'huge.jpg');
    // 稀疏写：只 stat 看大小，不真占内存
    const fd = fs.openSync(p, 'w');
    fs.ftruncateSync(fd, MAX_IMAGE_BYTES + 1);
    fs.closeSync(fd);
    expect(() => loadImage(p)).toThrow(/图片过大/);
  });

  it('空路径报错', () => {
    expect(() => loadImage('')).toThrow(/图片路径为空/);
  });
});

describe('chunkBase64 — 分块', () => {
  it('按 CHUNK_SIZE 切分且顺序拼接可还原', () => {
    const b64 = 'A'.repeat(CHUNK_SIZE * 2 + 100);
    const chunks = chunkBase64(b64);
    expect(chunks).toHaveLength(3);
    expect(chunks.map(c => c.length)).toEqual([CHUNK_SIZE, CHUNK_SIZE, 100]);
    expect(chunks.join('')).toBe(b64);
  });

  it('刚好整除时不产生空尾块', () => {
    const b64 = 'B'.repeat(CHUNK_SIZE);
    expect(chunkBase64(b64)).toHaveLength(1);
  });

  it('空串返回空数组', () => {
    expect(chunkBase64('')).toEqual([]);
  });

  it('非字符串报错', () => {
    expect(() => chunkBase64(null)).toThrow(/需要字符串/);
  });
});

describe('collectImageArgs — 参数收集', () => {
  it('单个 --image', () => {
    expect(collectImageArgs(['--image', 'a.jpg'])).toEqual(['a.jpg']);
  });

  it('重复 --image', () => {
    expect(collectImageArgs(['--image', 'a.jpg', '--image', 'b.png'])).toEqual(['a.jpg', 'b.png']);
  });

  it('逗号分隔 + 去空白', () => {
    expect(collectImageArgs(['--image', 'a.jpg, b.png ,c.webp'])).toEqual(['a.jpg', 'b.png', 'c.webp']);
  });

  it('没有 --image 返回空数组', () => {
    expect(collectImageArgs(['x', '--reply-to', '123'])).toEqual([]);
  });

  it('--image 后面跟另一个 flag 报错', () => {
    expect(() => collectImageArgs(['--image', '--reply-to', '1'])).toThrow(/需要一个文件路径/);
  });

  it('--image 结尾无值报错', () => {
    expect(() => collectImageArgs(['--image'])).toThrow(/需要一个文件路径/);
  });
});

describe('uploadImageViaBridge — 分片递送', () => {
  it('先 begin 再逐片 append，最后 upload 并返回图片信息', async () => {
    const p = tmpFile('up.jpg', Buffer.from([1, 2, 3, 4, 5]));
    const calls = [];
    const res = await uploadImageViaBridge(async (expr) => {
      calls.push(expr);
      if (expr.startsWith('window.__bridge.imageUpload')) {
        return { uri: 'tos-cn-i-x/abc', width: 240, height: 180, format: 'jpeg', size: 5 };
      }
      return true;
    }, p);

    expect(calls[0]).toBe(`window.__bridge.imageBegin(${Buffer.from([1, 2, 3, 4, 5]).toString('base64').length})`);
    expect(calls[1]).toMatch(/^window\.__bridge\.imageAppend\('[A-Za-z0-9+/=]+'\)$/);
    expect(calls[2]).toBe('window.__bridge.imageUpload()');
    expect(res.uri).toBe('tos-cn-i-x/abc');
    expect(res.width).toBe(240);
    expect(res.bytes).toBe(5);
  });

  it('服务端未回 uri 时报错', async () => {
    const p = tmpFile('nouri.jpg', Buffer.from([9]));
    await expect(uploadImageViaBridge(async () => ({}), p)).rejects.toThrow(/未返回 uri/);
  });

  it('上传失败时清理页面缓冲（imageReset）', async () => {
    const p = tmpFile('fail.jpg', Buffer.from([7, 7]));
    const calls = [];
    await expect(uploadImageViaBridge(async (expr) => {
      calls.push(expr);
      if (expr.startsWith('window.__bridge.imageUpload')) throw new Error('boom');
      return true;
    }, p)).rejects.toThrow('boom');
    expect(calls[calls.length - 1]).toBe('window.__bridge.imageReset()');
  });

  it('缺少 bridge 调用器时报错', async () => {
    await expect(uploadImageViaBridge(null, 'x.jpg')).rejects.toThrow(/需要 bridge 调用器/);
  });

  it('格式不合法时在递送前就失败（不调用 bridge）', async () => {
    const p = tmpFile('bad.txt', Buffer.from('hi'));
    let called = false;
    await expect(uploadImageViaBridge(async () => { called = true; }, p)).rejects.toThrow(/不支持的图片格式/);
    expect(called).toBe(false);
  });
});
