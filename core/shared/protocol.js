// lib/shared/protocol.js — 消息类型常量 + 校验
//
// 只剩 HTTP 长轮询一条通道：/api/connect 注册、/api/poll 取命令、/api/result 回结果、
// /api/call 由桌面端发起。原先的 WebSocket 消息类型（hello/eval/ping/pong/result/bye）
// 随 core/server/ws-hub.js 一起删除。

// ── HTTP API 端点 ──
const HTTP_API = {
  CALL:   'POST /api/call',
  STATUS: 'GET /api/status',
  HEALTH: 'GET /api/health',
};

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
      expression: body.expression,
      awaitPromise: body.awaitPromise !== false,
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

module.exports = {
  HTTP_API,
  normalizeAccount,
  validateCallRequest,
  flattenConnections,
};
