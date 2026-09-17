// lib/commands/preflight.js — 节奏守卫自检
//
// `node cli.js preflight [command]`
//   无参数：输出当前节奏状态（间隔配置 / 距上次写 / 距下次允许写）
//   带命令名：非阻塞地预检该命令是否可立即执行

const riskControl = require('../risk-control');

async function cmdPreflight(ctx, args) {
  const command = args[0];

  if (!command) {
    const intervals = riskControl.getIntervals();
    const last = riskControl.lastWriteTs();
    const sinceLast = last ? Math.round((Date.now() - last) / 1000) : null;
    const need = riskControl.msUntilNextWrite();
    return {
      intervals,
      last_write_ts: last || null,
      seconds_since_last_write: sinceLast,
      seconds_until_next_write_allowed: need > 0 ? Math.ceil(need / 1000) : 0,
      ready_to_write: need === 0,
      note: '写操作硬强制（post/like/delete-comment 入口阻塞）；读操作 advisory，由 agent 自行间隔',
    };
  }

  return riskControl.preflight(command);
}

module.exports = cmdPreflight;
