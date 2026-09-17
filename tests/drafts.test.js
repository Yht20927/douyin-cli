// tests/drafts.test.js — 草稿内存模块测试

const path = require('path');
const fs = require('fs');
const os = require('os');

describe('drafts memory module', () => {
  let tmpDir;
  let drafts;
  let db;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-drafts-test-'));
    process.env.DOUYIN_STORAGE_DIR = tmpDir;
    // 清除 db 缓存
    delete require.cache[require.resolve('../core/memory/db')];
    delete require.cache[require.resolve('../core/memory/drafts')];
    db = require('../core/memory/db');
    drafts = require('../core/memory/drafts');
  });

  afterAll(() => {
    try { db.closeDb(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
    delete process.env.DOUYIN_STORAGE_DIR;
  });

  it('should save a draft and return id', () => {
    const id = drafts.save({ awemeId: 'aweme_001', text: '测试回复' });
    expect(id).toBeGreaterThan(0);
  });

  it('should get a draft by id', () => {
    const id = drafts.save({ awemeId: 'aweme_002', text: '另一条回复' });
    const d = drafts.get(id);
    expect(d).not.toBeNull();
    expect(d.text).toBe('另一条回复');
    expect(d.aweme_id).toBe('aweme_002');
    expect(d.posted).toBe(0);
  });

  it('should list drafts', () => {
    drafts.save({ awemeId: 'aweme_003', text: '草稿1' });
    drafts.save({ awemeId: 'aweme_003', text: '草稿2' });
    const items = drafts.list({ awemeId: 'aweme_003' });
    expect(items.length).toBe(2);
  });

  it('should filter by posted status', () => {
    const id = drafts.save({ awemeId: 'aweme_004', text: '未发布' });
    drafts.markPosted(id);
    const unposted = drafts.list({ posted: false });
    const posted = drafts.list({ posted: true });
    expect(posted.some(d => d.id === id)).toBe(true);
    expect(unposted.some(d => d.id === id)).toBe(false);
  });

  it('should mark draft as posted', () => {
    const id = drafts.save({ awemeId: 'aweme_005', text: '待发布' });
    drafts.markPosted(id);
    const d = drafts.get(id);
    expect(d.posted).toBe(1);
  });

  it('should remove a draft', () => {
    const id = drafts.save({ awemeId: 'aweme_006', text: '待删除' });
    drafts.remove(id);
    expect(drafts.get(id)).toBeNull();
  });

  it('should count drafts', () => {
    drafts.save({ awemeId: 'aweme_007', text: '计数用' });
    const n = drafts.count();
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('should return null for missing draft', () => {
    expect(drafts.get(99999)).toBeNull();
  });

  it('should return null for invalid save', () => {
    expect(drafts.save({})).toBeNull();
    expect(drafts.save(null)).toBeNull();
  });

  it('should default limit to 50', () => {
    const items = drafts.list({ limit: 1000 });
    expect(items.length).toBeLessThanOrEqual(200);
  });
});
