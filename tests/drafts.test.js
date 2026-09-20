// tests/drafts.test.js — 草稿内存模块测试

const path = require('path');
const fs = require('fs');
const os = require('os');

describe('drafts memory module', () => {
  let tmpDir;
  let drafts;
  let vids;
  let cmts;
  let db;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-drafts-test-'));
    process.env.DOUYIN_STORAGE_DIR = tmpDir;
    // 清除 db 缓存。videos / comments 也要一起清：它们顶层就 require('./db')
    // 拿到的是**上一个临时库**的 getDb，搜索结果会写进别人家。
    for (const m of ['../core/memory/db', '../core/memory/drafts',
      '../core/memory/videos', '../core/memory/comments']) {
      delete require.cache[require.resolve(m)];
    }
    db = require('../core/memory/db');
    drafts = require('../core/memory/drafts');
    vids = require('../core/memory/videos');
    cmts = require('../core/memory/comments');
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

  // ═════════════════════════════════════════════════════════
  // 搜索（list / count 共用同一份 SQL 条件）
  //
  // 界面搜索若只在已加载的那一页里过滤，"没有命中"就是假话：list 最多返回
  // MAX_LIMIT 条，库里可能还有几十条没读进来。所以条件必须进 SQL，
  // 而 count 与 list 必须是**同一个集合** —— 否则"共 N 条"和列表内容互相矛盾。
  // ═════════════════════════════════════════════════════════
  describe('搜索', () => {
    beforeAll(() => {
      vids.upsert({ awemeId: 'v-srch-1', title: '家用咖啡机开箱测评', isMine: true });
      cmts.upsert({ cid: 'c-srch-1', awemeId: 'v-srch-1', uid: 'u1', text: '这个太贵了吧买不起' });
      drafts.save({ awemeId: 'v-srch-1', text: '好的谢谢，已经私你了' });
      drafts.save({ awemeId: 'v-srch-1', replyToCid: 'c-srch-1', text: '现在有活动哦' });
      drafts.save({ awemeId: 'v-srch-1', text: '关键词命中：性价比很高' });
      drafts.save({ awemeId: 'v-srch-2', text: '折扣 100% 生效' });
      drafts.save({ awemeId: 'v-srch-2', text: '折扣 A_B 生效' });
      drafts.save({ awemeId: 'v-srch-2', text: '折扣 AxB 生效' });
    });

    it('命中草稿正文', () => {
      const hits = drafts.list({ q: '性价比' });
      expect(hits.map(d => d.text)).toEqual(['关键词命中：性价比很高']);
    });

    it('命中所属视频的标题', () => {
      // 三条正文里没有"咖啡"，靠 videos.title 命中
      const hits = drafts.list({ q: '咖啡机' });
      expect(hits.length).toBe(3);
      expect(hits.every(d => d.aweme_id === 'v-srch-1')).toBe(true);
    });

    it('命中被回复那条评论的原文', () => {
      const hits = drafts.list({ q: '买不起' });
      expect(hits.map(d => d.text)).toEqual(['现在有活动哦']);
    });

    it('一个词都没命中时返回空，且 count 也是 0', () => {
      expect(drafts.list({ q: '这几个字库里绝不可能出现' })).toEqual([]);
      expect(drafts.count({ q: '这几个字库里绝不可能出现' })).toBe(0);
    });

    it('空白关键词等于不过滤', () => {
      expect(drafts.list({ q: '   ' }).length).toBe(drafts.list().length);
      expect(drafts.count({ q: '' })).toBe(drafts.count());
    });

    it('% 与 _ 按字面量匹配，不当通配符', () => {
      // 「100%」若被当通配符，会命中所有以 100 开头的正文；「A_B」若 _ 仍被当
      // 单字通配，会连带命中写着 AxB 的那条 —— 两条都必须只命中自己。
      expect(drafts.list({ q: '100%' }).map(d => d.text)).toEqual(['折扣 100% 生效']);
      expect(drafts.list({ q: 'A_B' }).map(d => d.text)).toEqual(['折扣 A_B 生效']);
      // % 若仍是通配符，这一句会命中「折扣 A_B 生效」
      expect(drafts.list({ q: '折扣 A%B 生效' })).toEqual([]);
      // 单独一个下划线不该把所有不含下划线的草稿都匹配掉
      expect(drafts.list({ q: '_' }).map(d => d.text)).toEqual(['折扣 A_B 生效']);
    });

    it('count 与 list 说的是同一个集合', () => {
      for (const q of ['性价比', '咖啡机', '买不起', '折扣']) {
        expect(drafts.count({ q })).toBe(drafts.list({ q }).length);
      }
    });

    it('搜索不越过账号边界', () => {
      drafts.save({ awemeId: 'v-srch-1', text: '甲号的性价比回复', accountUid: 'uidA' });
      drafts.save({ awemeId: 'v-srch-1', text: '乙号的性价比回复', accountUid: 'uidB' });
      expect(drafts.list({ q: '性价比', accountUid: 'uidA' }).map(d => d.text))
        .toEqual(['甲号的性价比回复']);
      expect(drafts.count({ q: '性价比', accountUid: 'uidB' })).toBe(1);
      // 指定账号时，account_uid 为 NULL 的旧草稿不得出现（无法判断归属 = 可能串号）
      expect(drafts.list({ q: '性价比', accountUid: 'uidA' })
        .some(d => d.text === '关键词命中：性价比很高')).toBe(false);
    });
  });

  describe('批量删除', () => {
    let a1, a2, b1;
    beforeEach(() => {
      a1 = drafts.save({ awemeId: 'v-rm', text: '待批量删除-甲1', accountUid: 'uidA' });
      a2 = drafts.save({ awemeId: 'v-rm', text: '待批量删除-甲2', accountUid: 'uidA' });
      b1 = drafts.save({ awemeId: 'v-rm', text: '待批量删除-乙1', accountUid: 'uidB' });
    });

    it('返回真正删掉的条数', () => {
      expect(drafts.removeMany([a1, a2], { accountUid: 'uidA' })).toBe(2);
      expect(drafts.get(a1)).toBeNull();
      expect(drafts.get(a2)).toBeNull();
    });

    it('不得删掉别的账号的草稿', () => {
      // 换号后 id 仍可能留在前端选中集合里；界面按账号过滤，用户看不见 b1，
      // 所以这一批必须一个字节都不动它。
      expect(drafts.removeMany([b1], { accountUid: 'uidA' })).toBe(0);
      expect(drafts.get(b1)).not.toBeNull();
      expect(drafts.removeMany([a1, b1], { accountUid: 'uidA' })).toBe(1);
      expect(drafts.get(b1)).not.toBeNull();
    });

    it('非法 id 直接忽略，不拼进 SQL', () => {
      expect(drafts.removeMany([])).toBe(0);
      expect(drafts.removeMany(null)).toBe(0);
      expect(drafts.removeMany([0, -1, 1.5, 'abc', NaN, undefined])).toBe(0);
      expect(drafts.get(a1)).not.toBeNull();
      // 重复 id 只算一条（否则界面会以为删了两条）
      expect(drafts.removeMany([a1, a1, String(a1)], { accountUid: 'uidA' })).toBe(1);
    });

    it('不存在的 id 返回 0 而不是报错', () => {
      expect(drafts.removeMany([99999998, 99999999], { accountUid: 'uidA' })).toBe(0);
    });
  });
});
