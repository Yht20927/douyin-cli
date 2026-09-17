// app/preload/index.js — 渲染层可用的能力白名单
//
// 渲染层没有 Node 权限（contextIsolation 开、nodeIntegration 关），
// 只能通过这里经 contextBridge 暴露出去的方法与主进程通信。
// 原则：只暴露具体动作，不暴露 ipcRenderer 本身 —— 否则等于把整个 IPC 面开放出去。

const { contextBridge, ipcRenderer } = require('electron');

/** 订阅主进程推送；返回取消函数，组件卸载时必须调用，否则监听器会泄漏 */
function subscribe(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('dy', {
  /** 应用与运行环境信息（版本、数据目录、配置文件位置…） */
  info: () => ipcRenderer.invoke('app:info'),

  /** 用系统浏览器打开外链（会校验只允许 http/https） */
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  /** 退出应用 */
  quit: () => ipcRenderer.invoke('app:quit'),

  bridge: {
    /** 取当前状态（立即返回，不用等推送） */
    status: () => ipcRenderer.invoke('bridge:status'),
    /** 立即重新检测一次 */
    refresh: () => ipcRenderer.invoke('bridge:refresh'),
    /** 用系统浏览器打开一键安装地址（Tampermonkey 会弹安装页） */
    openUserscript: () => ipcRenderer.invoke('bridge:open-userscript'),
    /** 复制安装地址（浏览器里打开当兜底路径） */
    copyUserscriptUrl: () => ipcRenderer.invoke('bridge:copy-userscript-url'),
    /** 订阅状态变化，返回取消订阅函数 */
    onStatusChanged: (cb) => subscribe('bridge:status-changed', cb),
  },

  config: {
    /** 脱敏后的配置快照（api_key / token 已打码） */
    describe: () => ipcRenderer.invoke('config:describe'),
  },
});
