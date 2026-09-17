import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import './styles.css';

// ErrorBoundary 必须在最外层：没有它时，任何渲染/effect 阶段的未捕获异常
// 都会让 React 卸载整棵树，界面变成一片空白（用户看到的"黑屏"）。
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
