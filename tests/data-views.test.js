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

    const purge = () => {
      for (const m of ['../core/memory/db', '../core/memory/videos', '../core/memory/comments',
        '../core/memory/users', '../core/memory/drafts', '../core/data/views']) {
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
      await fn({ views, vids, cmts, usrs, drfs });
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

    const list = views.listDrafts();
    expect(list).toHaveLength(1);
    expect(list[0].videoTitle).toBe('视频标题');
    expect(list[0].text).toBe('这是一条草稿内容');
  }));

  it('已发布的草稿不再出现在待发列表', withTempEnv({}, async ({ views, vids, drfs }) => {
    vids.upsert({ awemeId: 'v1', title: 'T', isMine: true });
    const id = drfs.save({ awemeId: 'v1', text: '草稿内容一' });
    drfs.markPosted(id);
    expect(views.listDrafts()).toEqual([]);
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

    const d = views.listDrafts().find(x => x.id === id);
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
