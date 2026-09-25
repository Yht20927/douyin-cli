import React from 'react';
import { describeStatus, unconnectedAccounts } from '../status.js';

/**
 * 导航分两组：「运行」是日常工作会来回切的页面，「通用」是配置与排障。
 * 以前六个入口平铺，且「设置」排在「连接」前面 —— 连接是与队列、作品
 * 同一性质的状态页，却排在配置之后，第一次找"我连上没有"的人会翻错地方。
 */
const NAV_GROUPS = [
  {
    label: '运行',
    items: [
      { key: 'queue', label: '队列', badge: 'queue' },
      // 运营对象排在「我的作品」前面：日常真正要干活的是别人的评论区
      // （实测 1850 条评论在别人视频下、只有 62 条在自己的），
      // 而在此之前工作台的唯一入口是「我的作品」，那 96% 的工作面不可达
      // 找视频排在运营对象前面：它是"往里加东西"的入口，
      // 与「运营对象」是同一个流程的上下游
      { key: 'discover', label: '找视频' },
      { key: 'targets', label: '运营对象' },
      { key: 'works', label: '我的作品' },
      { key: 'drafts', label: '草稿箱', badge: 'draft' },
      { key: 'analytics', label: '数据' },
      { key: 'connection', label: '连接' },
    ],
  },
  {
    label: '通用',
    items: [
      { key: 'settings', label: '设置' },
      { key: 'diagnostics', label: '诊断' },
    ],
  },
];

export default function Sidebar({
  view, onNavigate, status, queueCount, draftCount, version, onQuit,
  account, onSwitchAccount,
}) {
  const d = describeStatus(status);
  const badges = { queue: queueCount, draft: draftCount };

  // 当前账号由主进程解析（跟随浏览器当前登录的号），这里只显示与切换。
  //
  // 为什么必须显式摆在界面上：用户报的问题就是"在浏览器里换了号，数据没变"。
  // 只要"现在看的是哪个号"一直可见，这件事立刻能自证；而多开（几个号同时
  // 在线）时，也才有地方选定到底操作哪一个。
  const current = (account && account.accounts || []).find(a => a.current);
  const accountName = current ? (current.nickname || current.uid) : '';
  // 与连接页那一节同一个判据：侧栏说"另有 2 个"，点过去只能恰好是 2 行。
  // 当前这个号不在里面 —— 它就显示在这句话上面，再算进"另有"里是重复计账。
  const unconnected = unconnectedAccounts(account, status);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        {/* 视觉锚点：深色侧栏需要一枚"钉子"，否则品牌行是一句漂浮的文字 */}
        <div className="brand-mark" aria-hidden="true">评</div>
        <span className="brand-name">抖音评论运营</span>
        {version && <span className="brand-ver">v{version}</span>}
      </div>

      <nav className="nav">
        {NAV_GROUPS.map(group => (
          <div key={group.label}>
            <div className="nav-label">{group.label}</div>
            {group.items.map((item) => (
              <button
                key={item.key}
                className={`nav-item ${view === item.key ? 'nav-item-active' : ''}`}
                onClick={() => onNavigate(item.key)}
              >
                <span className="nav-marker" />
                {item.label}
                {/* 有任务在跑/在等、或有待发草稿时标一个数 —— 切到别的页面也能看到 */}
                {item.badge && badges[item.badge] > 0 && (
                  <span className="nav-badge num">{badges[item.badge]}</span>
                )}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        {/* 把核心状态常驻在侧栏底部：切到任何页面都能一眼看到能不能发，
            而不必回到「连接」页 */}
        {accountName && (
          <div className="sidebar-account-box">
            <div className="sidebar-account-label">当前账号</div>
            {account && account.needsChoice ? (
              // 多个号同时在线的**唯一**需要人工选的场合。只有一个号时是自动跟随的，
              // 摆一个下拉框只会让人以为"要手动切"。
              <select
                className="input sidebar-account-select"
                value={account.uid || ''}
                onChange={e => onSwitchAccount && onSwitchAccount(e.target.value)}
                title="有多个抖音页面同时在线，选一个作为当前操作的账号"
              >
                {[...(account.accounts || [])].map(a => (
                  <option key={a.uid} value={a.uid}>
                    {a.nickname || a.uid}{a.online ? '' : '（未连接）'}
                  </option>
                ))}
              </select>
            ) : (
              <div className="sidebar-account-name" title={current && current.uid}>
                {accountName}
              </div>
            )}
            {unconnected.length > 0 && !account.needsChoice && (
              // 只有一个在线时不显示下拉框，但把"库里还有别的号"说一句 ——
              // 否则用户会以为另一个号的数据没了。
              // 这句话原来到此为止：它说出了缺陷，却不给下一步，而下一步
              // （去浏览器里登录那个号）写在另一页上。所以做成能点的。
              <button
                type="button"
                className="nav-item sidebar-account-more"
                onClick={() => onNavigate('connection')}
              >
                另有 {unconnected.length} 个号未连接 —— 怎么连上
              </button>
            )}
          </div>
        )}

        <div className="nav-item sidebar-status" style={{ cursor: 'default' }}>
          <span
            className={`nav-dot ${d.state === 'online' ? 'nav-dot-on' : ''}`}
            style={
              d.state === 'waiting' ? { background: 'var(--wait)' }
                : d.state === 'offline' || d.state === 'down' ? { background: 'var(--bad)' }
                  : undefined
            }
          />
          <span className="sidebar-status-text">
            <span style={{ fontSize: 12.5 }}>{d.word}</span>
          </span>
        </div>
        <button className="nav-item" onClick={onQuit}>退出应用</button>
      </div>
    </aside>
  );
}
