// app/renderer/src/format.js — 界面里反复用到的几个格式化
//
// 提出来是因为 fileNameOf 在四个地方各写了一份（工作台 / 草稿箱 / 发布确认 /
// 图片列表），改一处漏三处的风险很实在。
// 倒计时那两处读数（mmss / duration）也收在这里：队列页、发布确认弹窗原本各写
// 一份，找视频页与运营对象页从本轮起也要显示等待与进度 —— 同一个"还剩多久"
// 不该有五份写法。

/**
 * 剩余毫秒 → `mm:ss`。
 *
 * 只负责读数本身。**"截止时刻一过就别显示"是调用方的责任**：
 * 停在 00:00 的读数与"数字冻住"在屏幕上完全同形，运营者分不出
 * "马上开始"还是"没人走表"，所以要用 `until > now` 挡住而不是让它数到 0。
 */
export function mmss(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 毫秒 → "12 秒" / "1 分 20 秒" / "1 小时 5 分"。跑完的任务显示耗时用 */
export function duration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s ? `${m} 分 ${s} 秒` : `${m} 分`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

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

/**
 * 大数字缩写：2589 → "2589"，11473 → "1.1万"。
 * 与抖音 App 一致用「万」——界面是给中文用户看的，"w" 是程序员习惯。
 * 非法输入显示 "—"，让缺数据长得像缺数据，而不是像 0。
 */
export function abbrNum(n) {
  const v = Number(n);
  if (n == null || !Number.isFinite(v) || v < 0) return '—';
  if (v < 10000) return String(v);
  return `${(v / 10000).toFixed(1)}万`;
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

/**
 * 命令名 → 运营者看得懂的动作名。
 *
 * 键取自真库 `events.command` 的实测取值（含 delete_comment 这个下划线写法 ——
 * 历史数据里两种都有，只认一种就会有一批图表标签仍是英文）。
 *
 * 为什么映射放在渲染层：命令名是 core 对外的接口（CLI 参数、审计、`events` 导出
 * 都用它），改它牵连三处以上；而"图表上该写什么字"只是显示问题。
 * 认不出来的**原样返回** —— 编一个中文名字比留英文更糟，那是在猜。
 */
const COMMAND_LABEL = {
  post: '发布回复',
  comment: '发评论',
  like: '点赞',
  get: '拉取评论',
  getReply: '生成回复',
  my: '拉取我的作品',
  search: '搜索视频',
  user: '看用户主页',
  analyze: 'AI 分析评论',
  enrich: '补全视频信息',
  'delete-comment': '删除回复',
  delete_comment: '删除回复',
  'upload-image': '上传图片',
  dm: '发私信',
  draft: '存草稿',
  replies: '查回复记录',
  replied: '查已回复',
  corpus: '语料库',
  suggest: '取回复建议',
  whois: '查用户',
  profile: '账号信息',
  events: '查操作记录',
  failures: '查失败模式',
  cleanup: '清理数据',
  note: '记笔记',
  dedup: '查重',
};

export function commandLabel(cmd) {
  if (cmd == null || cmd === '') return '未标注';
  return COMMAND_LABEL[String(cmd)] || String(cmd);
}

/** AI 调用的用途 → 人话。键取自真库 llm_usage.purpose 的实测取值。 */
const PURPOSE_LABEL = {
  getReply_batch: '批量生成回复',
  getReply_comment: '生成一条回复',
  getReply_reply: '生成追问回复',
  analyze: 'AI 分析评论',
};

export function purposeLabel(purpose) {
  if (purpose == null || purpose === '') return '未标注';
  return PURPOSE_LABEL[String(purpose)] || String(purpose);
}
