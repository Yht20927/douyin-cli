// lib/server/ws-hub.js — WebSocket Server 初始化 + 连接池 + 心跳

const { WebSocketServer } = require('ws');
const { WS_CLIENT_MSG, WS_SERVER_MSG, validateHello, validateResult } = require('../shared/protocol');

class WebSocketHub {
  /**
   * @param {object} options
   * @param {import('./registry').ConnectionRegistry} options.registry
   * @param {number} options.heartbeatInterval
   * @param {number} options.heartbeatTimeout
   * @param {number} options.heartbeatMaxFailures
   */
  constructor(options) {
    this.registry = options.registry;
    this.heartbeatInterval = options.heartbeatInterval || 30000;
    this.heartbeatTimeout = options.heartbeatTimeout || 10000;
    this.heartbeatMaxFailures = options.heartbeatMaxFailures || 3;
    // WebSocket 单条消息上限，与 HTTP 请求体上限保持一致（默认 64MB）
    this.maxPayload = options.maxPayload || 64 * 1024 * 1024;

    /** @type {Map<string, { failures: number, timer: NodeJS.Timeout|null }>} */
    this._heartbeats = new Map();

    /** @type {WebSocketServer|null} */
    this._wss = null;

    /** @type {Map<string, Set<Function>>} */
    this._events = new Map();
  }

  /**
   * 将 WebSocket Server attach 到已有的 HTTP Server（共用端口）
   * @param {import('http').Server} httpServer
   */
  attach(httpServer) {
    this._wss = new WebSocketServer({ server: httpServer, maxPayload: this.maxPayload });

    // Chrome Private Network Access: 允许公网站点连接 localhost WebSocket
    this._wss.on('headers', (headers) => {
      headers.push('Access-Control-Allow-Private-Network: true');
    });

    this._wss.on('connection', (ws) => {
      let connId = null;
      let site = null;

      // 等待第一条消息（必须是 hello）
      const helloTimeout = setTimeout(() => {
        console.error('[ws-hub] Connection did not send hello in time, closing');
        ws.close(4001, 'hello timeout');
      }, 10000);

      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch (e) {
          console.error('[ws-hub] Invalid JSON from client');
          return;
        }

        // 第一条消息必须是 hello
        if (!connId) {
          if (msg.type !== WS_CLIENT_MSG.HELLO) {
            console.error(`[ws-hub] First message must be hello, got "${msg.type}"`);
            ws.close(4002, 'hello required first');
            return;
          }
          clearTimeout(helloTimeout);

          const result = validateHello(msg);
          if (!result.valid) {
            console.error(`[ws-hub] Invalid hello: ${result.error}`);
            ws.close(4003, result.error);
            return;
          }

          site = result.data.site;
          const conn = this.registry.register(site, ws, result.data);
          connId = conn.id;

          // 启动心跳
          this._startHeartbeat(connId, ws);

          // 心跳响应
          return; // hello 不触发后续处理
        }

        // 后续消息处理
        switch (msg.type) {
          case WS_CLIENT_MSG.PONG:
            this._handlePong(connId);
            break;

          case WS_CLIENT_MSG.HELLO:
            // 重新握手（SPA 导航后 URL 变化）
            this.registry.updateMeta(connId, {
              url: msg.url,
              title: msg.title,
            });
            break;

          case WS_CLIENT_MSG.RESULT: {
            const vr = validateResult(msg);
            if (vr.valid) {
              this.registry.touch(connId);
              // result 由 router 的 pending 机制处理
              this.emit('result', msg);
            }
            break;
          }

          default:
            this.registry.touch(connId);
        }
      });

      ws.on('close', () => {
        if (connId) {
          this._stopHeartbeat(connId);
          this.registry.unregister(connId);
        } else {
          clearTimeout(helloTimeout);
        }
      });

      ws.on('error', (err) => {
        console.error(`[ws-hub] WebSocket error (${connId || 'unregistered'}): ${err.message}`);
      });
    });

    this._wss.on('error', (err) => {
      console.error(`[ws-hub] Server error: ${err.message}`);
    });

    console.error(`[ws-hub] Attached to HTTP server`);
  }

  /**
   * 向指定连接发送 eval 指令
   */
  sendEval(conn, msgId, expression, awaitPromise) {
    conn.ws.send(JSON.stringify({
      type: WS_SERVER_MSG.EVAL,
      id: msgId,
      expression,
      awaitPromise: awaitPromise !== false,
    }));
  }

  /**
   * 关闭 WebSocket Server
   */
  async stop() {
    // 向所有连接发送 bye（经由 registry 公开接口，不触碰其私有字段）
    this.registry.forEachConnection((c) => {
      try {
        c.ws.send(JSON.stringify({ type: WS_SERVER_MSG.BYE, reason: 'server_shutdown' }));
      } catch (e) { /* ignore */ }
    });

    // 停止所有心跳
    for (const [, hb] of this._heartbeats.entries()) {
      if (hb.timer) clearInterval(hb.timer);
    }
    this._heartbeats.clear();

    return new Promise((resolve) => {
      if (this._wss) {
        this._wss.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  // ── 事件系统（简单实现） ──
  on(event, handler) {
    if (!this._events.has(event)) this._events.set(event, new Set());
    this._events.get(event).add(handler);
  }

  emit(event, data) {
    const handlers = this._events.get(event);
    if (handlers) {
      for (const h of handlers) h(data);
    }
  }

  // ── 心跳 ──
  _startHeartbeat(connId, ws) {
    const timer = setInterval(() => {
      if (ws.readyState !== 1) {
        this._stopHeartbeat(connId);
        return;
      }

      const hb = this._heartbeats.get(connId);
      if (hb && hb.failures >= this.heartbeatMaxFailures) {
        console.error(`[ws-hub] Heartbeat lost for ${connId.slice(0, 8)}, closing`);
        this._stopHeartbeat(connId);
        try { ws.close(4004, 'heartbeat lost'); } catch (e) { /* */ }
        return;
      }

      // 每次发出 ping 后先记一次"未应答"；收到 pong（_handlePong）才清零。
      // 半开 TCP 连接 readyState 恒为 OPEN 且 send 不报错，
      // 若没有这个递增，heartbeatMaxFailures 永远不会触发、僵死连接无法被剔除。
      if (hb) hb.failures++;

      try {
        ws.send(JSON.stringify({ type: WS_SERVER_MSG.PING }));
      } catch (e) {
        this._stopHeartbeat(connId);
      }
    }, this.heartbeatInterval);

    this._heartbeats.set(connId, { failures: 0, timer });
  }

  _stopHeartbeat(connId) {
    const hb = this._heartbeats.get(connId);
    if (hb) {
      if (hb.timer) clearInterval(hb.timer);
      this._heartbeats.delete(connId);
    }
  }

  _handlePong(connId) {
    const hb = this._heartbeats.get(connId);
    if (hb) {
      hb.failures = 0; // 重置失败计数
    }
    this.registry.touch(connId);
  }
}

module.exports = { WebSocketHub };
