#!/usr/bin/env node
// server.js — Bridge Server 入口

const http = require('http');
const crypto = require('crypto');

const configModule = require('./core/config');
const logger = require('./core/runtime/logger');
const { ConnectionRegistry } = require('./core/server/registry');
const { WebSocketHub } = require('./core/server/ws-hub');
const { Router } = require('./core/server/router');

// 加载配置 —— 经 core/config 单一真源：自动合并默认值 + 校验。
// 改造前这里在缺 config.json 时直接 exit(1)，实际上除了 token 之外的设置都有合理默认值，
// 没必要拦住启动；现在改为缺文件也能起，缺 token 时自动生成。
const config = configModule.get();

for (const w of configModule.getWarnings()) {
  logger.warn(`[server] 配置告警 ${w.key}: ${w.message}（已回退为 ${JSON.stringify(w.fallback)}）`);
}

// 自动生成 token（如果未配置）。只写用户配置，不把默认值固化进文件。
if (!config.bridge.token) {
  const token = crypto.randomBytes(24).toString('hex');
  configModule.set({ bridge: { token } });
  config.bridge.token = token;
  logger.info(`[server] 已自动生成 access token 并写入 ${configModule.describe().file}`);
}

// 初始化组件
const registry = new ConnectionRegistry();
const wsHub = new WebSocketHub({
  registry,
  port: config.bridge.port,
  host: config.bridge.host,
  heartbeatInterval: config.bridge.heartbeatInterval,
  heartbeatTimeout: config.bridge.heartbeatTimeout,
  heartbeatMaxFailures: config.bridge.heartbeatMaxFailures,
  maxPayload: config.bridge.maxBodySize,
});
const router = new Router({
  registry,
  wsHub,
  requestTimeout: config.bridge.requestTimeout || 30000,
  token: config.bridge.token,
  maxBodySize: config.bridge.maxBodySize,
});

// 创建 HTTP Server
const httpServer = http.createServer((req, res) => {
  router.handle(req, res);
});

// 将 WebSocket attach 到 HTTP Server（共用端口）
wsHub.attach(httpServer);

// 启动监听
const bridgeHost = config.bridge.host;
const bridgePort = config.bridge.port;
httpServer.listen(bridgePort, bridgeHost, () => {
  logger.info(`[server] Bridge Server ready — http://${bridgeHost}:${bridgePort}`);
  logger.info(`[server] Health:  http://${bridgeHost}:${bridgePort}/api/health`);
  logger.info(`[server] Status:  http://${bridgeHost}:${bridgePort}/api/status`);
  logger.info(`[server] WebSocket: ws://${bridgeHost}:${bridgePort}/ws`);
  logger.info('[server] Waiting for Tampermonkey scripts to connect...');
});

// 优雅退出
async function shutdown() {
  logger.info('\n[server] Shutting down...');
  httpServer.close();
  await wsHub.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
