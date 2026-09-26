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

  // ═════════════════════════════════════════════════════════
  // 批量改正文（单条编辑也走这一条）
  //
  // 这条存在之前，界面的"编辑"是 save 一条新的 + remove 旧的。症状有三个，
  // 每一条都是这条用例要钉住的：id 变了（草稿在列表里跳位、created_at 变成现在）、
  // 两步之间失败留下**两条内容相同的待发草稿**（接着批量发布就是把同一句发两遍）、
  // 以及完全没有批量入口（30 条草稿只能一条条点开改）。
  //
  // 本文件共用同一个临时库，且 beforeEach 每个用例都会新插几行，
  // 所以每个用例各用一个独立的 aweme_id 把行隔开 —— 否则"行数不变"
  // 只能跟相对值比，而 list 有 limit，累积到几十个用例以后就会失真。
  // ═════════════════════════════════════════════════════════
  describe('批量改正文', () => {
    let seq = 0;
    let aw, a1, a2, a3, b1, sentId, orphanId;
    const rowsOfA = () => drafts.list({
      awemeId: aw, accountUid: 'uidA', limit: drafts.MAX_LIMIT,
    }).length;
    beforeEach(() => {
      aw = `v-up-${++seq}`;
      a1 = drafts.save({ awemeId: aw, text: '亲，这款有货哦', accountUid: 'uidA' });
      a2 = drafts.save({ awemeId: aw, text: '亲，那款没货了', accountUid: 'uidA' });
      a3 = drafts.save({ awemeId: aw, text: '感谢支持！', accountUid: 'uidA' });
      b1 = drafts.save({ awemeId: aw, text: '乙号的有货哦', accountUid: 'uidB' });
      sentId = drafts.save({ awemeId: aw, text: '已经发出的有货哦', accountUid: 'uidA' });
      drafts.markPosted(sentId);
      orphanId = drafts.save({ awemeId: aw, text: '没标归属的有货哦' });
    });

    it('改完还是同一条草稿：id、created_at、行数都不变', () => {
      const rows = rowsOfA();
      const before = drafts.get(a1);
      const r = drafts.updateMany([a1], { text: '统一口径的那句话' }, { accountUid: 'uidA' });
      expect(r.changed).toEqual([a1]);
      const after = drafts.get(a1);
      expect(after.id).toBe(before.id);
      expect(after.created_at).toBe(before.created_at);
      expect(after.text).toBe('统一口径的那句话');
      // 行数不变 = 没有"存新的再删旧的"那一步。少了这条断言，
      // 把实现换回 save+remove 照样能过上面三句
      expect(rowsOfA()).toBe(rows);
    });

    it('整批替换：勾到的每一条都变成同一句', () => {
      const r = drafts.updateMany([a1, a2, a3], { text: '统一口径的那句话' }, { accountUid: 'uidA' });
      expect([...r.changed].sort()).toEqual([a1, a2, a3].sort());
      expect(r.requested).toBe(3);
      for (const id of [a1, a2, a3]) expect(drafts.get(id).text).toBe('统一口径的那句话');
    });

    it('查找替换按字面量：$& 与正则元字符都不特殊', () => {
      const t1 = drafts.save({
        awemeId: aw, text: '1号链接 (1) 元', accountUid: 'uidA',
      });
      // replace 里写 `$&` 时 String.replace 会把它换成"匹配到的那一段"，
      // 用户敲进去的三个字符凭空长出别的东西
      drafts.updateMany([t1], { find: '(1)', replace: '<$&>' }, { accountUid: 'uidA' });
      expect(drafts.get(t1).text).toBe('1号链接 <$&> 元');

      const t2 = drafts.save({
        awemeId: aw, text: '1号链接 (1) 元', accountUid: 'uidA',
      });
      // find 若被当正则用，`(1)` 成了"分组捕获 1"—— 正文里每个孤立的 1 都被吃掉，
      // 开头的「1号链接」会跟着变成「X号链接」
      drafts.updateMany([t2], { find: '(1)', replace: 'X' }, { accountUid: 'uidA' });
      expect(drafts.get(t2).text).toBe('1号链接 X 元');
    });

    it('已发出的、别号的、库里没有的：各自算进 skipped，一个字节都不动', () => {
      const r = drafts.updateMany(
        [a1, sentId, b1, orphanId, 99999998], { text: '统一' }, { accountUid: 'uidA' });
      expect(r.changed).toEqual([a1]);
      expect(r.requested).toBe(5);
      expect(r.skipped.posted).toBe(1);
      // 别的账号 + account_uid 为 NULL 的旧草稿。NULL 算"外号"是因为无法判断归属，
      // 与 list / count 同一口径 —— 它不该被这一次批量改碰到
      expect(r.skipped.foreign).toBe(2);
      expect(r.skipped.missing).toBe(1);
      expect(drafts.get(sentId).text).toBe('已经发出的有货哦');
      expect(drafts.get(b1).text).toBe('乙号的有货哦');
      expect(drafts.get(orphanId).text).toBe('没标归属的有货哦');
    });

    it('改成空白：没附图的不许；带附图的存成空串而不是几个空格', () => {
      const r = drafts.updateMany([a2], { text: '   ' }, { accountUid: 'uidA' });
      expect(r.changed).toEqual([]);
      expect(r.skipped.empty).toBe(1);
      expect(drafts.get(a2).text).toBe('亲，那款没货了');

      const img = drafts.save({
        awemeId: aw, text: '带图的草稿', imagePath: '/tmp/x.jpg', accountUid: 'uidA',
      });
      const r2 = drafts.updateMany([img], { text: '   ' }, { accountUid: 'uidA' });
      expect(r2.changed).toEqual([img]);
      // 纯图草稿是合法的（image.withText=false），但正文得真的是空：
      // 留着三个空格，列表里看着"有字"、发出去是一条空评论
      expect(drafts.get(img).text).toBe('');
    });

    it('本来就一样的算 noop，不占 changed 的条数', () => {
      const same = drafts.updateMany([a3], { text: '感谢支持！' }, { accountUid: 'uidA' });
      expect(same.changed).toEqual([]);
      expect(same.skipped.noop).toBe(1);
      // 查找替换没命中时同理：界面说"改了 0 条"而不是"改了 3 条"
      const miss = drafts.updateMany([a1, a2, a3], { find: '这几个字正文里没有', replace: 'X' },
        { accountUid: 'uidA' });
      expect(miss.changed).toEqual([]);
      expect(miss.skipped.noop).toBe(3);
    });

    it('dryRun 一个字都不写，预览与真跑一次完全一致', () => {
      const ids = [a1, a2, a3, sentId];
      const patch = { find: '有货', replace: '现货' };
      const pre = drafts.updateMany(ids, patch, { accountUid: 'uidA', dryRun: true });
      // a2 是"没货"、a3 不含关键词 → noop；sentId 已发出 → 跳过。
      // 确认框里的"会改动 1 条"就必须是这个数，不能是界面猜的
      expect(pre.changed).toEqual([a1]);
      expect(pre.preview).toEqual([{ id: a1, from: '亲，这款有货哦', to: '亲，这款现货哦' }]);
      expect(drafts.get(a1).text).toBe('亲，这款有货哦');

      const run = drafts.updateMany(ids, patch, { accountUid: 'uidA' });
      expect(run.changed).toEqual(pre.changed);
      expect(run.preview).toEqual(pre.preview);
      expect(run.skipped).toEqual(pre.skipped);
    });

    it('两种模式互斥；缺内容时报错，而不是静默改 0 条', () => {
      expect(() => drafts.updateMany([a1], {}, { accountUid: 'uidA' })).toThrow('没有要改的内容');
      expect(() => drafts.updateMany([a1], { find: '' }, { accountUid: 'uidA' }))
        .toThrow('没有要改的内容');
      expect(() => drafts.updateMany([a1], { text: 'x', find: 'y', replace: 'z' },
        { accountUid: 'uidA' })).toThrow('只能选一种');
      expect(drafts.get(a1).text).toBe('亲，这款有货哦');
    });

    it('重复与非法 id 先净化，requested 报的是净化后的条数', () => {
      const r = drafts.updateMany([a1, a1, String(a1), 0, -1, 1.5, 'abc', null, undefined],
        { text: '统一' }, { accountUid: 'uidA' });
      expect(r.requested).toBe(1);
      expect(r.changed).toEqual([a1]);
      expect(drafts.get(a2).text).toBe('亲，那款没货了');
    });

    it('空 id 列表不报错，也不看 patch 形状', () => {
      const r = drafts.updateMany([], {});
      expect(r).toMatchObject({
        changed: [], requested: 0, preview: [],
        skipped: { missing: 0, posted: 0, foreign: 0, empty: 0, noop: 0 },
      });
    });
  });

  // ═════════════════════════════════════════════════════════
  // 写入必须标明归属账号
  //
  // 真实事故：批量 AI 生成回复后草稿箱是空的。数据其实进库了（CLI `draft list`
  // 能列出来），看不见是因为三个写草稿的入口都没带 accountUid，而本文件上面
  // 「指定账号时 account_uid 为 NULL 的草稿不得出现」那条用例把存储层行为
  // 钉成了设计如此 —— 隔离规则是对的，漏的是写入侧。这类"两半各自都对、
  // 拼起来什么都看不见"的缺陷，只测其中一半永远抓不到。
  // ═════════════════════════════════════════════════════════
  describe('写入必须标明归属账号', () => {
    it('带归属存进去的草稿，按该账号能列出来', () => {
      drafts.save({ awemeId: 'v-attr', text: '甲号准备好的回复', accountUid: 'attrA' });
      const items = drafts.list({ posted: false, accountUid: 'attrA' });
      expect(items.map(d => d.text)).toContain('甲号准备好的回复');
    });

    it('没标归属的草稿不许静默消失：count 的 unattributed 数得到', () => {
      const before = drafts.count({ posted: false, unattributed: true });
      drafts.save({ awemeId: 'v-attr', text: '没标归属的一条' });
      expect(drafts.count({ posted: false, unattributed: true })).toBe(before + 1);
      // 它与"按某个账号过滤"是两回事：两个条件相加恒为 0，所以视图层分开查
      expect(drafts.count({ posted: false, accountUid: 'attrA', unattributed: true })).toBe(0);
    });

    it('listDrafts 把未标明归属的条数报给界面', () => {
      for (const m of ['../core/data/views']) delete require.cache[require.resolve(m)];
      const views = require('../core/data/views');
      drafts.save({ awemeId: 'v-attr', text: '报给界面的孤儿草稿' });
      const box = views.listDrafts({ accountUid: 'attrA' });
      expect(box.items.map(d => d.text)).toContain('甲号准备好的回复');
      expect(box.items.map(d => d.text)).not.toContain('报给界面的孤儿草稿');
      expect(box.unattributed).toBeGreaterThanOrEqual(1);
    });

    it('每一个写草稿的调用点都必须显式带 accountUid', () => {
      const fs = require('fs');
      const path = require('path');
      const files = [
        'core/commands/getReply.js',
        'core/commands/draft.js',
        'app/main/ipc.js',
      ];
      let seen = 0;
      for (const rel of files) {
        const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
          // 注释里出现 drafts.save 不算调用点（本文件系列的护栏都踩过这个坑）
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const calls = src.match(/\.save\(\{[^}]*\}\)/g) || [];
        for (const call of calls) {
          expect(call).toMatch(/accountUid/);
          seen += 1;
        }
      }
      // 少于 3 个说明有调用点没被扫到（比如对象里出现了嵌套花括号，
      // [^}]* 会提前收尾）—— 那这条护栏就只是看着在起作用
      expect(seen).toBeGreaterThanOrEqual(3);
    });
  });
});
