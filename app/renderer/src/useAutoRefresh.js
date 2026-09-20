import { useEffect, useRef } from 'react';

/**
 * 定时重读本地数据。
 *
 * 为什么需要：这个应用里绝大多数数据只由**本地库**决定，而本地库会被
 * 别的东西改动 —— 你在另一个终端跑 `node cli.js get`、队列里一个长任务刚跑完、
 * 或者将来的定时拉取在后台进了新评论。界面不会自己知道，于是数字停在旧值上，
 * 用户以为"没拉到"。
 *
 * 三条纪律（与 core/config 里 ui 段的注释对应）：
 *
 * 1. **只读本地 SQLite，绝不访问抖音。** 从抖音拉新数据受风控约束
 *    （读操作间隔 30-50 秒），只能由手动触发或定时拉取负责。
 *    这里的间隔配得再小也不会产生一个网络请求。
 * 2. **间隔可配、可以关（0）。** 用户在设置页决定 —— 一个"永远在转"的
 *    界面和"永远不更新"的界面一样让人不安。
 * 3. **不可见时不干活。** 窗口最小化到托盘（这个应用默认就是这个行为）
 *    还每秒去扫一遍本地库是纯浪费。
 *
 * @param {string} key - `ui.refreshSec` 下的键名
 *   （targets / works / drafts / analytics / workspace）
 * @param {() => any} onTick - 到点了做什么（通常是那一页的 reload）。
 *   返回 Promise 时会被等待 —— 上一拍没跑完就不会再发起下一拍。
 */
export default function useAutoRefresh(key, onTick) {
  // 回调每次渲染都是新引用，不能进依赖数组，否则定时器会被反复重建、
  // 永远等不到第一次触发。用 ref 拿最新的那个。
  const tick = useRef(onTick);
  tick.current = onTick;

  useEffect(() => {
    let timer = null;
    let stopped = false;
    let busy = false;

    (async () => {
      let sec = 0;
      try {
        const r = await window.dy.config.describe();
        const ui = r && r.ok && r.data && r.data.config && r.data.config.ui;
        sec = Number(ui && ui.refreshSec && ui.refreshSec[key]);
      } catch (e) {
        sec = 0;
      }
      // 读不到配置就不刷新 —— 用一个猜的间隔去打扰用户，比不刷新更糟
      if (stopped || !Number.isFinite(sec) || sec <= 0) return;

      timer = setInterval(async () => {
        if (document.hidden || busy) return;
        busy = true;
        try { await tick.current(); } catch (e) { /* 重读失败不该打断界面 */ }
        finally { busy = false; }
      }, sec * 1000);
    })();

    return () => { stopped = true; clearInterval(timer); };
  }, [key]);
}
