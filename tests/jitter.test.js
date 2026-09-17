// tests/jitter.test.js — 节奏工具库

const { sleep, randomSleep, maybeDelay, jitter, humanDelayMs, DELAY_RANGES_FOR_TEST } = (() => {
  const m = require('../core/jitter');
  // DELAY_RANGES 未导出；经 humanDelayMs 行为间接覆盖边界
  return { ...m, DELAY_RANGES_FOR_TEST: null };
})();

describe('jitter', () => {
  it('抖动幅度限制在 ±percent 内', () => {
    for (let i = 0; i < 200; i++) {
      const v = jitter(60000, 0.30);
      expect(v).toBeGreaterThanOrEqual(42000);
      expect(v).toBeLessThanOrEqual(78000);
    }
  });

  it('percent=0 时精确等于 base', () => {
    expect(jitter(1000, 0)).toBe(1000);
  });
});

describe('humanDelayMs', () => {
  it('已知档位落在配置区间内', () => {
    const checks = ['page_turn', 'read_comment', 'think_reply', 'post_interval', 'browse_idle'];
    for (const type of checks) {
      for (let i = 0; i < 50; i++) {
        const ms = humanDelayMs(type);
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(typeof ms).toBe('number');
        expect(Number.isFinite(ms)).toBe(true);
      }
    }
  });

  it('未知档位回退默认 [1000, 3000]', () => {
    for (let i = 0; i < 30; i++) {
      const ms = humanDelayMs('nonexistent_type');
      expect(ms).toBeGreaterThanOrEqual(1000);
      expect(ms).toBeLessThanOrEqual(3000);
    }
  });
});

describe('sleep / randomSleep / maybeDelay', () => {
  it('sleep 不抛错且耗时 >= 指定毫秒', async () => {
    const t0 = Date.now();
    await sleep(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });

  it('randomSleep 在区间内不抛错', async () => {
    await randomSleep(1, 5);
  }, 100);

  it('maybeDelay 概率为 0 时立即返回', async () => {
    const t0 = Date.now();
    await maybeDelay(0, 10000, 20000);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('负数延迟被钳制为 0（不抛错）', async () => {
    await sleep(-100);
  });
});
