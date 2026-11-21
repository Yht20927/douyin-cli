// core/server/registry.js — 连接注册表（channel → connections[]）
//
// 多账号（从 main 分支移植）
// -------------------------
// 一个浏览器连接的身份 = 站点 + 登录账号：channel = `site#uid`（uid 为空时是 site）。
// 同 site 的多个账号落在不同的桶里，轮询队列/等待者按 channel 分桶后互不干扰。
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
const {
  channelOf,
  coerceConnAccount,
} = require('../shared/protocol');

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
   * 注册新连接。
   *
   * 兼容三种调用形状：
   *   register(site, meta)        —— 桌面端既有写法
   *   register(site, ws, meta)    —— main 分支/旧 WebSocket 写法
   *   register(site)              —— 测试与最小调用
   *
   * @param {string} site
   * @param {object|null} [wsOrMeta]
   * @param {object} [maybeMeta]
   * @returns {object} 连接记录
   */
  register(site, wsOrMeta, maybeMeta) {
    const hasWsArg = arguments.length >= 3;
    const ws = hasWsArg ? (wsOrMeta || null) : null;
    const meta = (hasWsArg ? maybeMeta : wsOrMeta) || {};

    const account = coerceConnAccount(meta.account, meta.nickname);
    const uid = account ? account.uid : '';
    const channel = channelOf(site, uid);
    const now = Date.now();

    const conn = {
      id: randomUUID(),
      ws,
      site,
      uid,
      account,
      channel,
      // 平台昵称，仅用于展示（人工/agent 一眼认出是哪个号）。拿不到就是空串。
      nickname: account ? account.nickname : (typeof meta.nickname === 'string' ? meta.nickname : ''),
      // 脚本能力版本（≥2 才会上报账号）。用来区分"旧脚本"与"新脚本但识别失败"，
      // 界面据此给出不同的修正指引。旧脚本没这个字段，归 null。
      clientVersion: typeof meta.clientVersion === 'number' ? meta.clientVersion : null,
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
    logger.info(`[registry] + ${channel} (${conn.id.slice(0, 8)}) — total: ${this._countChannel(channel)}`);
    return conn;
  }

  /**
   * 清理长轮询僵尸连接。
   *
   * 两种作用域：
   *   removeStalePolling(site)            —— 清掉该站点的全部轮询连接（既有行为）
   *   removeStalePolling(site, account)   —— 只清该 channel（多账号下的正确作用域）
   *
   * 按 site 清理会把同站点的其他账号一并删掉，所以 router 注册时一律传 account。
   * @param {string} site
   * @param {string} [account] 省略 = 整个 site；空串 = 未识别账号那个桶
   * @returns {number} 被清理的连接数
   */
  removeStalePolling(site, account) {
    if (account === undefined) {
      let removed = 0;
      for (const [channel, conns] of [...this._map.entries()]) {
        if (channel === site || channel.startsWith(`${site}#`)) {
          removed += conns.length;
          this._map.delete(channel);
        }
      }
      if (removed > 0) {
        logger.info(`[registry] Cleaned ${removed} stale polling connection(s) for ${site}`);
      }
      return removed;
    }

    const channel = channelOf(site, account);
    const conns = this._map.get(channel);
    if (!conns || conns.length === 0) return 0;
    const before = conns.length;
    // 保留 WebSocket 连接（桌面端恒为 null；兼容 main 分支的旧调用）
    const remaining = conns.filter(c => c.ws !== null);
    if (remaining.length === 0) {
      this._map.delete(channel);
    } else {
      this._map.set(channel, remaining);
    }
    const removed = before - remaining.length;
    if (removed > 0) {
      logger.info(`[registry] Cleaned ${removed} stale polling connection(s) for ${channel}`);
    }
    return removed;
  }

  /**
   * 移除连接（按 connId 或 ws 对象）
   */
  unregister(connIdOrWs) {
    for (const [channel, conns] of this._map.entries()) {
      const idx = conns.findIndex(c => c.id === connIdOrWs || (c.ws && c.ws === connIdOrWs));
      if (idx !== -1) {
        const removed = conns.splice(idx, 1)[0];
        logger.info(`[registry] - ${channel} (${removed.id.slice(0, 8)}) — remaining: ${conns.length}`);
        if (conns.length === 0) {
          this._map.delete(channel);
        }
        return removed;
      }
    }
    return null;
  }

  /**
   * 获取某站点的连接（默认返回第一个 alive）。
   * 这是 site 级兼容 API（连接页/旧测试）；多账号路由请用 getByChannel/getAccount。
   * @param {string} site
   * @param {number} [index=0]
   * @returns {object|null}
   */
  get(site, index = 0) {
    const conns = this.listBySite(site);
    if (conns.length === 0) return null;
    // 优先挑活着的（按最后活跃时间判定）。
    // 全都不活时仍返回一个（保持既有行为：让请求走队列并最终超时，
    // 调用方拿到的是"超时"而不是"找不到站点"）。
    const alive = conns.filter(c => this.isAlive(c));
    if (alive.length > 0) return alive[Math.min(index, alive.length - 1)] || null;
    return conns[Math.min(index, conns.length - 1)] || null;
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
    // 同账号多标签页：优先最近的活跃连接
    return conns.slice().sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity))[0];
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
   * 按 connId 取连接。长轮询客户端只带 id 时，router 靠它反查 channel。
   * @param {string} connId
   * @returns {object|null}
   */
  getById(connId) {
    if (!connId) return null;
    return this._find(String(connId));
  }

  /**
   * 某站点下所有账号的连接（跨 channel 打平）。
   * @param {string} site
   * @returns {object[]}
   */
  listBySite(site) {
    const out = [];
    for (const conns of this._map.values()) {
      for (const c of conns) {
        if (c.site === site) out.push(c);
      }
    }
    return out;
  }

  /** 某站点下所有存活连接（含未识别账号的） */
  aliveOf(site) {
    return this.listBySite(site).filter(c => this.isAlive(c));
  }

  /**
   * 该站点当前在线的账号列表（去重），供轮换与错误提示使用。
   * 未识别账号的连接不计入 —— 它不能被显式指定，也不该伪装成某个号。
   * @param {string} site
   * @returns {Array<{account: string, uid: string, nickname: string, channel: string, connId: string, lastServedAt: number, lastWriteAt: number}>}
   */
  accountsOf(site) {
    const seen = new Map();
    for (const c of this.listBySite(site)) {
      if (!this.isAlive(c)) continue;
      if (!c.uid) continue;
      // 同账号多连接（同容器多标签页）：保留最近活跃的那条作为代表
      const prev = seen.get(c.uid);
      if (!prev || c.lastActivity > prev.lastActivity) {
        seen.set(c.uid, {
          account: c.uid,
          uid: c.uid,
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
   *
   * 没有任何"已识别账号"的连接时，回退到未识别连接（旧脚本/未登录标签页），
   * 保持桌面端改造前"连上就能读"的行为；有账号时绝不选未识别的桶。
   *
   * @param {string} site
   * @param {number} [cooldownMs] 单账号读完后的静默期
   * @returns {object|null} 选中的连接
   */
  pickForRead(site, cooldownMs = 15000) {
    const all = this.listBySite(site).filter(c => this.isAlive(c));
    const candidates = all.filter(c => c.uid);
    if (candidates.length === 0) return all[0] || null;

    const now = Date.now();
    const byLru = candidates.slice().sort((a, b) => a.lastServedAt - b.lastServedAt);
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
   * @param {string|object} account
   * @returns {object|null} 更新后的连接
   */
  updateAccount(connId, account) {
    const c = this._find(connId);
    if (!c) return null;

    const nextAccount = coerceConnAccount(account, c.nickname);
    const nextUid = nextAccount ? nextAccount.uid : '';
    if (c.uid === nextUid) {
      if (nextAccount) {
        c.account = nextAccount;
        c.nickname = nextAccount.nickname || c.nickname;
      }
      return c;
    }

    const old = {
      id: c.id,
      connectedAt: c.connectedAt,
      lastServedAt: c.lastServedAt,
      lastWriteAt: c.lastWriteAt,
      lastActivity: c.lastActivity,
      url: c.url,
      title: c.title,
      userAgent: c.userAgent,
      clientVersion: c.clientVersion,
      ws: c.ws,
    };
    this.unregister(connId);
    const moved = this.register(c.site, old.ws, {
      account: nextAccount || undefined,
      nickname: nextAccount ? nextAccount.nickname : c.nickname,
      clientVersion: old.clientVersion,
      url: old.url,
      title: old.title,
      userAgent: old.userAgent,
    });
    // 保留原 id：油猴端的 connId 不变，否则它的 poll/touch 会失联
    moved.id = connId;
    moved.connectedAt = old.connectedAt;
    moved.lastActivity = old.lastActivity;
    moved.lastServedAt = old.lastServedAt;
    moved.lastWriteAt = old.lastWriteAt;
    return moved;
  }

  /**
   * 更新连接元信息（URL 变化 / 重新注册时）
   */
  updateMeta(connId, meta = {}) {
    const c = this._find(connId);
    if (!c) return null;
    if (meta.url) c.url = meta.url;
    if (meta.title) c.title = meta.title;
    if (typeof meta.nickname === 'string' && meta.nickname) c.nickname = meta.nickname;
    if (typeof meta.clientVersion === 'number') c.clientVersion = meta.clientVersion;
    if (meta.account !== undefined) {
      const next = coerceConnAccount(meta.account, meta.nickname);
      if ((next ? next.uid : '') !== c.uid) return this.updateAccount(connId, meta.account);
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
          // 平铺一份 uid：多账号路由与 CLI 不必再猜 account 是不是对象
          uid: c.uid || '',
          nickname: c.nickname || '',
          clientVersion: c.clientVersion,
          channel: c.channel,
          url: c.url,
          title: c.title,
          connectedAt: c.connectedAt,
          lastActivity: c.lastActivity,
          lastServedAt: c.lastServedAt,
          lastWriteAt: c.lastWriteAt,
          alive: this.isAlive(c),
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
