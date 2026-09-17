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
  return {
    valid: true,
    data: {
      site: msg.site,
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
      expression: body.expression,
      awaitPromise: body.awaitPromise !== false,
      connIndex: typeof body.connIndex === 'number' ? body.connIndex : 0,
      timeout: typeof body.timeout === 'number' ? body.timeout : null,
    },
  };
}

module.exports = {
  WS_CLIENT_MSG,
  WS_SERVER_MSG,
  HTTP_API,
  validateHello,
  validateResult,
  validateCallRequest,
};
