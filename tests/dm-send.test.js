// tests/dm-send.test.js — 发私信这条链路到底能不能报出"没发出去"
//
// 为什么单独有这一个文件
// --------------------
// 交接文档里那条"改了核心路径却只跑过失败分支"的验证项，私信是最危险的一条：
// 界面点一次就发一条给真人，而**发送结果从来没有被测过**。
//
// 首个用例就抓到一个真缺陷：命令里判成功的语句是 `data.status_code !== 0`，
// 可 IM 接口回的是 protobuf（proto/dm.proto 的 Response），解码结果里
// **根本没有 status_code 这个键**（只有 cmd / sequence_id / error_desc / message）。
// 那个条件因此恒为假 —— 任何一次被抖音挡下的发送都会走到"成功"分支，
// 界面上照样弹绿字「私信已发出」。

const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../core/config');

const ENV_KEYS = ['DOUYIN_STORAGE_DIR', 'DOUYIN_LOG_DIR', 'DOUYIN_CONFIG', 'DOUYIN_DATA_DIR'];

function withTempEnv(fn) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-dm-'));
    const saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];

    const cfgFile = path.join(tmp, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ policy: { dailyWriteQuota: 999, dailyRounds: 99 } }));
    process.env.DOUYIN_CONFIG = cfgFile;
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    process.env.DOUYIN_DATA_DIR = path.join(tmp, 'storage');
    process.env.DOUYIN_LOG_DIR = path.join(tmp, 'logs');

    // dm 在模块顶层 require 了 policy 单例，policy 又持有 db 引用 ——
    // 不清缓存就会读到上一个用例的库（这套测试反复踩过的坑）
    const purge = () => {
      for (const m of ['../core/memory/db', '../core/memory/accounts', '../core/memory/events',
        '../core/memory/comments', '../core/memory/videos', '../core/policy',
        '../core/policy/index', '../core/risk-control', '../core/commands/dm']) {
        try { delete require.cache[require.resolve(m)]; } catch (_) { /* 未加载过 */ }
      }
    };
    config.reset();
    purge();
    try {
      await fn();
    } finally {
      try { require('../core/memory/db').closeDb(); } catch (_) { /* */ }
      purge();
      try { config.reset(); } catch (_) { /* */ }
      for (const k of ENV_KEYS) {
        if (saved[k] == null) delete process.env[k];
        else process.env[k] = saved[k];
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

/**
 * 假 ctx。`replies` 是按顺序返回的桥接响应（第一次 createConversation、
 * 第二次 sendDM）。传 Error 则那一次调用抛出。
 */
function makeCtx(replies) {
  const calls = [];
  const events = [];
  let n = 0;
  return {
    calls,
    events,
    ctx: {
      signal: undefined,
      bridge: null,
      audit: {
        startOperation: (name, meta) => events.push(['start', name, meta]),
        endOperation: (status, summary, result, error) =>
          events.push(['end', status, summary, result, error]),
      },
      loggedCall: async (command, payload, expr) => {
        const r = replies[n++];
        calls.push({ command, payload, expr });
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
}

const OK_CONV = { conversation_id: 'conv-123456', conversation_short_id: '77', ticket: 'tk' };
// 成功时抖音的 Response 只有 cmd / body，error_desc 是空串
const OK_SEND = { cmd: 100, sequence_id: 1, error_desc: '' };

describe('dm send 的结果判定', () => {
  it('成功：会话号与正文原样返回，两次调用的表达式都对得上', withTempEnv(async () => {
    const cmdDM = require('../core/commands/dm');
    const { calls, ctx } = makeCtx([OK_CONV, OK_SEND]);

    const r = await cmdDM(ctx, ['send', 'u42', '你好，想聊聊合作']);

    expect(r).toMatchObject({ conversation_id: 'conv-123456', status: 'sent', text: '你好，想聊聊合作' });
    expect(calls.map(c => c.command)).toEqual(['dm.createConversation', 'dm.send']);
    expect(calls[0].expr).toBe("window.__bridge.createConversation('u42')");
    // 会话标识是三段拼起来的（缺任何一段都会让抖音那边认不出会话）
    expect(calls[1].expr).toBe(
      "window.__bridge.sendDM('conv-123456|77|tk', '你好，想聊聊合作')"
    );
  }));

  it('protobuf 里没有 status_code，error_desc 非空必须判成失败', withTempEnv(async () => {
    // 这条就是那个"恒为假"的条件：整个响应里没有任何 status_code 键
    const cmdDM = require('../core/commands/dm');
    const { ctx, events } = makeCtx([OK_CONV, { cmd: 100, error_desc: 'frequency limit exceeded' }]);

    // 只跑一次：假桥接是按顺序给响应的，第二次调用拿到的是 undefined，
    // 测的就成了"创建会话失败"而不是这里的发送判定
    let err = null;
    await cmdDM(ctx, ['send', 'u42', '在吗']).catch(e => { err = e; });

    expect(err).not.toBeNull();
    expect(err.message).toMatch(/私信没发出去/);
    // 抖音原话必须在：这类码的含义我们是猜的，不能只留下我们的翻译
    expect(err.message).toMatch(/frequency limit/);

    const end = events.filter(e => e[0] === 'end').pop();
    expect(end[1]).toBe('error');
  }));

  it('带 status_code 的响应（HTTP 型/测试替身）非 0 同样算失败', withTempEnv(async () => {
    const cmdDM = require('../core/commands/dm');
    const { ctx } = makeCtx([OK_CONV, { status_code: 4003 }]);
    await expect(cmdDM(ctx, ['send', 'u42', '在吗'])).rejects.toThrow(/4003/);
  }));

  it('抖音那边只有一个 message、没有 error_desc 时不谎报失败', withTempEnv(async () => {
    // 判失败只能依据 error_desc。把 message 也当错误信号的话，
    // 一句 "OK" 之类的正常回执会被报成发送失败，用户就不敢再用了。
    const cmdDM = require('../core/commands/dm');
    const { ctx } = makeCtx([OK_CONV, { cmd: 100, message: 'OK' }]);
    const r = await cmdDM(ctx, ['send', 'u42', '在吗']);
    expect(r.status).toBe('sent');
  }));

  it('创建会话失败时不发第二条请求（不会把消息发到不存在的会话上）', withTempEnv(async () => {
    const cmdDM = require('../core/commands/dm');
    const { calls, ctx } = makeCtx([{ }, OK_SEND]);

    await expect(cmdDM(ctx, ['send', 'u42', '在吗'])).rejects.toThrow(/无法创建私信会话/);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('dm.createConversation');
  }));

  it('审核留痕用的操作名必须是 dm.send —— 风控闸门按这个名字查写记录', withTempEnv(async () => {
    // events 里那一行是 endOperation 写的，键名与 risk-control 的名单不一致时，
    // 闸门就"看不见"这次写操作：间隔不累计、当日额度也不扣。
    const cmdDM = require('../core/commands/dm');
    const riskControl = require('../core/risk-control');
    const { ctx, events } = makeCtx([OK_CONV, OK_SEND]);

    await cmdDM(ctx, ['send', 'u42', '在吗']);
    expect(events[0][0]).toBe('start');
    expect(events[0][1]).toBe('dm.send');
    expect(riskControl.WRITE_COMMANDS.has('dm.send')).toBe(true);
  }));
});
