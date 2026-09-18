// app/renderer/src/settings/patch.js — 设置页的值 ↔ 补丁 转换
//
// 独立成模块（而不是写在 SettingsView.jsx 里）有两个原因：
//   1. 它是纯函数，可以直接被测试验证 —— 而「敏感字段绝不回写打码值」
//      这条约定值得单独钉住
//   2. 让 SettingsView 只关心渲染与状态，不掺数据形状的细节

/** 取点号路径的值 */
export function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * 把配置快照摊平成 { 'a.b.c': value }。
 *
 * 敏感字段（api_key / token）**不预填**：快照里是打码文案，一旦填进草稿
 * 并顺手提交，就会把真实密钥替换成那串星星，而且不会报任何错。
 * 留空 + "留空表示不修改" 才是安全的语义。
 *
 * @param {object} cfg - config.describe() 给的（已脱敏）配置
 * @param {string[]} [sensitiveKeys]
 */
export function flatten(cfg, sensitiveKeys = []) {
  const sensitive = new Set(sensitiveKeys);
  const out = {};
  const walk = (node, prefix) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const k of Object.keys(node)) walk(node[k], prefix ? `${prefix}.${k}` : k);
      return;
    }
    if (!prefix) return;
    out[prefix] = sensitive.has(prefix) ? '' : node;
  };
  walk(cfg, '');
  return out;
}

/**
 * 把改动过的路径拼成嵌套补丁对象。
 * 数组整体替换 —— 与 core/config 的深合并语义一致。
 *
 * 敏感字段留空 = 「不修改」，直接跳过：用户在这个框里什么都没写，
 * 提交空串会把已设置的密钥清掉，显然不是他的意思。
 *
 * @param {Iterable<string>} paths - 改动过的路径
 * @param {object} draft - 摊平后的草稿
 * @param {string[]} [sensitiveKeys]
 */
export function buildPatch(paths, draft, sensitiveKeys = []) {
  const sensitive = new Set(sensitiveKeys);
  const patch = {};
  for (const path of paths) {
    if (sensitive.has(path) && draft[path] === '') continue;
    const segs = String(path).split('.');
    let cur = patch;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!cur[segs[i]] || typeof cur[segs[i]] !== 'object') cur[segs[i]] = {};
      cur = cur[segs[i]];
    }
    cur[segs[segs.length - 1]] = draft[path];
  }
  return patch;
}
