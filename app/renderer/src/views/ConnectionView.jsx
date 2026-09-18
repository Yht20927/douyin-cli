import React from 'react';
import StatusBand from '../components/StatusBand.jsx';

/** 把时间戳转成"多久之前" */
function ago(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1500) return '刚刚';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  return min < 60 ? `${min} 分钟前` : `${Math.floor(min / 60)} 小时前`;
}

export default function ConnectionView({ status, actions, busy }) {
  // 桥接服务返回的 connections 里**包含已经断掉的残留连接**（alive: false）。
  // 之前这里直接用 connections.length 当"已连接"的数量，于是同一个屏幕上
  // 会出现两个对不上的数字：这里写"已连接的页面 3"，上面的状态条和诊断页
  // 却说"1 个抖音页面连上了"。用户只能猜哪个是真的。
  // 数量只数还在线的，断掉的仍然列出来（但要标明），否则用户不知道它去哪了。
  const all = (status && status.connections) || [];
  const connections = all.filter(c => c.alive);
  const stale = all.filter(c => !c.alive);

  return (
    <div className="main-col">
      <h1 className="page-title">连接</h1>
      <p className="page-sub">
        这套工具不直接抓取抖音 —— 它把指令交给浏览器里已登录的页面执行。
        所以需要有一个抖音页面保持开着。
      </p>

      <StatusBand status={status} actions={actions} busy={busy} />

      {status && status.error && (
        <div className="notice notice-bad">
          最近一次检测失败：<b>{status.error}</b>
        </div>
      )}

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">已连接的页面</h2>
          <span className="section-meta">{connections.length}</span>
        </div>

        {connections.length === 0 && stale.length === 0
          ? (
            <div className="empty">
              还没有页面连上来。<strong>打开并登录 douyin.com</strong>，保持那个标签页开着即可。
            </div>
          )
          : (
            <div className="list">
              {connections.map(c => (
                <div className="row-item" key={c.id}>
                  <span className="state-dot state-dot-on" />
                  <div className="row-main">
                    <div className="row-title">{c.title || '（页面无标题）'}</div>
                    <div className="row-sub">{c.url}</div>
                  </div>
                  <div className="row-meta">{ago(c.lastActivity)}</div>
                </div>
              ))}
              {stale.map(c => (
                <div className="row-item" key={c.id}>
                  <span className="state-dot state-dot-off" />
                  <div className="row-main">
                    <div className="row-title">{c.title || '（页面无标题）'}</div>
                    <div className="row-sub">
                      已断开 · 最后活动 {ago(c.lastActivity)} —— 页面关掉了，或脚本没在跑
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
      </section>
    </div>
  );
}
