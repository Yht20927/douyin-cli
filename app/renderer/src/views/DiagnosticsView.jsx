import React from 'react';

/**
 * 诊断。正常使用时不需要看，但出问题时是唯一能自查的地方：
 * 数据到底存哪了、配置被回退成了什么、脚本源在不在。
 */
export default function DiagnosticsView({ info, status, actions }) {
  const warnings = (info && info.configWarnings) || [];

  return (
    <div className="main-col">
      <h1 className="page-title">诊断</h1>
      <p className="page-sub">运行环境、数据位置与配置状态。出问题时先看这里。</p>

      {warnings.length > 0 && (
        <div className="notice notice-warn">
          <div>
            <b>配置里有非法值，已自动回退：</b>
            <ul>
              {warnings.map((w, i) => (
                <li key={i}><code>{w.key}</code> — {w.message}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {info && !info.sourceExists && (
        <div className="notice notice-bad">
          油猴脚本源文件缺失：<code>{info.sourceFile}</code>
          <br />安装包可能不完整，脚本相关的功能会失效。
        </div>
      )}

      <section className="section">
        <h2 className="section-title" style={{ marginBottom: 12 }}>运行环境</h2>
        <dl className="kv">
          <dt>版本</dt>
          <dd>v{info ? info.version : '…'}</dd>

          <dt>运行时</dt>
          <dd className="num">
            {info ? `Electron ${info.electron} · Node ${info.node} · ${info.platform}` : '…'}
          </dd>

          <dt>数据目录</dt>
          <dd>
            <code>{info ? info.dataDir : '…'}</code>
            <div className="sub">{info ? info.dataDirSource : ''}</div>
          </dd>

          <dt>配置文件</dt>
          <dd><code>{info ? info.configFile : '…'}</code></dd>

          <dt>脚本源</dt>
          <dd>
            <code>{info ? info.sourceFile : '…'}</code>
            <div className="sub">{info && info.sourceExists ? '存在' : '缺失'}</div>
          </dd>
        </dl>
      </section>

      <section className="section">
        <h2 className="section-title" style={{ marginBottom: 12 }}>桥接服务</h2>
        <dl className="kv">
          <dt>状态</dt>
          <dd>{status && status.listening ? '运行中' : '未启动'}</dd>

          <dt>监听地址</dt>
          <dd>{status && status.url ? <code>{status.url}</code> : '—'}</dd>

          <dt>已连接</dt>
          <dd className="num">{status ? status.totalConnections : '—'} 个页面</dd>

          <dt>脚本地址</dt>
          <dd>
            {status && status.userscriptUrl
              ? (
                <>
                  <code>{status.userscriptUrl}</code>
                  <div className="sub">
                    换浏览器或换机器时，在装了 Tampermonkey 的浏览器里打开这个地址即可安装。
                    <button
                      className="btn btn-quiet"
                      style={{ marginLeft: 8, padding: '1px 8px', fontSize: 12 }}
                      onClick={actions.copyUserscriptUrl}
                    >
                      复制
                    </button>
                  </div>
                </>
              )
              : '—'}
          </dd>
        </dl>
      </section>
    </div>
  );
}
