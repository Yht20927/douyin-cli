import React from 'react';

/**
 * 错误边界。
 *
 * 为什么必须有
 * ----------
 * React 在渲染或 effect 阶段遇到未捕获的异常、且没有错误边界时，会**卸载整棵树** ——
 * 界面上表现为整个窗口空白（用户描述为"黑屏"），且没有任何线索。
 *
 * 这不是假设：开发过程中 `window.dy.queue.result is not a function`（preload 漏暴露
 * 一个方法）就在 AI 生成完成后的 effect 里抛出，导致整个应用界面消失。
 *
 * 有了边界之后，最坏情况是"某一块坏了"，其余部分仍可用，并且直接把错误与
 * 出错位置摆在用户面前 —— 可诊断远好过一片空白。
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // 留在控制台便于排查（Electron 开发者工具里能看到）
    console.error('[界面错误]', error, info);
    this.setState({ info });
  }

  render() {
    if (!this.state.error) return this.props.children;

    const { error, info } = this.state;
    return (
      <div style={{ padding: 28, maxWidth: 720 }}>
        <h1 className="page-title">界面出错了</h1>
        <p className="page-sub">
          这一块渲染失败了，其余功能可能仍然可用。重新加载通常能恢复；
          若反复出现，请把下面的信息一并反馈。
        </p>

        <div className="notice notice-bad">
          <div>
            <b>{error && error.message ? error.message : String(error)}</b>
          </div>
        </div>

        <div className="row">
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            重新加载界面
          </button>
          <button className="btn" onClick={() => this.setState({ error: null, info: null })}>
            尝试继续
          </button>
        </div>

        {info && info.componentStack && (
          <details style={{ marginTop: 18 }}>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: 12.5 }}>
              出错位置
            </summary>
            <pre className="num" style={{ whiteSpace: 'pre-wrap', color: 'var(--text-3)', fontSize: 11.5 }}>
              {info.componentStack.trim()}
            </pre>
          </details>
        )}
      </div>
    );
  }
}
