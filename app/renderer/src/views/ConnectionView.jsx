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
  const connections = (status && status.connections) || [];

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

        {connections.length === 0
          ? (
            <div className="empty">
              还没有页面连上来。<strong>打开并登录 douyin.com</strong>，保持那个标签页开着即可。
            </div>
          )
          : (
            <div className="list">
              {connections.map((c) => (
                <div className="row-item" key={c.id}>
                  <span className={`state-dot ${c.alive ? 'state-dot-on' : 'state-dot-off'}`} />
                  <div className="row-main">
                    <div className="row-title">{c.title || '（页面无标题）'}</div>
                    <div className="row-sub">{c.url}</div>
                  </div>
                  <div className="row-meta">{ago(c.lastActivity)}</div>
                </div>
              ))}
            </div>
          )}
      </section>
    </div>
  );
}
