// lib/server/registry.js — 连接注册表（site → connections[]）

const { randomUUID } = require('crypto');

class ConnectionRegistry {
  constructor() {
    /** @type {Map<string, Array<{ id: string, ws: import('ws'), site: string, url: string, title: string, userAgent: string, connectedAt: string, lastActivity: string }>>} */
    this._map = new Map();
  }

  /**
   * 注册新连接
   * @param {string} site
   * @param {import('ws')} ws
   * @param {{ url?: string, title?: string, userAgent?: string }} meta
   * @returns {object} 连接记录
   */
  register(site, ws, meta = {}) {
    const conn = {
      id: randomUUID(),
      ws,
      site,
      url: meta.url || '',
      title: meta.title || '',
      userAgent: meta.userAgent || '',
      connectedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    };

    if (!this._map.has(site)) {
      this._map.set(site, []);
    }
    this._map.get(site).push(conn);

    console.log(`[registry] + ${site} (${conn.id.slice(0, 8)}) — total: ${this._countSite(site)}`);
    return conn;
  }

  /**
   * 清理指定 site 的 HTTP 轮询僵尸连接（ws === null）
   * HTTP 轮询没有 close 事件，页面刷新后旧连接无法被自动清理。
   * 每次 /api/connect 注册新连接前调用此方法，确保不会累积重复条目。
   * @param {string} site
   * @returns {number} 被清理的连接数
   */
  removeStalePolling(site) {
    const conns = this._map.get(site);
    if (!conns || conns.length === 0) return 0;
    const before = conns.length;
    const remaining = conns.filter(c => c.ws !== null); // 保留 WebSocket 连接
    if (remaining.length === 0) {
      this._map.delete(site);
    } else {
      this._map.set(site, remaining);
    }
    const removed = before - remaining.length;
    if (removed > 0) {
      console.log(`[registry] Cleaned ${removed} stale polling connection(s) for ${site}`);
    }
    return removed;
  }

  /**
   * 移除连接（按 ws 对象或 connId）
   */
  unregister(connIdOrWs) {
    for (const [site, conns] of this._map.entries()) {
      const idx = conns.findIndex(
        c => c.id === connIdOrWs || c.ws === connIdOrWs
      );
      if (idx !== -1) {
        const removed = conns.splice(idx, 1)[0];
        console.log(`[registry] - ${site} (${removed.id.slice(0, 8)}) — remaining: ${conns.length}`);
        if (conns.length === 0) {
          this._map.delete(site);
        }
        return removed;
      }
    }
    return null;
  }

  /**
   * 获取某站点的连接（默认返回第一个 alive）
   * @param {string} site
   * @param {number} [index=0]
   * @returns {object|null}
   */
  get(site, index = 0) {
    const conns = this._map.get(site);
    if (!conns || conns.length === 0) return null;
    // WS 优先，HTTP 轮询兜底
    const wsAlive = conns.filter(c => c.ws && c.ws.readyState === 1);
    if (wsAlive.length > 0) return wsAlive[Math.min(index, wsAlive.length - 1)] || null;
    // 无 WS 连接时返回 HTTP 轮询客户端
    return conns[Math.min(index, conns.length - 1)] || null;
  }

  /**
   * 获取某站点所有连接
   */
  getAll(site) {
    return this._map.get(site) || [];
  }

  /**
   * 遍历全部连接（供广播/关闭场景使用，替代外部直读 _map 私有字段）
   * @param {(conn: object) => void} cb
   */
  forEachConnection(cb) {
    for (const conns of this._map.values()) {
      for (const c of conns) cb(c);
    }
  }

  /**
   * 更新连接元信息（URL 变化时）
   */
  updateMeta(connId, meta) {
    for (const conns of this._map.values()) {
      const c = conns.find(x => x.id === connId);
      if (c) {
        if (meta.url) c.url = meta.url;
        if (meta.title) c.title = meta.title;
        c.lastActivity = new Date().toISOString();
        return c;
      }
    }
    return null;
  }

  /**
   * 更新最后活跃时间
   */
  touch(connId) {
    for (const conns of this._map.values()) {
      const c = conns.find(x => x.id === connId);
      if (c) {
        c.lastActivity = new Date().toISOString();
        return;
      }
    }
  }

  /**
   * 获取完整状态快照
   */
  list() {
    const result = {};
    for (const [site, conns] of this._map.entries()) {
      result[site] = conns.map(c => ({
        id: c.id,
        url: c.url,
        title: c.title,
        connectedAt: c.connectedAt,
        lastActivity: c.lastActivity,
        alive: c.ws ? c.ws.readyState === 1 : true,
      }));
    }
    return result;
  }

  /**
   * 总连接数
   */
  get totalConnections() {
    let count = 0;
    for (const conns of this._map.values()) count += conns.length;
    return count;
  }

  _countSite(site) {
    return (this._map.get(site) || []).length;
  }
}

module.exports = { ConnectionRegistry };
