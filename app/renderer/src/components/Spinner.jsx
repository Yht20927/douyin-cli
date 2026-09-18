import React from 'react';

/**
 * 转圈。放在按钮里表示"这一次点击正在处理"。
 *
 * 存在的理由：改造前全项目**零个 spinner**（styles.css 里 grep `spinner` = 0 命中），
 * 只有 5 个按钮会改文案（「生成中…」「保存中…」）。其余按钮点下去之后
 * 到结果回来之前界面**纹丝不动** —— 用户不知道是没点上、还是卡住了，
 * 于是重复点击（草稿"编辑保存"就因此会产生重复草稿）。
 *
 * 尺寸跟着字号走（em 为单位），这样在按钮里和正文里都不用单独调。
 *
 * @param {object} props
 * @param {number} [props.size] - 直径（px）。缺省 13px，与界面默认字号相当
 * @param {string} [props.label] - 无障碍标签；纯装饰时可不传
 */
export default function Spinner({ size = 13, label }) {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
