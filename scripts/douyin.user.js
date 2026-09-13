// ==UserScript==
// @name         Bridge: Douyin
// @namespace    bridge-framework
// @match        *://*.douyin.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      127.0.0.1:*
// @connect      localhost
// @connect      localhost:*
// ==/UserScript==

// ═══════════════════════════════════════════════════════════
// Bridge Framework — 抖音脚本
// 通过 GM_xmlhttpRequest 绕过 Chrome PNA loopback 限制
// unsafeWindow 用于页面上下文的 eval 和 __bridge API
// ═══════════════════════════════════════════════════════════

(function () {
  'use strict';

  const CONFIG = {
    server: 'http://127.0.0.1:19422',
    site: 'douyin.com',
    token: '901853b42dac9ccd8954cb4d9c994bd8377ea01b40939815',  // 填入 config.json 中的 bridge.token
    reconnectDelay: 2000,
  };

  let connected = false;
  let registered = false;
  let connId = null;           // 服务端返回的连接 ID，poll 时回传用于更新活跃时间
  let retryCount = 0;          // 连续重试次数（指数退避用）
  let pollFailCount = 0;       // 连续 poll 失败次数

  function gmFetch(url, opts) {
    // 自动注入 Authorization header
    var headers = Object.assign({}, opts && opts.headers);
    if (CONFIG.token) headers['Authorization'] = 'Bearer ' + CONFIG.token;
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest(Object.assign({ url: url, timeout: 35000 }, opts, {
        headers: headers,
        onload: function (r) { resolve(r); },
        onerror: function (e) { reject(new Error('GM_xmlhttpRequest failed')); },
        ontimeout: function () { reject(new Error('GM_xmlhttpRequest timeout')); },
      }));
    });
  }

  // ── HTTP 连接管理（通过 GM_xmlhttpRequest 绕过 PNA）──
  async function connect() {
    if (!registered) {
      try {
        console.log('[Bridge] Registering via GM_xmlhttpRequest...');
        var r = await gmFetch(CONFIG.server + '/api/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify({
            site: CONFIG.site,
            url: location.href,
            title: document.title,
            userAgent: navigator.userAgent,
          }),
        });
        if (r.status === 200) {
          registered = true;
          connected = true;
          retryCount = 0; // 成功后重置
          var data = JSON.parse(r.responseText);
          connId = data.id || null; // 保存服务端返回的连接 ID
          console.log('[Bridge] ✓ Registered with Bridge Server, id=' + (connId || '').slice(0, 8));
        } else {
          throw new Error('status ' + r.status);
        }
      } catch (err) {
        retryCount++;
        // 指数退避: 2s, 4s, 8s, 16s, 最大 60s
        var delay = Math.min(CONFIG.reconnectDelay * Math.pow(2, retryCount - 1), 60000);
        console.warn('[Bridge] Registration failed, retry in ' + Math.round(delay / 1000) + 's:', err.message);
        setTimeout(connect, delay);
        return;
      }
    }
    poll();
  }

  async function poll() {
    if (!registered) return;
    try {
      var pollUrl = CONFIG.server + '/api/poll?site=' + CONFIG.site;
      if (connId) pollUrl += '&id=' + connId;
      var r = await gmFetch(pollUrl, { method: 'GET' });
      if (r.status !== 200) throw new Error('status ' + r.status);
      var msg = JSON.parse(r.responseText);

      if (msg.type === 'eval') {
        connected = true;
        pollFailCount = 0;
        try {
          // 在页面上下文执行 eval
          var result = (0, unsafeWindow.eval)(msg.expression);
          if (msg.awaitPromise !== false) result = await Promise.resolve(result);
          console.log('[Bridge] eval result type:', typeof result, 'keys:', result ? Object.keys(result).slice(0, 5) : 'null/undefined');
          await gmFetch(CONFIG.server + '/api/result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ id: msg.id, value: safeSerialize(result) }),
          });
        } catch (e) {
          await gmFetch(CONFIG.server + '/api/result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ id: msg.id, error: e.message || String(e) }),
          });
        }
        poll();
      } else {
        connected = true;
        pollFailCount = 0;
        poll();
      }
    } catch (err) {
      pollFailCount++;
      // 连续失败 3 次后才断开重连，避免偶发超时误判
      if (pollFailCount >= 3) {
        console.warn('[Bridge] Poll failed ' + pollFailCount + ' times, reconnecting:', err.message);
        connected = false;
        registered = false;
        pollFailCount = 0;
        setTimeout(connect, CONFIG.reconnectDelay);
      } else {
        // 单次失败：短暂等待后重试
        setTimeout(poll, 1000);
      }
    }
  }

  // ── 安全序列化（仅防循环引用和 DOM 泄漏）──
  function safeSerialize(value) {
    try {
      // 处理 BigInt：将 BigInt 转换为字符串
      return JSON.parse(JSON.stringify(value === undefined ? null : value, (key, val) => {
        return typeof val === 'bigint' ? val.toString() : val;
      }));
    } catch (e) {
      return null;
    }
  }

  // ── SPA 导航检测（拦截页面 history API）──
  var lastUrl = location.href;
  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
    }
  }
  var _pushState = unsafeWindow.history.pushState;
  var _replaceState = unsafeWindow.history.replaceState;
  unsafeWindow.history.pushState = function () { _pushState.apply(this, arguments); checkUrlChange(); };
  unsafeWindow.history.replaceState = function () { _replaceState.apply(this, arguments); checkUrlChange(); };
  unsafeWindow.addEventListener('popstate', checkUrlChange);
  unsafeWindow.addEventListener('hashchange', checkUrlChange);

  // ═══════════════════════════════════════════════════════════
  // 抖音 Bridge API — 注入到页面上下文（用页面的 fetch/cookie）
  // ═══════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════
  // DM Bridge 库 (protobuf + 辅助函数)，注入页面上下文
  // ═══════════════════════════════════════════════════════════
  var DM_BRIDGE_CODE = (function () {/*
// ═══════════════════════════════════════════════════════════
// 抖音私信 Bridge Lib — 最小化 protobuf 编解码 + DM API 函数
// 注入到页面上下文中运行，使用页面的 fetch/cookie/WebSocket
// ═══════════════════════════════════════════════════════════

// ── 最小化 Protobuf 编解码器 ──
var _DM_PROTO = (function() {
  // Wire types
  var WIRE_VARINT = 0, WIRE_FIXED64 = 1, WIRE_LENDELIM = 2;

  // ═══ Varint 编解码 ═══
  function encodeVarint(val) {
    val = typeof val === 'bigint' ? Number(val) : (val | 0);
    if (val < 0) val = val >>> 0; // 转为无符号
    var bytes = [];
    do {
      var b = val & 0x7F;
      val = val >>> 7;
      if (val) b |= 0x80;
      bytes.push(b);
    } while (val);
    return bytes;
  }

  function encodeVarintBig(val) {
    if (val === undefined || val === null || val === '') return [0];
    try { val = BigInt(val); } catch(e) { return [0]; }
    var bytes = [];
    while (val > 127n) {
      bytes.push(Number(val & 127n) | 128);
      val = val >> 7n;
    }
    bytes.push(Number(val));
    return bytes;
  }

  function decodeVarint(bytes, offset) {
    var result = 0n, shift = 0n, pos = offset || 0;
    while (pos < bytes.length) {
      var b = BigInt(bytes[pos++]);
      result |= (b & 127n) << shift;
      if (!(b & 128n)) break;
      shift += 7n;
    }
    return { value: result, nextPos: pos };
  }

  // ═══ 字段编码 ═══
  function encodeTag(fieldNum, wireType) {
    return encodeVarint((fieldNum << 3) | wireType);
  }

  function encodeUint64Field(fieldNum, val) {
    return encodeTag(fieldNum, WIRE_VARINT).concat(encodeVarintBig(val));
  }

  function encodeIntField(fieldNum, val) {
    return encodeTag(fieldNum, WIRE_VARINT).concat(encodeVarint(val));
  }

  function encodeStringField(fieldNum, val) {
    var utf8 = stringToUTF8(val);
    return encodeTag(fieldNum, WIRE_LENDELIM)
      .concat(encodeVarint(utf8.length))
      .concat(utf8);
  }

  function encodeBytesField(fieldNum, val) {
    return encodeTag(fieldNum, WIRE_LENDELIM)
      .concat(encodeVarint(val.length))
      .concat(Array.from(val));
  }

  function encodeMessageField(fieldNum, msgBytes) {
    return encodeTag(fieldNum, WIRE_LENDELIM)
      .concat(encodeVarint(msgBytes.length))
      .concat(msgBytes);
  }

  function encodeBoolField(fieldNum, val) {
    return encodeTag(fieldNum, WIRE_VARINT).concat(val ? [1] : [0]);
  }

  function encodeRepeatedInt64(fieldNum, arr) {
    var bytes = [];
    for (var i = 0; i < arr.length; i++) {
      bytes = bytes.concat(encodeTag(fieldNum, WIRE_VARINT)).concat(encodeVarintBig(arr[i]));
    }
    return bytes;
  }

  function encodeMapStringField(fieldNum, obj) {
    var bytes = [];
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var entry = encodeStringField(1, keys[i]).concat(encodeStringField(2, obj[keys[i]]));
      bytes = bytes.concat(encodeMessageField(fieldNum, entry));
    }
    return bytes;
  }

  function encodeMapStringStringField(fieldNum, obj) {
    // map<string,string> 编码为 repeated message { key=1, value=2 }
    var bytes = [];
    var keys = Object.keys(obj || {});
    for (var i = 0; i < keys.length; i++) {
      var entry = encodeStringField(1, keys[i]).concat(encodeStringField(2, String(obj[keys[i]])));
      bytes = bytes.concat(encodeMessageField(fieldNum, entry));
    }
    return bytes;
  }

  // ═══ UTF-8 编解码 ═══
  function stringToUTF8(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c < 0xD800 || c >= 0xE000) {
        bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      } else {
        // Surrogate pair
        i++;
        var c2 = str.charCodeAt(i);
        var cp = 0x10000 + ((c & 0x3FF) << 10) + (c2 & 0x3FF);
        bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
                   0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      }
    }
    return bytes;
  }

  function utf8ToString(bytes, offset, length) {
    var str = '', end = (offset || 0) + (length || bytes.length);
    for (var i = offset || 0; i < end;) {
      var b = bytes[i++];
      if (b < 0x80) {
        str += String.fromCharCode(b);
      } else if (b < 0xE0) {
        str += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i++] & 0x3F));
      } else if (b < 0xF0) {
        str += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i] & 0x3F) << 6) | (bytes[i+1] & 0x3F));
        i += 2;
      } else {
        var cp = ((b & 0x07) << 18) | ((bytes[i] & 0x3F) << 12) | ((bytes[i+1] & 0x3F) << 6) | (bytes[i+2] & 0x3F);
        cp -= 0x10000;
        str += String.fromCharCode(0xD800 + (cp >> 10));
        str += String.fromCharCode(0xDC00 + (cp & 0x3FF));
        i += 3;
      }
    }
    return str;
  }

  // ═══ 字段解码 ═══
  function decodeField(bytes, offset) {
    var tag = decodeVarint(bytes, offset);
    var fieldNum = Number(tag.value >> 3n);
    var wireType = Number(tag.value & 7n);
    var result = { fieldNum: fieldNum, wireType: wireType };
    var pos = tag.nextPos;

    if (wireType === WIRE_VARINT) {
      var v = decodeVarint(bytes, pos);
      result.value = v.value;
      pos = v.nextPos;
    } else if (wireType === WIRE_FIXED64) {
      result.value = bytes.slice(pos, pos + 8);
      pos += 8;
    } else if (wireType === WIRE_LENDELIM) {
      var len = decodeVarint(bytes, pos);
      var dataStart = len.nextPos;
      var dataLen = Number(len.value);
      result.value = bytes.slice(dataStart, dataStart + dataLen);
      pos = dataStart + dataLen;
    }
    return { field: result, nextPos: pos };
  }

  // ═══ 具体消息编解码 ═══

  // 编码 Request 消息
  // @param {object} opts
  // @param {number} opts.cmd - 100=发送消息, 609=创建会话, 610=获取会话列表
  // @param {string} opts.token - web_protect ticket
  // @param {string} opts.ts_sign - web_protect ts_sign
  // @param {string} opts.sdk_cert - base64(client_cert)
  // @param {string} opts.reuqest_sign - ECDSA 签名
  // @param {object} opts.body - 内层消息体字节
  // @param {object} opts.headersObj - 请求头 map
  function encodeRequest(opts) {
    var bodyBytes = opts.bodyBytes || [];
    var bodyFieldNum = 0;
    if (opts.cmd === 100) bodyFieldNum = 100;      // send_message_body
    else if (opts.cmd === 609) bodyFieldNum = 609;  // create_conversation_v2_body
    else if (opts.cmd === 610) bodyFieldNum = 610;  // get_conversation_info_list_v2_body

    var bytes = [].concat(
      encodeIntField(1, opts.cmd),                                      // cmd
      encodeIntField(2, opts.sequence_id || (10000 + Math.floor(Math.random()*1000))), // sequence_id
      encodeStringField(3, opts.sdk_version || '1.1.3'),                // sdk_version
      encodeStringField(4, opts.token || ''),                           // token
      encodeIntField(5, opts.refer || 3),                               // refer
      encodeIntField(6, opts.inbox_type || 0),                          // inbox_type
      encodeStringField(7, opts.build_number || '5fa6ff1:Detached: 5fa6ff1111fd53aafc4c753505d3c93daad74d27'),
      encodeMessageField(8, bodyBytes),                                  // body
      encodeStringField(9, opts.device_id || '0'),                      // device_id
      encodeStringField(11, opts.device_platform || 'douyin_pc'),       // device_platform
      encodeMapStringStringField(15, opts.headersObj || {
        session_aid: '6383', session_did: '0', app_name: 'douyin_pc',
        priority_region: 'cn', cookie_enabled: 'true',
        browser_language: 'zh-CN', browser_platform: 'Win32',
        browser_online: 'true', screen_width: String(screen.width),
        screen_height: String(screen.height),
        user_agent: navigator.userAgent,
        referer: '', timezone_name: 'Etc/GMT-8',
        deviceId: '0', webid: (typeof getCookie==='function' ? getCookie('s_v_web_id') : '') || '',
        fp: (typeof getCookie==='function' ? getCookie('s_v_web_id') : '') || ''
      }),
      encodeIntField(18, opts.auth_type || 4),                          // auth_type
      encodeStringField(21, opts.biz || 'douyin_web'),                  // biz
      encodeStringField(22, opts.access || 'web_sdk'),                  // access
      encodeStringField(23, opts.ts_sign || ''),                        // ts_sign
      encodeStringField(24, opts.sdk_cert || ''),                       // sdk_cert
      encodeStringField(25, opts.reuqest_sign || '')                     // reuqest_sign
    );
    return bytes;
  }

  // 编码 SendMessageRequestBody
  function encodeSendMessageBody(opts) {
    var content = JSON.stringify({
      mention_users: [],
      aweType: 700,
      richTextInfos: [],
      text: opts.text || ''
    });

    var extBytes = [].concat(
      encodeExtValue('s:client_message_id', opts.client_message_id || ''),
      encodeExtValue('s:stime', String(Date.now())),
      encodeExtValue('s:mentioned_users', '')
    );

    var bytes = [].concat(
      encodeStringField(1, opts.conversation_id),
      encodeIntField(2, opts.conversation_type || 1),
      encodeIntField(3, opts.conversation_short_id || 0),
      encodeStringField(4, content),
      extBytes,
      encodeIntField(6, opts.message_type || 7),
      encodeStringField(7, opts.ticket || ''),
      encodeStringField(8, opts.client_message_id || '')
    );
    return bytes;
  }

  function encodeExtValue(key, value) {
    return encodeMessageField(5, encodeStringField(1, key).concat(encodeStringField(2, value)));
  }

  // 编码 CreateConversationV2RequestBody
  function encodeCreateConversationBody(opts) {
    var bytes = [].concat(
      encodeIntField(1, opts.conversation_type || 1),
      encodeRepeatedInt64(2, opts.participants || [])
    );
    return bytes;
  }

  // 解码 PushFrame (WebSocket 接收)
  function decodePushFrame(bytes) {
    var result = {}, pos = 0;
    while (pos < bytes.length) {
      var decoded = decodeField(bytes, pos);
      var f = decoded.field;
      pos = decoded.nextPos;
      switch (f.fieldNum) {
        case 1: result.seqId = f.value; break;
        case 2: result.logId = f.value; break;
        case 7: result.payloadType = utf8ToString(f.value); break;
        case 8: result.payload = f.value; break;
      }
    }
    return result;
  }

  // 解码 Response 消息
  function decodeResponse(bytes) {
    var result = {}, pos = 0;
    while (pos < bytes.length) {
      var decoded = decodeField(bytes, pos);
      var f = decoded.field;
      pos = decoded.nextPos;

      if (f.fieldNum === 6 && f.wireType === WIRE_LENDELIM) {
        // ResponseBody — 递归解码
        result.body = decodeResponseBody(f.value);
      } else if (f.fieldNum === 1) {
        result.cmd = Number(f.value);
      } else if (f.fieldNum === 2) {
        result.sequence_id = f.value;
      } else if (f.fieldNum === 3) {
        result.error_desc = utf8ToString(f.value);
      } else if (f.fieldNum === 4) {
        result.message = utf8ToString(f.value);
      }
    }
    return result;
  }

  function decodeResponseBody(bytes) {
    var result = {}, pos = 0;
    while (pos < bytes.length) {
      var decoded = decodeField(bytes, pos);
      var f = decoded.field;
      pos = decoded.nextPos;

      if (f.fieldNum === 500 && f.wireType === WIRE_LENDELIM) {
        result.new_message_notify = decodeNewMessageNotify(f.value);
      } else if (f.fieldNum === 609 && f.wireType === WIRE_LENDELIM) {
        result.create_conversation_v2_body = decodeConversationList(f.value);
      } else if (f.fieldNum === 610 && f.wireType === WIRE_LENDELIM) {
        result.get_conversation_info_list_v2_response_body = decodeConversationList(f.value);
      }
    }
    return result;
  }

  function decodeNewMessageNotify(bytes) {
    var result = {}, pos = 0;
    while (pos < bytes.length) {
      var decoded = decodeField(bytes, pos);
      var f = decoded.field;
      pos = decoded.nextPos;

      if (f.fieldNum === 5 && f.wireType === WIRE_LENDELIM) {
        result.message = decodeMessageBody(f.value);
      } else if (f.fieldNum === 2) {
        result.conversation_id = utf8ToString(f.value);
      } else if (f.fieldNum === 3) {
        result.conversation_type = Number(f.value);
      }
    }
    return result;
  }

  function decodeMessageBody(bytes) {
    var result = {}, pos = 0;
    while (pos < bytes.length) {
      var decoded = decodeField(bytes, pos);
      var f = decoded.field;
      pos = decoded.nextPos;

      switch (f.fieldNum) {
        case 1: result.conversation_id = utf8ToString(f.value); break;
        case 4: result.index_in_conversation = String(f.value); break;
        case 5: result.conversation_short_id = String(f.value); break;
        case 6: result.message_type = Number(f.value); break;
        case 7: result.sender = String(f.value); break;
        case 8: result.content = utf8ToString(f.value); break;
      }
    }
    // 解析 content JSON
    if (result.content) {
      try { result.content_parsed = JSON.parse(result.content); } catch(e) {}
    }
    return result;
  }

  function decodeConversationList(bytes) {
    var result = { conversation_info_list: [] }, pos = 0;
    while (pos < bytes.length) {
      var decoded = decodeField(bytes, pos);
      var f = decoded.field;
      pos = decoded.nextPos;

      if (f.fieldNum === 1 && f.wireType === WIRE_LENDELIM) {
        result.conversation_info_list.push(decodeConversationInfo(f.value));
      }
    }
    return result;
  }

  function decodeConversationInfo(bytes) {
    var result = {}, pos = 0;
    while (pos < bytes.length) {
      var decoded = decodeField(bytes, pos);
      var f = decoded.field;
      pos = decoded.nextPos;

      switch (f.fieldNum) {
        case 1: result.conversation_id = utf8ToString(f.value); break;
        case 2: result.conversation_short_id = String(f.value); break;
        case 3: result.conversation_type = Number(f.value); break;
        case 4: result.ticket = utf8ToString(f.value); break;
      }
    }
    return result;
  }

  return {
    encodeRequest: encodeRequest,
    encodeSendMessageBody: encodeSendMessageBody,
    encodeCreateConversationBody: encodeCreateConversationBody,
    decodePushFrame: decodePushFrame,
    decodeResponse: decodeResponse,
    bytesToArray: function(bytes) { return new Uint8Array(bytes); }
  };
})();


// ── DM 辅助函数 ──
var _DM_HELPERS = (function() {
  // 从 localStorage 读取 web_protect 和 SDK 密钥
  // 注意: 抖音实际使用的 key 可能有变体，做 fallback
  function getDMKeys() {
    // 尝试多种可能的 localStorage key
    var wpRaw = null;
    var sdkRaw = null;

    try { wpRaw = localStorage.getItem('web_protect'); } catch(e) {}
    if (!wpRaw) {
      try { wpRaw = localStorage.getItem('security-sdk/s_sdk_sign_data_key/web_protect'); } catch(e) {}
    }

    try { sdkRaw = localStorage.getItem('s_sdk_crypt_sdk'); } catch(e) {}
    if (!sdkRaw) {
      try { sdkRaw = localStorage.getItem('security-sdk/s_sdk_crypt_sdk'); } catch(e) {}
    }
    // 旧版 key
    if (!sdkRaw) {
      try { sdkRaw = localStorage.getItem('bd_ec_key'); } catch(e) {}
    }

    var wp = {}, sdk = {};
    if (wpRaw) {
      try { wp = JSON.parse(wpRaw); } catch(e) {}
      // 有时 web_protect 有多层 JSON 嵌套
      if (wp.data && typeof wp.data === 'string') {
        try { wp = JSON.parse(wp.data); } catch(e2) {}
      } else if (wp.data && typeof wp.data === 'object') {
        wp = wp.data;
      }
    }
    if (sdkRaw) {
      try { sdk = JSON.parse(sdkRaw); } catch(e) {}
      if (sdk.data && typeof sdk.data === 'string') {
        try { sdk = JSON.parse(sdk.data); } catch(e2) {}
      } else if (sdk.data && typeof sdk.data === 'object') {
        sdk = sdk.data;
      }
    }

    return {
      ticket: wp.ticket || '',
      ts_sign: wp.ts_sign || '',
      client_cert: wp.client_cert || '',
      privateKey: sdk.ec_privateKey || '',
      publicKey: sdk.ec_publicKey || ''
    };
  }

  // ECDSA SHA256 签名 (使用 Web Crypto API)
  async function ecdsaSign(privateKeyHex, dataToSign) {
    if (!privateKeyHex || !dataToSign) return '';
    try {
      // EC 私钥 hex → ArrayBuffer
      var keyBytes = hexToArrayBuffer(privateKeyHex);
      // 导入为 ECDSA P-256 密钥
      var key = await crypto.subtle.importKey(
        'raw', keyBytes,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, ['sign']
      );
      // SHA-256 哈希 + 签名
      var dataBytes = new TextEncoder().encode(dataToSign);
      var signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key, dataBytes
      );
      // 转为 base64
      return arrayBufferToBase64(signature);
    } catch(e) {
      console.warn('[DM] ECDSA sign failed:', e.message);
      return '';
    }
  }

  function hexToArrayBuffer(hex) {
    hex = hex.replace(/[^0-9a-fA-F]/g, '');
    if (hex.length % 2) hex = '0' + hex;
    var len = hex.length / 2;
    var buf = new ArrayBuffer(len);
    var view = new Uint8Array(buf);
    for (var i = 0; i < len; i++) {
      view[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return buf;
  }

  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // 生成 msToken (107 随机字符)
  function generateMsToken() {
    var chars = 'ABCDEFGHIGKLMNOPQRSTUVWXYZabcdefghigklmnopqrstuvwxyz0123456789=';
    var arr = new Uint8Array(107);
    crypto.getRandomValues(arr);
    var result = '';
    for (var i = 0; i < 107; i++) {
      result += chars[arr[i] % chars.length];
    }
    return result;
  }

  // 计算 DM WebSocket access_key
  function computeAccessKey(deviceId, fpid, appKey) {
    var raw = (fpid || '9') + (appKey || 'e1bd35ec9db7b8d846de66ed140b1ad9') + deviceId + 'f8a69f1719916z';
    // MD5 — 使用浏览器原生 crypto API (如果支持) 否则用简化方法
    // 注意: crypto.subtle.digest 是异步的，这里我们需要同步方法
    // 使用简单的 hash (生产环境应使用完整 MD5)
    // 由于浏览器限制，暂时用简单的 XOR hash 作为占位
    // 实际使用时需要引入 MD5 实现或使用 crypto.subtle
    return md5(raw);
  }

  // 简单 MD5 实现 (用于 access_key 计算)
  function md5(string) {
    function rotateLeft(lValue, iShiftBits) {
      return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
    }
    function addUnsigned(lX, lY) {
      var lX4, lY4, lX8, lY8, lResult;
      lX8 = (lX & 0x80000000);
      lY8 = (lY & 0x80000000);
      lX4 = (lX & 0x40000000);
      lY4 = (lY & 0x40000000);
      lResult = (lX & 0x3FFFFFFF) + (lY & 0x3FFFFFFF);
      if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
      if (lX4 | lY4) {
        if (lResult & 0x40000000) return lResult ^ 0xC0000000 ^ lX8 ^ lY8;
        else return lResult ^ 0x40000000 ^ lX8 ^ lY8;
      } else return lResult ^ lX8 ^ lY8;
    }
    function F(x, y, z) { return (x & y) | ((~x) & z); }
    function G(x, y, z) { return (x & z) | (y & (~z)); }
    function H(x, y, z) { return x ^ y ^ z; }
    function I(x, y, z) { return y ^ (x | (~z)); }
    function FF(a, b, c, d, x, s, ac) {
      a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac));
      return addUnsigned(rotateLeft(a, s), b);
    }
    function GG(a, b, c, d, x, s, ac) {
      a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac));
      return addUnsigned(rotateLeft(a, s), b);
    }
    function HH(a, b, c, d, x, s, ac) {
      a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac));
      return addUnsigned(rotateLeft(a, s), b);
    }
    function II(a, b, c, d, x, s, ac) {
      a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac));
      return addUnsigned(rotateLeft(a, s), b);
    }
    function convertToWordArray(string) {
      var lWordCount, lMessageLength = string.length, lNumberOfWords_temp1 = lMessageLength + 8,
          lNumberOfWords_temp2 = (lNumberOfWords_temp1 - (lNumberOfWords_temp1 % 64)) / 64,
          lNumberOfWords = (lNumberOfWords_temp2 + 1) * 16,
          lWordArray = Array(lNumberOfWords - 1), lBytePosition = 0, lByteCount = 0;
      while (lByteCount < lMessageLength) {
        lWordCount = (lByteCount - (lByteCount % 4)) / 4;
        lBytePosition = (lByteCount % 4) * 8;
        lWordArray[lWordCount] = (lWordArray[lWordCount] | (string.charCodeAt(lByteCount) << lBytePosition));
        lByteCount++;
      }
      lWordCount = (lByteCount - (lByteCount % 4)) / 4;
      lBytePosition = (lByteCount % 4) * 8;
      lWordArray[lWordCount] = lWordArray[lWordCount] | (0x80 << lBytePosition);
      lWordArray[lNumberOfWords - 2] = lMessageLength << 3;
      lWordArray[lNumberOfWords - 1] = lMessageLength >>> 29;
      return lWordArray;
    }
    function wordToHex(lValue) {
      var wordToHexValue = '', wordToHexValue_temp = '', lByte, lCount;
      for (lCount = 0; lCount <= 3; lCount++) {
        lByte = (lValue >>> (lCount * 8)) & 255;
        wordToHexValue_temp = '0' + lByte.toString(16);
        wordToHexValue = wordToHexValue + wordToHexValue_temp.substr(wordToHexValue_temp.length - 2, 2);
      }
      return wordToHexValue;
    }
    var x = convertToWordArray(string);
    var a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
    for (var k = 0; k < x.length; k += 16) {
      var AA = a, BB = b, CC = c, DD = d;
      a = FF(a, b, c, d, x[k+0],  7,  0xD76AA478);
      d = FF(d, a, b, c, x[k+1],  12, 0xE8C7B756);
      c = FF(c, d, a, b, x[k+2],  17, 0x242070DB);
      b = FF(b, c, d, a, x[k+3],  22, 0xC1BDCEEE);
      a = FF(a, b, c, d, x[k+4],  7,  0xF57C0FAF);
      d = FF(d, a, b, c, x[k+5],  12, 0x4787C62A);
      c = FF(c, d, a, b, x[k+6],  17, 0xA8304613);
      b = FF(b, c, d, a, x[k+7],  22, 0xFD469501);
      a = FF(a, b, c, d, x[k+8],  7,  0x698098D8);
      d = FF(d, a, b, c, x[k+9],  12, 0x8B44F7AF);
      c = FF(c, d, a, b, x[k+10], 17, 0xFFFF5BB1);
      b = FF(b, c, d, a, x[k+11], 22, 0x895CD7BE);
      a = FF(a, b, c, d, x[k+12], 7,  0x6B901122);
      d = FF(d, a, b, c, x[k+13], 12, 0xFD987193);
      c = FF(c, d, a, b, x[k+14], 17, 0xA679438E);
      b = FF(b, c, d, a, x[k+15], 22, 0x49B40821);
      a = GG(a, b, c, d, x[k+1],  5,  0xF61E2562);
      d = GG(d, a, b, c, x[k+6],  9,  0xC040B340);
      c = GG(c, d, a, b, x[k+11], 14, 0x265E5A51);
      b = GG(b, c, d, a, x[k+0],  20, 0xE9B6C7AA);
      a = GG(a, b, c, d, x[k+5],  5,  0xD62F105D);
      d = GG(d, a, b, c, x[k+10], 9,  0x02441453);
      c = GG(c, d, a, b, x[k+15], 14, 0xD8A1E681);
      b = GG(b, c, d, a, x[k+4],  20, 0xE7D3FBC8);
      a = GG(a, b, c, d, x[k+9],  5,  0x21E1CDE6);
      d = GG(d, a, b, c, x[k+14], 9,  0xC33707D6);
      c = GG(c, d, a, b, x[k+3],  14, 0xF4D50D87);
      b = GG(b, c, d, a, x[k+8],  20, 0x455A14ED);
      a = GG(a, b, c, d, x[k+13], 5,  0xA9E3E905);
      d = GG(d, a, b, c, x[k+2],  9,  0xFCEFA3F8);
      c = GG(c, d, a, b, x[k+7],  14, 0x676F02D9);
      b = GG(b, c, d, a, x[k+12], 20, 0x8D2A4C8A);
      a = HH(a, b, c, d, x[k+5],  4,  0xFFFA3942);
      d = HH(d, a, b, c, x[k+8],  11, 0x8771F681);
      c = HH(c, d, a, b, x[k+11], 16, 0x6D9D6122);
      b = HH(b, c, d, a, x[k+14], 23, 0xFDE5380C);
      a = HH(a, b, c, d, x[k+1],  4,  0xA4BEEA44);
      d = HH(d, a, b, c, x[k+4],  11, 0x4BDECFA9);
      c = HH(c, d, a, b, x[k+7],  16, 0xF6BB4B60);
      b = HH(b, c, d, a, x[k+10], 23, 0xBEBFBC70);
      a = HH(a, b, c, d, x[k+13], 4,  0x289B7EC6);
      d = HH(d, a, b, c, x[k+0],  11, 0xEAA127FA);
      c = HH(c, d, a, b, x[k+3],  16, 0xD4EF3085);
      b = HH(b, c, d, a, x[k+6],  23, 0x04881D05);
      a = HH(a, b, c, d, x[k+9],  4,  0xD9D4D039);
      d = HH(d, a, b, c, x[k+12], 11, 0xE6DB99E5);
      c = HH(c, d, a, b, x[k+15], 16, 0x1FA27CF8);
      b = HH(b, c, d, a, x[k+2],  23, 0xC4AC5665);
      a = II(a, b, c, d, x[k+0],  6,  0xF4292244);
      d = II(d, a, b, c, x[k+7],  10, 0x432AFF97);
      c = II(c, d, a, b, x[k+14], 15, 0xAB9423A7);
      b = II(b, c, d, a, x[k+5],  21, 0xFC93A039);
      a = II(a, b, c, d, x[k+12], 6,  0x655B59C3);
      d = II(d, a, b, c, x[k+3],  10, 0x8F0CCC92);
      c = II(c, d, a, b, x[k+10], 15, 0xFFEFF47D);
      b = II(b, c, d, a, x[k+1],  21, 0x85845DD1);
      a = II(a, b, c, d, x[k+8],  6,  0x6FA87E4F);
      d = II(d, a, b, c, x[k+15], 10, 0xFE2CE6E0);
      c = II(c, d, a, b, x[k+6],  15, 0xA3014314);
      b = II(b, c, d, a, x[k+13], 21, 0x4E0811A1);
      a = II(a, b, c, d, x[k+4],  6,  0xF7537E82);
      d = II(d, a, b, c, x[k+11], 10, 0xBD3AF235);
      c = II(c, d, a, b, x[k+2],  15, 0x2AD7D2BB);
      b = II(b, c, d, a, x[k+9],  21, 0xEB86D391);
      a = addUnsigned(a, AA);
      b = addUnsigned(b, BB);
      c = addUnsigned(c, CC);
      d = addUnsigned(d, DD);
    }
    return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
  }

  // 获取 deviceId (用于 WebSocket)
  function getDeviceId() {
    try {
      return (localStorage.getItem('d_device_id') || localStorage.getItem('device_id')
              || getCookie('device_id') || '0');
    } catch(e) { return '0'; }
  }

  return {
    getDMKeys: getDMKeys,
    ecdsaSign: ecdsaSign,
    generateMsToken: generateMsToken,
    computeAccessKey: computeAccessKey,
    getDeviceId: getDeviceId,
    md5: md5
  };
})();

*/}).toString().match(/\/\*([\s\S]*)\*\//)[1];
  unsafeWindow.eval(DM_BRIDGE_CODE);
  console.log('[Bridge:Douyin] DM Bridge lib injected');
  var BRIDGE_CODE = (function () {/*
var PAGE_LOAD_TIME = Date.now();
function getCookie(name) { var match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([\.$?*|{}\(\)\[\]\\+/^])/g, '\\$1') + '=([^;]*)')); return match ? decodeURIComponent(match[1]) : ''; }
// 统一 fetch+JSON 解析：失败时抛出含状态码/Content-Type/响应前 200 字的友好错误。
// readOnly=true 的请求在非 JSON 响应时自动重试 1 次（间隔 1s），写操作绝不重试。
async function bridgeFetchJson(label, url, init, readOnly){
  var attempt = 0;
  while (true) {
    attempt++;
    var r, text, ct;
    try {
      r = await fetch(url, init || {});
      ct = (r.headers && r.headers.get) ? (r.headers.get('content-type') || '') : '';
      text = await r.text();
    } catch (netErr) {
      if (readOnly && attempt === 1) { await new Promise(function(res){setTimeout(res,1000);}); continue; }
      throw new Error('['+label+'] 网络请求失败: ' + (netErr && netErr.message ? netErr.message : netErr));
    }
    if (!r.ok) {
      // 4xx/5xx：抖音风控页通常是 200+HTML，所以这里多半是网关错误
      var snippet = text.length > 200 ? text.substring(0,200) + '...' : text;
      throw new Error('['+label+'] HTTP ' + r.status + ' (' + ct + '): ' + snippet);
    }
    // 空响应（抖音偶发，常见于被限流）
    if (!text || !text.trim()) {
      if (readOnly && attempt === 1) { await new Promise(function(res){setTimeout(res,1000);}); continue; }
      throw new Error('['+label+'] 服务器返回空响应 (HTTP 200, content-type: ' + ct + ') — 可能被限流或登录态失效');
    }
    try {
      // reviver：防御 19 位 cid/aweme_id/uid 若以 JSON number 返回时精度丢失，转字符串
      return JSON.parse(text, function(k, v) {
        return (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v)) ? String(v) : v;
      });
    } catch (parseErr) {
      // 非 JSON：通常是 HTML 风控/登录页
      var snippet2 = text.length > 200 ? text.substring(0,200) + '...' : text;
      var isHtml = /^\s*</.test(text) || /text\/html/i.test(ct);
      var hint = isHtml ? '抖音返回了 HTML 页面（可能登录态失效/被风控/账号校验中），请刷新 douyin.com 并重新登录' : '响应不是合法 JSON';
      if (readOnly && attempt === 1) { await new Promise(function(res){setTimeout(res,1000);}); continue; }
      throw new Error('['+label+'] '+hint+' (content-type: ' + ct + '): ' + snippet2);
    }
  }
}
window.__bridge = {
  _q: function() {
    var conn = navigator.connection || {};
    // 动态获取真实 Chrome 版本，避免硬编码被检测
    var ua = navigator.userAgent;
    var chromeVer = '148.0.0.0';
    var m = ua.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
    if (m) chromeVer = m[1];
    return {
      device_platform:'webapp',aid:'6383',channel:'channel_pc_web',
      pc_client_type:'1',pc_libra_divert:'Windows',
      update_version_code:'170400',support_h265:'1',support_dash:'1',
      version_code:'170400',version_name:'17.4.0',
      cookie_enabled:'true',screen_width:String(screen.width),screen_height:String(screen.height),
      browser_language:navigator.language||'zh-CN',browser_platform:'Win32',
      browser_name:'Chrome',browser_version:chromeVer,
      browser_online:'true',engine_name:'Blink',engine_version:chromeVer,
      os_name:'Windows',os_version:'10',
      cpu_core_num:String(navigator.hardwareConcurrency||12),device_memory:String(navigator.deviceMemory||16),platform:'PC',
      downlink:String(conn.downlink||10),effective_type:conn.effectiveType||'4g',round_trip_time:String(conn.rtt||100)
    };
  },
  replies: async function(cid,awemeId,cursor,count){
    var p=new URLSearchParams(Object.assign(this._q(),{aweme_id:awemeId,comment_id:cid,cursor:cursor||0,count:count||10,item_type:'0',pc_img_format:'webp',cut_version:'1'}));
    return await bridgeFetchJson('replies','/aweme/v1/web/comment/list/reply/?'+p,{credentials:'include'},true);
  },
  getComments: async function(id,c,n){
    var p=new URLSearchParams(Object.assign(this._q(),{aweme_id:id,cursor:c||0,count:n||20,item_type:'0',pc_img_format:'webp',cut_version:'1'}));
    return await bridgeFetchJson('getComments','/aweme/v1/web/comment/list/?'+p,{credentials:'include'},true);
  },
  myPosts: async function(cursor,count){
    var info=await bridgeFetchJson('myPosts.userinfo','/aweme/v1/web/query/user/?device_platform=webapp&aid=6383&channel=channel_pc_web',{credentials:'include'},true);
    var secUid=(info.user||{}).sec_uid||'';
    var p=new URLSearchParams(Object.assign(this._q(),{sec_user_id:secUid,max_cursor:cursor||0,count:count||18,locate_query:'false',show_live_replay_strategy:'1',need_time_list:'1',time_list_query:'0',whale_cut_token:'',cut_version:'1',publish_video_strategy_type:'2',from_user_page:'0'}));
    return await bridgeFetchJson('myPosts','/aweme/v1/web/aweme/post/?'+p,{credentials:'include'},true);
  },
  // 任意用户作品列表（按 sec_user_id 查看他人主页作品）
  userPosts: async function(secUserId,cursor,count){
    var p=new URLSearchParams(Object.assign(this._q(),{sec_user_id:secUserId,max_cursor:cursor||0,count:count||18,locate_query:'false',show_live_replay_strategy:'1',need_time_list:'1',time_list_query:'0',whale_cut_token:'',cut_version:'1',publish_video_strategy_type:'2',from_user_page:'1'}));
    return await bridgeFetchJson('userPosts','/aweme/v1/web/aweme/post/?'+p,{credentials:'include'},true);
  },
  search: async function(kw,offset,count){
    var p=new URLSearchParams(Object.assign(this._q(),{keyword:kw,offset:offset||0,count:count||10,search_channel:'aweme_general',search_source:'normal_search',query_correct_type:'1',is_filter_search:'0',need_filter_settings:'0',list_type:'single'}));
    return await bridgeFetchJson('search','/aweme/v1/web/general/search/single/?'+p,{credentials:'include'},true);
  },
  publish: async function(id,text,rid,rrid,mentions,images){
    var extras=mentions?JSON.stringify(mentions):'[]';var now=Date.now();
    var sendCelltime=String(Math.floor((now-PAGE_LOAD_TIME)/1000)*1000);
    var videoCelltime=String(Number(sendCelltime)+5000+Math.floor(Math.random()*30000));
    var b=new URLSearchParams();b.set('aweme_id',id);b.set('comment_send_celltime',sendCelltime);b.set('comment_video_celltime',videoCelltime);b.set('one_level_comment_rank',rid?'1':'-1');b.set('paste_edit_method',Math.random()<0.9?'non_paste':'paste');
    if(rid)b.set('reply_id',rid);if(rrid)b.set('reply_to_reply_id',rrid);b.set('text',text);b.set('text_extra',extras);
    // 图片评论：多个字段以逗号分隔（实测确认字段名，单一图片同样适用）
    if(images&&images.length){
      b.set('image_uri_list',images.map(function(x){return x.uri;}).join(','));
      b.set('image_formats',images.map(function(x){return x.format||'jpeg';}).join(','));
      b.set('image_widths',images.map(function(x){return String(x.width||0);}).join(','));
      b.set('image_heights',images.map(function(x){return String(x.height||0);}).join(','));
    }
    var qParams={};qParams.app_name='aweme';qParams.enter_from=Math.random()<0.85?'others_homepage':'search_result';qParams.previous_page=Math.random()<0.85?'others_homepage':'homepage';qParams.aweme_id=id;qParams.item_type='0';
    var fp=this._q();for(var k in fp){if(fp.hasOwnProperty(k))qParams[k]=fp[k];}
    qParams.webid=getCookie('s_v_web_id')||getCookie('webid')||'';qParams.uifid=getCookie('UIFID')||'';
    var q=new URLSearchParams();for(var key in qParams){if(qParams.hasOwnProperty(key))q.set(key,qParams[key]);}
    // publish 是写操作，readOnly=false，绝不自动重试（避免重复发布）
    return await bridgeFetchJson('publish','/aweme/v1/web/comment/publish/?'+q,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:b.toString(),credentials:'include'},false);
  },
  digg: async function(awemeId,type){
    var p=new URLSearchParams(Object.assign(this._q(),{}));
    var b=new URLSearchParams({aweme_id:awemeId,item_type:'0',type:String(type)});
    return await bridgeFetchJson('digg','/aweme/v1/web/commit/item/digg/?'+p,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},body:b.toString(),credentials:'include'},false);
  },
  deleteComment: async function(cid){
    var p=new URLSearchParams(Object.assign(this._q(),{cid:cid,channel_id:'0',app_name:'aweme'}));
    return await bridgeFetchJson('deleteComment','/aweme/v1/web/comment/delete?'+p,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},body:'',credentials:'include'},false);
  },
  // ── 私信 (DM) ──
  _dmKeys: function(){ return _DM_HELPERS.getDMKeys(); },
  _myUidCache: null,
  _getMyUid: async function(){
    if(window.__bridge._myUidCache)return window.__bridge._myUidCache;
    // 从 myPosts 的 user info API 获取
    try{
      var p=new URLSearchParams(Object.assign(this._q(),{}));
      var info=await bridgeFetchJson('getMyUid','/aweme/v1/web/query/user/?'+p,{credentials:'include'},true);
      var uid=(info.user||{}).uid||(info.user||{}).short_id||'';
      if(uid){window.__bridge._myUidCache=String(uid);return uid;}
    }catch(e){console.warn('[DM] getMyUid failed:',e.message);}
    // fallback: 从 cookie 或 localStorage 取
    var id=getCookie('uid')||getCookie('UIFID')||'';
    if(id&&id.length>=3)return id;
    try{var ui=JSON.parse(localStorage.getItem('user_info')||'{}');id=ui.short_id||ui.user_id||ui.uid||'';}catch(e){}
    if(id&&id.length>=3&&id.length<20)return id;
    return '';
  },
  createConversation: async function(toUserId){
    var keys=_DM_HELPERS.getDMKeys();
    var myUid=await this._getMyUid();
    if(!myUid)throw new Error('无法获取当前登录用户的ID，请确认已登录抖音');
    var bodyBytes=_DM_PROTO.encodeCreateConversationBody({conversation_type:1,participants:[toUserId,myUid]});
    var signData='avatar_url=&idempotent_id=&name=&participants='+toUserId+','+myUid;
    var reqSign=await _DM_HELPERS.ecdsaSign(keys.privateKey,signData);
    var requestBytes=_DM_PROTO.encodeRequest({cmd:609,token:keys.ticket,ts_sign:keys.ts_sign,
      sdk_cert:btoa(keys.client_cert||''),reuqest_sign:reqSign,bodyBytes:bodyBytes});
    var resp=await fetch('https://imapi.douyin.com/v2/conversation/create',{
      method:'POST',headers:{'Content-Type':'application/x-protobuf','Accept':'application/x-protobuf'},
      body:_DM_PROTO.bytesToArray(requestBytes),credentials:'include'});
    if(!resp.ok){var t=await resp.text();throw new Error('[createConversation] HTTP '+resp.status+': '+t.substring(0,200));}
    var respBytes=new Uint8Array(await resp.arrayBuffer());
    var result=_DM_PROTO.decodeResponse(respBytes);
    if(result.body&&result.body.create_conversation_v2_body){
      var cl=result.body.create_conversation_v2_body.conversation_info_list||[];
      if(cl.length>0)return{conversation_id:cl[0].conversation_id,
        conversation_short_id:String(cl[0].conversation_short_id),ticket:cl[0].ticket};
    }
    throw new Error('[createConversation] 未找到会话: '+JSON.stringify(result).substring(0,200));
  },
  sendDM: async function(convId,text){
    var parts=convId.split('|');
    var conversation_id=parts[0],conversation_short_id=parts[1]||'0',ticket=parts[2]||'';
    var keys=_DM_HELPERS.getDMKeys();
    var clientMsgId=Date.now().toString(36)+Math.random().toString(36).slice(2,8);
    var bodyBytes=_DM_PROTO.encodeSendMessageBody({conversation_id:conversation_id,
      conversation_short_id:conversation_short_id,conversation_type:1,ticket:ticket,
      text:text,client_message_id:clientMsgId,message_type:7});
    var contentJson=JSON.stringify({mention_users:[],aweType:700,richTextInfos:[],text:text});
    var signData='content='+contentJson+'&conversation_id='+conversation_id+'&conversation_short_id='+conversation_short_id;
    var reqSign=await _DM_HELPERS.ecdsaSign(keys.privateKey,signData);
    var requestBytes=_DM_PROTO.encodeRequest({cmd:100,token:keys.ticket,ts_sign:keys.ts_sign,
      sdk_cert:btoa(keys.client_cert||''),reuqest_sign:reqSign,bodyBytes:bodyBytes});
    var resp=await fetch('https://imapi.douyin.com/v1/message/send',{
      method:'POST',headers:{'Content-Type':'application/x-protobuf','Accept':'application/x-protobuf'},
      body:_DM_PROTO.bytesToArray(requestBytes),credentials:'include'});
    if(!resp.ok){var t=await resp.text();throw new Error('[sendDM] HTTP '+resp.status+': '+t.substring(0,200));}
    var respBytes=new Uint8Array(await resp.arrayBuffer());
    return _DM_PROTO.decodeResponse(respBytes);
  },
  connectDMWS: function(){
    if(window.__dmWs&&window.__dmWs.readyState===WebSocket.OPEN)return{status:'connected'};
    // 获取真实 device_id: 优先取 cookie 中的 uid，然后尝试多种 localStorage key
    var deviceId=getCookie('uid')||getCookie('UIFID')||
      localStorage.getItem('d_device_id')||localStorage.getItem('device_id')||
      localStorage.getItem('user_unique_id')||'0';
    if(deviceId==='0'){
      try{var s=localStorage.getItem('bd_ticket_guard_client_data');if(s){var j=JSON.parse(s);deviceId=j.user_id||'0';}}catch(e){}
    }
    // 匹配抖音原生 IM WebSocket 参数
    var accessKey=_DM_HELPERS.computeAccessKey(deviceId,'9','e1bd35ec9db7b8d846de66ed140b1ad9');
    var p=new URLSearchParams({aid:'6383',device_platform:'web',fpid:'9',
      version_code:'fws_1.0.0',device_id:deviceId,access_key:accessKey,
      xsack:'0',xaack:'0',xsqos:'0',qos_sdk_version:'2'});
    try{
      var ws=new WebSocket('wss://frontier-im.douyin.com/ws/v2?'+p.toString());
      ws.binaryType='arraybuffer';
      ws.onopen=function(){console.log('[DM WS] Connected');window.__dmWs=ws;};
      ws.onmessage=function(event){
        try{
          var mbytes=new Uint8Array(event.data);
          var frame=_DM_PROTO.decodePushFrame(mbytes);
          if(frame.payloadType==='pb'&&frame.payload){
            var resp=_DM_PROTO.decodeResponse(frame.payload);
            if(resp.body&&resp.body.new_message_notify){
              var msg=resp.body.new_message_notify.message;
              window.__dmQueue=window.__dmQueue||[];
              window.__dmQueue.push({sender:String(msg.sender),
                conversation_id:msg.conversation_id,message_type:msg.message_type,
                content:msg.content_parsed||msg.content,
                index:String(msg.index_in_conversation),timestamp:Date.now()});
            }
          }
        }catch(e){console.warn('[DM WS] Decode:',e.message);}
      };
      ws.onclose=function(){console.log('[DM WS] Closed');setTimeout(function(){window.__bridge.connectDMWS();},5000);};
      ws.onerror=function(){console.warn('[DM WS] Error');};
      return{status:'connecting'};
    }catch(e){console.warn('[DM WS] Failed:',e.message);return{status:'error',error:e.message};}
  },
  pollDMs: async function(timeoutMs){
    var deadline=Date.now()+(timeoutMs||30000);
    window.__dmQueue=window.__dmQueue||[];
    this.connectDMWS();
    while(Date.now()<deadline){
      if(window.__dmQueue.length>0)return{messages:window.__dmQueue.splice(0),has_more:false};
      await new Promise(function(r){setTimeout(r,500);});
    }
    return{messages:[],has_more:false};
  },
  getDMs: function(){
    window.__dmQueue=window.__dmQueue||[];
    return window.__dmQueue.splice(0);
  },
  // ═══════════════════════════════════════════════════════════
  // 评论图片上传（ImageX，AWS SigV4）
  // 链路：comment/upload/auth → ApplyImageUpload → PUT TOS → CommitImageUpload
  // 全程用页面 fetch：授权接口同源自动带 cookie，上传域名跨域但服务端放行 CORS
  // ═══════════════════════════════════════════════════════════
  _imgx: (function(){
    var enc=new TextEncoder();
    function toHex(buf){var u=new Uint8Array(buf),s='';for(var i=0;i<u.length;i++)s+=(u[i]<16?'0':'')+u[i].toString(16);return s;}
    async function sha256Hex(data){
      var bytes=typeof data==='string'?enc.encode(data):data;
      return toHex(await crypto.subtle.digest('SHA-256',bytes));
    }
    async function hmacRaw(keyBytes,msg){
      var k=await crypto.subtle.importKey('raw',keyBytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
      return new Uint8Array(await crypto.subtle.sign('HMAC',k,typeof msg==='string'?enc.encode(msg):msg));
    }
    async function hmacHex(keyBytes,msg){return toHex(await hmacRaw(keyBytes,msg));}
    // AWS 规范 URI 编码（保留 A-Za-z0-9-_.~）
    function uriEncode(s){return encodeURIComponent(s).replace(/[!'()*]/g,function(c){return '%'+c.charCodeAt(0).toString(16).toUpperCase();});}
    function canonQuery(p){
      return Object.keys(p).sort().map(function(k){return uriEncode(k)+'='+uriEncode(p[k]);}).join('&');
    }
    function crc32(u8){
      var crc=0xFFFFFFFF,c,i,j;
      for(i=0;i<u8.length;i++){
        c=(crc^u8[i])&0xFF;
        for(j=0;j<8;j++)c=c&1?(c>>>1)^0xEDB88320:c>>>1;
        crc=(crc>>>8)^c;
      }
      return ((crc^0xFFFFFFFF)>>>0).toString(16).padStart(8,'0');
    }
    async function signingKey(secret,dateStamp){
      var k=await hmacRaw(enc.encode('AWS4'+secret),dateStamp);
      k=await hmacRaw(k,'cn-north-1');k=await hmacRaw(k,'imagex');
      return hmacRaw(k,'aws4_request');
    }
    // 签名并发送 ImageX 请求（region/service 固定 cn-north-1 / imagex）
    async function sign(method,host,pathname,creds,params,bodyObj){
      var amzDate=new Date().toISOString().replace(/\.\d{3}Z$/,'Z').replace(/[:\-]/g,'');
      var dateStamp=amzDate.slice(0,8);
      var cq=canonQuery(params||{});
      var hdrs={'x-amz-date':amzDate,'x-amz-security-token':creds.sessionToken};
      var body=null;
      if(bodyObj){body=JSON.stringify(bodyObj);hdrs['X-Amz-Content-Sha256']=await sha256Hex(body);}
      var bodyHash=hdrs['X-Amz-Content-Sha256']||(body?await sha256Hex(canonQuery(body)):await sha256Hex(''));
      var lower={};Object.keys(hdrs).forEach(function(h){lower[h.toLowerCase()]=hdrs[h];});
      var names=Object.keys(lower).sort();
      var canonHeaders=names.map(function(n){return n+':'+lower[n]+'\n';}).join('');
      var signedHeaders=names.join(';');
      var canonReq=[method,pathname,cq,canonHeaders,signedHeaders,bodyHash].join('\n');
      var scope=dateStamp+'/cn-north-1/imagex/aws4_request';
      var sts=['AWS4-HMAC-SHA256',amzDate,scope,await sha256Hex(canonReq)].join('\n');
      var sig=await hmacHex(await signingKey(creds.secretAccessKey,dateStamp),sts);
      var auth='AWS4-HMAC-SHA256 Credential='+creds.accessKeyId+'/'+scope+', SignedHeaders='+signedHeaders+', Signature='+sig;
      var url='https://'+host+pathname+(cq?'?'+cq:'');
      var init={method:method,headers:Object.assign({Authorization:auth},hdrs)};
      if(body){init.body=body;init.headers['Content-Type']='application/json';}
      var r=await fetch(url,init);
      var text=await r.text();
      var json;try{json=JSON.parse(text);}catch(e){json=text.slice(0,300);}
      return {http:r.status,body:json};
    }
    return {sha256Hex:sha256Hex,crc32:crc32,canonQuery:canonQuery,uriEncode:uriEncode,sign:sign};
  })(),
  // 分块传输缓冲：避免单条 eval 表达式塞进数 MB base64 拖垮 WebSocket
  _imgBuf: null,
  _storageUidCache: null,
  _getStorageUid: async function(){
    if(this._storageUidCache)return this._storageUidCache;
    try{
      var info=await bridgeFetchJson('getStorageUid','/aweme/v1/web/query/user/?'+new URLSearchParams(this._q()),{credentials:'include'},true);
      if(info&&info.user_uid){this._storageUidCache=String(info.user_uid);return this._storageUidCache;}
    }catch(e){console.warn('[Bridge] getStorageUid failed:',e.message);}
    return '';
  },
  imageBegin: function(expectedLen){this._imgBuf={parts:[],len:0,expected:expectedLen||0};return true;},
  imageAppend: function(chunk){
    if(!this._imgBuf)throw new Error('imageBegin() 未调用');
    this._imgBuf.parts.push(chunk);this._imgBuf.len+=chunk.length;
    return this._imgBuf.len;
  },
  imageReset: function(){this._imgBuf=null;return true;},
  // 上传缓冲中的图片 → {uri,width,height,format,size}
  imageUpload: async function(){
    if(!this._imgBuf||!this._imgBuf.len)throw new Error('图片缓冲为空，请先 imageBegin/imageAppend');
    var b64=this._imgBuf.parts.join('');
    this._imgBuf=null;
    var bin=atob(b64),u8=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);

    // 1) 取上传授权（同源，自动带 cookie）
    var q=Object.assign(this._q(),{content_type:'0'});
    var auth=await bridgeFetchJson('commentUploadAuth','/aweme/v1/web/comment/upload/auth/?'+new URLSearchParams(q),{credentials:'include'},true);
    if(auth.status_code!==0||!auth.access_key)throw new Error('取图片上传授权失败: '+(auth.status_msg||('status_code='+auth.status_code)));
    var creds={accessKeyId:auth.access_key,secretAccessKey:auth.secret_key,sessionToken:auth.session_token};

    // 2) ApplyImageUpload
    var apply=await this._imgx.sign('GET',auth.upload_domain,'/',creds,{
      Action:'ApplyImageUpload',Version:'2018-08-01',ServiceId:auth.service_id,
      s:Math.random().toString(36).slice(2)
    });
    var addr=apply.body&&apply.body.Result&&apply.body.Result.UploadAddress;
    if(!addr||!addr.StoreInfos||!addr.StoreInfos.length)throw new Error('申请上传地址失败: '+JSON.stringify(apply.body).slice(0,200));

    // 3) 上传字节到 TOS（无 /upload/v1 前缀，实测确认）
    var store=addr.StoreInfos[0];
    var uid=await this._getStorageUid();
    var upRes=await fetch('https://'+addr.UploadHosts[0]+'/'+store.StoreUri,{
      method:'PUT',
      headers:{Authorization:store.Auth,'Content-CRC32':this._imgx.crc32(u8),'X-Storage-U':uid},
      body:u8
    });
    var upText=await upRes.text();
    if(upRes.status!==200||/"success"\s*:\s*[1-9]/.test(upText)){
      throw new Error('图片上传失败 HTTP '+upRes.status+': '+upText.slice(0,200));
    }

    // 4) CommitImageUpload
    var commit=await this._imgx.sign('POST',auth.upload_domain,'/',creds,
      {Action:'CommitImageUpload',Version:'2018-08-01',ServiceId:auth.service_id},
      {SessionKey:addr.SessionKey});
    var pr=commit.body&&commit.body.Result&&commit.body.Result.PluginResult&&commit.body.Result.PluginResult[0];
    if(!pr)throw new Error('图片提交失败: '+JSON.stringify(commit.body).slice(0,200));
    return {uri:pr.ImageUri,width:pr.ImageWidth,height:pr.ImageHeight,format:pr.ImageFormat,size:pr.ImageSize};
  },
  getDetail: async function(awemeId){
    var p=new URLSearchParams(Object.assign(this._q(),{aweme_id:awemeId}));
    return await bridgeFetchJson('getDetail','/aweme/v1/web/aweme/detail/?'+p,{credentials:'include'},true);
  }
};
console.log('[Bridge:Douyin] __bridge API ready');
*/}).toString().match(/\/\*([\s\S]*)\*\//)[1];

  // 注入到页面上下文（用页面的 fetch/cookie，不用 sandbox 的）
  unsafeWindow.eval(BRIDGE_CODE);

  // ── Auto-connect DM WebSocket (3s delay) ──
  setTimeout(function() {
    try { (0, unsafeWindow.eval)('if(window.__bridge&&window.__bridge.connectDMWS)window.__bridge.connectDMWS();'); } catch(e) {}
  }, 3000);
  // ── 启动轮询 ──
  connect();

  console.log('[Bridge:Douyin] Ready — connected to ' + CONFIG.server);
})();
