// core/runtime/abort.js — 可取消的等待
//
// 为什么需要
// ----------
// 改造前 risk-control.enforceDelay 用 `await sleep(need)` 硬等 40-55 秒。
// CLI 下这没关系（用户就是敲一条命令等一条），但在 GUI 里必须满足两点：
//   1. **可观测** —— 界面上要显示"还需等待 00:37"的倒计时
//   2. **可取消** —— 用户点了取消就得真的停下来，而不是等满 55 秒
//
// 所以把 sleep 换成可被 AbortSignal 打断的版本，并提供统一的取消错误类型，
// 让上层（TaskQueue / GUI）能区分"被用户取消"和"真的失败"。

/** 取消错误。上层用 isAbortError() 判断，不要靠比字符串。 */
class AbortError extends Error {
  constructor(message = '操作已取消') {
    super(message);
    this.name = 'AbortError';
    this.code = 'ABORTED';
  }
}

/**
 * 判断一个错误是否来自取消。
 * @param {Error} e
 * @returns {boolean}
 */
function isAbortError(e) {
  return !!e && (e.code === 'ABORTED' || e.name === 'AbortError');
}

/**
 * 可被 AbortSignal 打断的 sleep。
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 * @throws {AbortError} signal 在等待期间被 abort 时
 */
function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new AbortError());
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));

    function onAbort() {
      clearTimeout(timer);
      cleanup();
      reject(new AbortError());
    }

    function cleanup() {
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 在 signal 上挂一个"已取消则抛 AbortError"的检查点。
 * 用于长循环里（如逐页拉取）在每次迭代开始时快速退出。
 * @param {AbortSignal} [signal]
 */
function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new AbortError();
}

module.exports = {
  AbortError,
  isAbortError,
  sleepAbortable,
  throwIfAborted,
};
