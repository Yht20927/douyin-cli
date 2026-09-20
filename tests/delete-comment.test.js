// tests/delete-comment.test.js — 删除评论（含本地账目回退）
//
// 不变量：
// 1. 抖音侧删成功之后，**本地也要跟着回退**：那行移除、被回复的父评论回到未回复
//    —— 不然界面继续显示「已回复」、待回复数不涨回来，而它在抖音上已经没了
// 2. 服务端非 0 状态码要连原始信息一起报出来（2055 这类码的含义我们是猜的）
// 3. 不是自己发的评论，本地就能判出来并拒绝，不用等抖音那边报一个含糊的错
// 4. `delete-comment`（连字符）必须被认成写操作 —— 这条曾经恒为假

const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../core/config');

function withTempEnv(fn) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-del-'));
    const saved = {
      cfg: process.env.DOUYIN_CONFIG,
      storage: process.env.DOUYIN_STORAGE_DIR,
      log: process.env.DOUYIN_LOG_DIR,
    };
    process.env.DOUYIN_CONFIG = path.join(tmp, 'config.json');
    fs.writeFileSync(process.env.DOUYIN_CONFIG, JSON.stringify({}));
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    process.env.DOUYIN_LOG_DIR = path.join(tmp, 'logs');

    // delete-comment 在**模块顶层**就 require 了 policy 单例，而 policy 又持有
    // db 的引用 —— 不清的话下一个用例读到的是上一个临时库
    const purge = () => {
      for (const m of ['../core/memory/db', '../core/memory/comments', '../core/memory/corpus',
        '../core/memory/videos', '../core/memory/events', '../core/memory/accounts',
        '../core/policy', '../core/policy/index', '../core/risk-control',
        '../core/data/views', '../core/commands/delete-comment']) {
        try { delete require.cache[require.resolve(m)]; } catch (_) { /* 未加载过 */ }
      }
    };
    config.reset();
    purge();

    try {
      const comments = require('../core/memory/comments');
      const corpus = require('../core/memory/corpus');
      const accounts = require('../core/memory/accounts');
      const cmdDelete = require('../core/commands/delete-comment');
      await fn({ comments, corpus, accounts, cmdDelete });
    } finally {
      try { require('../core/memory/db').closeDb(); } catch (_) { /* */ }
      purge();
      try { config.reset(); } catch (_) { /* */ }
      if (saved.cfg == null) delete process.env.DOUYIN_CONFIG; else process.env.DOUYIN_CONFIG = saved.cfg;
      if (saved.storage == null) delete process.env.DOUYIN_STORAGE_DIR; else process.env.DOUYIN_STORAGE_DIR = saved.storage;
      if (saved.log == null) delete process.env.DOUYIN_LOG_DIR; else process.env.DOUYIN_LOG_DIR = saved.log;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

/**
 * 假的 ctx。`reply` 是 bridge 的返回体。
 * 桥接状态里挂一个账号 —— 归属校验靠它。
 */
function makeCtx(reply = { status_code: 0 }, accountUid = 'me') {
  const calls = [];
  const events = [];
  return {
    calls,
    events,
    ctx: {
      audit: {
        startOperation: (name, meta) => events.push(['start', name, meta]),
        endOperation: (status, summary, result, error) =>
          events.push(['end', status, summary, result, error]),
      },
      loggedCall: async (command, payload, expr) => {
        calls.push({ command, payload, expr });
        if (reply instanceof Error) throw reply;
        return reply;
      },
      bridge: {
        status: async () => ({
          connections: [{ alive: true, account: accountUid ? { uid: accountUid } : null }],
        }),
      },
    },
  };
}

/** 造一条"我回过的评论" + 我们发出去的那条回复 */
function seedReplied(comments, corpus, { cid = 'q1', replyCid = 'r1', myUid = 'me' } = {}) {
  comments.upsert({ cid, awemeId: 'v1', uid: 'u1', text: '求教程' });
  comments.markReplied(cid, 'v1', replyCid);
  comments.upsert({ cid: replyCid, awemeId: 'v1', uid: myUid, text: '在置顶', parentCid: cid });
  corpus.append({
    srcCid: cid, srcText: '求教程', replyText: '在置顶',
    replyCid, awemeId: 'v1', postedAt: Date.now(), outcome: 'published',
  });
}

describe('删除评论', () => {
  it('删掉我们的回复之后，本地那行移除、父评论回到未回复', withTempEnv(async ({ comments, corpus, cmdDelete }) => {
    seedReplied(comments, corpus);
    expect(comments.get('q1').replied).toBe(true);

    const { ctx, calls } = makeCtx();
    const r = await cmdDelete(ctx, ['r1', '--no-throttle']);

    expect(calls.map(c => c.command)).toEqual(['delete_comment']);
    expect(calls[0].expr).toContain('deleteComment');
    expect(r).toMatchObject({ cid: 'r1', status: 'deleted', localRemoved: 1, localUnmarked: 1 });

    // 本地账目回退：回复那行没了，父评论回到未回复
    expect(comments.get('r1')).toBeNull();
    expect(comments.get('q1')).toMatchObject({ replied: false, replyCid: null });
    // 语料库留痕（这是唯一的"已删除"记录）
    expect(corpus.findByReplyCid('r1')).toMatchObject({ outcome: 'deleted' });
  }));

  it('删掉的如果是自己的顶级评论，只移除那一行（没有父评论要回退）', withTempEnv(async ({ comments, cmdDelete }) => {
    comments.upsert({ cid: 'mine1', awemeId: 'v1', uid: 'me', text: '我自己发的评论' });

    const { ctx } = makeCtx();
    const r = await cmdDelete(ctx, ['mine1', '--no-throttle']);

    expect(r).toMatchObject({ localRemoved: 1, localUnmarked: 0 });
    expect(comments.get('mine1')).toBeNull();
  }));

  it('服务端非 0 状态码：抛出，并把原话带在错误里', withTempEnv(async ({ comments, corpus, cmdDelete }) => {
    seedReplied(comments, corpus);
    const { ctx, events } = makeCtx({ status_code: 2055, status_msg: '评论已被删除' });

    await expect(cmdDelete(ctx, ['r1', '--no-throttle'])).rejects.toThrow(/2055/);
    await expect(cmdDelete(ctx, ['r1', '--no-throttle'])).rejects.toThrow(/评论已被删除/);

    // 失败时**不能**动本地数据 —— 抖音那边没删掉，本地先回退就成了假的
    expect(comments.get('r1')).not.toBeNull();
    expect(comments.get('q1').replied).toBe(true);
    expect(events.find(e => e[0] === 'end')[1]).toBe('error');
  }));

  it('不是当前账号发的评论，本地就判出来并拒绝（不发请求）', withTempEnv(async ({ comments, cmdDelete }) => {
    comments.upsert({ cid: 'other1', awemeId: 'v1', uid: 'u1', text: '别人的评论' });

    const { ctx, calls } = makeCtx();
    await expect(cmdDelete(ctx, ['other1', '--no-throttle'])).rejects.toThrow(/不是当前账号发的/);
    // 关键：一个请求都没发出去
    expect(calls).toEqual([]);
  }));

  it('本地没有这条记录时不做归属校验，交给抖音判', withTempEnv(async ({ cmdDelete }) => {
    const { ctx, calls } = makeCtx({ status_code: 0 });
    const r = await cmdDelete(ctx, ['unknown-cid', '--no-throttle']);
    expect(calls).toHaveLength(1);
    expect(r).toMatchObject({ localRemoved: 0, localUnmarked: 0 });
  }));
});

describe('delete-comment 必须被认成写操作', () => {
  // 回归背景：命令注册表里叫 `delete-comment`（连字符），events 里记的是
  // `delete_comment`（下划线）。`WRITE_COMMANDS.includes(task.command)` 因此
  // 对删除**恒为 false** —— 队列不给它排轮次、也不补 --no-throttle，
  // 于是它的等待跑到命令内部去了，与其他写操作不再协调。
  it('两种拼写都算，别的命令不算', withTempEnv(async () => {
    const { isWriteCommand, WRITE_COMMANDS } = require('../core/policy');
    expect(isWriteCommand('delete-comment')).toBe(true);
    expect(isWriteCommand('delete_comment')).toBe(true);
    expect(isWriteCommand('post')).toBe(true);
    expect(isWriteCommand('get')).toBe(false);
    expect(isWriteCommand('enrich')).toBe(false);
    expect(isWriteCommand('')).toBe(false);
    expect(isWriteCommand(null)).toBe(false);
    // 归一化之后必须仍与 events 里的那套拼写一致
    expect(WRITE_COMMANDS).toContain('delete_comment');
  }));
});
