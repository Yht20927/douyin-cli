// lib/commands/dashboard.js — 运营仪表盘

const fs = require('fs');
const path = require('path');
const { getFlag } = require('./helpers');

/**
 * 生成运营仪表盘
 * @param {object} ctx - { audit }
 * @param {string[]} args - [--video <id>, --days N]
 */
async function cmdDashboard(ctx, args) {
  const { generateDashboardHTML } = require('../dashboard');
  const videoId = getFlag(args, '--video', null);
  const days = getFlag(args, '--days', 14);
  // 多账号：--account 由 cli.js 解析并摘除，这里用 ctx.account 限定统计范围
  const account = ctx.account || null;

  ctx.audit.startOperation('dashboard', { video_id: videoId, days, account });
  const html = generateDashboardHTML(videoId, days, account);

  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const fp = path.join(process.cwd(), 'logs', `dashboard-${ts}.html`);
  fs.writeFileSync(fp, html);
  console.error(`仪表盘已保存: ${fp}`);

  // 跨平台打开浏览器
  try {
    const { exec } = require('child_process');
    const platform = process.platform;
    if (platform === 'darwin') exec(`open "${fp}"`);
    else if (platform === 'linux') exec(`xdg-open "${fp}"`);
    else exec(`start "" "${fp}"`); // Windows
  } catch (e) { /* 静默失败 */ }

  ctx.audit.endOperation('success', { file: 'logs/' + path.basename(fp), account });
  return { file: 'logs/' + path.basename(fp), account };
}

module.exports = cmdDashboard;
