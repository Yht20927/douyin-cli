// core/server/registry.js — 连接注册表（site → connections[]）
//
// 通道只有一条：**HTTP 长轮询**。原先并存的 WebSocket 通道（core/server/ws-hub.js）
// 已删除 —— 油猴脚本从未使用它，且它的 hello 握手既不校验 token 也不校验来源。
//
// 长轮询**没有 close 事件**：页面被关掉、被刷新、网络断掉，服务端不会收到任何通知。
// 因此存活只能靠"最后活跃时间"推断：油猴脚本在长轮询返回后会立刻再发起下一次
// （router 侧 25 秒超时），所以健康客户端的 lastActivity 至少每 25 秒被 touch 一次。
// 超过阈值没动静，就判定它已经死了。
//
// 改造前这里是 `alive: c.ws ? c.ws.readyState === 1 : true` —— 长轮询一律 true，
// 于是关掉抖音页面后界面永远显示"已连接"，离线告警完全失效。

const { randomUUID } = require('crypto');
const logger = require('../runtime/logger');
const { normalizeAccount } = require('../shared/protocol');

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
    /** @type {Map<string, Array<{ id: string, site: string, url: string, title: string, userAgent: string, account: object|null, clientVersion: number|null, connectedAt: string, lastActivity: string }>>} */
    this._map = new Map();
    this.staleAfterMs = options.staleAfterMs || DEFAULT_STALE_AFTER_MS;
  }

  /**
   * 连接是否还活着 —— 只看最后一次轮询距现在多久。
   * @param {object} conn
   * @returns {boolean}
   */
  isAlive(conn) {
    const age = Date.now() - new Date(conn.lastActivity).getTime();
    return age <= this.staleAfterMs;
  }

  /**
   * 注册新连接
   * @param {string} site
   * @param {{ url?: string, title?: string, userAgent?: string, account?: object, clientVersion?: number }} meta
   * @returns {object} 连接记录
   */
  register(site, meta = {}) {
    const conn = {
      id: randomUUID(),
      site,
      url: meta.url || '',
      title: meta.title || '',
      userAgent: meta.userAgent || '',
      // 登录账号信息（昵称/头像）。取不到（旧版脚本、未登录、抓取失败）时为 null，
      // 界面按"未识别账号"处理，不能让缺账号影响连接本身。
      account: normalizeAccount(meta.account),
      // 脚本能力版本（≥2 才会上报账号）。用来区分"旧脚本"与"新脚本但识别失败"，
      // 界面据此给出不同的修正指引。旧脚本没这个字段，归 null。
      clientVersion: typeof meta.clientVersion === 'number' ? meta.clientVersion : null,
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
   * 清理指定 site 的全部旧连接记录
   * 长轮询没有 close 事件，页面刷新后旧连接无法被自动清理。
   * 每次 /api/connect 注册新连接前调用此方法，确保不会累积重复条目。
   * @param {string} site
   * @returns {number} 被清理的连接数
   */
  removeStalePolling(site) {
    const conns = this._map.get(site);
    if (!conns || conns.length === 0) return 0;
    this._map.delete(site);
    logger.info(`[registry] Cleaned ${conns.length} stale polling connection(s) for ${site}`);
    return conns.length;
  }

  /**
   * 移除连接（按 connId）
   */
  unregister(connId) {
    for (const [site, conns] of this._map.entries()) {
      const idx = conns.findIndex(c => c.id === connId);
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
    // 优先挑活着的（按最后活跃时间判定）。
    // 全都不活时仍返回一个（保持既有行为：让请求走队列并最终超时，
    // 调用方拿到的是"超时"而不是"找不到站点"）。
    const alive = conns.filter(c => this.isAlive(c));
    if (alive.length > 0) return alive[Math.min(index, alive.length - 1)] || null;
    return conns[Math.min(index, conns.length - 1)] || null;
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
        account: c.account,
        clientVersion: c.clientVersion,
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
