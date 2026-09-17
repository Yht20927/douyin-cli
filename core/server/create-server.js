// core/server/create-server.js — 进程内启动 Bridge Server
//
// 为什么需要这一层
// ----------------
// 改造前启动逻辑写死在 server.js 里：读配置、建组件、listen、注册信号处理，
// 一览子执行完就常驻。桌面应用需要的是**可被调用的服务对象** —— 能拿到实际端口
// （配置为 0 时由系统分配）、能优雅停止（用户退出应用时不能留下孤儿进程）、
// 能报告启动失败（端口被占用要能弹给用户看，而不是静默退出）。
//
// server.js 现在退化为这个模块的薄壳，CLI 与桌面应用走同一份实现。

const http = require('http');

const configModule = require('../config');
const loggerModule = require('../runtime/logger');
const { renderUserscript, sourceExists } = require('../userscript');
const { ConnectionRegistry } = require('./registry');
const { WebSocketHub } = require('./ws-hub');
const { Router } = require('./router');

/** 一键安装油猴脚本的端点路径 */
const USERSCRIPT_PATH = '/install.user.js';

/**
 * 创建（但不启动）Bridge Server。
 *
 * @param {object} [opts]
 * @param {string} [opts.host]   - 监听地址，缺省取配置
 * @param {number} [opts.port]   - 监听端口，缺省取配置；传 0 由系统分配
 * @param {string} [opts.token]  - 访问令牌，缺省取配置
 * @param {object} [opts.logger] - 覆盖 logger（测试用）
 * @returns {object} { start, stop, url, port, host, token, registry, wsHub, router }
 */
function createBridgeServer(opts = {}) {
  const config = opts.config || configModule.get();
  const bridge = config.bridge || {};

  // 用 ?? 而不是 || —— 端口 0 是**合法值**（表示由系统分配空闲端口），
  // 被 || 当成假值替换成 19422 就失去了隔离能力：多个实例会互相抢同一个端口。
  // 测试里这个 bug 表现为一连串 "socket hang up" 与 EADDRINUSE。
  const host = opts.host ?? bridge.host ?? '127.0.0.1';
  let port = opts.port ?? bridge.port ?? 19422;
  const token = opts.token ?? bridge.token ?? '';
  const log = opts.logger || loggerModule.getLogger();

  const registry = new ConnectionRegistry();
  const wsHub = new WebSocketHub({
    registry,
    port,
    host,
    heartbeatInterval: bridge.heartbeatInterval,
    heartbeatTimeout: bridge.heartbeatTimeout,
    heartbeatMaxFailures: bridge.heartbeatMaxFailures,
    maxPayload: bridge.maxBodySize,
  });
  const router = new Router({
    registry,
    wsHub,
    requestTimeout: bridge.requestTimeout || 30000,
    token,
    maxBodySize: bridge.maxBodySize,
  });

  const httpServer = http.createServer((req, res) => {
    // 一键安装端点先于 router —— 它不属于 /api 命名空间，也不需要 token 认证
    if (req.method === 'GET' && req.url.split('?')[0] === USERSCRIPT_PATH) {
      handleUserscript(req, res, token, log);
      return;
    }
    router.handle(req, res);
  });

  // WebSocket 与 HTTP 共用端口
  wsHub.attach(httpServer);

  /** 实际监听端口（传 0 时由系统分配，启动后才知道） */
  let actualPort = port;
  let listening = false;

  // 显式持有自身引用，而不是在方法里用 this ——
  // 调用方很可能写成 `const { start } = server`，那时 this 就丢了。
  const server = {
    host,
    get port() { return actualPort; },
    get listening() { return listening; },
    get url() { return `http://${host}:${actualPort}`; },
    get userscriptUrl() { return `http://${host}:${actualPort}${USERSCRIPT_PATH}`; },
    token,
    registry,
    wsHub,
    router,

    /**
     * 开始监听。可重复调用（已启动则直接返回当前地址）。
     * @returns {Promise<{host:string, port:number, url:string}>}
     * @throws {Error} 端口被占用等启动失败情况（带可读原因）
     */
    start() {
      if (listening) return Promise.resolve({ host, port: actualPort, url: server.url });

      return new Promise((resolve, reject) => {
        const onError = (e) => {
          httpServer.removeListener('listening', onListening);
          if (e.code === 'EADDRINUSE') {
            reject(new Error(`端口 ${port} 已被占用 —— 可能已有一个实例在运行`));
          } else if (e.code === 'EACCES') {
            reject(new Error(`没有权限监听端口 ${port}`));
          } else {
            reject(e);
          }
        };
        const onListening = () => {
          httpServer.removeListener('error', onError);
          listening = true;
          actualPort = httpServer.address().port;
          log.info(`[server] Bridge Server ready — ${server.url}`);
          log.info(`[server] Health:  ${server.url}/api/health`);
          log.info(`[server] 油猴脚本: ${server.userscriptUrl}`);
          resolve({ host, port: actualPort, url: server.url });
        };

        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port, host);
      });
    },

    /** 优雅停止（桌面应用退出时调用，避免留下孤儿监听）。可重复调用。 */
    async stop() {
      if (!listening) return;
      listening = false;
      await new Promise((resolve) => httpServer.close(() => resolve()));
      try { await wsHub.stop(); } catch (e) { /* 已停则忽略 */ }
      log.info('[server] 已停止');
    },
  };

  return server;
}

/**
 * 处理油猴脚本一键安装请求。
 *
 * 安全说明：脚本内含 access token，因此**不设置任何 CORS 响应头** ——
 * 跨源读取会被浏览器自身拦下。服务只监听回环地址，本机进程本就能直接读
 * config.json，故这里不做额外认证（加认证反而会让 Tampermonkey 的
 * "从 URL 安装" 流程走不通）。
 */
function handleUserscript(req, res, token, log) {
  if (!sourceExists()) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('油猴脚本源模板不存在 —— 安装包可能不完整');
    log.error('[server] 油猴脚本源模板缺失，无法提供一键安装');
    return;
  }
  try {
    const script = renderUserscript({ token });
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': Buffer.byteLength(script),
      'Cache-Control': 'no-store',
    });
    res.end(script);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`生成安装脚本失败: ${e.message}`);
    log.error(`[server] 生成安装脚本失败: ${e.message}`);
  }
}

module.exports = { createBridgeServer, USERSCRIPT_PATH };
