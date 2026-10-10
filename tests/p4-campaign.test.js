// tests/p4-campaign.test.js — P4 推广引擎测试
//
// 关键不变量：
// 1. campaigns.create/get/list + 状态机 draft→running⇄paused→done
// 2. taskUpsert UNIQUE(campaign_id, cid) 幂等
// 3. getDue / markExecuted / countByOutcome
// 4. campaign create→list→status→pause→resume 命令入口
// 5. campaign plan（mock cmdGet + LLM）生成 task
// 6. campaign run（mock cmdPost + riskControl patched）消费 task

const fs = require('fs');
const path = require('path');
const os = require('os');

function withTempProject(fn) {
  return async () => {
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-p4-' + id + '-'));
    const origStorage = process.env.DOUYIN_STORAGE_DIR;
    const origLog = process.env.DOUYIN_LOG_DIR;
    const origCwd = process.cwd();
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    process.env.DOUYIN_LOG_DIR = path.join(tmp, 'logs');
    process.chdir(tmp);
    [
      '../lib/memory/db', '../lib/memory/events',
      '../lib/memory/users', '../lib/memory/comments', '../lib/memory/videos',
      '../lib/memory/corpus', '../lib/memory/failures', '../lib/memory/campaigns',
      '../lib/risk-control', '../lib/audit',
      '../lib/commands/post', '../lib/commands/suggest', '../lib/commands/campaign',
    ].forEach(m => { try { delete require.cache[require.resolve(m)]; } catch (e) {} });
    try { await fn(tmp); }
    finally {
      try { require('../lib/memory/db').closeDb(); } catch (e) { /* */ }
      process.chdir(origCwd);
      if (origStorage == null) delete process.env.DOUYIN_STORAGE_DIR; else process.env.DOUYIN_STORAGE_DIR = origStorage;
      if (origLog == null) delete process.env.DOUYIN_LOG_DIR; else process.env.DOUYIN_LOG_DIR = origLog;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

describe('P4: campaigns 记忆层', () => {
  it('create/get/list + 默认值', withTempProject(async () => {
    const campaigns = require('../lib/memory/campaigns');
    const c = campaigns.create({ name: '618', goal: 'product_launch', videos: ['v1', 'v2'], dailyQuota: 20 });
    expect(c.id).toBeGreaterThan(0);
    expect(c.status).toBe('draft');
    expect(c.dailyQuota).toBe(20);
    expect(c.videos).toEqual(['v1', 'v2']);
    expect(campaigns.get(c.id).name).toBe('618');
    expect(campaigns.list()).toHaveLength(1);
  }));

  it('状态机 draft→running→paused→running→done', withTempProject(async () => {
    const campaigns = require('../lib/memory/campaigns');
    const c = campaigns.create({ name: 's1' });
    expect(campaigns.updateStatus(c.id, 'running').status).toBe('running');
    expect(campaigns.get(c.id).startedAt).toBeGreaterThan(0);
    expect(campaigns.updateStatus(c.id, 'paused').status).toBe('paused');
    expect(campaigns.updateStatus(c.id, 'running').status).toBe('running');
    // started_at 不被覆盖
    const startedBefore = campaigns.get(c.id).startedAt;
    campaigns.updateStatus(c.id, 'running');
    expect(campaigns.get(c.id).startedAt).toBe(startedBefore);
    expect(campaigns.updateStatus(c.id, 'done').status).toBe('done');
    expect(campaigns.get(c.id).stats.total).toBe(0);
  }));

  it('taskUpsert 幂等（UNIQUE campaign_id+cid）', withTempProject(async () => {
    const campaigns = require('../lib/memory/campaigns');
    const c = campaigns.create({ name: 's2' });
    expect(campaigns.taskUpsert({ campaignId: c.id, cid: 'c1', replyText: 'r1' })).toBe(true);
    expect(campaigns.taskUpsert({ campaignId: c.id, cid: 'c1', replyText: 'r2' })).toBe(false);
    expect(campaigns.taskUpsertMany([
      { campaignId: c.id, cid: 'c2' }, { campaignId: c.id, cid: 'c1' }, { campaignId: c.id, cid: 'c3' },
    ])).toEqual({ total: 3, inserted: 2 });
  }));

  it('getDue / markExecuted / countByOutcome', withTempProject(async () => {
    const campaigns = require('../lib/memory/campaigns');
    const c = campaigns.create({ name: 's3' });
    campaigns.taskUpsert({ campaignId: c.id, cid: 'c1' });
    campaigns.taskUpsert({ campaignId: c.id, cid: 'c2' });
    expect(campaigns.getDue(c.id)).toHaveLength(2);
    const due = campaigns.getDue(c.id);
    campaigns.markExecuted(due[0].id, 'posted');
    campaigns.markExecuted(due[1].id, 'skipped', 'sticker');
    expect(campaigns.getDue(c.id)).toHaveLength(0);
    const counts = campaigns.countByOutcome(c.id);
    expect(counts).toMatchObject({ posted: 1, skipped: 1, pending: 0, failed: 0, total: 2 });
  }));
});

describe('P4: campaign 命令族', () => {
  it('create → list → status → pause → resume', withTempProject(async () => {
    const cmdCampaign = require('../lib/commands/campaign');
    const { AuditLogger } = require('../lib/audit');
    const ctx = { audit: new AuditLogger(), config: {}, account: 'acc1' };

    const c = await cmdCampaign(ctx, ['create', '--name', '618', '--videos', 'v1,v2', '--daily-quota', '10']);
    expect(c.name).toBe('618');
    expect(c.videos).toEqual(['v1', 'v2']);

    const list = await cmdCampaign(ctx, ['list']);
    expect(list).toHaveLength(1);

    const st = await cmdCampaign(ctx, ['status', String(c.id)]);
    expect(st.campaign.name).toBe('618');
    expect(st.tasks.total).toBe(0);

    expect((await cmdCampaign(ctx, ['pause', String(c.id)])).status).toBe('paused');
    expect((await cmdCampaign(ctx, ['resume', String(c.id)])).status).toBe('running');
  }));

  it('plan：mock cmdGet + LLM 生成 task', withTempProject(async () => {
    const cmdCampaign = require('../lib/commands/campaign');
    const { AuditLogger } = require('../lib/audit');
    const llmModule = require('../lib/llm');
    const campaigns = require('../lib/memory/campaigns');

    const origCtor = llmModule.LLMClient;
    llmModule.LLMClient = class FakeLLM {
      constructor() {}
      async suggestReplies(comments) {
        return comments.map(c => ({ cid: c.cid, reply: '回复_' + c.cid }));
      }
    };
    try {
      const ctx = {
        audit: new AuditLogger(), config: {}, account: 'acc1',
        cmdGet: async () => [
          { cid: 'c1', text: '求推荐', user: { uid: 'u1' } },
          { cid: 'c2', text: '看看', user: { uid: 'u2' } },
        ],
      };
      const c = await cmdCampaign(ctx, ['create', '--name', 'p', '--videos', 'v1']);
      const r = await cmdCampaign(ctx, ['plan', String(c.id)]);
      expect(r.inserted).toBe(2);
      expect(r.comments_seen).toBe(2);
      // 幂等：再 plan 一次（同评论）→ inserted=0
      const r2 = await cmdCampaign(ctx, ['plan', String(c.id)]);
      expect(r2.inserted).toBe(0);
      // task 落库
      const tasks = campaigns.listTasks(c.id);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].replyText).toBe('回复_c1');
    } finally {
      llmModule.LLMClient = origCtor;
    }
  }));

  it('run：mock cmdPost + riskControl patched → 消费 task', withTempProject(async () => {
    const cmdCampaign = require('../lib/commands/campaign');
    const { AuditLogger } = require('../lib/audit');
    const rc = require('../lib/risk-control');
    const campaigns = require('../lib/memory/campaigns');

    // patch 节奏与预检，避免 wall-clock sleep
    const origAi = rc.adaptiveInterval;
    const origPf = rc.preflightPublish;
    rc.adaptiveInterval = () => ({ intervalMs: 1, baseMs: 60000, multiplier: 1, reasons: [] });
    rc.preflightPublish = () => ({ ok: true, blockers: [] });

    try {
      const ctx = {
        audit: new AuditLogger(), config: {}, account: 'acc1',
        cmdGet: async () => [{ cid: 'c1', text: 'x', user: { uid: 'u1' } }, { cid: 'c2', text: 'y', user: { uid: 'u2' } }],
        cmdPost: async (a) => ({ cid: 'reply-' + a[3], status: 'published' }),
      };
      const c = await cmdCampaign(ctx, ['create', '--name', 'r', '--videos', 'v1']);
      campaigns.taskUpsert({ campaignId: c.id, cid: 'c1', awemeId: 'v1', replyText: '回复1' });
      campaigns.taskUpsert({ campaignId: c.id, cid: 'c2', awemeId: 'v1', replyText: '回复2' });
      const r = await cmdCampaign(ctx, ['run', String(c.id), '--limit', '10']);
      expect(r.posted).toBe(2);
      expect(campaigns.countByOutcome(c.id).posted).toBe(2);
      expect(campaigns.get(c.id).status).toBe('done'); // 无 pending → done
    } finally {
      rc.adaptiveInterval = origAi;
      rc.preflightPublish = origPf;
    }
  }));

  it('run：preflightPublish skip（blacklist）→ 任务标记 skipped', withTempProject(async () => {
    const cmdCampaign = require('../lib/commands/campaign');
    const { AuditLogger } = require('../lib/audit');
    const rc = require('../lib/risk-control');
    const campaigns = require('../lib/memory/campaigns');

    const origAi = rc.adaptiveInterval;
    rc.adaptiveInterval = () => ({ intervalMs: 1, baseMs: 60000, multiplier: 1, reasons: [] });
    // preflight 默认行为（查 DB）：blacklist 用户会被 skip
    // 这里用真实 preflightPublish + 一个 blacklist 用户
    const users = require('../lib/memory/users');
    try {
      const ctx = {
        audit: new AuditLogger(), config: {}, account: 'acc1',
        cmdGet: async () => [{ cid: 'c1', text: 'x', user: { uid: 'ub' } }],
        cmdPost: async () => { throw new Error('should not be called'); },
      };
      users.upsert({ uid: 'ub', nickname: 'bad' });
      users.setTier('ub', 'blacklist');

      const c = await cmdCampaign(ctx, ['create', '--name', 'r2', '--videos', 'v1']);
      // 让 preflightPublish 能从 cid 反查 uid → 命中 blacklist
      const comments = require('../lib/memory/comments');
      comments.upsert({ cid: 'c1', awemeId: 'v1', uid: 'ub', text: 'x' });
      campaigns.taskUpsert({ campaignId: c.id, cid: 'c1', awemeId: 'v1', replyText: '回复' });
      const r = await cmdCampaign(ctx, ['run', String(c.id)]);
      expect(r.skipped).toBe(1);
      expect(r.posted).toBe(0);
      expect(campaigns.countByOutcome(c.id).skipped).toBe(1);
    } finally {
      rc.adaptiveInterval = origAi;
    }
  }));
});

describe('P4: campaign daemon（--daemon / stop）', () => {
  it('status: 无 PID 文件 → daemon.running=false', withTempProject(async () => {
    const cmdCampaign = require('../lib/commands/campaign');
    const { AuditLogger } = require('../lib/audit');
    const ctx = { audit: new AuditLogger(), config: {}, account: 'acc1' };
    const c = await cmdCampaign(ctx, ['create', '--name', 'd0', '--videos', 'v1']);
    const st = await cmdCampaign(ctx, ['status', String(c.id)]);
    expect(st.daemon.running).toBe(false);
    expect(st.daemon.pid).toBe(null);
  }));

  it('stale PID 文件被 daemonAlive 清理', withTempProject(async () => {
    const cmdCampaign = require('../lib/commands/campaign');
    const { AuditLogger } = require('../lib/audit');
    const fs = require('fs');
    const path = require('path');
    const ctx = { audit: new AuditLogger(), config: {}, account: 'acc1' };
    const c = await cmdCampaign(ctx, ['create', '--name', 'd1', '--videos', 'v1']);
    const pidFile = path.join(process.env.DOUYIN_STORAGE_DIR, `campaign-${c.id}.pid`);
    fs.writeFileSync(pidFile, '999999'); // 必定不存在的 pid
    const st = await cmdCampaign(ctx, ['status', String(c.id)]);
    expect(st.daemon.running).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(false); // 失效 PID 文件被清理
  }));

  it('run --daemon 写 PID 文件 + stop 幂等清理', withTempProject(async () => {
    const cmdCampaign = require('../lib/commands/campaign');
    const { AuditLogger } = require('../lib/audit');
    const fs = require('fs');
    const path = require('path');
    const ctx = { audit: new AuditLogger(), config: {}, account: 'acc1' };
    const c = await cmdCampaign(ctx, ['create', '--name', 'd2', '--videos', 'v1']);
    // 无 task：子进程前台 run 立即退出（getDue 空），但 PID 文件已由 spawn 写入
    const r = await cmdCampaign(ctx, ['run', String(c.id), '--daemon']);
    expect(r.daemon).toBe(true);
    expect(typeof r.pid).toBe('number');
    const pidFile = path.join(process.env.DOUYIN_STORAGE_DIR, `campaign-${c.id}.pid`);
    expect(fs.existsSync(pidFile)).toBe(true);
    // stop 幂等：无论子进程是否已退出，都清理 PID + 置 paused
    const stop = await cmdCampaign(ctx, ['stop', String(c.id)]);
    expect(stop.campaign_id).toBe(c.id);
    expect(fs.existsSync(pidFile)).toBe(false);
  }));
});
