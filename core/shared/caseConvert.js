// lib/shared/caseConvert.js — 递归把对象 key 从 camelCase 转回 snake_case
// 用途：某些 API 响应拦截器会把字段全部驼峰化，CLI 解析按 snake_case 写，
// 所以收到后统一转回来。
//
// 规则：
//  - 普通对象、数组深度遍历
//  - 单字符 key、纯小写 key（已经是 snake/无需转）原样
//  - 仅转 keys；不动 value
//  - 同名冲突时（驼峰版和下划线版同时存在），下划线版优先保留

function camelToSnake(s) {
  if (typeof s !== 'string' || s.length < 2) return s;
  if (s.indexOf('_') !== -1) return s;
  if (s === s.toLowerCase() || s === s.toUpperCase()) return s;
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function convertKeys(value, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (!seen) seen = new WeakSet();
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = convertKeys(value[i], seen);
    return value;
  }

  const keys = Object.keys(value);
  for (const k of keys) {
    const sk = camelToSnake(k);
    const v = convertKeys(value[k], seen);
    if (sk !== k) {
      if (!(sk in value)) value[sk] = v;
      delete value[k];
    } else {
      value[k] = v;
    }
  }
  return value;
}

module.exports = { convertKeys, camelToSnake };
