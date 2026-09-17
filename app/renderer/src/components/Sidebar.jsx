import React from 'react';
import { describeStatus } from '../status.js';

/** 目前真实存在的页面。后续（P3 起）会加：我的作品 / 评论工作台 / 草稿箱 / 私信 / 事件日志 / 设置 */
const NAV = [
  { key: 'connection', label: '连接' },
  { key: 'diagnostics', label: '诊断' },
];

export default function Sidebar({ view, onNavigate, status, version, onQuit }) {
  const d = describeStatus(status);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-name">抖音评论运营</span>
        {version && <span className="brand-ver">v{version}</span>}
      </div>

      <nav className="nav">
        <div className="nav-label">运行</div>
        {NAV.map((item) => (
          <button
            key={item.key}
            className={`nav-item ${view === item.key ? 'nav-item-active' : ''}`}
            onClick={() => onNavigate(item.key)}
          >
            <span className="nav-marker" />
            {item.label}
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        {/* 把核心状态常驻在侧栏底部：切到任何页面都能一眼看到能不能发，
            而不必回到「连接」页 */}
        <div className="nav-item" style={{ cursor: 'default' }}>
          <span
            className={`nav-dot ${d.state === 'online' ? 'nav-dot-on' : ''}`}
            style={
              d.state === 'waiting' ? { background: 'var(--wait)' }
                : d.state === 'offline' || d.state === 'down' ? { background: 'var(--bad)' }
                  : undefined
            }
          />
          <span style={{ fontSize: 12.5 }}>{d.word}</span>
        </div>
        <button className="nav-item" onClick={onQuit}>退出应用</button>
      </div>
    </aside>
  );
}
