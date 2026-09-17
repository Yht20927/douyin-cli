// tests/server/create-server.test.js — 进程内 Bridge Server 与一键安装端点
//
// 不变量：
// 1. 可被调用方启动/停止（桌面应用退出时不能留下孤儿监听）
// 2. 端口传 0 时能拿到系统分配的真实端口（避免与用户机器上已跑的实例冲突）
// 3. 端口被占用时给出可读原因，而不是静默失败
// 4. /install.user.js 现场渲染脚本并注入当前 token；不设 CORS 头（跨源读不到）

const http = require('http');

const { createBridgeServer, USERSCRIPT_PATH } = require('../../core/server/create-server');
const { renderUserscript, sourcePath } = require('../../core/userscript');

/** 最小可用配置：端口 0 让系统分配，避免与开发机上正在跑的实例打架 */
function testConfig(overrides = {}) {
  return {
    bridge: {
      host: '127.0.0.1',
      port: 0,
      token: 'test-token-abc',
      heartbeatInterval: 30000,
      heartbeatTimeout: 10000,
      heartbeatMaxFailures: 3,
      requestTimeout: 5000,
      maxBodySize: 1024 * 1024,
      ...overrides,
    },
  };
}

/** 静默 logger（避免测试输出被服务端日志淹没） */
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** 起一个服务并在测试结束后关掉 */
function withServer(cfg, fn) {
  return async () => {
    const server = createBridgeServer({ config: cfg || testConfig(), logger: quietLogger });
    try {
      await fn(server);
    } finally {
      await server.stop();
    }
  };
}

/**
 * 发一个 HTTP 请求，返回 { status, headers, body }。
 *
 * 必须 agent: false —— Node 19 起全局 agent 默认开启 keep-alive，
 * 测试里每个用例的服务器端口不同（port 0）但可能被系统回收复用，
 * 于是复用到的旧 socket 已被上一个已关闭的服务器断开，表现为 "socket hang up"。
 * 强制每次新建连接就稳定了。
 */
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

describe('createBridgeServer: 生命周期', () => {
  it('start 返回实际监听地址（端口 0 时由系统分配）', withServer(null, async (server) => {
    const info = await server.start();
    expect(info.port).toBeGreaterThan(0);
    // 关键：端口 0 必须被当作"由系统分配"，而不是被 || 兜底成配置里的 19422。
    // 用临时端口范围（Linux 通常 32768+），不可能撞上 19422。
    expect(info.port).not.toBe(19422);
    expect(info.url).toBe(`http://127.0.0.1:${info.port}`);
    expect(server.listening).toBe(true);
    expect(server.url).toBe(info.url);
  }));

  it('多个实例可以并存（各自拿到不同端口，互不干扰）', withServer(null, async (server) => {
    await server.start();
    const other = createBridgeServer({ config: testConfig(), logger: quietLogger });
    try {
      await other.start();
      expect(other.port).not.toBe(server.port);
      // 两个都能正常响应
      const [a, b] = await Promise.all([
        get(`${server.url}/api/health`),
        get(`${other.url}/api/health`),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
    } finally {
      await other.stop();
    }
  }));

  it('重复 start 是幂等的，不换端口', withServer(null, async (server) => {
    const a = await server.start();
    const b = await server.start();
    expect(b.port).toBe(a.port);
  }));

  it('stop 之后可以再次 start（不残留监听）', withServer(null, async (server) => {
    const a = await server.start();
    await server.stop();
    expect(server.listening).toBe(false);

    const b = await server.start();
    expect(b.port).toBeGreaterThan(0);
    // 端口可能被系统重新分配，关键是能再起来
    expect(server.listening).toBe(true);
  }));

  it('重复 stop 不抛错', withServer(null, async (server) => {
    await server.start();
    await server.stop();
    await expect(server.stop()).resolves.toBeUndefined();
  }));

  it('未 start 就 stop 是安全的 no-op', withServer(null, async (server) => {
    await expect(server.stop()).resolves.toBeUndefined();
  }));

  it('start 可以被解构调用（不依赖 this）', withServer(null, async (server) => {
    const { start } = server;
    const info = await start();
    expect(info.port).toBeGreaterThan(0);
  }));

  it('/api/health 可达', withServer(null, async (server) => {
    await server.start();
    const r = await get(`${server.url}/api/health`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).ok).toBe(true);
  }));

  it('端口被占用时给出可读的错误原因', withServer(null, async (server) => {
    await server.start();
    const busyPort = server.port;

    const second = createBridgeServer({
      config: testConfig({ port: busyPort }),
      logger: quietLogger,
    });
    try {
      await expect(second.start()).rejects.toThrow(/已被占用/);
      expect(second.listening).toBe(false);
    } finally {
      await second.stop();
    }
  }));
});

describe('/install.user.js 一键安装端点', () => {
  it('返回脚本全文，含 UserScript 头与 __bridge', withServer(null, async (server) => {
    await server.start();
    const r = await get(`${server.url}${USERSCRIPT_PATH}`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('// ==UserScript==');
    expect(r.body).toContain('window.__bridge');
    expect(r.body).toContain('@match');
  }));

  it('注入的是本实例的 token，且无占位符残留', withServer(null, async (server) => {
    await server.start();
    const r = await get(`${server.url}${USERSCRIPT_PATH}`);
    expect(r.body).toContain("token: 'test-token-abc'");
    expect(r.body).not.toContain('{{BRIDGE_TOKEN}}');
    expect(r.body).not.toContain('{{SITE_KEY}}');
    expect(r.body).toContain("site: 'douyin.com'");
  }));

  it('每个实例拿到自己的 token（多账号预留的基础）', withServer(null, async (server) => {
    await server.start();
    const other = createBridgeServer({
      config: testConfig({ token: 'another-token' }),
      logger: quietLogger,
    });
    try {
      await other.start();
      const a = await get(`${server.url}${USERSCRIPT_PATH}`);
      const b = await get(`${other.url}${USERSCRIPT_PATH}`);
      expect(a.body).toContain("token: 'test-token-abc'");
      expect(b.body).toContain("token: 'another-token'");
      expect(b.body).not.toContain('test-token-abc');
    } finally {
      await other.stop();
    }
  }));

  it('不设 CORS 头（脚本含 token，跨源必须读不到）', withServer(null, async (server) => {
    await server.start();
    const r = await get(`${server.url}${USERSCRIPT_PATH}`);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  }));

  it('Content-Type 为 JS，且禁止缓存（token 可能被轮换）', withServer(null, async (server) => {
    await server.start();
    const r = await get(`${server.url}${USERSCRIPT_PATH}`);
    expect(r.headers['content-type']).toContain('javascript');
    expect(r.headers['cache-control']).toBe('no-store');
  }));

  it('带查询串也能命中（Tampermonkey 可能附加参数）', withServer(null, async (server) => {
    await server.start();
    const r = await get(`${server.url}${USERSCRIPT_PATH}?v=1`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('// ==UserScript==');
  }));
});

describe('renderUserscript', () => {
  it('替换 token 与 site', () => {
    const out = renderUserscript({ token: 'tk', site: 'douyin#2' });
    expect(out).toContain("token: 'tk'");
    expect(out).toContain("site: 'douyin#2'");
    expect(out).not.toContain('{{');
  });

  it('缺 token 时抛错（不允许产出无法认证的脚本）', () => {
    expect(() => renderUserscript({})).toThrow(/缺少 token/);
    expect(() => renderUserscript({ token: '' })).toThrow(/缺少 token/);
  });

  it('源模板不存在时抛出含路径的错误', () => {
    expect(() => renderUserscript({ token: 'x', sourceFile: '/no/such/file.user.js' }))
      .toThrow(/不可读/);
  });

  it('site 缺省为 douyin.com', () => {
    expect(renderUserscript({ token: 'x' })).toContain("site: 'douyin.com'");
  });

  it('sourcePath 指向仓库内的脚本源码', () => {
    expect(sourcePath().endsWith('scripts/douyin.user.js')).toBe(true);
  });
});
