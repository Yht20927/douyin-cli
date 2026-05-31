// lib/daemon.js — Daemon 健壮性：PID 锁、重连、页面感知、心跳
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { CDPClient } = require('./cdp');

const PID_FILE = path.join(__dirname, '..', '.douyin_daemon.pid');

// ===== PID 锁（JSON 格式，含启动时间，僵尸检测） =====
function acquireLock() {
  if (fs.existsSync(PID_FILE)) {
    try {
      const content = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
      const oldPid = content.pid;
      try {
        process.kill(oldPid, 0);
        const age = Date.now() - (content.started || 0);
        if (age > 24 * 60 * 60 * 1000) {
          console.error(`[daemon] Stale daemon (pid ${oldPid}, ${Math.round(age/3600000)}h), taking over`);
          try { process.kill(oldPid, 'SIGTERM'); } catch {}
        } else {
          console.log('Daemon already running.');
          process.exit(0);
        }
      } catch(e) {
        console.error('[daemon] Stale PID file, cleaning');
      }
    } catch(e) {
      console.error('[daemon] Corrupt PID file, cleaning');
    }
  }

  fs.writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, started: Date.now() }));
}

function releaseLock() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

// ===== 指数退避重连管理器 =====
class ReconnectManager {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 5;
    this.initialDelay = options.initialDelay || 1000;
    this.maxDelay = options.maxDelay || 30000;
    this.backoffFactor = options.backoffFactor || 2;
    this.retryCount = 0;
  }

  async attempt(connectFn) {
    while (this.retryCount < this.maxRetries) {
      const delay = Math.min(
        this.initialDelay * Math.pow(this.backoffFactor, this.retryCount),
        this.maxDelay
      );
      console.error(`[daemon] Reconnect ${this.retryCount + 1}/${this.maxRetries} in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      try {
        const result = await connectFn();
        this.reset();
        return result;
      } catch(e) {
        this.retryCount++;
        console.error(`[daemon] Reconnect failed: ${e.message}`);
      }
    }
    throw new Error(`Failed to reconnect after ${this.maxRetries} attempts`);
  }

  reset() { this.retryCount = 0; }
}

// ===== 页面感知（监控导航事件） =====
class PageMonitor {
  constructor(state) {
    this.state = state; // shared { value: 'running'|'paused'|'recovering' }
  }

  handleNavigation(cdp, url) {
    const isDouyin = url && url.includes('douyin.com');
    if (!isDouyin && this.state.value === 'running') {
      this.state.value = 'paused';
      console.error('[daemon] Page left Douyin, pausing');
    } else if (isDouyin && (this.state.value === 'paused' || this.state.value === 'recovering')) {
      this.state.value = 'running';
      console.error('[daemon] Returned to Douyin, resuming');
    }
  }

  async verifyBridge(cdp, sessionId) {
    try {
      const result = await cdp.send('Runtime.evaluate', {
        expression: 'typeof window.__dy === "object"',
        returnByValue: true,
      }, sessionId);
      return result.result?.value === true;
    } catch { return false; }
  }
}

// ===== 心跳检测 =====
class HeartbeatMonitor {
  constructor(options = {}) {
    this.interval = options.interval || 60000;
    this.failureThreshold = options.failureThreshold || 3;
    this.consecutiveFailures = 0;
    this.timer = null;
    this.onConnectionLost = null;
  }

  start(cdp, sessionId) {
    this.timer = setInterval(async () => {
      try {
        await cdp.send('Runtime.evaluate', {
          expression: '1', returnByValue: true,
        }, sessionId);
        this.consecutiveFailures = 0;
      } catch(e) {
        this.consecutiveFailures++;
        console.error(`[daemon] Heartbeat fail ${this.consecutiveFailures}/${this.failureThreshold}: ${e.message}`);
        if (this.consecutiveFailures >= this.failureThreshold) {
          console.error('[daemon] Connection lost, triggering reconnect');
          if (this.onConnectionLost) this.onConnectionLost();
        }
      }
    }, this.interval);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

module.exports = { acquireLock, releaseLock, ReconnectManager, PageMonitor, HeartbeatMonitor };
