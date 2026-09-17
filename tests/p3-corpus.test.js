// tests/p3-corpus.test.js — v3 P3 reply_corpus / failure_patterns / suggest 闭环测试
//
// 关键不变量：
// 1. corpus.append → findByText（hash 匹配），同一文本第二次仍能查到（不去重，append 多行）
// 2. failures.classify 把 status_code / 油猴典型错误归一化为稳定 signature
// 3. failures.record 重复 signature → hit_count 累加（UPSERT）
// 4. cmdPost 失败路径写 failures（mock loggedCall 抛 status_code=8）
// 5. cmdPost 成功 + reply_to → corpus.append 一行
// 6. cmdSuggest 把 corpus / failures / userTags 注入到 LLMClient.suggestReplies(args)
// 7. dedup / failures / corpus 三个新命令的入口可用

const fs = require('fs');
const path = require('path');
const os = require('os');

function withTempProject(fn) {
  return async () => {
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-p3-' + id + '-'));
    const origStorageEnv = process.env.DOUYIN_STORAGE_DIR;
    const origLogEnv = process.env.DOUYIN_LOG_DIR;
    const origCwd = process.cwd();
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    process.env.DOUYIN_LOG_DIR = path.join(tmp, 'logs');
    process.chdir(tmp);
    [
      '../core/memory/db', '../core/memory/events',
      '../core/memory/users', '../core/memory/comments', '../core/memory/videos',
      '../core/memory/corpus', '../core/memory/failures',
      '../core/audit',
      '../core/commands/post', '../core/commands/suggest',
      '../core/commands/corpus', '../core/commands/failures', '../core/commands/dedup',
    ].forEach(m => {
      try { delete require.cache[require.resolve(m)]; } catch (e) {}
    });
    try {
      await fn(tmp);
    } finally {
      try { require('../core/memory/db').closeDb(); } catch (e) { /* */ }
      process.chdir(origCwd);
      if (origStorageEnv == null) delete process.env.DOUYIN_STORAGE_DIR;
      else process.env.DOUYIN_STORAGE_DIR = origStorageEnv;
      if (origLogEnv == null) delete process.env.DOUYIN_LOG_DIR;
      else process.env.DOUYIN_LOG_DIR = origLogEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

describe('P3: corpus repo', () => {
  it('append → findByText 命中（hash 匹配）', withTempProject(async () => {
    const corpus = require('../core/memory/corpus');
    const id = corpus.append({
      replyText: '感谢支持~ 后续会出更多教程！',
      srcCid: 'c1', srcText: '什么时候出新视频？', awemeId: 'v1',
    });
    expect(id).toBeTruthy();
    const m = corpus.findByText('感谢支持~ 后续会出更多教程！');
    expect(m).toBeTruthy();
    expect(m.replyText).toBe('感谢支持~ 后续会出更多教程！');
    expect(m.outcome).toBe('published');
    // hash 规范化：大小写/前后空格不影响命中
    const m2 = corpus.findByText('  感谢支持~ 后续会出更多教程！  ');
    expect(m2 && m2.id).toBe(m.id);
  }));

  it('recent 默认按 posted_at DESC，可按 awemeId 过滤', withTempProject(async () => {
    const corpus = require('../core/memory/corpus');
    corpus.append({ replyText: 'a', awemeId: 'v1', postedAt: 1000 });
    corpus.append({ replyText: 'b', awemeId: 'v2', postedAt: 2000 });
    corpus.append({ replyText: 'c', awemeId: 'v1', postedAt: 3000 });
    const all = corpus.recent({ limit: 10 });
    expect(all.map(r => r.replyText)).toEqual(['c', 'b', 'a']);
    const v1 = corpus.recent({ limit: 10, awemeId: 'v1' });
    expect(v1.map(r => r.replyText)).toEqual(['c', 'a']);
  }));

  it('search 按 src_text 或 reply_text 模糊匹配', withTempProject(async () => {
    const corpus = require('../core/memory/corpus');
    corpus.append({ replyText: '教程已经在路上', srcText: '什么时候出新视频' });
    corpus.append({ replyText: '点赞收藏不迷路', srcText: '666' });
    expect(corpus.search('教程')).toHaveLength(1);
    expect(corpus.search('什么时候')).toHaveLength(1);
    expect(corpus.search('不存在的关键词')).toHaveLength(0);
  }));
});

describe('P3: failures repo', () => {
  it('classify：status_code / 油猴错误 / 兜底 msg', () => {
    const failures = require('../core/memory/failures');
    expect(failures.classify({ status_code: 8 })).toBe('status_code=8');
    expect(failures.classify('status_code=2154 — 评论被拦截')).toBe('status_code=2154');
    expect(failures.classify('返回了 HTML 页面，可能未登录')).toBe('bridge_html_response');
    expect(failures.classify('ECONNREFUSED 127.0.0.1:19422')).toBe('bridge_offline');
    expect(failures.classify('Unauthorized')).toBe('bridge_unauthorized');
    expect(failures.classify('某个奇怪的错误')).toMatch(/^msg:/);
  });

  it('record 重复 signature → hit_count 累加', withTempProject(async () => {
    const failures = require('../core/memory/failures');
    failures.record({ status_code: 8 }, { exampleText: 'hi' });
    failures.record({ status_code: 8 }, { exampleText: 'hello' });
    failures.record({ status_code: 8 });
    const top = failures.top(5);
    expect(top).toHaveLength(1);
    expect(top[0].signature).toBe('status_code=8');
    expect(top[0].hitCount).toBe(3);
    expect(top[0].exampleText).toBeTruthy(); // COALESCE 保留首次非空
  }));

  it('top 排序按 hit_count DESC', withTempProject(async () => {
    const failures = require('../core/memory/failures');
    failures.record({ status_code: 1 });
    failures.record({ status_code: 2 });
    failures.record({ status_code: 2 });
    failures.record({ status_code: 3 });
    failures.record({ status_code: 3 });
    failures.record({ status_code: 3 });
    const top = failures.top(5);
    expect(top[0].signature).toBe('status_code=3');
    expect(top[0].hitCount).toBe(3);
    expect(top[1].signature).toBe('status_code=2');
  }));
});

describe('P3: cmdPost 双写到 corpus / failures', () => {
  it('成功 + reply-to → corpus 累计 1 条', withTempProject(async () => {
    const cmdPost = require('../core/commands/post');
    const corpus = require('../core/memory/corpus');
    const comments = require('../core/memory/comments');
    const { AuditLogger } = require('../core/audit');

    // 模拟 cmdGet 已落库 src 评论
    comments.upsert({ cid: 'src1', awemeId: 'v1', uid: 'uA', text: '什么时候出新视频？' });

    const ctx = {
      audit: new AuditLogger(),
      loggedCall: async () => ({
        comment: { cid: 'mine1', text: '感谢支持~', create_time: 1700000000,
          user: { uid: 'me', nickname: 'me' } },
      }),
    };
    const out = await cmdPost(ctx, ['v1', '感谢支持~', '--reply-to', 'src1']);
    expect(out.cid).toBe('mine1');
    expect(corpus.count()).toBe(1);
    const recent = corpus.recent({ limit: 5 });
    expect(recent[0].replyText).toBe('感谢支持~');
    expect(recent[0].srcCid).toBe('src1');
    expect(recent[0].srcText).toBe('什么时候出新视频？');
    expect(recent[0].outcome).toBe('published');
  }));

  it('status_code != 0 → failures.record(status_code=N) 并抛错', withTempProject(async () => {
    const cmdPost = require('../core/commands/post');
    const failures = require('../core/memory/failures');
    const { AuditLogger } = require('../core/audit');
    const ctx = {
      audit: new AuditLogger(),
      loggedCall: async () => ({ status_code: 8 }),
    };
    await expect(cmdPost(ctx, ['v1', '内容', '--reply-to', 'src1']))
      .rejects.toThrow(/status_code=8/);
    const top = failures.top(5);
    expect(top.find(f => f.signature === 'status_code=8')).toBeTruthy();
  }));

  it('无 reply-to 的纯顶层评论不入 corpus', withTempProject(async () => {
    const cmdPost = require('../core/commands/post');
    const corpus = require('../core/memory/corpus');
    const { AuditLogger } = require('../core/audit');
    const ctx = {
      audit: new AuditLogger(),
      loggedCall: async () => ({ comment: { cid: 'mine2', text: '顶层评论', create_time: 1700000001,
        user: { uid: 'me' } } }),
    };
    await cmdPost(ctx, ['v1', '顶层评论']);
    expect(corpus.count()).toBe(0);
  }));
});

describe('P3: cmdSuggest LLM 上下文注入 + dedup 重写', () => {
  it('suggest 把 corpus/failures/avoid/userTags 注入 LLMClient.suggestReplies', withTempProject(async () => {
    // 1. 准备历史数据
    const corpus = require('../core/memory/corpus');
    const failures = require('../core/memory/failures');
    const users = require('../core/memory/users');
    corpus.append({ replyText: '历史回复 A', srcText: '历史问题 A' });
    failures.record({ status_code: 8 }, { exampleText: '导流话术' });
    users.upsert({ uid: 'uA', nickname: 'Alice' });
    users.addTag('uA', '种子');
    users.addTag('uA', '技术粉');

    // 2. mock LLMClient
    const llmModule = require('../core/llm');
    let captured = null;
    const origCtor = llmModule.LLMClient;
    llmModule.LLMClient = class FakeLLM {
      constructor() {}
      async suggestReplies(comments, strategy, videoDesc, context) {
        captured = { comments, context };
        return comments.map(c => ({ cid: c.cid, reply: '新回复 ' + c.cid }));
      }
    };

    try {
      const cmdSuggest = require('../core/commands/suggest');
      const { AuditLogger } = require('../core/audit');
      const cmdAnalyze = async () => [
        { cid: 'c1', uid: 'uA', sentiment: 'positive', priority: 5, text: '问题1' },
        { cid: 'c2', uid: 'uB', sentiment: 'positive', priority: 4, text: '问题2' },
      ];
      const ctx = { audit: new AuditLogger(), config: {}, cmdAnalyze };
      const out = await cmdSuggest(ctx, ['v1', '--fast']);

      expect(out).toHaveLength(2);
      expect(captured).toBeTruthy();
      expect(captured.context.corpus).toHaveLength(1);
      expect(captured.context.corpus[0].replyText).toBe('历史回复 A');
      expect(captured.context.failures).toHaveLength(1);
      expect(captured.context.failures[0].signature).toBe('status_code=8');
      expect(captured.context.avoid).toContain('历史回复 A');
      // userTags 挂在 comment 对象上
      const c1 = captured.comments.find(c => c.cid === 'c1');
      expect(c1.userTags).toContain('种子');
    } finally {
      llmModule.LLMClient = origCtor;
    }
  }));

  it('LLM 输出命中 corpus 时触发重写', withTempProject(async () => {
    const corpus = require('../core/memory/corpus');
    corpus.append({ replyText: '感谢支持' });

    const llmModule = require('../core/llm');
    const origCtor = llmModule.LLMClient;
    let calls = 0;
    let rewriteCalls = 0;
    llmModule.LLMClient = class FakeLLM {
      constructor() {}
      async suggestReplies(comments) {
        calls++;
        // 首轮直接返回命中文本 → 触发重写
        return comments.map(c => ({ cid: c.cid, reply: '感谢支持' }));
      }
      async rewriteReply(srcText, originalReply) {
        rewriteCalls++;
        return '新文案 c1';
      }
    };

    try {
      const cmdSuggest = require('../core/commands/suggest');
      const { AuditLogger } = require('../core/audit');
      const cmdAnalyze = async () => [
        { cid: 'c1', sentiment: 'positive', priority: 5, text: 'x' },
      ];
      const ctx = { audit: new AuditLogger(), config: {}, cmdAnalyze };
      const out = await cmdSuggest(ctx, ['v1', '--fast']);
      expect(calls).toBe(1);
      expect(rewriteCalls).toBe(1);
      expect(out[0].reply).toBe('新文案 c1');
      expect(out[0].rewritten).toBe(true);
    } finally {
      llmModule.LLMClient = origCtor;
    }
  }));
});

describe('P3: cli 子命令', () => {
  it('cmdDedup 命中已发文本', withTempProject(async () => {
    const corpus = require('../core/memory/corpus');
    corpus.append({ replyText: '已发过的话术' });
    const cmdDedup = require('../core/commands/dedup');
    const { AuditLogger } = require('../core/audit');
    const out = await cmdDedup({ audit: new AuditLogger() }, ['已发过的话术']);
    expect(out.duplicate).toBe(true);
    expect(out.match.reply_text).toBe('已发过的话术');
  }));

  it('cmdDedup 未命中', withTempProject(async () => {
    const cmdDedup = require('../core/commands/dedup');
    const { AuditLogger } = require('../core/audit');
    const out = await cmdDedup({ audit: new AuditLogger() }, ['全新文案']);
    expect(out.duplicate).toBe(false);
    expect(out.match).toBe(null);
  }));

  it('cmdFailures 返回 top 列表', withTempProject(async () => {
    const failures = require('../core/memory/failures');
    failures.record({ status_code: 8 });
    failures.record({ status_code: 8 });
    failures.record({ status_code: 1 });
    const cmdFailures = require('../core/commands/failures');
    const { AuditLogger } = require('../core/audit');
    const out = await cmdFailures({ audit: new AuditLogger() }, []);
    expect(out[0].signature).toBe('status_code=8');
    expect(out[0].hitCount).toBe(2);
  }));

  it('cmdCorpus stats / search', withTempProject(async () => {
    const corpus = require('../core/memory/corpus');
    corpus.append({ replyText: '教程在路上' });
    corpus.append({ replyText: '点赞收藏~' });
    const cmdCorpus = require('../core/commands/corpus');
    const { AuditLogger } = require('../core/audit');
    const stats = await cmdCorpus({ audit: new AuditLogger() }, ['stats']);
    expect(stats.total).toBe(2);
    expect(stats.published).toBe(2);
    const found = await cmdCorpus({ audit: new AuditLogger() }, ['search', '教程']);
    expect(found).toHaveLength(1);
  }));
});
