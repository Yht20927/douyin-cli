// ==UserScript==
// @name         Bridge: Douyin
// @namespace    bridge-framework
// @match        *://*.douyin.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// ==/UserScript==

// ═══════════════════════════════════════════════════════════
// Bridge Framework — 抖音脚本
// 通过 GM_xmlhttpRequest 绕过 Chrome PNA loopback 限制
// unsafeWindow 用于页面上下文的 eval 和 __bridge API
// ═══════════════════════════════════════════════════════════

(function() {
  'use strict';

  const CONFIG = {
    server: 'http://127.0.0.1:19422',
    site: 'douyin.com',
    token: '',  // 填入 config.json 中的 bridge.token
    reconnectDelay: 2000,
  };

  let connected = false;
  let registered = false;
  let retryCount = 0;          // 连续重试次数（指数退避用）
  let pollFailCount = 0;       // 连续 poll 失败次数

  function gmFetch(url, opts) {
    // 自动注入 Authorization header
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
          console.log('[Bridge] ✓ Registered with Bridge Server');
        } else {
          throw new Error('status ' + r.status);
        }
      } catch (err) {
        retryCount++;
        // 指数退避: 2s, 4s, 8s, 16s, 最大 60s
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
          console.log('[Bridge] eval result type:', typeof result, 'keys:', result ? Object.keys(result).slice(0,5) : 'null/undefined');
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
      return JSON.parse(JSON.stringify(value === undefined ? null : value));
    } catch(e) {
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
  unsafeWindow.history.pushState = function() { _pushState.apply(this, arguments); checkUrlChange(); };
  unsafeWindow.history.replaceState = function() { _replaceState.apply(this, arguments); checkUrlChange(); };
  unsafeWindow.addEventListener('popstate', checkUrlChange);
  unsafeWindow.addEventListener('hashchange', checkUrlChange);

  // ═══════════════════════════════════════════════════════════
  // 抖音 Bridge API — 注入到页面上下文（用页面的 fetch/cookie）
  // ═══════════════════════════════════════════════════════════

  var BRIDGE_CODE = (function(){/*
var PAGE_LOAD_TIME = Date.now();
function getCookie(name) { var match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([\.$?*|{}\(\)\[\]\\+/^])/g, '\\$1') + '=([^;]*)')); return match ? decodeURIComponent(match[1]) : ''; }
window.__bridge = {
  _q: function() {
    var conn = navigator.connection || {}; return {
      device_platform:'webapp',aid:'6383',channel:'channel_pc_web',
      pc_client_type:'1',pc_libra_divert:'Windows',
      update_version_code:'170400',support_h265:'1',support_dash:'1',
      version_code:'170400',version_name:'17.4.0',
      cookie_enabled:'true',screen_width:String(screen.width),screen_height:String(screen.height),
      browser_language:navigator.language||'zh-CN',browser_platform:'Win32',
      browser_name:'Chrome',browser_version:'148.0.0.0',
      browser_online:'true',engine_name:'Blink',engine_version:'148.0.0.0',
      os_name:'Windows',os_version:'10',
      cpu_core_num:String(navigator.hardwareConcurrency||12),device_memory:String(navigator.deviceMemory||16),platform:'PC',
      downlink:String(conn.downlink||10),effective_type:conn.effectiveType||'4g',round_trip_time:String(conn.rtt||100)
    };
  },
  replies: async function(cid,awemeId,cursor,count){
    var p=new URLSearchParams(Object.assign(this._q(),{aweme_id:awemeId,comment_id:cid,cursor:cursor||0,count:count||10,item_type:'0',pc_img_format:'webp',cut_version:'1'}));
    var r=await fetch('/aweme/v1/web/comment/list/reply/?'+p,{credentials:'include'});return await r.json();
  },
  getComments: async function(id,c,n){
    var p=new URLSearchParams(Object.assign(this._q(),{aweme_id:id,cursor:c||0,count:n||20,item_type:'0',pc_img_format:'webp',cut_version:'1'}));
    var r=await fetch('/aweme/v1/web/comment/list/?'+p,{credentials:'include'});return await r.json();
  },
  myPosts: async function(cursor,count){
    var info=await(await fetch('/aweme/v1/web/query/user/?device_platform=webapp&aid=6383&channel=channel_pc_web',{credentials:'include'})).json();
    var secUid=(info.user||{}).sec_uid||'';
    var p=new URLSearchParams(Object.assign(this._q(),{sec_user_id:secUid,max_cursor:cursor||0,count:count||18,locate_query:'false',show_live_replay_strategy:'1',need_time_list:'1',time_list_query:'0',whale_cut_token:'',cut_version:'1',publish_video_strategy_type:'2',from_user_page:'0'}));
    var r=await fetch('/aweme/v1/web/aweme/post/?'+p,{credentials:'include'});return await r.json();
  },
  search: async function(kw,offset,count){
    var p=new URLSearchParams(Object.assign(this._q(),{keyword:kw,offset:offset||0,count:count||10,search_channel:'aweme_general',search_source:'normal_search',query_correct_type:'1',is_filter_search:'0',need_filter_settings:'0',list_type:'single'}));
    var r=await fetch('/aweme/v1/web/general/search/single/?'+p,{credentials:'include'});return await r.json();
  },
  publish: async function(id,text,rid,rrid,mentions){
    var extras=mentions?JSON.stringify(mentions):'[]';var now=Date.now();
    var sendCelltime=String(Math.floor((now-PAGE_LOAD_TIME)/1000)*1000);
    var videoCelltime=String(Number(sendCelltime)+5000+Math.floor(Math.random()*30000));
    var b=new URLSearchParams();b.set('aweme_id',id);b.set('comment_send_celltime',sendCelltime);b.set('comment_video_celltime',videoCelltime);b.set('one_level_comment_rank',rid?'1':'-1');b.set('paste_edit_method','non_paste');
    if(rid)b.set('reply_id',rid);if(rrid)b.set('reply_to_reply_id',rrid);b.set('text',text);b.set('text_extra',extras);
    var qParams={};qParams.app_name='aweme';qParams.enter_from='others_homepage';qParams.previous_page='others_homepage';qParams.aweme_id=id;qParams.item_type='0';
    var fp=this._q();for(var k in fp){if(fp.hasOwnProperty(k))qParams[k]=fp[k];}
    qParams.webid=getCookie('s_v_web_id')||getCookie('webid')||'';qParams.uifid=getCookie('UIFID')||'';
    var q=new URLSearchParams();for(var key in qParams){if(qParams.hasOwnProperty(key))q.set(key,qParams[key]);}
    var r=await fetch('/aweme/v1/web/comment/publish/?'+q,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:b.toString(),credentials:'include'});
    return await r.json();
  }
};
console.log('[Bridge:Douyin] __bridge API ready');
*/}).toString().match(/\/\*([\s\S]*)\*\//)[1];

  // 注入到页面上下文（用页面的 fetch/cookie，不用 sandbox 的）
  unsafeWindow.eval(BRIDGE_CODE);

  // ── 启动轮询 ──
  connect();

  console.log('[Bridge:Douyin] Ready — connected to ' + CONFIG.server);
})();
