import React from 'react';

/**
 * 页面内的提示条（不是右下角那颗浮层 Toast —— 那个会自动消失）。
 *
 * 允许两种写法：字符串，或 `{ text, warn }`。
 * 需要对象是因为有一类操作"跑成功了"只说了一半事实 ——
 * 删除评论：抖音那边确实没了，但本地回退可能只做了一半。
 * 这种坏消息如果还用普通信息条显示，它和"一切正常"长得一模一样。
 *
 * ⚠️ 内容必须包一层 div：`.notice` 是 flex 容器，直接放文字时每个文本节点、
 * 每个内联标签都会变成独立的 flex 子项（见 styles.css 里 .notice 的注释）。
 *
 * @param {object} props
 * @param {string|null|{text:string,warn?:boolean}} props.data - null / 空时不渲染
 * @param {object} [props.style]
 */
export default function Notice({ data, style }) {
  if (!data) return null;
  const obj = typeof data === 'object';
  return (
    <div className={`notice ${obj && data.warn ? 'notice-warn' : ''}`} style={style}>
      <div>{obj ? data.text : data}</div>
    </div>
  );
}
