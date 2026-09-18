// app/renderer/src/format.js — 界面里反复用到的几个格式化
//
// 提出来是因为 fileNameOf 在四个地方各写了一份（工作台 / 草稿箱 / 发布确认 /
// 图片列表），改一处漏三处的风险很实在。

/**
 * 从路径里取文件名用于展示。
 *
 * 同时兼容 Windows 的反斜杠与 POSIX 的正斜杠 —— 路径来自用户的本机，
 * 而这段代码要在两个平台上都能看出文件名。
 */
export function fileNameOf(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

/**
 * 文件大小。
 *
 * 小于 1KB 时显示字节数：直接 (size/1024).toFixed(0) 会把一张小图显示成
 * "0 KB"，看起来像读取失败，而它其实只是很小。
 */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** "多久之前"。传入的必须是毫秒时间戳（views.js 已经把抖音的秒归一成毫秒） */
export function ago(ts) {
  if (!ts) return '';
  const ms = Date.now() - ts;
  if (ms < 60000) return '刚刚';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}
