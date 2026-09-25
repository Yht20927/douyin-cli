// tests/data-views.test.js — 界面视图模型
//
// 数据层与命令层的分工是刻意的：看本地数据走这里（读 SQLite，无风控风险），
// 动手（拉新评论、发布）才走队列。这里验证前者的正确性，尤其是
// **判定结果必须与发布时用的决策树一致** —— 界面上显示"建议回复"，
// 点发布时却被拦下，是最伤信任的那种不一致。

const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../core/config');

const ENV_KEYS = ['DOUYIN_STORAGE_DIR', 'DOUYIN_LOG_DIR', 'DOUYIN_CONFIG'];

function withTempEnv(cfg, fn) {
  return async () => {
    const saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-views-'));
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    process.env.DOUYIN_LOG_DIR = path.join(tmp, 'logs');
    const cfgFile = path.join(tmp, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify(cfg || {}));
    process.env.DOUYIN_CONFIG = cfgFile;
    config.reset();

    // ⚠️ 必须连 memory 层一并清掉。这些模块顶层就 `const { getDb } = require('./db')`，
    // 把**函数引用**钉在了自己身上 —— db 清了、它们没清，下一次调用拿到的仍是
    // 上一个临时库的 getDb。表现是"单独跑过、一起跑挂"，而且数据看起来像串了
    // （与 开发进度.md §2.4 是同一条坑）。
    const purge = () => {
      for (const m of ['../core/memory/db', '../core/memory/videos', '../core/memory/comments',
        '../core/memory/users', '../core/memory/drafts', '../core/memory/events',
        '../core/memory/failures', '../core/memory/llm-usage', '../core/memory/accounts',
        '../core/data/views']) {
        delete require.cache[require.resolve(m)];
      }
    };
    purge();

    try {
      const views = require('../core/data/views');
      const vids = require('../core/memory/videos');
      const cmts = require('../core/memory/comments');
      const usrs = require('../core/memory/users');
      const drfs = require('../core/memory/drafts');
      const evts = require('../core/memory/events');
      const fails = require('../core/memory/failures');
      const llm = require('../core/memory/llm-usage');
      await fn({ views, vids, cmts, usrs, drfs, evts, fails, llm });
    } finally {
      try { require('../core/memory/db').closeDb(); } catch (e) { /* ignore */ }
      purge();
      config.reset();
      for (const k of ENV_KEYS) {
        if (saved[k] == null) delete process.env[k];
        else process.env[k] = saved[k];
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

/**
 * 造一条评论。
 *
 * 注意 replied 必须走 markReplied()：upsert 的列里根本没有这一列 ——
 * "已回复"是只有真正发出去之后才该置位的权威状态，不该能被批量写入顺手改掉。
 * 首版这里直接把 replied 塞给 upsert，结果静默不生效，8 个用例一起挂。
 */
function addComment(cmts, awemeId, cid, text, extra = {}) {
  cmts.upsert({
    cid, awemeId, uid: extra.uid || 'u1', text,
    digg: extra.digg || 0, createdAt: extra.createdAt || Date.now(),
  });
  if (extra.replied) cmts.markReplied(cid, awemeId, extra.replyCid || `reply-${cid}`);
}

describe('我的作品', () => {
  it('空库返回空数组', withTempEnv({}, async ({ views }) => {
    expect(views.listMyVideos()).toEqual([]);
    expect(views.overview()).toMatchObject({ videos: 0, comments: 0 });
  }));

  it('带出评论统计（总数/已回/待回）', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: '第一个视频', isMine: true });
    addComment(cmts, 'v1', 'c1', '这个怎么做的？');
    addComment(cmts, 'v1', 'c2', '不错的分享内容啊');
    addComment(cmts, 'v1', 'c3', '最早的那条评论', { replied: true, replyCid: 'r1' });

    const [v] = views.listMyVideos();
    expect(v.awemeId).toBe('v1');
    expect(v.title).toBe('第一个视频');
    expect(v.commentStats).toMatchObject({ total: 3, replied: 1, pending: 2 });
  }));

  it('待回复不把自己发的评论算进去', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true, authorUid: 'me123' });
    addComment(cmts, 'v1', 'other1', '这个怎么做的？', { uid: 'someone' });   // 别人的，待回
    addComment(cmts, 'v1', 'mine1', '我自己的留言', { uid: 'me123' });        // 我自己发的
    addComment(cmts, 'v1', 'mine2', '我发出的回复', { uid: 'me123', parentCid: 'other1' });
    addComment(cmts, 'v1', 'done1', '已回过的', { uid: 'someone2', replied: true });

    const [v] = views.listMyVideos();
    // 4 条评论里：1 条我发的 + 1 条我的回复 + 1 条已回复，真正的待回复只有 1 条
    expect(v.commentStats).toMatchObject({ total: 4, replied: 1, mine: 2, pending: 1 });
  }));

  it('只列自己的作品，不含别人的', withTempEnv({}, async ({ views, vids }) => {
    vids.upsert({ awemeId: 'mine', title: '我的', isMine: true });
    vids.upsert({ awemeId: 'other', title: '别人的', isMine: false });
    const list = views.listMyVideos();
    expect(list.map(v => v.awemeId)).toEqual(['mine']);
  }));

  it('视频详情含 desc 与封面（作品列表要显示）', withTempEnv({}, async ({ views, vids }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', desc: '这是描述', coverUrl: 'https://x/c.jpg', isMine: true });
    const d = views.videoDetail('v1');
    expect(d.desc).toBe('这是描述');
    expect(d.coverUrl).toBe('https://x/c.jpg');
  }));

  it('不存在的视频返回 null', withTempEnv({}, async ({ views }) => {
    expect(views.videoDetail('nope')).toBeNull();
  }));

  // ═══════════════════════════════════════════════════════════
  // 排序
  //
  // 用户反馈"我最新的作品显示的时间是 11 分钟以前" —— 根因有两层：
  // 一是那个位置显示的是**最后拉取时间**而不是发布时间（已在界面修掉，
  // 两行都加了标签）；二是列表**按拉取时间排序**，于是 6/1 发的排在 6/19 前面。
  // ═══════════════════════════════════════════════════════════

  it('作品列表按发布时间倒序，而不是按拉取时间', withTempEnv({}, async ({ views, vids }) => {
    // 6/1 发的但刚拉取过；6/19 发的但很久没拉 —— 按发布时间应然后者在先
    vids.upsert({ awemeId: 'older', title: '六月一日发的', isMine: true, createTime: 1780272000, lastGetTs: Date.now() });
    vids.upsert({ awemeId: 'newer', title: '六月十九发的', isMine: true, createTime: 1781827200, lastGetTs: Date.now() - 90 * 86400000 });

    expect(views.listMyVideos().map(v => v.awemeId)).toEqual(['newer', 'older']);
  }));

  it('发布时间缺失时排在最后（不让未知时间挤到前面）', withTempEnv({}, async ({ views, vids }) => {
    vids.upsert({ awemeId: 'known', title: 'A', isMine: true, createTime: 1781827200 });
    vids.upsert({ awemeId: 'unknown', title: 'B', isMine: true });

    expect(views.listMyVideos()[0].awemeId).toBe('known');
  }));

  it('createTime 原样带出（秒），由界面负责展示', withTempEnv({}, async ({ views, vids }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true, createTime: 1781827200 });
    const v = views.listMyVideos()[0];
    expect(v.createTime).toBe(1781827200);
    // 解出来是 2026 年，而不是被当成毫秒解到 1970
    expect(new Date(v.createTime * 1000).getUTCFullYear()).toBe(2026);
  }));

  it('videos.list 默认仍按活跃度排序（其它视图依赖）', withTempEnv({}, async ({ vids }) => {
    vids.upsert({ awemeId: 'old', title: 'A', isMine: true, createTime: 1781827200, lastGetTs: 1000 });
    vids.upsert({ awemeId: 'recent', title: 'B', isMine: true, createTime: 1000000, lastGetTs: 9e12 });

    expect(vids.list({ isMine: true }).map(v => v.awemeId)).toEqual(['recent', 'old']);
  }));
});

describe('评论列表与判定', () => {
  it('每条评论带上判定结果与原因', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    addComment(cmts, 'v1', 'c1', '这个是怎么做到的？');
    addComment(cmts, 'v1', 'c2', '666');
    addComment(cmts, 'v1', 'c3', '😊');

    const list = views.listComments('v1').items;
    const by = Object.fromEntries(list.map(c => [c.cid, c.decision]));
    expect(by.c1.action).toBe('reply');
    expect(by.c2.action).toBe('skip');
    expect(by.c3.action).toBe('emoji_reply');
  }));

  it('已回复的评论判定为"已回复过"，且标记 replied', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    addComment(cmts, 'v1', 'done', '这个怎么做的', { replied: true, replyCid: 'r1' });

    const [c] = views.listComments('v1').items;
    expect(c.replied).toBe(true);
    expect(c.decision.action).toBe('skip');
    expect(c.decision.reason).toContain('已回复');
  }));

  it('按判定结果过滤：只取建议回复的', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    addComment(cmts, 'v1', 'c1', '这个是怎么做到的？');
    addComment(cmts, 'v1', 'c2', '666');
    addComment(cmts, 'v1', 'c3', '请问在哪里买');

    const replies = views.listComments('v1', { filter: 'reply' }).items;
    expect(replies.map(c => c.cid).sort()).toEqual(['c1', 'c3']);
  }));

  it('按判定结果过滤：只取跳过的', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    addComment(cmts, 'v1', 'c1', '这个是怎么做到的？');
    addComment(cmts, 'v1', 'c2', '666');

    expect(views.listComments('v1', { filter: 'skip' }).items.map(c => c.cid)).toEqual(['c2']);
  }));

  it('按已回复状态过滤走 SQL，不被判定过滤干扰', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    addComment(cmts, 'v1', 'a', '这个怎么做的', { replied: true });
    addComment(cmts, 'v1', 'b', '这个也怎么做');

    expect(views.listComments('v1', { filter: 'replied' }).items.map(c => c.cid)).toEqual(['a']);
    expect(views.listComments('v1', { filter: 'pending' }).items.map(c => c.cid)).toEqual(['b']);
  }));

  it('搜索按评论内容或昵称匹配', withTempEnv({}, async ({ views, vids, cmts, usrs }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    usrs.upsert({ uid: 'u1', nickname: '小明' });
    usrs.upsert({ uid: 'u2', nickname: '小红' });
    addComment(cmts, 'v1', 'a', '关于缓存的问题', { uid: 'u1' });
    addComment(cmts, 'v1', 'b', '别的什么内容', { uid: 'u2' });

    expect(views.listComments('v1', { search: '缓存' }).items.map(c => c.cid)).toEqual(['a']);
    expect(views.listComments('v1', { search: '小红' }).items.map(c => c.cid)).toEqual(['b']);
  }));

  it('带出用户昵称与分级', withTempEnv({}, async ({ views, vids, cmts, usrs }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    usrs.upsert({ uid: 'u1', nickname: '小明' });
    usrs.setTier('u1', 'vip');
    addComment(cmts, 'v1', 'a', '这个怎么做的', { uid: 'u1' });

    const [c] = views.listComments('v1').items;
    expect(c.user).toMatchObject({ nickname: '小明', tier: 'vip' });
  }));

  it('黑名单用户被判定为跳过（与发布时同一套判定）', withTempEnv({}, async ({ views, vids, cmts, usrs }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    usrs.upsert({ uid: 'bad', nickname: '捣乱的' });
    usrs.setTier('bad', 'blacklist');
    addComment(cmts, 'v1', 'a', '这个怎么做的', { uid: 'bad' });

    const [c] = views.listComments('v1').items;
    expect(c.decision.action).toBe('skip');
    expect(c.decision.reason).toContain('blacklist');
  }));
});

describe('自己的评论不出现在待回复里', () => {
  it('videos.myUid() 从自己的视频里取作者 uid', withTempEnv({}, async ({ vids }) => {
    expect(vids.myUid()).toBeNull();          // 还没有 my 过
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true, authorUid: 'me123' });
    expect(vids.myUid()).toBe('me123');
  }));

  it('别人的视频不影响 myUid', withTempEnv({}, async ({ vids }) => {
    vids.upsert({ awemeId: 'other', title: 'X', isMine: false, authorUid: 'someone' });
    expect(vids.myUid()).toBeNull();
  }));

  it('我自己发的评论被判定为跳过', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true, authorUid: 'me123' });
    addComment(cmts, 'v1', 'mine1', '这个是怎么做到的？', { uid: 'me123' });
    addComment(cmts, 'v1', 'other1', '这个是怎么做到的？', { uid: 'someone' });

    const list = views.listComments('v1').items;
    const by = Object.fromEntries(list.map(c => [c.cid, c.decision]));

    expect(by.mine1.action).toBe('skip');
    expect(by.mine1.reason).toContain('我自己');
    expect(by.other1.action).toBe('reply');
  }));

  it('我发出的回复（作为子评论拉回来）同样被跳过', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true, authorUid: 'me123' });
    addComment(cmts, 'v1', 'parent', '这个是怎么做到的？', { uid: 'someone' });
    cmts.upsert({ cid: 'myreply', awemeId: 'v1', uid: 'me123', text: '我回你了', parentCid: 'parent' });

    const list = views.listComments('v1').items;
    const mine = list.find(c => c.cid === 'myreply');
    expect(mine.decision.action).toBe('skip');
    expect(mine.decision.reason).toContain('我自己');
  }));

  it('判定分布里"我自己发的"计入 skip 而不是 reply', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true, authorUid: 'me123' });
    addComment(cmts, 'v1', 'a', '这个怎么做的？', { uid: 'me123' });
    addComment(cmts, 'v1', 'b', '这个怎么做的？', { uid: 'other' });

    const s = views.videoStats('v1');
    expect(s.byDecision.skip).toBe(1);
    expect(s.byDecision.reply).toBe(1);
  }));
});

// ═══════════════════════════════════════════════════════════
// 时间戳单位
//
// 抖音原生时间字段是「秒」，本项目自己产生的是「毫秒」（见 core/memory/db.js
// 的单位约定）。界面按毫秒算"多久之前"，不归一化就会把 2026 年的评论
// 显示成"20692 天前" —— 这正是改造后第一次用真实数据渲染时暴露出来的。
// ═══════════════════════════════════════════════════════════

describe('评论时间戳单位归一', () => {
  it('秒级时间戳被转成毫秒后交给界面', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    // 抖音的 create_time 是秒
    const seconds = 1788586286;
    cmts.upsert({ cid: 'a', awemeId: 'v1', uid: 'u1', text: '这个怎么做的', createdAt: seconds });

    const [c] = views.listComments('v1').items;
    expect(c.createdAt).toBe(seconds * 1000);
    expect(c.createdAtRaw).toBe(seconds);          // 原始值保留，便于排查
    // 解出来应该是 2026 年，而不是 1970 年
    expect(new Date(c.createdAt).getUTCFullYear()).toBe(2026);
  }));

  it('已是毫秒的时间戳不会被二次放大', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    const ms = 1788586286000;
    cmts.upsert({ cid: 'a', awemeId: 'v1', uid: 'u1', text: '这个怎么做的', createdAt: ms });

    const [c] = views.listComments('v1').items;
    expect(c.createdAt).toBe(ms);   // 不能变成 1788586286000000
  }));

  it('commentDetail 走同一套归一', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    cmts.upsert({ cid: 'a', awemeId: 'v1', uid: 'u1', text: '这个怎么做的', createdAt: 1788586286 });

    const d = views.commentDetail('a');
    expect(d.createdAt).toBe(1788586286000);
  }));

  it('空值不炸（老数据可能没有时间）', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    cmts.upsert({ cid: 'a', awemeId: 'v1', uid: 'u1', text: '这个怎么做的' });

    const [c] = views.listComments('v1').items;
    expect(c.createdAt).toBeNull();
  }));
});

describe('视频判定分布', () => {
  it('统计各判定结果的数量', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    addComment(cmts, 'v1', 'a', '这个是怎么做到的？');
    addComment(cmts, 'v1', 'b', '请问在哪里买');
    addComment(cmts, 'v1', 'c', '666');
    addComment(cmts, 'v1', 'd', '😊');
    addComment(cmts, 'v1', 'e', '已回过的', { replied: true });

    const s = views.videoStats('v1');
    expect(s.total).toBe(5);
    expect(s.replied).toBe(1);
    expect(s.byDecision.reply).toBe(2);
    expect(s.byDecision.emoji_reply).toBe(1);
    expect(s.byDecision.skip).toBe(2);   // 666 与已回复
  }));
});

describe('草稿箱', () => {
  it('列出草稿并附上视频标题', withTempEnv({}, async ({ views, vids, drfs }) => {
    vids.upsert({ awemeId: 'v1', title: '视频标题', isMine: true });
    drfs.save({ awemeId: 'v1', text: '这是一条草稿内容', replyToCid: 'c1', personaId: 'casual_friend' });

    // listDrafts 返回 { items, total, truncated }，不是裸数组 ——
    // 裸数组会让"共 N 条"拿列表长度当真实总数（作品列表踩过这个坑）
    const list = views.listDrafts().items;
    expect(list).toHaveLength(1);
    expect(list[0].videoTitle).toBe('视频标题');
    expect(list[0].text).toBe('这是一条草稿内容');
  }));

  it('已发布的草稿不再出现在待发列表', withTempEnv({}, async ({ views, vids, drfs }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    const id = drfs.save({ awemeId: 'v1', text: '草稿内容一' });
    drfs.markPosted(id);
    expect(views.listDrafts().items).toEqual([]);
  }));

  // 搜索条件必须在 SQL 里，且 matched / total 两个数都要返回。
  // 界面一旦只拿 items 过滤，"没有命中"和"共 N 条"都会成为假话（详见 drafts.searchWhere）。
  it('搜索：matched 是命中数，total 仍是箱子总量', withTempEnv({}, async ({ views, vids, drfs }) => {
    vids.upsert({ awemeId: 'v1', title: '咖啡机测评', isMine: true });
    drfs.save({ awemeId: 'v1', text: '第一条：性价比很高' });
    drfs.save({ awemeId: 'v1', text: '第二条普通内容' });
    drfs.save({ awemeId: 'v1', text: '第三条普通内容' });

    const hit = views.listDrafts({ q: '性价比' });
    expect(hit.items.map(d => d.text)).toEqual(['第一条：性价比很高']);
    expect(hit).toMatchObject({ matched: 1, total: 3, truncated: false, q: '性价比' });

    const none = views.listDrafts({ q: '咖啡机' });   // 靠视频标题命中
    expect(none.items).toHaveLength(3);
    expect(none).toMatchObject({ matched: 3, total: 3 });

    const miss = views.listDrafts({ q: '不存在xyz' });
    expect(miss).toMatchObject({ items: [], matched: 0, total: 3, truncated: false });

    // 不带关键词时两个数必须相同 —— 侧栏角标与"共 N 条"同源，不会各说各话
    const all = views.listDrafts();
    expect(all).toMatchObject({ matched: 3, total: 3, q: '' });
  }));

  it('truncated 说的是命中数超出返回条数', withTempEnv({}, async ({ views, drfs }) => {
    for (const t of ['性价比甲', '性价比乙', '性价比丙']) drfs.save({ awemeId: 'v1', text: t });
    const page = views.listDrafts({ q: '性价比', limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page).toMatchObject({ matched: 3, truncated: true });
    // 放开了就不该再报截断
    expect(views.listDrafts({ q: '性价比' })).toMatchObject({ truncated: false });
  }));

  it('搜索不越过账号边界', withTempEnv({}, async ({ views, vids, drfs }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    drfs.save({ awemeId: 'v1', text: '甲号的性价比回复', accountUid: 'uidA' });
    drfs.save({ awemeId: 'v1', text: '乙号的性价比回复', accountUid: 'uidB' });

    const a = views.listDrafts({ accountUid: 'uidA', q: '性价比' });
    expect(a.items.map(d => d.text)).toEqual(['甲号的性价比回复']);
    // total 也只数当前账号：否则角标会显示成 2
    expect(a).toMatchObject({ matched: 1, total: 1 });
  }));
});

describe('总览', () => {
  it('汇总数字与草稿数', withTempEnv({}, async ({ views, vids, cmts, drfs }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    addComment(cmts, 'v1', 'a', '这个怎么做的');
    addComment(cmts, 'v1', 'b', '已回的', { replied: true });
    drfs.save({ awemeId: 'v1', text: '草稿内容' });

    const o = views.overview();
    expect(o).toMatchObject({ videos: 1, comments: 2, replied: 1, pending: 1, drafts: 1 });
  }));
});

describe('与发布判定的一致性', () => {
  it('界面显示"建议回复"的评论，策略闸门不会因内容原因拦下', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    addComment(cmts, 'v1', 'a', '这个是怎么做到的？');

    const [c] = views.listComments('v1').items;
    expect(c.decision.action).toBe('reply');

    // 该评论本身不该触发"已回复过"之类的拦截
    const policy = require('../core/policy').createPolicyEngine({});
    const r = policy.beforeWrite({ cid: c.cid, awemeId: 'v1' });
    const replayBlocked = r.hardBlockers.some(b => b.reason.includes('已经回复过'));
    expect(replayBlocked).toBe(false);
  }));

  it('界面显示"已回复"的评论，发布判定也会拦下（两处口径一致）', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    addComment(cmts, 'v1', 'done', '这个是怎么做到的？', { replied: true, replyCid: 'r1' });

    const [c] = views.listComments('v1').items;
    expect(c.decision.action).toBe('skip');

    // 发布侧用的是同一个 decision 依据：comments 表的 replied 列
    const policy = require('../core/policy').createPolicyEngine({});
    const r = policy.beforeWrite({ cid: 'done', awemeId: 'v1' });
    expect(r.hardBlockers.some(b => b.reason.includes('已经回复过'))).toBe(true);
  }));
});

// ═══════════════════════════════════════════════════════════
// 已回复的评论要能看到"当时回了什么"
//
// 需求(1)：在列表里选中一条已回复的评论，应当显示出回复内容。
// 数据其实一直在库里 —— post.js 会把自己发出去的那条回复
// **也 upsert 进 comments 表**（cid = 原评论的 reply_cid），
// 只是视图层从来没有按 reply_cid 把它查回来。
// ═══════════════════════════════════════════════════════════
describe('数据层 / 已发出回复的正文可追溯', () => {
  it('已回复的评论带回回复正文与时间', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    addComment(cmts, 'v1', 'c1', '这个怎么做？', { replied: true, replyCid: 'r1' });
    // 模拟 post.js 的落库：我们发出的那条回复本身也是一行评论
    cmts.upsert({ cid: 'r1', awemeId: 'v1', uid: 'me', text: '看这里，步骤是……', createdAt: 1700000500 });

    const [c] = views.listComments('v1').items;
    expect(c.replied).toBe(true);
    expect(c.replyCid).toBe('r1');
    expect(c.replyText).toBe('看这里，步骤是……');
    // 抖音的时间字段是**秒**，交给界面之前必须归一成毫秒
    expect(c.replyAt).toBe(1700000500 * 1000);
  }));

  it('评论行被清掉时回退到语料库', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    addComment(cmts, 'v1', 'c1', 'x', { replied: true, replyCid: 'r1' });
    // 只入语料库，不入评论行 —— 模拟 cleanup 把回复那行清掉之后的状态
    require('../core/memory/corpus').append({
      srcCid: 'c1', replyText: '语料库里的那句', replyCid: 'r1', awemeId: 'v1', postedAt: 1700000600000,
    });

    const [c] = views.listComments('v1').items;
    expect(c.replyText).toBe('语料库里的那句');
  }));

  it('查不到就返回 null，而不是空字符串', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    // 有 replied 标记但没有 reply_cid（早期数据）
    cmts.upsert({ cid: 'c1', awemeId: 'v1', uid: 'u1', text: 'x' });
    require('../core/memory/db').getDb()
      .prepare("UPDATE comments SET replied = 1 WHERE cid = 'c1'").run();

    const [c] = views.listComments('v1').items;
    // 关键：必须是 null。空字符串会被界面读成"回过、但内容是空的"，
    // 那是另一回事 —— 界面据此显示"回复内容未记录"而不是一片空白。
    expect(c.replyText).toBeNull();
  }));

  it('单条详情也带回复正文', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    addComment(cmts, 'v1', 'c1', 'x', { replied: true, replyCid: 'r1' });
    cmts.upsert({ cid: 'r1', awemeId: 'v1', uid: 'me', text: '我回的那句', createdAt: 1700000500 });

    const d = views.commentDetail('c1');
    expect(d.replyText).toBe('我回的那句');
    expect(d.replyAt).toBe(1700000500 * 1000);
  }));

  it('草稿带上被回复评论的原文与作者 uid', withTempEnv({}, async ({ views, vids, cmts, drfs }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    addComment(cmts, 'v1', 'c1', '求个教程', { uid: 'u9' });
    const id = drfs.save({ awemeId: 'v1', text: '来了', replyToCid: 'c1' });

    const d = views.listDrafts().items.find(x => x.id === id);
    expect(d.replyToText).toBe('求个教程');
    // uid 是给发布用的：策略「同一用户每轮最多回复几条」只看 meta.uid，
    // 不带的话这条规则从草稿箱发布时不生效，而从工作台发布就生效
    expect(d.replyToUid).toBe('u9');
  }));

  it('getMany 批量取，且能跨越 SQLite 的参数批量上限', withTempEnv({}, async ({ cmts }) => {
    const cids = [];
    for (let i = 0; i < 900; i++) {
      const cid = `c${i}`;
      cids.push(cid);
      cmts.upsert({ cid, awemeId: 'v1', uid: 'u1', text: `t${i}` });
    }
    const map = cmts.getMany(cids);
    expect(map.size).toBe(900);
    expect(map.get('c899').text).toBe('t899');
    // 重复与空值不该让它出错
    expect(cmts.getMany(['c1', 'c1', null, '']).size).toBe(1);
    expect(cmts.getMany([]).size).toBe(0);
  }));

  it('总览的待回复口径与作品列表一致（都排掉我自己发的）', withTempEnv({}, async ({ views, vids, cmts }) => {
    // myUid 的判定依据就是「is_mine 的视频的 author_uid」，没有单独的 setter
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true, authorUid: 'me' });
    addComment(cmts, 'v1', 'c1', '别人的评论', { uid: 'u1' });
    addComment(cmts, 'v1', 'c2', '我自己的回复', { uid: 'me' });
    addComment(cmts, 'v1', 'c3', '已回过的', { uid: 'u1', replied: true, replyCid: 'r1' });

    const o = views.overview();
    // 3 条里：1 条是我的、1 条已回复 → 待回复只剩 1 条
    expect(o.total).toBeUndefined();
    expect(o.comments).toBe(3);
    expect(o.mine).toBe(1);
    expect(o.pending).toBe(1);
    expect(o.pending).toBe(views.videoDetail('v1').commentStats.pending);
  }));
});

// ═══════════════════════════════════════════════════════════
// analytics —— 数据分析页的全量聚合
// 口径必须与作品列表 / 工作台一致，否则"三个页面三个数"的老问题会复发
// ═══════════════════════════════════════════════════════════
describe('analytics 数据分析聚合', () => {
  it('空库返回全空集合，不报错', withTempEnv({}, async ({ views }) => {
    const a = views.analytics();
    expect(a.totals.videos).toBe(0);
    expect(a.videos).toEqual([]);
    expect(a.daily).toHaveLength(30);          // 时间轴照常补零
    expect(a.topComments).toEqual([]);
    expect(a.topUsers).toEqual([]);
  }));

  it('汇总作品互动数据并按视频展开', withTempEnv({}, async ({ views, vids, cmts }) => {
    // createTime 是秒（抖音 create_time 单位）：v2 更晚发布 → 排在前面
    vids.upsert({ awemeId: 'v1', title: '甲', isMine: true, createTime: 1700000000, playCount: 100, diggCount: 10, commentCount: 3, shareCount: 2 });
    vids.upsert({ awemeId: 'v2', title: '乙', isMine: true, createTime: 1700100000, playCount: 50, diggCount: 5, commentCount: 1, shareCount: 1 });
    addComment(cmts, 'v1', 'c1', '好');

    const a = views.analytics();
    expect(a.totals).toMatchObject({ videos: 2, plays: 150, likes: 15, apiComments: 4, shares: 3 });
    expect(a.videos).toHaveLength(2);
    // 按发布时间倒序：v2 在前
    expect(a.videos[0].awemeId).toBe('v2');
    expect(a.videos[1].stats).toMatchObject({ plays: 100 });
    expect(a.videos[1].commentStats.total).toBe(1);
  }));

  it('回复进度与判定分布的口径：我发的评论不进待回复，判定统计每行', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true, authorUid: 'me123' });
    // 别人的提问 → 建议回复，未回
    addComment(cmts, 'v1', 'q1', '地址在哪？', { uid: 'someone' });
    // 我发出的回复（uid=me）—— 不算待回复，也不进每日分布/榜单
    addComment(cmts, 'v1', 'my-reply', '在置顶', { uid: 'me123', parentCid: 'q1' });
    // 别人的已回复
    addComment(cmts, 'v1', 'done1', '哈哈哈', { uid: 'someone2', replied: true });
    // 别人的寒暄 → 跳过
    addComment(cmts, 'v1', 'skip1', '哈哈哈哈哈', { uid: 'someone3' });

    const a = views.analytics();
    // 4 条本地评论：1 条我发的，1 条已回复 → 待回复 2
    expect(a.totals.localComments).toBe(4);
    expect(a.totals.replied).toBe(1);
    expect(a.totals.pending).toBe(2);
    // 判定分布对每一行（与工作台三个标签页同口径）
    expect(a.decision.reply).toBeGreaterThanOrEqual(1);
    // 每日分布只统计评论者的原评论：my-reply 那天不能多出一条
    const withCount = a.daily.filter(d => d.count > 0);
    expect(withCount.reduce((s, d) => s + d.count, 0)).toBe(3);
    // 活跃用户不含我自己
    expect(a.topUsers.map(u => u.uid)).not.toContain('me123');
  }));

  it('高赞评论按 digg 排序并带昵称', withTempEnv({}, async ({ views, vids, cmts, usrs }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    usrs.upsert({ uid: 'ua', nickname: '甲用户', seenAt: Date.now() });
    addComment(cmts, 'v1', 'low', '普通的', { uid: 'ua', digg: 1 });
    addComment(cmts, 'v1', 'high', '热评', { uid: 'ua', digg: 99 });
    addComment(cmts, 'v1', 'mid', '中间', { uid: 'ub', digg: 40 });

    const a = views.analytics();
    expect(a.topComments.map(c => c.cid)).toEqual(['high', 'mid', 'low']);
    expect(a.topComments[0].nickname).toBe('甲用户');
    expect(a.topUsers[0]).toMatchObject({ uid: 'ua', count: 2 });
  }));

  it('每日时间轴补零且覆盖最近 N 天', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    // 三天前的一条评论
    addComment(cmts, 'v1', 'old', '三天前', { createdAt: Date.now() - 3 * 86400 * 1000 });

    const a = views.analytics({ dayWindow: 7 });
    expect(a.daily).toHaveLength(7);
    const hit = a.daily.filter(d => d.count > 0);
    expect(hit).toHaveLength(1);
    expect(hit[0].count).toBe(1);
  }));
});

// ═══════════════════════════════════════════════════════════
// 运营对象（listTargets）
//
// 回归背景：这个工具的实际打法是在**别人的**视频评论区互动引流，而工作台
// 此前唯一的入口是「我的作品」（只列 is_mine=1）。实测某台机器上 215 个视频里
// 只有 7 个是自己的、1850 条评论（96%）落在别人那边 —— 真正在运营的东西
// 在界面上不可达。
// ═══════════════════════════════════════════════════════════
describe('运营对象 listTargets', () => {
  it('只列别人的视频，且必须有本地评论', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'mine', title: '我的', isMine: true });
    addComment(cmts, 'mine', 'c0', '我作品下的评论');
    // 别人的视频、有评论 → 运营对象
    vids.upsert({ awemeId: 'other1' });            // get/post 建出来的壳：无标题
    addComment(cmts, 'other1', 'c1', '别人的视频下的评论');
    // 别人的视频、但没有评论 → 只是抓取留下的痕迹，不是运营对象
    vids.upsert({ awemeId: 'other2' });

    const t = views.listTargets();
    expect(t.items.map(i => i.awemeId)).toEqual(['other1']);
    expect(t.total).toBe(1);
  }));

  it('待回复不把我自己发的算进去（与工作台同口径）', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'mine', isMine: true, authorUid: 'me123' });
    vids.upsert({ awemeId: 'other' });
    addComment(cmts, 'other', 'q1', '这个怎么做的？', { uid: 'someone' });
    addComment(cmts, 'other', 'my1', '我发出的回复', { uid: 'me123' });
    addComment(cmts, 'other', 'done1', '已回过的', { uid: 'someone2', replied: true });

    const [it] = views.listTargets().items;
    expect(it.commentStats).toMatchObject({ total: 3, replied: 1, mine: 1, pending: 1 });
    // 同一个数字必须与工作台那一侧一致 —— 两处口径分叉会让人以为数据错了
    expect(it.commentStats.pending).toBe(views.videoStats('other').pending);
  }));

  it('默认按待回复降序排，可切排序方式', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'a' });
    vids.upsert({ awemeId: 'b' });
    // a：3 条待回复；b：1 条待回复，但总评论 4 条更多
    addComment(cmts, 'a', 'a1', '问题一');
    addComment(cmts, 'a', 'a2', '问题二');
    addComment(cmts, 'a', 'a3', '问题三');
    addComment(cmts, 'b', 'b1', '问题');
    addComment(cmts, 'b', 'b2', '已回', { replied: true });
    addComment(cmts, 'b', 'b3', '已回二', { replied: true });
    addComment(cmts, 'b', 'b4', '已回三', { replied: true });

    expect(views.listTargets().items.map(i => i.awemeId)).toEqual(['a', 'b']);
    // 按评论数排时 b（3 条）在前
    expect(views.listTargets({ order: 'comments' }).items.map(i => i.awemeId)).toEqual(['b', 'a']);
  }));

  it('未知排序退回默认，而不是返回空列表', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'a' });
    addComment(cmts, 'a', 'a1', '问题');
    const t = views.listTargets({ order: 'typo' });
    expect(t.order).toBe('pending');
    expect(t.items).toHaveLength(1);
    // 退回之外不再多给一个 unknownOrder 字段：排序下拉的取值全部来自下面的 orders，
    // 那个字段既递不上去也没人显示，留着只会让人以为界面说明了这件事
    expect(t).not.toHaveProperty('unknownOrder');
  }));

  it('头部信息给全：扫描上限、缺标题的数量、可选排序由 core 提供', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'a' });
    addComment(cmts, 'a', 'a1', '问题');
    vids.upsert({ awemeId: 'b' });   // 无评论也无标题

    const t = views.listTargets();
    expect(t.scanLimit).toBe(views.TARGET_SCAN_LIMIT);
    expect(t.scanCapped).toBe(false);
    // a 与 b 都没有标题 → 界面据此显示「补全视频信息」入口
    expect(t.missingInfoCount).toBe(2);
    expect(t.orders).toBe(views.TARGET_ORDERS);
    expect(t.orders.map(o => o.name)).toContain(t.order);
  }));
});

// ═══════════════════════════════════════════════════════════
// 统计口径（scope）
//
// 默认必须是 all：只算自己的作品等于只分析 3% 的业务
// ═══════════════════════════════════════════════════════════
describe('analytics / overview 的统计范围', () => {
  it('默认统计全部视频，含别人的', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'mine', isMine: true });
    addComment(cmts, 'mine', 'm1', '我作品下的');
    vids.upsert({ awemeId: 'other' });
    addComment(cmts, 'other', 'o1', '别人视频下的');

    const a = views.analytics();
    expect(a.scope).toBe('all');
    expect(a.scopeCounts).toEqual({ all: 2, mine: 1 });
    expect(a.totals.videos).toBe(2);
    expect(a.totals.localComments).toBe(2);
  }));

  it('scope=mine 只算自己的作品', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'mine', isMine: true });
    addComment(cmts, 'mine', 'm1', '我作品下的');
    vids.upsert({ awemeId: 'other' });
    addComment(cmts, 'other', 'o1', '别人视频下的');

    const a = views.analytics({ scope: 'mine' });
    expect(a.scope).toBe('mine');
    expect(a.totals.videos).toBe(1);
    expect(a.totals.localComments).toBe(1);
    // scopeCounts 始终给两个数 —— 界面的切换按钮要靠它标数字
    expect(a.scopeCounts).toEqual({ all: 2, mine: 1 });
  }));

  it('未知 scope 一律退回 all', withTempEnv({}, async ({ views }) => {
    expect(views.analytics({ scope: 'typo' }).scope).toBe('all');
    expect(views._normScope(undefined)).toBe('all');
    expect(views._normScope('mine')).toBe('mine');
  }));

  it('statsWithData 只数真有互动数据的视频（0 次播放算有数据）', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'a', title: '甲', isMine: true, playCount: 0, diggCount: 0 });
    vids.upsert({ awemeId: 'b', title: '乙', isMine: true, playCount: 100 });
    vids.upsert({ awemeId: 'c' });                       // 从没拉到过
    addComment(cmts, 'c', 'c1', '评论');

    const a = views.analytics();
    expect(a.totals.videos).toBe(3);
    expect(a.totals.statsWithData).toBe(2);
    // 逐视频的标记同理：界面的作品对比图靠它把"没拉过"的排除掉
    const byId = Object.fromEntries(a.videos.map(v => [v.awemeId, v.hasStats]));
    expect(byId).toEqual({ a: true, b: true, c: false });
  }));

  it('overview 同样吃 scope', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'mine', isMine: true });
    addComment(cmts, 'mine', 'm1', '一');
    vids.upsert({ awemeId: 'other' });
    addComment(cmts, 'other', 'o1', '二');

    expect(views.overview()).toMatchObject({ scope: 'all', comments: 2 });
    expect(views.overview({ scope: 'mine' })).toMatchObject({ scope: 'mine', comments: 1 });
  }));
});

// ═══════════════════════════════════════════════════════════
// videoMyUid —— "这条视频下哪个 uid 算是我"
//
// 回归背景：user.js 会给抓来的作品写 authorUid + isMine:false。
// 若只看 authorUid 非空就当"我"，视频作者在自己评论区发的评论会被判定成
// "我发的" —— 从待处理里消失、还被标成已回复。
// ═══════════════════════════════════════════════════════════
describe('videoMyUid 的归属判定', () => {
  it('别人的视频：作者 uid 不能当成我', withTempEnv({}, async ({ views, vids }) => {
    // 我的一个作品，用来确立全局 myUid = me123
    vids.upsert({ awemeId: 'mine', isMine: true, authorUid: 'me123' });
    // 别人的视频，作者是 author999（user.js 就是这么写的）
    vids.upsert({ awemeId: 'other', isMine: false, authorUid: 'author999' });

    expect(views.videoMyUid('other')).toBe('me123');
    expect(views.videoMyUid('mine')).toBe('me123');
  }));

  it('别人的视频里，作者的评论仍是待回复', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'mine', isMine: true, authorUid: 'me123' });
    vids.upsert({ awemeId: 'other', isMine: false, authorUid: 'author999' });
    // 视频作者自己在自己评论区发了一条 —— 对"我"来说这是路人，要回
    addComment(cmts, 'other', 'by-author', '谢谢大家支持', { uid: 'author999' });
    addComment(cmts, 'other', 'by-me', '我发的回复', { uid: 'me123' });

    const s = views.videoStats('other');
    expect(s.mine).toBe(1);
    expect(s.pending).toBe(1);

    // 列表侧的「待处理」也要把它留着，不能因为 uid 与 author_uid 相同就漏掉
    const list = views.listComments('other', { filter: 'pending' });
    expect(list.items.map(i => i.cid)).toEqual(['by-author']);
  }));

  it('我自己的作品：归属账号优先于全局 myUid（多账号不串号）', withTempEnv({}, async ({ views, vids }) => {
    // 两个号，作品数是 me123 多 → 全局 myUid = me123
    vids.upsert({ awemeId: 'v1', isMine: true, authorUid: 'me123' });
    vids.upsert({ awemeId: 'v2', isMine: true, authorUid: 'me123' });
    vids.upsert({ awemeId: 'v3', isMine: true, authorUid: 'me456' });

    expect(views.videoMyUid('v3')).toBe('me456');
  }));
});

// ═══════════════════════════════════════════════════════════
// statsForVideos —— 批量版必须与单条版逐字一致
// ═══════════════════════════════════════════════════════════
describe('statsForVideos 与 statsForVideo 口径一致', () => {
  it('同一批数据批量算与逐条算完全相同', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'mine123', isMine: true, authorUid: 'me123' });
    vids.upsert({ awemeId: 'a' });
    vids.upsert({ awemeId: 'b' });
    addComment(cmts, 'a', 'a1', '问题一', { uid: 'u1' });
    addComment(cmts, 'a', 'a2', '我发的', { uid: 'me123' });
    addComment(cmts, 'a', 'a3', '已回', { uid: 'u2', replied: true });
    addComment(cmts, 'b', 'b1', '问题', { uid: 'u3' });

    const map = cmts.statsForVideos(['a', 'b'], { excludeUid: 'me123' });
    for (const id of ['a', 'b']) {
      expect(map.get(id)).toEqual(cmts.statsForVideo(id, { excludeUid: 'me123' }));
    }
    expect(map.get('a')).toMatchObject({ total: 3, mine: 1, replied: 1, pending: 1 });

    // 一条评论都没有的视频**不在 Map 里**（不是"统计为 0"）——
    // 调用方要自己用空形状兜底，listTargets 就是这么做的
    expect(map.has('empty')).toBe(false);
    expect(views.listTargets().items.every(i => i.commentStats.total > 0)).toBe(true);
  }));
});

// ═══════════════════════════════════════════════════════════
// 列表的「共 N 条」必须与列表内容同一口径
//
// 回归背景：「待处理」把"我自己发出的回复"从列表里滤掉了，但 total 走的是
// SQL 计数、不排自己 —— 工作台上就出现「共 99 条 · 当前显示 95 条」，
// 而同一屏顶部的「待回 95」又是排过的。三个数字两种口径。
// ═══════════════════════════════════════════════════════════
describe('评论列表的总数与截断', () => {
  it('待处理的 total 排掉我自己的评论，与列表长度、与工作台计数一致', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'mine', isMine: true, authorUid: 'me123' });
    vids.upsert({ awemeId: 'other' });
    addComment(cmts, 'other', 'q1', '问题一', { uid: 'u1' });
    addComment(cmts, 'other', 'q2', '问题二', { uid: 'u2' });
    addComment(cmts, 'other', 'mine1', '我发出的回复', { uid: 'me123' });
    addComment(cmts, 'other', 'mine2', '我发出的回复二', { uid: 'me123' });
    addComment(cmts, 'other', 'done1', '已回的', { uid: 'u3', replied: true });

    const r = views.listComments('other', { filter: 'pending' });
    expect(r.total).toBe(2);
    expect(r.shown).toBe(2);
    expect(r.items.map(i => i.cid).sort()).toEqual(['q1', 'q2']);
    // 与工作台头部那个「待回 N」是同一个数
    expect(r.total).toBe(views.videoStats('other').pending);
  }));

  it('截断按真实总数判定，而不是拿"我取了 limit 条"去比', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'mine', isMine: true, authorUid: 'me123' });
    vids.upsert({ awemeId: 'other' });
    for (let i = 0; i < 5; i++) addComment(cmts, 'other', `c${i}`, `问题${i}`, { uid: `u${i}` });

    const r = views.listComments('other', { filter: 'pending', limit: 2 });
    // 库里 5 条待处理，只取了 2 条 —— 必须说出来还有更多
    expect(r.total).toBe(5);
    expect(r.shown).toBe(2);
    expect(r.truncated).toBe(true);

    // 取满时不该谎报截断
    const full = views.listComments('other', { filter: 'pending', limit: 5 });
    expect(full.truncated).toBe(false);
  }));

  it('无需内存筛选的标签页仍走精确计数', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    addComment(cmts, 'v1', 'a', '一');
    addComment(cmts, 'v1', 'b', '二');
    addComment(cmts, 'v1', 'c', '三', { replied: true });

    expect(views.listComments('v1').total).toBe(3);
    expect(views.listComments('v1', { filter: 'replied' }).total).toBe(1);
    expect(views.listComments('v1', { filter: 'pending' }).total).toBe(2);
  }));

  it('搜索时总数与列表同一条件（昵称也算命中）', withTempEnv({}, async ({ views, vids, cmts, usrs }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    usrs.upsert({ uid: 'ux', nickname: '找我的张三', seenAt: Date.now() });
    addComment(cmts, 'v1', 'c1', '正文里有关键词', { uid: 'u1' });
    addComment(cmts, 'v1', 'c2', '无关内容', { uid: 'ux' });

    expect(views.listComments('v1', { search: '关键词' }).total).toBe(1);
    // 昵称命中：总数不能只数正文，否则「共 1 条」而列表里有 2 条
    expect(views.listComments('v1', { search: '张三' }).total).toBe(1);
  }));
});

// ═══════════════════════════════════════════════════════════
// 运营成本与效果（analytics 的 llm / ops / failures / replyEffect）
//
// 这四块**不吃 scope** —— 它们是"我干了什么"，与"统计哪些视频"无关。
// 但它们吃**时间范围**（失败模式库除外，见下）。
// ═══════════════════════════════════════════════════════════
describe('analytics 的运营成本与效果', () => {
  it('range 跟着 dayWindow 走，并被夹到 1–365 天', withTempEnv({}, async ({ views }) => {
    expect(views.analytics({ dayWindow: 7 }).range.dayWindow).toBe(7);
    expect(views.analytics({ dayWindow: 90 }).range.dayWindow).toBe(90);
    // 越界与非法值都要被夹住，而不是原样传下去（一个 100000 天的图没法看）
    expect(views.analytics({ dayWindow: 0 }).range.dayWindow).toBe(30);
    expect(views.analytics({ dayWindow: -5 }).range.dayWindow).toBe(1);
    expect(views.analytics({ dayWindow: 9999 }).range.dayWindow).toBe(365);
    expect(views.analytics({ dayWindow: 'abc' }).range.dayWindow).toBe(30);
  }));

  it('ops 按时间范围统计，成功率不含 running', withTempEnv({}, async ({ views, evts }) => {
    const now = Date.now();
    const old = now - 40 * 86400000;
    // 最近：2 次成功 + 1 次失败
    evts.append({ ts: now, command: 'post', status: 'success', durationMs: 1000 });
    evts.append({ ts: now, command: 'post', status: 'success', durationMs: 3000 });
    evts.append({ ts: now, command: 'post', status: 'error', durationMs: 500 });
    // 40 天前：不在 7/30 天范围内
    evts.append({ ts: old, command: 'get', status: 'error', durationMs: 100 });

    const a7 = views.analytics({ dayWindow: 7 });
    const post = a7.ops.byCommand.find(c => c.command === 'post');
    expect(post).toMatchObject({ total: 3, errors: 1, ok: 2, avgMs: 1500 });
    expect(post.successRate).toBeCloseTo(2 / 3);
    expect(a7.ops.byCommand.find(c => c.command === 'get')).toBeUndefined();

    // 90 天范围里，那条 40 天前的失败才出现
    const a90 = views.analytics({ dayWindow: 90 });
    expect(a90.ops.byCommand.find(c => c.command === 'get')).toMatchObject({ total: 1, errors: 1 });
  }));

  it('ops 里一次都没跑过的命令不出现（而不是成功率 0%）', withTempEnv({}, async ({ views }) => {
    const a = views.analytics();
    expect(a.ops.total).toBe(0);
    expect(a.ops.byCommand).toEqual([]);
  }));

  it('llm 汇总调用次数/Token/成本，并给出单次平均耗时', withTempEnv({}, async ({ views, llm }) => {
    llm.log({ model: 'mimo-v2.5', purpose: 'getReply_reply', promptTokens: 100, completionTokens: 50, totalTokens: 150, durationMs: 8000 });
    llm.log({ model: 'mimo-v2.5', purpose: 'getReply_reply', promptTokens: 200, completionTokens: 60, totalTokens: 260, durationMs: 12000 });

    const a = views.analytics();
    expect(a.llm.calls).toBe(2);
    expect(a.llm.tokens).toBe(410);
    expect(a.llm.avgMs).toBe(10000);
    expect(a.llm.byPurpose).toHaveLength(1);
    expect(a.llm.byPurpose[0]).toMatchObject({ purpose: 'getReply_reply', calls: 2, tokens: 410 });
    // 成本按模型单价估算，正数即可（单价表在 llm-usage.js 里，不在这里复述）
    expect(a.llm.cost).toBeGreaterThan(0);
  }));

  it('回复效果：二次互动的分母是"能判定先后的那些"', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true, authorUid: 'me' });
    // ⚠️ created_at 是**抖音的秒**（epoch seconds），不是毫秒也不是序号 ——
    // 用 900/1000 这种小数字造数据，会被 since 过滤掉，测试就变成"永远通过"了
    const now = Math.floor(Date.now() / 1000);
    // 对方的评论，我们回过了
    addComment(cmts, 'v1', 'q1', '问题一', { uid: 'u1', createdAt: now - 1000, replied: true, replyCid: 'r1' });
    // 我们发出的那条回复
    cmts.upsert({ cid: 'r1', awemeId: 'v1', uid: 'me', text: '答复', createdAt: now - 900, parentCid: 'q1' });
    // 对方后来又来了（比我们回复晚）
    addComment(cmts, 'v1', 'q2', '又来一条', { uid: 'u1', createdAt: now - 500 });
    // 另一个我们回过的，对方没再来
    addComment(cmts, 'v1', 'q3', '问题三', { uid: 'u2', createdAt: now - 1000, replied: true, replyCid: 'r2' });
    cmts.upsert({ cid: 'r2', awemeId: 'v1', uid: 'me', text: '答复二', createdAt: now - 900, parentCid: 'q3' });

    const e = views.analytics().replyEffect;
    expect(e.replied).toBe(2);
    expect(e.withTime).toBe(2);
    expect(e.second).toBe(1);
    expect(e.secondRate).toBeCloseTo(0.5);
  }));

  it('回复效果好几年以前发出的不计入（时间范围过滤用的是我们回复的时间）', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true, authorUid: 'me' });
    const now = Math.floor(Date.now() / 1000);
    addComment(cmts, 'v1', 'old', '很久以前的问题', { uid: 'u1', replied: true, replyCid: 'rold' });
    cmts.upsert({ cid: 'rold', awemeId: 'v1', uid: 'me', text: '答复', createdAt: now - 200 * 86400, parentCid: 'old' });

    expect(views.analytics({ dayWindow: 7 }).replyEffect.replied).toBe(0);
    expect(views.analytics({ dayWindow: 90 }).replyEffect.replied).toBe(0);
    expect(views.analytics({ dayWindow: 365 }).replyEffect.replied).toBe(1);
  }));

  it('回复没有时间戳时不计入二次互动，但仍在"已回复"里', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true, authorUid: 'me' });
    // 故意不给 createdAt：这是早期数据的形状
    addComment(cmts, 'v1', 'q1', '问题', { uid: 'u1', replied: true, replyCid: 'r1' });
    cmts.upsert({ cid: 'r1', awemeId: 'v1', uid: 'me', text: '答复' });

    const e = views.analytics().replyEffect;
    expect(e.replied).toBe(1);
    expect(e.withTime).toBe(0);
    // 分母为 0 时给 null，而不是给 0% —— "无法判断"和"确定没有"是两回事
    expect(e.secondRate).toBeNull();
  }));

  it('失败模式是累计值，不随时间范围变', withTempEnv({}, async ({ views, fails }) => {
    fails.record('status_code=2055');
    fails.record('status_code=2055');
    fails.record({ status_code: 8 });

    const a7 = views.analytics({ dayWindow: 7 });
    const a90 = views.analytics({ dayWindow: 90 });
    expect(a7.failures.map(f => f.signature)).toEqual(a90.failures.map(f => f.signature));
    expect(a7.failures[0]).toMatchObject({ signature: 'status_code=2055', hitCount: 2 });
  }));
});

// ═══════════════════════════════════════════════════════════
// 播放历史快照（schema v12）
//
// 回归背景：videos.play_count 是单值列，每次刷新被覆盖，于是"这条一周涨了
// 多少播放"永远答不出来。v12 起按天落一行快照。
// ═══════════════════════════════════════════════════════════
describe('互动数据的历史快照', () => {
  const day = (offset) => Date.now() - offset * 86400000;

  it('写统计数时自动落一行；同一天再写覆盖成最新读数', withTempEnv({}, async ({ vids }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true, playCount: 100, diggCount: 1 });
    expect(vids.listStatsHistory({ awemeId: 'v1' })).toHaveLength(1);
    expect(vids.listStatsHistory({ awemeId: 'v1' })[0]).toMatchObject({ plays: 100, likes: 1 });

    // 同一数值再写一次：不该产生第二行（刷新列表是常态操作）
    vids.upsert({ awemeId: 'v1', playCount: 100, diggCount: 1 });
    expect(vids.listStatsHistory({ awemeId: 'v1' })).toHaveLength(1);

    // 数值变了：同一天仍然只有一行，值是新的
    vids.upsert({ awemeId: 'v1', playCount: 250, diggCount: 3 });
    const rows = vids.listStatsHistory({ awemeId: 'v1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ plays: 250, likes: 3 });
  }));

  it('只有 id 的 upsert（markGet/markPost）不留空行', withTempEnv({}, async ({ vids }) => {
    vids.markGet('shell');            // 拉评论时顺手建出来的壳
    vids.markPost('shell');
    expect(vids.listStatsHistory({ awemeId: 'shell' })).toEqual([]);
  }));

  it('快照记的是库里生效的值，不是本次传入的字段', withTempEnv({}, async ({ vids }) => {
    vids.upsert({ awemeId: 'v1', isMine: true, playCount: 500, diggCount: 10 });
    // 这次只传 digg（upsert 用 COALESCE 保留 play_count）——
    // 快照若拿入参去记，play_count 会被记成 NULL
    vids.upsert({ awemeId: 'v1', diggCount: 20 });
    const last = vids.listStatsHistory({ awemeId: 'v1' }).pop();
    expect(last).toMatchObject({ plays: 500, likes: 20 });
  }));

  it('按天分行：不同日期是不同行', withTempEnv({}, async ({ vids }) => {
    vids.upsert({ awemeId: 'v1', isMine: true, playCount: 100 });
    vids.snapshotStats('v1', day(3));
    vids.upsert({ awemeId: 'v1', playCount: 400 });
    vids.snapshotStats('v1', day(1));
    vids.upsert({ awemeId: 'v1', playCount: 700 });

    const rows = vids.listStatsHistory({ awemeId: 'v1' });
    // 3 天前、1 天前、今天 —— 三行，按 day 升序
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.plays)).toEqual([100, 400, 700]);
    expect(rows[0].day < rows[1].day).toBe(true);
  }));

  it('buildGrowth：按天汇总 + 逐视频增量；只有一天快照给 null 而不是 0', withTempEnv({}, async ({ views, vids }) => {
    vids.upsert({ awemeId: 'a', title: '甲', isMine: true, playCount: 100 });
    vids.snapshotStats('a', day(3));
    vids.upsert({ awemeId: 'a', playCount: 900 });      // 今天
    vids.upsert({ awemeId: 'b', title: '乙', isMine: true, playCount: 50 });
    vids.snapshotStats('b', day(3));
    vids.upsert({ awemeId: 'b', playCount: 80 });       // 今天
    // c 只有今天一条 → 增量给不出
    vids.upsert({ awemeId: 'c', title: '丙', isMine: true, playCount: 5 });

    const g = views.analytics({ dayWindow: 7 }).growth;
    expect(g.covered).toBe(3);
    // 有两个不同日期
    expect(g.daily).toHaveLength(2);
    expect(g.daily.map(d => d.day)).toEqual([...g.daily.map(d => d.day)].sort());
    // 最后一天的总播放 = 900 + 80 + 5
    expect(g.daily[g.daily.length - 1]).toMatchObject({ plays: 985, videos: 3 });

    const byId = Object.fromEntries(g.perVideo.map(p => [p.awemeId, p]));
    expect(byId.a).toMatchObject({ plays: 900, playsDelta: 800 });
    expect(byId.b).toMatchObject({ plays: 80, playsDelta: 30 });
    // ⚠️ 只有一天快照 → null（"没有两次读数可比"），不是 0（"一点没涨"）
    expect(byId.c.playsDelta).toBeNull();
    // 排序：涨得多的在前，null 排最后
    expect(g.perVideo[0].awemeId).toBe('a');
  }));

  it('buildGrowth 吃 scope：仅我的只算自己的作品', withTempEnv({}, async ({ views, vids }) => {
    vids.upsert({ awemeId: 'mine', title: '我的', isMine: true, playCount: 10 });
    vids.snapshotStats('mine', day(2));
    vids.upsert({ awemeId: 'mine', playCount: 30 });
    vids.upsert({ awemeId: 'other', title: '别人的', isMine: false, playCount: 100 });
    vids.snapshotStats('other', day(2));
    vids.upsert({ awemeId: 'other', playCount: 200 });

    expect(views.analytics({ scope: 'all' }).growth.covered).toBe(2);
    expect(views.analytics({ scope: 'mine' }).growth.covered).toBe(1);
    expect(views.analytics({ scope: 'mine' }).growth.perVideo[0].awemeId).toBe('mine');
  }));

  it('没有快照时返回空集，不报错（升级前就是这个状态）', withTempEnv({}, async ({ views }) => {
    const g = views.analytics().growth;
    expect(g).toEqual({ daily: [], perVideo: [], covered: 0, totalDays: 0 });
  }));
});

// ═══════════════════════════════════════════════════════════
// 账号级数据隔离
//
// 回归背景：应用里没有"当前账号"这个概念 —— `is_mine=1` 只说"本机某个登录
// 账号的作品"，不区分是哪个号；所有"我"的判断都落到 videos.myUid()
// （"is_mine 里 author_uid 出现最多的那个"）这个全局猜测上。
// 症状：在浏览器里换了号、刷新列表，作品列表一点都不变。
// ═══════════════════════════════════════════════════════════
describe('账号级数据隔离', () => {
  it('我的作品只列当前账号的，不混别的号', withTempEnv({}, async ({ views, vids }) => {
    vids.upsert({ awemeId: 'A1', title: '甲号的作品一', isMine: true, authorUid: 'uidA' });
    vids.upsert({ awemeId: 'A2', title: '甲号的作品二', isMine: true, authorUid: 'uidA' });
    vids.upsert({ awemeId: 'B1', title: '乙号的作品', isMine: true, authorUid: 'uidB' });

    expect(views.listMyVideos({ accountUid: 'uidA' }).map(v => v.awemeId)).toEqual(['A1', 'A2']);
    expect(views.listMyVideos({ accountUid: 'uidB' }).map(v => v.awemeId)).toEqual(['B1']);
    expect(vids.count({ isMine: true, accountUid: 'uidA' })).toBe(2);
    expect(vids.count({ isMine: true, accountUid: 'uidB' })).toBe(1);
    // 不传账号（解析不出来）时退回旧口径：全部列出 —— 由 accountCertain 提示，
    // 而不是拿一个猜测去过滤、把另一个号的数据藏起来
    expect(views.listMyVideos().length).toBe(3);
  }));

  it('运营对象按 ops_uid 隔离：乙号看不到甲号运营的视频', withTempEnv({}, async ({ views, vids, cmts }) => {
    // 别人的视频，是甲号拉取/运营的
    vids.upsert({ awemeId: 'other', opsUid: 'uidA' });
    addComment(cmts, 'other', 'c1', '别人的视频下的评论');

    expect(views.listTargets({ accountUid: 'uidA' }).items.map(i => i.awemeId)).toEqual(['other']);
    expect(views.listTargets({ accountUid: 'uidB' }).items).toEqual([]);
    // 列表里带上归属账号，界面要显示它
    expect(views.listTargets({ accountUid: 'uidA' }).accountUid).toBe('uidA');
  }));

  it('草稿按账号隔离：换号之后看不到别的号准备的回复', withTempEnv({}, async ({ views, vids, drfs }) => {
    vids.upsert({ awemeId: 'v1', isMine: true, authorUid: 'uidA' });
    drfs.save({ awemeId: 'v1', text: '甲号准备的回复', accountUid: 'uidA' });
    drfs.save({ awemeId: 'v1', text: '乙号准备的回复', accountUid: 'uidB' });

    const a = views.listDrafts({ accountUid: 'uidA' });
    expect(a.items.map(d => d.text)).toEqual(['甲号准备的回复']);
    expect(a.total).toBe(1);
    expect(views.listDrafts({ accountUid: 'uidB' }).items.map(d => d.text)).toEqual(['乙号准备的回复']);
  }));

  it('别人的视频里，"我"是当前账号而不是全局猜测', withTempEnv({}, async ({ views, vids, cmts }) => {
    // 两个号，甲号作品多 → 全局 myUid() 会猜 uidA
    vids.upsert({ awemeId: 'A1', isMine: true, authorUid: 'uidA' });
    vids.upsert({ awemeId: 'A2', isMine: true, authorUid: 'uidA' });
    vids.upsert({ awemeId: 'other', opsUid: 'uidB' });
    addComment(cmts, 'other', 'byA', '甲号发的', { uid: 'uidA' });
    addComment(cmts, 'other', 'byB', '乙号发的', { uid: 'uidB' });

    // 以乙号身份看：甲号那条是"路人评论"，该回；乙号自己那条不算待回复
    const s = views.videoStats('other', { accountUid: 'uidB' });
    expect(s.mine).toBe(1);
    expect(s.pending).toBe(1);

    // 以甲号身份看：反过来
    const s2 = views.videoStats('other', { accountUid: 'uidA' });
    expect(s2.mine).toBe(1);
    expect(s2.pending).toBe(1);

    // 待处理列表也一样：乙号看到的待处理是甲号那条
    const list = views.listComments('other', { filter: 'pending', accountUid: 'uidB' });
    expect(list.items.map(i => i.cid)).toEqual(['byA']);
  }));

  it('overview / analytics 的「仅我的」按账号算', withTempEnv({}, async ({ views, vids }) => {
    vids.upsert({ awemeId: 'A1', isMine: true, authorUid: 'uidA', playCount: 100 });
    vids.upsert({ awemeId: 'B1', isMine: true, authorUid: 'uidB', playCount: 5 });

    expect(views.overview({ scope: 'mine', accountUid: 'uidA' }).videos).toBe(1);
    expect(views.overview({ scope: 'mine', accountUid: 'uidB' }).videos).toBe(1);

    const a = views.analytics({ scope: 'mine', accountUid: 'uidA' });
    expect(a.totals.videos).toBe(1);
    expect(a.totals.plays).toBe(100);
    // 两个范围各有多少个视频，也要按账号算 —— 切换按钮上的数字靠它
    expect(a.scopeCounts.mine).toBe(1);

    const b = views.analytics({ scope: 'mine', accountUid: 'uidB' });
    expect(b.totals.plays).toBe(5);
  }));

  it('解析不出账号时不过滤，但如实标出 uncertain', withTempEnv({}, async ({ views, vids }) => {
    vids.upsert({ awemeId: 'A1', isMine: true, authorUid: 'uidA' });
    vids.upsert({ awemeId: 'B1', isMine: true, authorUid: 'uidB' });

    const r = views.listTargets();
    // 不传 accountUid 时列表不该被某个猜测过滤掉一半
    expect(r.accountCertain).toBe(false);
    expect(views.listMyVideos().length).toBe(2);
    expect(views.overview({ scope: 'mine' }).accountCertain).toBe(false);
  }));

  it('markGet / markPost 把操作账号写进 ops_uid', withTempEnv({}, async ({ vids }) => {
    vids.markGet('v1', { accountUid: 'uidA' });
    expect(vids.get('v1').opsUid).toBe('uidA');
    // 之后别的账号操作它，ops_uid 跟着换（"最近一次是谁在运营"）
    vids.markPost('v1', { accountUid: 'uidB' });
    expect(vids.get('v1').opsUid).toBe('uidB');
    // 不带账号的调用不会把它抹掉（拉评论的兼容路径）
    vids.markGet('v1', { commentsSeenDelta: 1 });
    expect(vids.get('v1').opsUid).toBe('uidB');
  }));
});

// ═══════════════════════════════════════════════════════════
// 当前账号的解析
// ═══════════════════════════════════════════════════════════
describe('accounts.resolveCurrent', () => {
  const withTempAccounts = (fn) => withTempEnv({}, async (ctx) => {
    const accounts = require('../core/memory/accounts');
    await fn({ accounts, ...ctx });
  });

  it('唯一在线账号 → 自动跟随（这就是"换号之后数据跟着变"）', withTempAccounts(async ({ accounts }) => {
    const ctx = { bridge: { status: async () => ({ connections: [{ alive: true, account: { uid: 'uidB' } }] }) } };
    const r = await accounts.resolveCurrent(ctx);
    expect(r).toMatchObject({ uid: 'uidB', source: 'bridge' });
  }));

  it('断开的连接不算在线（那是历史，不是现状）', withTempAccounts(async ({ accounts }) => {
    const ctx = { bridge: { status: async () => ({ connections: [{ alive: false, account: { uid: 'uidOld' } }] }) } };
    expect((await accounts.resolveCurrent(ctx)).uid).toBeNull();
  }));

  it('多开时用选定的那个；选定的已下线就用当前在线的', withTempAccounts(async ({ accounts }) => {
    accounts.upsert({ uid: 'uidA', nickname: '甲' });
    accounts.upsert({ uid: 'uidB', nickname: '乙' });
    expect(accounts.setCurrent('uidB')).toBe(true);

    const both = { bridge: { status: async () => ({ connections: [
      { alive: true, account: { uid: 'uidA' } },
      { alive: true, account: { uid: 'uidB' } },
    ] }) } };
    expect(await accounts.resolveCurrent(both)).toMatchObject({ uid: 'uidB', source: 'picked' });

    // 乙号的页面被关掉了 → 选定的那个不在线，退回在线的那个
    const onlyA = { bridge: { status: async () => ({ connections: [{ alive: true, account: { uid: 'uidA' } }] }) } };
    expect((await accounts.resolveCurrent(onlyA)).uid).toBe('uidA');
  }));

  it('显式指定优先于一切', withTempAccounts(async ({ accounts }) => {
    const ctx = { accountUid: 'uidX', bridge: { status: async () => ({ connections: [{ alive: true, account: { uid: 'uidA' } }] }) } };
    expect(await accounts.resolveCurrent(ctx)).toMatchObject({ uid: 'uidX', source: 'explicit' });
  }));

  it('没有在线连接（CLI 场景）时退回持久化选择', withTempAccounts(async ({ accounts }) => {
    accounts.upsert({ uid: 'uidA' });
    accounts.setCurrent('uidA');
    expect(await accounts.resolveCurrent({})).toMatchObject({ uid: 'uidA', source: 'stored' });
    expect(await accounts.resolveCurrent({ bridge: { status: async () => { throw new Error('服务没起'); } } }))
      .toMatchObject({ uid: 'uidA' });
  }));

  it('选一个名册里没有的号：如实返回 false，而不是静默什么都不发生', withTempAccounts(async ({ accounts }) => {
    expect(accounts.setCurrent('nobody')).toBe(false);
    expect(accounts.currentUid()).toBeNull();
  }));
});

// ═══════════════════════════════════════════════════════════
// targetStatus —— 「找视频」页区分「已收录 / 可加入」
// ═══════════════════════════════════════════════════════════
describe('targetStatus', () => {
  it('报出每条视频在库里的状态（含"是不是当前账号在运营"）', withTempEnv({}, async ({ views, vids, cmts }) => {
    vids.upsert({ awemeId: 'm1', title: '我的作品', isMine: true, authorUid: 'uidA' });
    addComment(cmts, 'm1', 'c1', '评论一');
    vids.upsert({ awemeId: 't1', title: '甲号在运营的', opsUid: 'uidA' });
    addComment(cmts, 't1', 'c2', '评论二');
    addComment(cmts, 't1', 'c3', '评论三');
    vids.upsert({ awemeId: 't2', title: '乙号在运营的', opsUid: 'uidB' });

    const st = views.targetStatus(['m1', 't1', 't2', 'missing'], { accountUid: 'uidA' });
    expect(st.m1).toMatchObject({ inLibrary: true, isMine: true, mineOfCurrent: true, commentCount: 1 });
    expect(st.t1).toMatchObject({ inLibrary: true, isMine: false, mineOfCurrent: true, commentCount: 2, pending: 2 });
    // 乙号运营的：在库里，但**不是当前账号**的 —— 界面据此不显示"去工作台"
    expect(st.t2).toMatchObject({ inLibrary: true, mineOfCurrent: false });
    // 完全没见过的：可加入
    expect(st.missing).toMatchObject({ inLibrary: false, mineOfCurrent: false, commentCount: 0 });
  }));

  it('空数组与空值不炸，返回空对象', withTempEnv({}, async ({ views }) => {
    expect(views.targetStatus([])).toEqual({});
    expect(views.targetStatus(null)).toEqual({});
    expect(views.targetStatus([null, '', undefined])).toEqual({});
  }));
});
