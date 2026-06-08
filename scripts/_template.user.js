// ==UserScript==
// @name         Bridge: {{SITE_NAME}}
// @namespace    bridge-framework
// @match        {{URL_PATTERN}}
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// ==/UserScript==

// ═══════════════════════════════════════════════════════════
// Bridge Framework — 通用油猴脚本模板
// 替换 {{SITE_NAME}}、{{URL_PATTERN}}、{{SITE_KEY}} 后使用。
// 通过 GM_xmlhttpRequest 绕过 Chrome PNA，unsafeWindow.eval 注入页面 API。
// ═══════════════════════════════════════════════════════════

(function() {
  'use strict';

  var CONFIG = {
    server: 'http://127.0.0.1:19422',
    site: '{{SITE_KEY}}',
    token: '',  // 填入 config.json 中的 bridge.token
    reconnectDelay: 2000,
  };

  var connected = false;
  var registered = false;
  var retryCount = 0;
  var pollFailCount = 0;

  function gmFetch(url, opts) {
    var headers = Object.assign({}, opts && opts.headers);
    if (CONFIG.token) headers['Authorization'] = 'Bearer ' + CONFIG.token;
    return new Promise(function(resolve, reject) {
      GM_xmlhttpRequest(Object.assign({ url: url, timeout: 35000 }, opts, {
        headers: headers,
        onload: function(r) { resolve(r); },
        onerror: function(e) { reject(new Error('GM_xmlhttpRequest failed')); },
        ontimeout: function() { reject(new Error('GM_xmlhttpRequest timeout')); },
      }));
    });
  }

  function safeSerialize(value) {
    try {
      return JSON.parse(JSON.stringify(value === undefined ? null : value));
    } catch(e) { return null; }
  }

  // ── 连接管理（GM_xmlhttpRequest 绕过 PNA）──
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
          registered = true; connected = true; retryCount = 0;
          console.log('[Bridge] ✓ Registered with Bridge Server');
        } else { throw new Error('status ' + r.status); }
      } catch (err) {
        retryCount++;
        var delay = Math.min(CONFIG.reconnectDelay * Math.pow(2, retryCount - 1), 60000);
        console.warn('[Bridge] Registration failed, retry in ' + Math.round(delay/1000) + 's:', err.message);
        setTimeout(connect, delay);
        return;
      }
    }
    poll();
  }

  async function poll() {
    if (!registered) return;
    try {
      var r = await gmFetch(CONFIG.server + '/api/poll?site=' + CONFIG.site, { method: 'GET' });
      if (r.status !== 200) throw new Error('status ' + r.status);
      var msg = JSON.parse(r.responseText);
      if (msg.type === 'eval') {
        connected = true;
        pollFailCount = 0;
        try {
          // 在页面上下文执行 eval
          var result = (0, unsafeWindow.eval)(msg.expression);
          if (msg.awaitPromise !== false) result = await Promise.resolve(result);
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
      if (pollFailCount >= 3) {
        console.warn('[Bridge] Poll failed ' + pollFailCount + ' times, reconnecting:', err.message);
        connected = false; registered = false; pollFailCount = 0;
        setTimeout(connect, CONFIG.reconnectDelay);
      } else {
        setTimeout(poll, 1000);
      }
    }
  }

  // ── SPA 导航检测（拦截页面 history API）──
  var lastUrl = location.href;
  function checkUrlChange() { if (location.href !== lastUrl) { lastUrl = location.href; } }
  var _pushState = unsafeWindow.history.pushState;
  var _replaceState = unsafeWindow.history.replaceState;
  unsafeWindow.history.pushState = function() { _pushState.apply(this, arguments); checkUrlChange(); };
  unsafeWindow.history.replaceState = function() { _replaceState.apply(this, arguments); checkUrlChange(); };
  unsafeWindow.addEventListener('popstate', checkUrlChange);
  unsafeWindow.addEventListener('hashchange', checkUrlChange);

  // ═══════════════════════════════════════════════════════════
  // 站点 __bridge API — 注入页面上下文（用页面的 fetch/cookie）
  // ═══════════════════════════════════════════════════════════

  var BRIDGE_CODE = (function(){/*
var PAGE_LOAD_TIME = Date.now();
function getCookie(name) { var match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([\.$?*|{}\(\)\[\]\\+/^])/g, '\\$1') + '=([^;]*)')); return match ? decodeURIComponent(match[1]) : ''; }
window.__bridge = {
  _q: function() {
    return {
      device_platform:'webapp',aid:'6383',channel:'channel_pc_web',
      cookie_enabled:'true',screen_width:String(screen.width),screen_height:String(screen.height),
      browser_language:navigator.language||'zh-CN',browser_platform:'Win32',
      browser_name:'Chrome',browser_online:'true',platform:'PC',
      cpu_core_num:String(navigator.hardwareConcurrency||8),device_memory:String(navigator.deviceMemory||16),
    };
  },
  // 在此添加站点 API 方法...
};
console.log('[Bridge:{{SITE_NAME}}] __bridge API ready');
*/}).toString().match(/\/\*([\s\S]*)\*\//)[1];

  // 注入到页面上下文
  unsafeWindow.eval(BRIDGE_CODE);

  // ── 启动 ──
  connect();
  console.log('[Bridge] Script loaded for ' + CONFIG.site);
})();
