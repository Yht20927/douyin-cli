// app/main/bridge-manager.js — 内嵌 Bridge Server 的启停与连接健康监测
//
// 两件事：
//   1. 进程内启动 Bridge Server（复用 core/server/create-server.js）
//   2. 周期性轮询 /api/status，把"油猴脚本是否连上"变成界面上一条可见的状态
//
// 为什么要在主进程轮询而不是让渲染层自己拉：
//   - 渲染层不应该知道服务端口、token 这些细节
//   - 离线判定需要跨轮询累积状态（连续多久没有活跃连接），放在一处更清楚
//   - 后续托盘图标、系统通知都要用同一份状态

const { BridgeClient } = require('../../core/client/bridge-client');
const { createBridgeServer } = require('../../core/server/create-server');
const configModule = require('../../core/config');
const loggerModule = require('../../core/runtime/logger');

/**
 * @param {object} opts
 * @param {object} opts.config  - 配置快照
 * @returns {object} manager
 */
function createBridgeManager(opts = {}) {
  const log = loggerModule.getLogger();
  const config = opts.config || configModule.get();
  const watchCfg = (config.bridge && config.bridge.connectionWatch) || {};
  const pollIntervalMs = (watchCfg.pollIntervalSec || 5) * 1000;
  const offlineAlertMs = (watchCfg.offlineAlertSec || 60) * 1000;

  let server = null;
  let client = null;
  let timer = null;
  /** 最近一次观测到活跃连接的时间戳 */
  let lastSeenAt = 0;
  /** 最近一次轮询结果（供界面立即取值，不必等下一次推送） */
  let lastStatus = {
    listening: false,
    url: '',
    userscriptUrl: '',
    online: false,
    offlineForMs: 0,
    connections: [],
    totalConnections: 0,
    error: null,
  };
  /** 状态变化回调（主进程用它更新托盘与窗口） */
  const listeners = new Set();

  function emit() {
    // 用 lastStatus 而不是 getStatus() —— 后者是返回对象上的方法，
    // **不在本函数作用域内**。这里曾经写成 getStatus()，抛出的 ReferenceError
    // 又被下面的 catch 吞掉，表现为"订阅者永远收不到状态"，
    // 而 getStatus() 却是对的（轮询正常），极难定位。
    const snapshot = { ...lastStatus };
    for (const fn of listeners) {
      try {
        fn(snapshot);
      } catch (e) {
        // 隔离监听方异常，但**必须留痕**：静默 catch 会连自己的编程错误一起藏起来
        log.warn(`[bridge] 状态监听回调出错: ${e.message}`);
      }
    }
  }

  /** 从 /api/status 的响应里取出活跃连接 */
  function extractConnections(status) {
    if (!status || !status.connections) return [];
    const out = [];
    for (const [site, conns] of Object.entries(status.connections)) {
      for (const c of (conns || [])) {
        out.push({
          site,
          id: c.id,
          url: c.url,
          title: c.title,
          alive: c.alive !== false,
          lastActivity: c.lastActivity,
        });
      }
    }
    return out;
  }

  async function poll() {
    if (!server || !server.listening) return;
    try {
      const status = await client.status();
      const connections = extractConnections(status);
      const hasLive = connections.some(c => c.alive);

      if (hasLive) lastSeenAt = Date.now();

      const offlineForMs = lastSeenAt ? Date.now() - lastSeenAt : 0;
      // 从未连上过时不算"离线告警"，只显示"等待连接"
      const online = hasLive;
      const shouldAlert = !hasLive && lastSeenAt > 0 && offlineForMs >= offlineAlertMs;

      const next = {
        listening: true,
        url: server.url,
        userscriptUrl: server.userscriptUrl,
        online,
        offlineForMs,
        alert: shouldAlert,
        connections,
        // 只数活着的 —— 长轮询没有 close 事件，死连接会一直躺在注册表里
        // （见 core/server/registry.js 的 isAlive）
        totalConnections: connections.filter(c => c.alive).length,
        error: null,
      };

      if (JSON.stringify(next) !== JSON.stringify(lastStatus)) {
        lastStatus = next;
        emit();
      }
    } catch (e) {
      // 轮询失败通常意味着服务刚停或端口被别的进程接管
      const next = {
        ...lastStatus,
        listening: server ? server.listening : false,
        online: false,
        error: e.message,
      };
      if (JSON.stringify(next) !== JSON.stringify(lastStatus)) {
        lastStatus = next;
        emit();
      }
    }
  }

  return {
    /**
     * 启动内嵌服务。
     * @returns {Promise<{host:string, port:number, url:string}>}
     * @throws {Error} 端口占用等启动失败（调用方负责展示给用户）
     */
    async start() {
      server = createBridgeServer({ config, logger: log });
      const info = await server.start();
      client = new BridgeClient({ host: server.host, port: server.port, token: server.token });

      lastStatus = {
        ...lastStatus,
        listening: true,
        url: server.url,
        userscriptUrl: server.userscriptUrl,
      };
      emit();

      timer = setInterval(poll, pollIntervalMs);
      if (timer.unref) timer.unref();
      await poll();
      return info;
    },

    async stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (server) { await server.stop(); server = null; }
      lastStatus = { ...lastStatus, listening: false, online: false };
      emit();
    },

    /** 立即轮询一次（界面点"重新检测"时用） */
    refresh() { return poll(); },

    getStatus() { return { ...lastStatus }; },

    /** 订阅状态变化，返回取消订阅函数 */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** 一键安装地址（界面展示与"用浏览器打开"用） */
    getUserscriptUrl() { return server ? server.userscriptUrl : ''; },
  };
}

module.exports = { createBridgeManager };
