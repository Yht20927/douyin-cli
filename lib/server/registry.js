// lib/server/registry.js — 连接注册表（channel → connections[]）
//
// 多账号：一个浏览器连接的身份 = 站点 + 登录账号（channel）。
//   channel = `${site}#${account}`，account 为空串 = 已连上但未识别出登录账号。
// 同 site 的多个账号因此天然落在不同的桶里，互不干扰。

const { randomUUID } = require('crypto');
const { channelOf } = require('../shared/protocol');

class ConnectionRegistry {
  constructor() {
    /**
     * @type {Map<string, Array<{
     *   id: string, ws: import('ws'), site: string, account: string, channel: string,
     *   url: string, title: string, userAgent: string,
     *   connectedAt: string, lastActivity: string,
     *   lastServedAt: number, lastWriteAt: number
     * }>>}
     */
    this._map = new Map();
  }

  /**
   * 注册新连接
   * @param {string} site
   * @param {import('ws')} ws
   * @param {{ account?: string, url?: string, title?: string, userAgent?: string }} meta
   * @returns {object} 连接记录
   */
  register(site, ws, meta = {}) {
    const account = typeof meta.account === 'string' ? meta.account : '';
    const channel = channelOf(site, account);
    const now = Date.now();

    const conn = {
      id: randomUUID(),
      ws,
      site,
      account,
      // 平台昵称，仅用于展示（人工/agent 一眼认出是哪个号）。拿不到就是空串。
      nickname: typeof meta.nickname === 'string' ? meta.nickname : '',
      // 油猴脚本上报的注册契约版本。null = 旧脚本根本没这个字段
      // （用来一眼区分"浏览器里跑的是旧脚本"和"新脚本但探测失败"）
      clientVersion: typeof meta.clientVersion === 'number' ? meta.clientVersion : null,
      channel,
      url: meta.url || '',
      title: meta.title || '',
      userAgent: meta.userAgent || '',
      connectedAt: new Date(now).toISOString(),
      lastActivity: new Date(now).toISOString(),
      lastServedAt: 0,
      lastWriteAt: 0,
    };

    if (!this._map.has(channel)) {
      this._map.set(channel, []);
    }
    this._map.get(channel).push(conn);

    // 连接的身份就是账号（channel 里带 uid），不再打印无意义的 UUID 前缀
    console.log(`[registry] + ${channel} — total: ${this._countChannel(channel)}`);
    return conn;
  }

  /**
   * 清理指定 channel 的 HTTP 轮询僵尸连接（ws === null）。
   * HTTP 轮询没有 close 事件，页面刷新后旧连接无法被自动清理。
   *
   * 作用域必须是 channel 而不是 site：多账号下每个账号都是一个独立的轮询客户端，
   * 按 site 清理会把别的账号一并删掉（第二个账号一连上就踢掉第一个）。
   * @param {string} site
   * @param {string} [account]
   * @returns {number} 被清理的连接数
   */
  removeStalePolling(site, account = '') {
    const channel = channelOf(site, account);
    const conns = this._map.get(channel);
    if (!conns || conns.length === 0) return 0;
    const before = conns.length;
    const remaining = conns.filter(c => c.ws !== null); // 保留 WebSocket 连接
    if (remaining.length === 0) {
      this._map.delete(channel);
    } else {
      this._map.set(channel, remaining);
    }
    const removed = before - remaining.length;
    if (removed > 0) {
      console.log(`[registry] Cleaned ${removed} stale polling connection(s) for ${channel}`);
    }
    return removed;
  }

  /**
   * 移除连接（按 ws 对象或 connId）
   */
  unregister(connIdOrWs) {
    for (const [channel, conns] of this._map.entries()) {
      const idx = conns.findIndex(
        c => c.id === connIdOrWs || c.ws === connIdOrWs
      );
      if (idx !== -1) {
        const removed = conns.splice(idx, 1)[0];
        console.log(`[registry] - ${channel} — remaining: ${conns.length}`);
        if (conns.length === 0) {
          this._map.delete(channel);
        }
        return removed;
      }
    }
    return null;
  }

  /**
   * 按 channel 精确取连接。找不到返回 null。
   *
   * 刻意不做「越界取最后一个」的兜底：多账号下那等于静默把请求派给别的账号，
   * 比报错危险得多。指定了账号就要么命中、要么明确失败。
   * @param {string} channel
   * @returns {object|null}
   */
  getByChannel(channel) {
    const conns = this._map.get(channel);
    if (!conns || conns.length === 0) return null;
    // WS 优先，HTTP 轮询兜底
    const wsAlive = conns.filter(c => c.ws && c.ws.readyState === 1);
    if (wsAlive.length > 0) return wsAlive[0];
    return conns[0];
  }

  /**
   * 按 (site, account) 取连接。
   * @param {string} site
   * @param {string} [account]
   */
  getAccount(site, account = '') {
    return this.getByChannel(channelOf(site, account));
  }

  /**
   * 某站点下所有账号的连接（跨 channel 打平）。
   * @param {string} site
   * @returns {object[]}
   */
  listBySite(site) {
    const out = [];
    for (const [channel, conns] of this._map.entries()) {
      for (const c of conns) {
        if (c.site === site) out.push(c);
      }
    }
    return out;
  }

  /** 某站点下所有存活连接（含未识别账号的） */
  aliveOf(site) {
    return this.listBySite(site).filter(c => this._isAlive(c));
  }

  /**
   * 该站点当前在线的账号列表（去重），供轮换与错误提示使用。
   * 空账号的连接一律不计入——握手已强制 account 非空，这里只是兜底。
   * @param {string} site
   * @returns {Array<{account: string, channel: string, connId: string, lastServedAt: number, lastWriteAt: number}>}
   */
  accountsOf(site) {
    const seen = new Map();
    for (const c of this.listBySite(site)) {
      if (!this._isAlive(c)) continue;
      if (!c.account) continue;
      // 同账号多连接（同容器多标签页）：保留最近活跃的那条作为代表
      const prev = seen.get(c.account);
      if (!prev || c.lastActivity > prev.lastActivity) {
        seen.set(c.account, {
          account: c.account,
          nickname: c.nickname || '',
          clientVersion: c.clientVersion,
          channel: c.channel,
          connId: c.id,
          lastServedAt: c.lastServedAt,
          lastWriteAt: c.lastWriteAt,
        });
      }
    }
    return [...seen.values()];
  }

  /**
   * 为读操作挑一个账号：轮询 + 每号独立冷却。
   *
   * 规则：在在线且已识别账号的连接里，取 lastServedAt 最早的（等价于轮询）；
   * 若该连接还在冷却窗口内（刚被读过 / 刚写过），则退而取次早的；
   * 全部都还在冷却中时退化为取最早的那条——读操作是 advisory 的，不阻塞。
   * @param {string} site
   * @param {number} [cooldownMs] 单账号读完后的静默期
   * @returns {object|null} 选中的连接
   */
  pickForRead(site, cooldownMs = 15000) {
    const candidates = this.listBySite(site).filter(c => this._isAlive(c) && c.account);
    if (candidates.length === 0) return null;

    const now = Date.now();
    const byLru = candidates.slice().sort((a, b) => a.lastServedAt - b.lastServedAt);

    // 一档：没被读过、也没被写过（写后冷却期通常更长，用写间隔下限兜底）
    const fresh = byLru.find(c => this._isReadEligible(c, now, cooldownMs));
    return fresh || byLru[0];
  }

  /** 标记某连接刚服务过一次读请求 */
  markServed(connId) {
    const c = this._find(connId);
    if (c) c.lastServedAt = Date.now();
  }

  /** 标记某连接刚执行过一次写操作（读轮换会因此把它排到后面） */
  markWrite(connId) {
    const c = this._find(connId);
    if (c) c.lastWriteAt = Date.now();
  }

  /**
   * 身份后到：把连接从旧 channel 桶搬到新 channel 桶。
   * 油猴先以 account='' 注册保证不断线，探测到 uid 后再挪。
   * @param {string} connId
   * @param {string} account
   * @returns {object|null} 更新后的连接
   */
  updateAccount(connId, account) {
    const next = typeof account === 'string' ? account : '';
    const c = this._find(connId);
    if (!c) return null;
    if (c.account === next) return c;

    this.unregister(connId);
    const moved = this.register(c.site, c.ws, {
      account: next,
      nickname: c.nickname,
      clientVersion: c.clientVersion,
      url: c.url,
      title: c.title,
      userAgent: c.userAgent,
    });
    // 保留原 id：油猴端的 connId 不变，否则它的 poll/touch 会失联
    moved.id = connId;
    moved.connectedAt = c.connectedAt;
    moved.lastServedAt = c.lastServedAt;
    moved.lastWriteAt = c.lastWriteAt;
    return moved;
  }

  /**
   * 更新连接元信息（URL 变化 / 重握手时）
   */
  updateMeta(connId, meta) {
    const c = this._find(connId);
    if (!c) return null;
    if (meta.url) c.url = meta.url;
    if (meta.title) c.title = meta.title;
    if (typeof meta.nickname === 'string' && meta.nickname) c.nickname = meta.nickname;
    if (typeof meta.clientVersion === 'number') c.clientVersion = meta.clientVersion;
    if (typeof meta.account === 'string' && meta.account !== c.account) {
      return this.updateAccount(connId, meta.account);
    }
    c.lastActivity = new Date().toISOString();
    return c;
  }

  /**
   * 更新最后活跃时间
   */
  touch(connId) {
    const c = this._find(connId);
    if (c) c.lastActivity = new Date().toISOString();
  }

  /**
   * 获取完整状态快照（按 site 分组，每条含账号信息）
   */
  list() {
    const result = {};
    for (const conns of this._map.values()) {
      for (const c of conns) {
        if (!result[c.site]) result[c.site] = [];
        result[c.site].push({
          id: c.id,
          account: c.account,
          nickname: c.nickname || '',
          clientVersion: c.clientVersion,
          channel: c.channel,
          url: c.url,
          title: c.title,
          connectedAt: c.connectedAt,
          lastActivity: c.lastActivity,
          lastServedAt: c.lastServedAt,
          lastWriteAt: c.lastWriteAt,
          alive: this._isAlive(c),
        });
      }
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

  // ── 内部 ──

  _isAlive(c) {
    return c.ws ? c.ws.readyState === 1 : true; // HTTP 轮询连接没有 ws，靠 connect 存活
  }

  _isReadEligible(c, now, cooldownMs) {
    if (c.lastServedAt && now - c.lastServedAt < cooldownMs) return false;
    // 刚写过这个号的窗口内不再派读：写后立刻读会放大该账号的请求密度
    if (c.lastWriteAt && now - c.lastWriteAt < cooldownMs) return false;
    return true;
  }

  _find(connId) {
    for (const conns of this._map.values()) {
      const c = conns.find(x => x.id === connId);
      if (c) return c;
    }
    return null;
  }

  _countChannel(channel) {
    return (this._map.get(channel) || []).length;
  }
}

module.exports = { ConnectionRegistry };
