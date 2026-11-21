// core/shared/protocol.js — 消息类型常量 + 校验
//
// 只剩 HTTP 长轮询一条通道：/api/connect 注册、/api/poll 取命令、/api/result 回结果、
// /api/call 由桌面端发起。原先的 WebSocket 消息类型（hello/eval/ping/pong/result/bye）
// 随 core/server/ws-hub.js 一起删除。
//
// 多账号（从 main 分支移植）
// -------------------------
// 一个浏览器连接的身份 = 站点 + 登录账号。寻址键是 channel：
//   channel = `site#uid`（account 为空时退化为 `site`，兼容旧脚本/未登录标签页）
// 这样 router 的 _pollQueue / _pollWaiters / _pending 只要按 channel 分桶，
// 账号隔离就是结构自带的，不需要在下游到处判空。

// ── HTTP API 端点 ──
const HTTP_API = {
  CALL:   'POST /api/call',
  STATUS: 'GET /api/status',
  HEALTH: 'GET /api/health',
};

// ── 通道（channel）──

/**
 * 多账号寻址键：一个浏览器连接 = 一个「站点 + 登录账号」组合。
 *
 * account 为空时返回 site 本身而不是 `site#`：
 *   - 旧脚本（客户端版本 2，只传 site）仍然按 site 轮询，行为不变；
 *   - 未登录标签页的"身份不明"连接也落在同一个桶里，不会被当成某个账号。
 * 有 uid 时 `site#uid` 与同站点的其他账号互不干扰。
 *
 * @param {string} site
 * @param {string} [account]
 */
function channelOf(site, account) {
  const s = String(site || '');
  const a = account == null ? '' : String(account);
  return a ? `${s}#${a}` : s;
}

/** @param {string} channel @returns {{site: string, account: string}} */
function parseChannel(channel) {
  const raw = String(channel || '');
  const i = raw.indexOf('#');
  if (i < 0) return { site: raw, account: '' };
  return { site: raw.slice(0, i), account: raw.slice(i + 1) };
}

/** 从连接上报的账号对象/字符串里取 uid，取不到返回空串 */
function accountUidOf(account) {
  // 两条路径都要截断：uid 来自外部输入（注册/调用请求），长度不能无界。
  if (typeof account === 'string') return account.trim().slice(0, 64);
  if (!account || typeof account !== 'object' || Array.isArray(account)) return '';
  const uid = account.uid != null ? String(account.uid).trim() : '';
  return uid.slice(0, 64);
}

/**
 * 构造派发给油猴端的 eval 消息。
 * expectAccount 非空时，油猴端会先比对自己当前登录账号，不一致则拒绝执行 ——
 * 这是写操作的护栏，防容器/登录态切换的竞态导致「用 A 号发了 B 号的评论」。
 */
function buildEvalMessage(id, expression, awaitPromise = true, expectAccount = null) {
  const msg = { type: 'eval', id, expression, awaitPromise };
  if (expectAccount) msg.expectAccount = String(expectAccount);
  return msg;
}

// ── 校验函数 ──

/**
 * 归一化连接上报的登录账号信息。
 *
 * 账号信息来自浏览器页面（油猴脚本注册时抓取），属于**外部输入**：
 * 只取白名单字段、一律转字符串并截断，其余内容全部丢弃 ——
 * 否则恶意/异常的注册载荷可以把任意结构塞进注册表，再原样进入界面。
 *
 * @param {unknown} account - 形如 { nickname, avatar, secUid, uid, followerCount, followingCount, likesReceived } 的对象
 * @returns {null | { nickname: string, avatar: string, secUid: string, uid: string, followerCount: number|null, followingCount: number|null, likesReceived: number|null }}
 */
function normalizeAccount(account) {
  if (!account || typeof account !== 'object' || Array.isArray(account)) return null;
  const str = (v, max) => {
    const s = typeof v === 'string' ? v.trim() : (typeof v === 'number' ? String(v) : '');
    return s ? s.slice(0, max) : '';
  };
  // 粉丝/关注/获赞：接受数字或纯数字字符串（不同端点/版本可能给字符串），
  // 负数、小数、非数字一律丢弃为 null —— 界面按"没这项"处理
  const num = (v) => {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };
  const out = {
    nickname: str(account.nickname, 60),
    avatar: /^https:\/\//.test(String(account.avatar || '')) ? str(account.avatar, 500) : '',
    secUid: str(account.secUid, 64),
    uid: str(account.uid, 64),
    followerCount: num(account.followerCount),
    followingCount: num(account.followingCount),
    likesReceived: num(account.likesReceived),
  };
  // 至少要有昵称才算"认出了账号"，否则不如返回 null（界面按未识别处理）
  return out.nickname ? out : null;
}

/** 连接上报的账号统一成"注册表存的那一份"：优先完整对象，其次只有 uid 的字符串 */
function coerceConnAccount(account, nickname) {
  const normalized = normalizeAccount(account);
  if (normalized) return normalized;
  const uid = accountUidOf(account);
  if (!uid) return null;
  return {
    nickname: typeof nickname === 'string' ? nickname.slice(0, 60) : '',
    avatar: '',
    secUid: '',
    uid,
    followerCount: null,
    followingCount: null,
    likesReceived: null,
  };
}

/**
 * 校验 HTTP /api/call 请求体
 */
function validateCallRequest(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: '请求体必须是对象' };
  }
  if (!body.site || typeof body.site !== 'string') {
    return { valid: false, error: '缺少 site 字段' };
  }
  if (!body.expression || typeof body.expression !== 'string') {
    return { valid: false, error: '缺少 expression 字段' };
  }
  return {
    valid: true,
    data: {
      site: body.site,
      // 指定账号时路由到该账号的连接；为空表示「读操作，由服务端轮换」
      account: accountUidOf(body.account) || null,
      expression: body.expression,
      awaitPromise: body.awaitPromise !== false,
      // 'write' 会触发服务端的「必须显式指定账号」校验与油猴端 expectAccount 比对
      opType: body.opType === 'write' ? 'write' : 'read',
      noThrottle: body.noThrottle === true,
      timeout: typeof body.timeout === 'number' ? body.timeout : null,
    },
  };
}

/**
 * 把 `/api/status` 的 connections 摊平成"连接列表"。
 *
 * 服务端返回的是**按 site 分组的对象**（`{'douyin.com': [conn, …]}`）—— 那是线格式，
 * 便于人直接看；而消费方要的是一个数组。以前各处各自假设形状：
 * `accounts.aliveUids` 用 `for…of` 遍历 `status.connections`，对象不可迭代抛
 * TypeError，异常又被 `resolveCurrent` 的 catch 当成"桥接不可用"吞掉 —— 于是
 * "自动跟随唯一在线账号"对所有走 BridgeClient 的调用方（CLI、Agent SDK）永远不成立。
 * 这里是唯一一份适配器。
 *
 * @param {object} status - 服务端原样响应，或主进程已摊平的快照（数组）
 * @returns {Array<object>} 每项带 `site`；空/缺失返回 []
 */
function flattenConnections(status) {
  const grouped = status && status.connections;
  if (!grouped) return [];
  if (Array.isArray(grouped)) return grouped;
  const out = [];
  for (const [site, conns] of Object.entries(grouped)) {
    for (const c of conns || []) out.push({ ...c, site });
  }
  return out;
}

/** 连接记录上的账号 uid（兼容 account 对象 / 字符串 / 平铺的 accountUid 字段） */
function connectionAccountUid(conn) {
  if (!conn) return '';
  if (conn.accountUid != null) return String(conn.accountUid);
  const fromAccount = accountUidOf(conn.account);
  if (fromAccount) return fromAccount;
  // /api/status 的 connections 里还有一份平铺的 uid（registry.list 输出）；
  // 老脚本/异常注册可能只有它，没有 account 对象。
  return conn.uid != null ? String(conn.uid) : '';
}

module.exports = {
  HTTP_API,
  channelOf,
  parseChannel,
  accountUidOf,
  connectionAccountUid,
  buildEvalMessage,
  normalizeAccount,
  coerceConnAccount,
  validateCallRequest,
  flattenConnections,
};
