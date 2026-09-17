// app/renderer/vite.config.js
//
// base 必须是相对路径：打包后 Electron 用 file:// 载入 index.html，
// 绝对路径（/assets/...）会解析到文件系统根目录。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  root: __dirname,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
