// lib/cdp.js — CDP WebSocket 工具函数
const WebSocket = require('ws');

class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this._counter = 0;
    this._pending = new Map();
    this._events = new Map();

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // 响应消息
        if (msg.id && this._pending.has(msg.id)) {
          const { resolve, reject, timer } = this._pending.get(msg.id);
          clearTimeout(timer);
          this._pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
        // 事件消息
        if (msg.method && this._events.has(msg.method)) {
          for (const handler of this._events.get(msg.method)) {
            handler(msg.params || {}, msg);
          }
        }
      } catch(e) {}
    });
  }

  async send(method, params = {}, sessionId) {
    const id = ++this._counter;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, 30000);
      this._pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }

  on(eventName, handler) {
    if (!this._events.has(eventName)) this._events.set(eventName, new Set());
    this._events.get(eventName).add(handler);
  }

  close() { try { this.ws.close(); } catch(e) {} }
}

module.exports = { CDPClient };
