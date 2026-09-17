// core/server/registry.js — 连接注册表（site → connections[]）
//
// 两条连接通道：
//   - WebSocket：页面刷新/关闭有 close 事件，`readyState` 就能判断死活
//   - HTTP 长轮询（生产实际走这条）：**没有 close 事件**，页面被关掉后
//     服务端不会收到任何通知
//
// 因此长轮询连接的存活必须靠"最后活跃时间"推断：油猴脚本在长轮询返回后
// 会立刻再发起下一次（router 侧 25 秒超时），所以健康客户端的 lastActivity
// 至少每 25 秒被 touch 一次。超过阈值没动静，就判定它已经死了。
//
// 改造前这里是 `alive: c.ws ? c.ws.readyState === 1 : true` —— 长轮询一律 true，
// 于是关掉抖音页面后界面永远显示"已连接"，离线告警完全失效。

const { randomUUID } = require('crypto');
const logger = require('../runtime/logger');

/**
 * 长轮询连接多久没活跃就判定死亡。
 * 依据：router 的 /api/poll 长轮询超时是 25 秒，健康客户端每 ≤25 秒 touch 一次，
 * 45 秒留出接近一倍的余量（覆盖网络抖动与客户端重连退避的初始阶段）。
 */
const DEFAULT_STALE_AFTER_MS = 45000;

class ConnectionRegistry {
  /**
   * @param {object} [options]
   * @param {number} [options.staleAfterMs] - 长轮询连接的失活阈值（测试可注入短值）
   */
  constructor(options = {}) {
    /** @type {Map<string, Array<{ id: string, ws: import('ws'), site: string, url: string, title: string, userAgent: string, connectedAt: string, lastActivity: string }>>} */
    this._map = new Map();
    this.staleAfterMs = options.staleAfterMs || DEFAULT_STALE_AFTER_MS;
  }

  /**
   * 连接是否还活着。
   * @param {object} conn
   * @returns {boolean}
   */
  isAlive(conn) {
    if (conn.ws) return conn.ws.readyState === 1;
    const age = Date.now() - new Date(conn.lastActivity).getTime();
    return age <= this.staleAfterMs;
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

    logger.info(`[registry] + ${site} (${conn.id.slice(0, 8)}) — total: ${this._countSite(site)}`);
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
      logger.info(`[registry] Cleaned ${removed} stale polling connection(s) for ${site}`);
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
        logger.info(`[registry] - ${site} (${removed.id.slice(0, 8)}) — remaining: ${conns.length}`);
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
    // 优先挑活着的：WS 通道天然优先，长轮询则看最后活跃时间。
    // 全都不活时仍返回一个（保持既有行为：让请求走队列并最终超时，
    // 调用方拿到的是"超时"而不是"找不到站点"）。
    const alive = conns.filter(c => this.isAlive(c));
    if (alive.length > 0) return alive[Math.min(index, alive.length - 1)] || null;
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
        alive: this.isAlive(c),
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
