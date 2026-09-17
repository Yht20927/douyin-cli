#!/usr/bin/env node
// server.js — Bridge Server 独立启动入口（薄壳）
//
// 真正的实现在 core/server/create-server.js —— 桌面应用由主进程进程内启动同一份实现，
// 两条路径行为一致。本文件只负责：读配置、缺 token 时生成、启动、等待退出信号。

const crypto = require('crypto');

const configModule = require('./core/config');
const loggerModule = require('./core/runtime/logger');
const { createBridgeServer } = require('./core/server/create-server');

// 独立运行时日志走 console（诊断→stderr，保持与改造前一致的输出流）
loggerModule.configure({
  sinks: [loggerModule.consoleSink(), loggerModule.fileSink()],
  level: loggerModule.defaultLevel(),
});
const log = loggerModule.getLogger();

const config = configModule.get();

for (const w of configModule.getWarnings()) {
  log.warn(`[server] 配置告警 ${w.key}: ${w.message}（已回退为 ${JSON.stringify(w.fallback)}）`);
}

// 缺 token 时自动生成并写回用户配置（不把默认值固化进文件）。
// 桌面应用不会走这条 —— 它由首次启动向导显式生成。
if (!config.bridge.token) {
  const token = crypto.randomBytes(24).toString('hex');
  configModule.set({ bridge: { token } });
  config.bridge.token = token;
  log.info(`[server] 已自动生成 access token 并写入 ${configModule.describe().file}`);
}

const server = createBridgeServer({ config });

server.start().then(({ url }) => {
  log.info('[server] Waiting for Tampermonkey scripts to connect...');
  log.info(`[server] 没装脚本？打开 ${url}/install.user.js 一键安装`);
}).catch((e) => {
  log.error(`[server] 启动失败: ${e.message}`);
  process.exit(1);
});

async function shutdown() {
  log.info('\n[server] Shutting down...');
  await server.stop();
  loggerModule.getLogger().close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
