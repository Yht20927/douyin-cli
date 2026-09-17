// lib/shared/serialize.js — 安全 JSON 序列化（循环引用/DOM/函数处理）

/**
 * 将任意 JS 值安全序列化为 JSON 兼容的结构。
 * 处理：undefined → null、循环引用 → "[Circular]"、
 *       DOM 节点 → "[NodeName]"、函数 → "[Function]"、
 *       Window → "[Window]"
 *
 * @param {*} value - 任意 JS 值
 * @returns {*} JSON 兼容的值
 */
function safeSerialize(value) {
  // undefined 会被 JSON.stringify 丢弃，先转为 null
  const sanitized = value === undefined ? null : value;

  const seen = new WeakSet();

  return JSON.parse(JSON.stringify(sanitized, (key, val) => {
    if (typeof val === 'bigint') {
      return val.toString();
    }
    if (typeof val === 'function') {
      return '[Function]';
    }
    if (typeof Node !== 'undefined' && val instanceof Node) {
      return `[${val.nodeName}]`;
    }
    if (typeof Window !== 'undefined' && val instanceof Window) {
      return '[Window]';
    }
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) {
        return '[Circular]';
      }
      seen.add(val);
    }
    return val;
  }));
}

module.exports = { safeSerialize };
