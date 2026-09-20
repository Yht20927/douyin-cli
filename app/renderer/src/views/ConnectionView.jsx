import React from 'react';
import StatusBand from '../components/StatusBand.jsx';
import { abbrNum } from '../format.js';

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

/**
 * 账号头像。
 *
 * 抖音的头像存在 CDN 上，可能因防盗链或网络问题加载失败 —— 失败就降级成
 * 昵称首字母的圆块，而不是留个破图（与作品封面的降级是同一种思路）。
 */
function Avatar({ url, name, off }) {
  const [failed, setFailed] = React.useState(false);
  const initial = (name || '').trim().charAt(0).toUpperCase() || '？';
  if (!url || failed) {
    return <div className={`avatar avatar-fallback ${off ? 'avatar-off' : ''}`}>{initial}</div>;
  }
  return <img className={`avatar ${off ? 'avatar-off' : ''}`} src={url} alt="" onError={() => setFailed(true)} />;
}

/**
 * 一条连接的展示主体：用户关心的是"连的哪个号"，不是页面网址。
 *
 * "未识别到账号"有两种成因，指引必须分开给：
 *   - 脚本没有 clientVersion 标记 → 旧脚本，根本不会上报账号，刷新没用，要重装；
 *   - 有标记但账号为空 → 新脚本在跑但没认出账号：多半是页面没登录，或
 *     账号接口暂时失败（脚本会在浏览器控制台留痕）。
 * 给错指引比不给指引更糟。
 */
function ConnectionRow({ c, actions }) {
  const acct = c.account;
  const name = acct ? acct.nickname : '未识别到账号';
  const isLegacy = !c.clientVersion; // 旧脚本：没有能力版本标记

  let sub;
  if (c.alive && acct) {
    // 账号体量 + 身份，一行说清"连的是哪个号、多大的号"。
    // 某项没拿到就整段跳过，不显示 "粉丝 —" 这种占位噪音。
    const stats = [
      acct.followerCount != null && `粉丝 ${abbrNum(acct.followerCount)}`,
      acct.likesReceived != null && `获赞 ${abbrNum(acct.likesReceived)}`,
    ].filter(Boolean).join(' · ');
    const parts = [stats, acct.uid && `UID ${acct.uid}`].filter(Boolean).join(' · ');
    sub = parts ? `${parts} · 最后活动 ${ago(c.lastActivity)}` : `最后活动 ${ago(c.lastActivity)}`;
  } else if (c.alive && isLegacy) {
    sub = '脚本版本较旧，不会上报账号 —— 点右侧「重装脚本」即可';
  } else if (c.alive) {
    sub = '没认出登录账号 —— 确认页面右上角已登录，然后刷新抖音页面试试';
  } else if (acct) {
    sub = `最后活动 ${ago(c.lastActivity)} —— 页面关掉了，或脚本没在跑`;
  } else {
    sub = `页面关掉了，或脚本没在跑（最后活动 ${ago(c.lastActivity)}）`;
  }

  return (
    <div className="row-item" title={c.url || undefined}>
      <Avatar url={acct && acct.avatar} name={acct && acct.nickname} off={!c.alive} />
      <div className="row-main">
        <div className="row-title">
          {name}
          {!c.alive && <span className="tag tag-dim" style={{ marginLeft: 8 }}>已断开</span>}
        </div>
        <div className="row-sub">{sub}</div>
      </div>
      {c.alive && isLegacy && (
        <button className="btn btn-quiet" style={{ flex: 'none' }} onClick={actions.openUserscript}>
          重装脚本
        </button>
      )}
      {c.alive && <div className="row-meta">{ago(c.lastActivity)}</div>}
    </div>
  );
}

/**
 * 首次使用引导。
 *
 * 以前这条路径只有"打开并登录 douyin.com"一句话，而真正卡住新用户的一步
 * ——把脚本装进浏览器——入口埋在「诊断」页最深处。连接页本来就是为了
 * 解决"连不上"而存在的，三步引导和按钮就应该放在这里。
 */
function SetupGuide({ actions, busy }) {
  return (
    <div className="setup">
      <div className="setup-title">第一次使用？三步把抖音接进来</div>

      <div className="setup-step">
        <span className="setup-num num">1</span>
        <div className="setup-step-main">
          <div className="setup-step-text">把工具的脚本装进浏览器（需要已安装 Tampermonkey 扩展）</div>
          <div className="setup-step-sub">脚本里已自动写好本机地址与凭证，确认安装提示即可，不需要复制任何东西。</div>
          <div className="setup-step-actions">
            <button className="btn btn-primary" disabled={busy} onClick={actions.openUserscript}>
              一键安装脚本
            </button>
            <button className="btn" disabled={busy} onClick={actions.copyUserscriptUrl}>
              复制安装地址
            </button>
          </div>
        </div>
      </div>

      <div className="setup-step">
        <span className="setup-num num">2</span>
        <div className="setup-step-main">
          <div className="setup-step-text">打开并登录 douyin.com，保持那个标签页开着</div>
          <div className="setup-step-actions">
            <button className="btn" disabled={busy} onClick={actions.openDouyin}>
              打开抖音
            </button>
          </div>
        </div>
      </div>

      <div className="setup-step">
        <span className="setup-num num">3</span>
        <div className="setup-step-main">
          <div className="setup-step-text">点「重新检测」—— 出现你的账号头像就是接好了</div>
          <div className="setup-step-actions">
            <button className="btn" disabled={busy} onClick={actions.refresh}>
              重新检测
            </button>
          </div>
        </div>
      </div>
    </div>
  );
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
        下面显示的就是当前登录、正在被操作的账号。
      </p>

      <StatusBand status={status} actions={actions} busy={busy} />

      {status && status.error && (
        <div className="notice notice-bad">
          最近一次检测失败：<b>{status.error}</b>
        </div>
      )}

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">已连接的账号</h2>
          <span className="section-meta">{connections.length}</span>
        </div>

        {connections.length === 0
          ? (
            <>
              <SetupGuide actions={actions} busy={busy} />
              {/* 曾经连上又断掉的残留连接仍然要露面：它说明"之前装好过、现在是断了"，
                  这与"从来没装过"是完全不同的排查方向。 */}
              {stale.length > 0 && (
                <>
                  <div className="setup-stale-label muted">之前的连接（已断开）</div>
                  <div className="list">
                    {stale.map(c => <ConnectionRow key={c.id} c={c} actions={actions} />)}
                  </div>
                </>
              )}
            </>
          )
          : (
            <div className="list">
              {connections.map(c => <ConnectionRow key={c.id} c={c} actions={actions} />)}
              {stale.map(c => <ConnectionRow key={c.id} c={c} actions={actions} />)}
            </div>
          )}
      </section>
    </div>
  );
}
