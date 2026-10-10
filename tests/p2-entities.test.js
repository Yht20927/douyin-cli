// tests/p2-entities.test.js — v3 P2 实体表 + whois/note 测试
//
// 关键不变量：
// 1. comments.upsertMany 把同 cid 多次写入合并：first_seen 取早，last_seen 取晚
// 2. users.upsertMany 累加 commentDelta；comment_count 等于实际观察次数
// 3. videos.markGet/markPost 维护 last_get_ts / last_post_ts
// 4. cmdGet（测试中用 persistEntities 直接调）正确把原始评论树落到 users + comments
// 5. cmdWhois 输出 found / 评论列表 / my_replies
// 6. cmdNote 支持 --tier --tag --untag --notes --clear；非法 tier 抛错
// 7. comments.markReplied + setAnalysis 写入字段持久化

const fs = require('fs');
const path = require('path');
const os = require('os');

function withTempProject(fn) {
  return async () => {
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-p2-' + id + '-'));
    const origStorageEnv = process.env.DOUYIN_STORAGE_DIR;
    const origLogEnv = process.env.DOUYIN_LOG_DIR;
    const origCwd = process.cwd();
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    process.env.DOUYIN_LOG_DIR = path.join(tmp, 'logs');
    process.chdir(tmp);
    [
      '../lib/memory/db', '../lib/memory/events',
      '../lib/memory/users', '../lib/memory/comments', '../lib/memory/videos',
      '../lib/audit',
      '../lib/commands/get', '../lib/commands/whois', '../lib/commands/note',
      '../lib/commands/videos',
    ].forEach(m => {
      try { delete require.cache[require.resolve(m)]; } catch (e) {}
    });
    try {
      await fn(tmp);
    } finally {
      try { require('../lib/memory/db').closeDb(); } catch (e) { /* */ }
      process.chdir(origCwd);
      if (origStorageEnv == null) delete process.env.DOUYIN_STORAGE_DIR;
      else process.env.DOUYIN_STORAGE_DIR = origStorageEnv;
      if (origLogEnv == null) delete process.env.DOUYIN_LOG_DIR;
      else process.env.DOUYIN_LOG_DIR = origLogEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

describe('P2: comments repo', () => {
  it('upsertMany 合并同 cid：first_seen 取早，last_seen 取晚', withTempProject(async () => {
    const comments = require('../lib/memory/comments');
    comments.upsertMany([
      { cid: 'c1', awemeId: 'v1', uid: 'u1', text: 'hi', digg: 5, createdAt: 1700000, seenAt: 2_000_000 },
    ]);
    comments.upsertMany([
      { cid: 'c1', awemeId: 'v1', uid: 'u1', text: 'hi', digg: 7, createdAt: 1700000, seenAt: 1_000_000 },
    ]);
    const c = comments.get('c1');
    expect(c.firstSeen).toBe(1_000_000);
    expect(c.lastSeen).toBe(2_000_000);
    expect(c.digg).toBe(7); // COALESCE 覆盖（excluded 非 null）
    expect(c.textHash).toBeTruthy();
  }));

  it('markReplied 标记 replied + reply_cid', withTempProject(async () => {
    const comments = require('../lib/memory/comments');
    comments.upsert({ cid: 'src', awemeId: 'v1', uid: 'u1', text: 'q?' });
    expect(comments.markReplied('src', 'v1', 'mine')).toBe(true);
    const c = comments.get('src');
    expect(c.replied).toBe(true);
    expect(c.replyCid).toBe('mine');
  }));

  it('setAnalysis 写入 sentiment + priority', withTempProject(async () => {
    const comments = require('../lib/memory/comments');
    comments.upsert({ cid: 'c1', awemeId: 'v1', uid: 'u1', text: 'good' });
    comments.setAnalysis('c1', { sentiment: 'positive', priority: 4 });
    const c = comments.get('c1');
    expect(c.sentiment).toBe('positive');
    expect(c.priority).toBe(4);
  }));

  it('listByUid 按 created_at DESC 跨视频', withTempProject(async () => {
    const comments = require('../lib/memory/comments');
    comments.upsertMany([
      { cid: 'a', awemeId: 'v1', uid: 'u1', text: 'a', createdAt: 100 },
      { cid: 'b', awemeId: 'v2', uid: 'u1', text: 'b', createdAt: 300 },
      { cid: 'c', awemeId: 'v1', uid: 'u1', text: 'c', createdAt: 200 },
      { cid: 'd', awemeId: 'v1', uid: 'other', text: 'd', createdAt: 400 },
    ]);
    const list = comments.listByUid('u1');
    expect(list.map(c => c.cid)).toEqual(['b', 'c', 'a']);
  }));
});

describe('P2: users repo', () => {
  it('upsertMany 累加 commentDelta', withTempProject(async () => {
    const users = require('../lib/memory/users');
    users.upsertMany([
      { uid: 'u1', nickname: 'A', commentDelta: 1 },
      { uid: 'u1', nickname: 'A', commentDelta: 1 },
      { uid: 'u1', nickname: 'A', commentDelta: 1 },
    ]);
    const u = users.get('u1');
    expect(u.commentCount).toBe(3);
  }));

  it('setTier + addTag/removeTag', withTempProject(async () => {
    const users = require('../lib/memory/users');
    users.upsert({ uid: 'u1' });
    users.setTier('u1', 'vip');
    users.addTag('u1', '技术粉');
    users.addTag('u1', '常提问');
    users.addTag('u1', '技术粉'); // 去重
    users.removeTag('u1', '常提问');
    const u = users.get('u1');
    expect(u.tier).toBe('vip');
    expect(u.tags).toEqual(['技术粉']);
  }));
});

describe('P2: videos repo', () => {
  it('markGet 累加 totalCommentsSeen + 维护 last_get_ts', withTempProject(async () => {
    const videos = require('../lib/memory/videos');
    videos.markGet('v1', 5, 1000);
    videos.markGet('v1', 3, 2000);
    const v = videos.get('v1');
    expect(v.totalCommentsSeen).toBe(8);
    expect(v.lastGetTs).toBe(2000);
  }));

  it('markPost 维护 last_post_ts，is_mine 一旦 true 不回退', withTempProject(async () => {
    const videos = require('../lib/memory/videos');
    videos.upsert({ awemeId: 'v1', isMine: true, title: 'My Video' });
    videos.markPost('v1', 5000);
    videos.upsert({ awemeId: 'v1', isMine: false }); // 不应回退
    const v = videos.get('v1');
    expect(v.isMine).toBe(true);
    expect(v.title).toBe('My Video');
    expect(v.lastPostTs).toBe(5000);
  }));

  // ── 多账号：is_mine 归属（P3）──
  it('account 记下 is_mine 视频归属哪个号', withTempProject(async () => {
    const videos = require('../lib/memory/videos');
    videos.upsert({ awemeId: 'v1', isMine: true, title: 'A 的作品', account: 'ACC_A' });
    videos.upsert({ awemeId: 'v2', isMine: true, title: 'B 的作品', account: 'ACC_B' });
    expect(videos.get('v1').account).toBe('ACC_A');
    expect(videos.get('v2').account).toBe('ACC_B');
  }));

  it('后续不带 account 的观察（markGet）不会抹掉已有归属', withTempProject(async () => {
    const videos = require('../lib/memory/videos');
    videos.upsert({ awemeId: 'v1', isMine: true, account: 'ACC_A' });
    videos.markGet('v1', 5, 1000); // 别的号 get 到这条视频：不带 account
    expect(videos.get('v1').account).toBe('ACC_A');
    expect(videos.get('v1').isMine).toBe(true);
  }));

  it('list 可按 account 过滤（只列某号的作品）', withTempProject(async () => {
    const videos = require('../lib/memory/videos');
    videos.upsert({ awemeId: 'v1', isMine: true, account: 'ACC_A' });
    videos.upsert({ awemeId: 'v2', isMine: true, account: 'ACC_B' });
    videos.upsert({ awemeId: 'v3', isMine: true, account: 'ACC_A' });
    const a = videos.list({ isMine: true, account: 'ACC_A' });
    expect(a.map(v => v.awemeId).sort()).toEqual(['v1', 'v3']);
    expect(videos.list({ isMine: true, account: 'ACC_B' }).map(v => v.awemeId)).toEqual(['v2']);
    expect(videos.list({ isMine: true })).toHaveLength(3); // 不指定 = 全部账号
  }));
});

describe('P2: cmdGet.persistEntities', () => {
  it('原始评论树正确落到 users + comments', withTempProject(async () => {
    const { persistEntities } = require('../lib/commands/get');
    const users = require('../lib/memory/users');
    const comments = require('../lib/memory/comments');
    const raw = [
      {
        cid: 'top1', text: 'hello', digg_count: 10, create_time: 1700,
        user: { uid: 'uA', sec_uid: 'secA', nickname: 'Alice' },
        children: [
          { cid: 'rep1', text: 're1', digg_count: 1, create_time: 1701,
            user: { uid: 'uB', sec_uid: 'secB', nickname: 'Bob' } },
        ],
      },
      {
        cid: 'top2', text: 'world', digg_count: 5, create_time: 1702,
        user: { uid: 'uA', sec_uid: 'secA', nickname: 'Alice' },
      },
    ];
    persistEntities(raw, 'v1');
    expect(comments.count({ awemeId: 'v1' })).toBe(3);
    expect(users.get('uA').commentCount).toBe(2);
    expect(users.get('uB').commentCount).toBe(1);
    const rep = comments.get('rep1');
    expect(rep.parentCid).toBe('top1');
  }));
});

describe('P2: cmdWhois', () => {
  it('已知用户：输出评论列表 + my_replies', withTempProject(async () => {
    const cmdWhois = require('../lib/commands/whois');
    const { AuditLogger } = require('../lib/audit');
    const users = require('../lib/memory/users');
    const comments = require('../lib/memory/comments');

    users.upsert({ uid: 'u1', nickname: 'Alice' });
    users.setTier('u1', 'vip');
    users.addTag('u1', '种子');

    comments.upsert({ cid: 'c1', awemeId: 'v1', uid: 'u1', text: 'hi', createdAt: 1700 });
    comments.upsert({ cid: 'mine', awemeId: 'v1', uid: 'me', text: 'thanks', createdAt: 1701, parentCid: 'c1' });
    comments.markReplied('c1', 'v1', 'mine');

    const out = await cmdWhois({ audit: new AuditLogger() }, ['u1']);
    expect(out.found).toBe(true);
    expect(out.profile.tier).toBe('vip');
    expect(out.profile.tags).toContain('种子');
    expect(out.total_comments).toBe(1);
    expect(out.total_my_replies).toBe(1);
    expect(out.my_replies[0].cid).toBe('mine');
  }));

  it('未知用户：found=false 但不抛', withTempProject(async () => {
    const cmdWhois = require('../lib/commands/whois');
    const { AuditLogger } = require('../lib/audit');
    const out = await cmdWhois({ audit: new AuditLogger() }, ['unknown']);
    expect(out.found).toBe(false);
    expect(out.total_comments).toBe(0);
  }));
});

describe('P2: cmdNote', () => {
  it('--tier + --tag + --notes 同时生效', withTempProject(async () => {
    const cmdNote = require('../lib/commands/note');
    const { AuditLogger } = require('../lib/audit');
    const out = await cmdNote(
      { audit: new AuditLogger() },
      ['u1', '--tier', 'vip', '--tag', '技术粉', '--notes', '种子用户']
    );
    expect(out.profile.tier).toBe('vip');
    expect(out.profile.tags).toContain('技术粉');
    expect(out.profile.notes).toBe('种子用户');
  }));

  it('--clear 清空 tier/tags/notes', withTempProject(async () => {
    const cmdNote = require('../lib/commands/note');
    const { AuditLogger } = require('../lib/audit');
    await cmdNote({ audit: new AuditLogger() }, ['u1', '--tier', 'vip', '--tag', 'x', '--notes', 'n']);
    const out = await cmdNote({ audit: new AuditLogger() }, ['u1', '--clear']);
    expect(out.profile.tier).toBe(null);
    expect(out.profile.tags).toEqual([]);
    expect(out.profile.notes).toBe(null);
  }));

  it('非法 tier 抛错', withTempProject(async () => {
    const cmdNote = require('../lib/commands/note');
    const { AuditLogger } = require('../lib/audit');
    await expect(cmdNote({ audit: new AuditLogger() }, ['u1', '--tier', 'bad']))
      .rejects.toThrow(/tier/);
  }));
});

// ── cmdVideos：记忆层视频列表（含账号归属）──
// cmdVideos 是同步执行体（无 await），可以直接用捕获 console.log 的方式断言输出。
function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.map(String).join(' '));
  try { return Promise.resolve(fn()).then(r => ({ result: r, output: lines.join('\n') })); }
  finally { console.log = orig; }
}

describe('P2: cmdVideos', () => {
  it('列出视频 + 归属账号；--mine 只列自己的；ctx.account 按账号过滤', withTempProject(async () => {
    const cmdVideos = require('../lib/commands/videos');
    const videos = require('../lib/memory/videos');
    videos.upsert({ awemeId: 'v1', isMine: true, title: 'A 的作品', account: 'ACC_A' });
    videos.upsert({ awemeId: 'v2', isMine: true, title: 'B 的作品', account: 'ACC_B' });
    videos.upsert({ awemeId: 'v3', isMine: false, title: '别人的视频' });

    const all = await captureLog(() => cmdVideos({}, []));
    expect(all.output).toContain('v1');
    expect(all.output).toContain('v3');
    expect(all.output).toContain('acct=ACC_A');

    const mine = await captureLog(() => cmdVideos({}, ['--mine']));
    expect(mine.output).toContain('v1');
    expect(mine.output).not.toContain('v3'); // is_mine=false 不该出现

    const byAcct = await captureLog(() => cmdVideos({ account: 'ACC_B' }, []));
    expect(byAcct.output).toContain('v2');
    expect(byAcct.output).not.toContain('v1');
  }));

  it('--json 输出结构化结果（含 account 归属）', withTempProject(async () => {
    const cmdVideos = require('../lib/commands/videos');
    const videos = require('../lib/memory/videos');
    videos.upsert({ awemeId: 'v1', isMine: true, title: 'X', account: 'ACC_A' });
    const out = await captureLog(() => cmdVideos({}, ['--json']));
    const parsed = JSON.parse(out.output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].awemeId).toBe('v1');
    expect(parsed[0].account).toBe('ACC_A');
  }));

  it('空表 → No matching videos.', withTempProject(async () => {
    const cmdVideos = require('../lib/commands/videos');
    const out = await captureLog(() => cmdVideos({}, []));
    expect(out.output).toContain('No matching videos.');
  }));
});
