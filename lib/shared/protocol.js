// lib/shared/protocol.js — 消息类型常量 + 校验

// ── WebSocket 消息类型 ──
const WS_CLIENT_MSG = {
  HELLO:  'hello',
  RESULT: 'result',
  PONG:   'pong',
};

const WS_SERVER_MSG = {
  EVAL: 'eval',
  PING: 'ping',
  BYE:  'bye',
};

// ── HTTP API 端点 ──
const HTTP_API = {
  CALL:   'POST /api/call',
  STATUS: 'GET /api/status',
  HEALTH: 'GET /api/health',
};

// ── 通道（channel）──
//
// 多账号寻址键：一个浏览器连接 = 一个「站点 + 登录账号」组合。
// account 为空串表示「已连上但未识别出登录账号」——这种连接只允许被读轮换选中，
// 不允许承接写操作（写必须显式指定且能校验身份）。
//
// 之所以把 account 并进这一个字符串而不是新增独立维度：router 的
// _pollQueue / _pollWaiters / _pending 全部按通道分桶，并进来即自动获得账号隔离。

/** @param {string} site @param {string} [account] */
function channelOf(site, account) {
  return `${site}#${account || ''}`;
}

/** @param {string} channel @returns {{site: string, account: string}} */
function parseChannel(channel) {
  const i = String(channel || '').indexOf('#');
  if (i < 0) return { site: String(channel || ''), account: '' };
  return { site: channel.slice(0, i), account: channel.slice(i + 1) };
}

/**
 * 构造派发给油猴端的 eval 消息。
 * expectAccount 非空时，油猴端会先比对自己当前登录账号，不一致则拒绝执行——
 * 这是写操作的护栏，防容器/登录态切换的竞态导致「用 A 号发了 B 号的评论」。
 */
function buildEvalMessage(id, expression, awaitPromise = true, expectAccount = null) {
  const msg = { type: WS_SERVER_MSG.EVAL, id, expression, awaitPromise };
  if (expectAccount) msg.expectAccount = expectAccount;
  return msg;
}

// ── 校验函数 ──

/**
 * 校验 hello 消息
 * @returns {{ valid: false, error: string } | { valid: true, data: object }}
 */
function validateHello(msg) {
  if (!msg || typeof msg !== 'object') {
    return { valid: false, error: '消息必须是对象' };
  }
  if (msg.type !== WS_CLIENT_MSG.HELLO) {
    return { valid: false, error: `type 必须为 "${WS_CLIENT_MSG.HELLO}"` };
  }
  if (!msg.site || typeof msg.site !== 'string') {
    return { valid: false, error: '缺少 site 字段' };
  }
  // account 必填：未登录的标签页不应建立连接。
  // 如果允许空 account，就会出现一个"身份不明"的连接，它既不该被写操作选中、
  // 也无法做写护栏校验 —— 与其在下游到处判空，不如在握手就拒掉。
  if (!msg.account || typeof msg.account !== 'string') {
    return { valid: false, error: '缺少 account 字段（未登录的标签页不应连接）' };
  }
  return {
    valid: true,
    data: {
      site: msg.site,
      account: msg.account,
      nickname: typeof msg.nickname === 'string' ? msg.nickname : '',
      clientVersion: typeof msg.clientVersion === 'number' ? msg.clientVersion : null,
      url: msg.url || '',
      title: msg.title || '',
      userAgent: msg.userAgent || '',
    },
  };
}

/**
 * 校验 result 消息
 */
function validateResult(msg) {
  if (!msg || typeof msg !== 'object') {
    return { valid: false, error: '消息必须是对象' };
  }
  if (msg.type !== WS_CLIENT_MSG.RESULT) {
    return { valid: false, error: `type 必须为 "${WS_CLIENT_MSG.RESULT}"` };
  }
  if (!msg.id) {
    return { valid: false, error: '缺少 id 字段' };
  }
  if (!msg.hasOwnProperty('value') && !msg.hasOwnProperty('error')) {
    return { valid: false, error: '消息必须包含 value 或 error' };
  }
  return { valid: true, data: msg };
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
      account: typeof body.account === 'string' && body.account ? body.account : null,
      expression: body.expression,
      awaitPromise: body.awaitPromise !== false,
      // 'write' 会触发服务端的「必须显式指定账号」校验
      opType: body.opType === 'write' ? 'write' : 'read',
      noThrottle: body.noThrottle === true,
      // connIndex 已废弃：位置型寻址在多账号下会静默落到别的账号，保留仅为兼容旧调用
      connIndex: typeof body.connIndex === 'number' ? body.connIndex : 0,
      timeout: typeof body.timeout === 'number' ? body.timeout : null,
    },
  };
}

module.exports = {
  WS_CLIENT_MSG,
  WS_SERVER_MSG,
  HTTP_API,
  channelOf,
  parseChannel,
  buildEvalMessage,
  validateHello,
  validateResult,
  validateCallRequest,
};
