// app/renderer/src/useNow.js — 倒计时共用的本地时钟
//
// 为什么要有这一个 hook，而不是每个页面自己写 setInterval + useState：
//
// 1. 倒计时只能走「绝对时刻 − 本地 now」。主进程只在队列边界（入队/开始/等待/
//    恢复/结束）推一次快照，拿快照里的 `remainingMs` 做倒数就是数字冻住。
//    这条规则以前在三个地方各写了一遍（队列页页首、队列行、发布确认弹窗）,
//    每加一页就要重新记住一遍。
// 2. 挂载瞬间要先同步一次 now。定时器最快 500ms 才跳，而这一帧渲染用的
//    `useState(Date.now())` 可能已经是几秒前的值 —— 队列行会先闪出一个
//    错得离谱的"已跑 X 秒"，然后才修正。
// 3. 不需要走表的时候不挂定时器（enabled=false）：一个满屏的历史任务列表
//    每条都开一个 500ms 定时器，纯属白烧 CPU。

import { useEffect, useState } from 'react';

/**
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=500] 走表间隔
 * @param {boolean} [opts.enabled=true]  为 false 时完全不挂定时器，返回值也不再更新
 * @returns {number} 当前时刻（毫秒）
 */
export function useNow({ intervalMs = 500, enabled = true } = {}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, enabled]);

  return now;
}
