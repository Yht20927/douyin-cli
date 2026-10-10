// lib/dashboard.js — Dashboard HTML 生成（从 cli.js 提取）
const fs = require('fs');
const path = require('path');
const { AuditLogger } = require('./audit');
const { escapeHtml } = require('./shared/sanitize');

/**
 * 从审计日志和 results 文件中提取数据，生成自包含 HTML 仪表盘
 * @param {string|null} videoId - 可选，筛选特定视频
 * @param {number} days - 统计天数
 * @param {string|null} [account] - 可选，只看该账号（多账号）
 * @returns {string} HTML 字符串
 */
function generateDashboardHTML(videoId, days, account = null) {
  // videoId / 活动名等用户可控文本拼进 HTML 前一律转义
  const safeVideoId = escapeHtml(videoId || '');
  const safeAccount = escapeHtml(account || '');
  const title = videoId ? `视频 ${safeVideoId} 评论仪表盘` : '抖音评论运营仪表盘';
  const logger = new AuditLogger();

  let totalComments = 0, repliedCount = 0, todayNew = 0;
  const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
  const dailyComments = {};
  const now = Date.now();
  const cutoffMs = now - days * 24 * 60 * 60 * 1000;

  try {
    const a = logger.load();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTs = todayStart.getTime() / 1000;

    for (const s of (a.sessions || [])) {
      for (const op of (s.operations || [])) {
        if (op.status !== 'success') continue;
        const opTime = op.started ? new Date(op.started).getTime() : 0;
        if (opTime < cutoffMs) continue;
        if (videoId && op.args && op.args.aweme_id !== videoId) continue;
        // 多账号：只看该账号的操作
        if (account && (op.account || (op.args && op.args.account)) !== account) continue;

        // 评论获取 → 累加
        if (op.command === 'get' && op.summary && op.summary.comments) {
          totalComments += op.summary.comments;
          const dayKey = op.started ? op.started.substring(0, 10) : 'unknown';
          dailyComments[dayKey] = (dailyComments[dayKey] || 0) + op.summary.comments;
          if (op.args && op.args.since && op.args.since >= todayTs) {
            todayNew += op.summary.comments;
          }
        }

        // 回复发布
        if (op.command === 'post' && op.result && op.result.status === 'published') {
          repliedCount++;
        }

        // LLM 分析结果 → 情感分布
        if (op.command === 'analyze' && op.resultFile) {
          try {
            const fp = path.join(__dirname, '..', op.resultFile);
            if (fs.existsSync(fp)) {
              const analysisData = JSON.parse(fs.readFileSync(fp, 'utf8'));
              const items = Array.isArray(analysisData) ? analysisData : [];
              for (const item of items) {
                if (item.sentiment === 'positive') sentimentCounts.positive++;
                else if (item.sentiment === 'negative') sentimentCounts.negative++;
                else sentimentCounts.neutral++;
              }
            }
          } catch (e) { /* ignore */ }
        }
      }
    }

    // 从 results 文件直接统计（兜底）
    // 注意：results 文件名里没有账号信息，按账号筛选时不能走这条兜底，否则会混入别的号
    if (totalComments === 0 && !account) {
      try {
        const resultsDir = path.join(__dirname, '..', 'logs', 'results');
        if (fs.existsSync(resultsDir)) {
          const files = fs.readdirSync(resultsDir).filter(f => f.startsWith('get-') && f.endsWith('.json'));
          for (const f of files) {
            if (videoId && !f.includes(videoId)) continue;
            try {
              const data = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'));
              const cmts = data.comments || [];
              totalComments += cmts.length;
            } catch (e) { /* ignore */ }
          }
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }

  const pendingReplies = Math.max(0, totalComments - repliedCount);

  // 趋势数据
  const dayLabels = [];
  const dayValues = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().substring(0, 10);
    dayLabels.push(key.substring(5));
    dayValues.push(dailyComments[key] || 0);
  }

  const hasSentiment = sentimentCounts.positive + sentimentCounts.neutral + sentimentCounts.negative > 0;
  const sPos = hasSentiment ? sentimentCounts.positive : 0;
  const sNeu = hasSentiment ? sentimentCounts.neutral : 0;
  const sNeg = hasSentiment ? sentimentCounts.negative : 0;

  // 推广活动卡片（P4）
  let campaignHTML = '';
  try {
    const campaigns = require('./memory/campaigns');
    const list = campaigns.list();
    if (list.length > 0) {
      const rows = list.map(c => {
        const t = campaigns.countByOutcome(c.id);
        const total = t.total || 1;
        const pct = (k) => Math.round((t[k] / total) * 100);
        return `
      <div class="camp-row">
        <div class="camp-head"><span class="camp-name">${escapeHtml(c.name)}</span>
          <span class="camp-status status-${c.status}">${escapeHtml(c.status)}</span>
          <span class="camp-id">#${c.id}</span></div>
        <div class="bar">
          <div class="seg posted" style="width:${pct('posted')}%" title="posted ${t.posted}"></div>
          <div class="seg failed" style="width:${pct('failed')}%" title="failed ${t.failed}"></div>
          <div class="seg skipped" style="width:${pct('skipped')}%" title="skipped ${t.skipped}"></div>
          <div class="seg pending" style="width:${pct('pending')}%" title="pending ${t.pending}"></div>
        </div>
        <div class="camp-meta">posted ${t.posted} · failed ${t.failed} · skipped ${t.skipped} · pending ${t.pending} / ${t.total} · 配额 ${c.dailyQuota}/日</div>
      </div>`;
      }).join('');
      campaignHTML = `<div class="campaigns"><h2>推广活动</h2>${rows}</div>`;
    }
  } catch (e) { /* campaigns 表未迁移或不存在，跳过 */ }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:1200px;margin:0 auto;padding:24px;background:#f0f2f5;color:#1a1a2e}
h1{font-size:24px;margin-bottom:4px}
.subtitle{color:#666;font-size:14px;margin-bottom:24px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card .label{font-size:13px;color:#888;margin-bottom:4px}
.card .value{font-size:32px;font-weight:700;color:#1a1a2e}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:16px}
.chart-box{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.hint{text-align:center;padding:20px;color:#999;font-size:14px}
.campaigns{margin-top:24px;background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.campaigns h2{font-size:18px;margin-bottom:16px}
.camp-row{margin-bottom:16px}
.camp-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.camp-name{font-weight:600}
.camp-id{color:#999;font-size:12px}
.camp-status{font-size:11px;padding:2px 8px;border-radius:10px;background:#eee}
.status-running{background:#e3f2fd;color:#1976d2}
.status-paused{background:#fff3e0;color:#f57c00}
.status-done{background:#e8f5e9;color:#388e3c}
.status-draft{background:#f5f5f5;color:#999}
.bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:#f0f0f0}
.seg{height:100%}
.seg.posted{background:#4CAF50}
.seg.failed{background:#F44336}
.seg.skipped{background:#9E9E9E}
.seg.pending{background:#FFC107}
.camp-meta{font-size:12px;color:#888;margin-top:4px}
</style></head>
<body>
<h1>${title}</h1>
<p class="subtitle">${new Date().toLocaleString('zh-CN')} · 最近 ${days} 天${videoId ? ' · ' + safeVideoId : ''}${account ? ' · 账号 ' + safeAccount : ''}</p>
<div class="cards">
<div class="card"><div class="label">评论总数</div><div class="value">${totalComments || '—'}</div></div>
<div class="card"><div class="label">待回复</div><div class="value">${pendingReplies || '—'}</div></div>
<div class="card"><div class="label">已回复</div><div class="value">${repliedCount || '—'}</div></div>
<div class="card"><div class="label">今日新增</div><div class="value">${todayNew || '—'}</div></div>
</div>
<div class="charts">
<div class="chart-box"><canvas id="s-chart"></canvas></div>
<div class="chart-box"><canvas id="t-chart"></canvas></div>
</div>
${campaignHTML}
${!hasSentiment ? '<div class="hint">💡 运行 analyze 命令后，情感分布图表将展示真实数据</div>' : ''}
<script>
new Chart(document.getElementById('s-chart'),{type:'doughnut',data:{labels:['正面','中性','负面'],datasets:[{data:[${sPos},${sNeu},${sNeg}],backgroundColor:['#4CAF50','#FFC107','#F44336']}]},options:{responsive:true,plugins:{title:{display:true,text:'情感分布'}}}});
new Chart(document.getElementById('t-chart'),{type:'line',data:{labels:${JSON.stringify(dayLabels)},datasets:[{label:'评论数',data:${JSON.stringify(dayValues)},borderColor:'#2196F3',backgroundColor:'rgba(33,150,243,0.1)',fill:true,tension:0.3}]},options:{responsive:true,plugins:{title:{display:true,text:'评论趋势（' + ${days} + '天）'}},scales:{y:{beginAtZero:true}}}});
<\/script></body></html>`;
}

module.exports = { generateDashboardHTML };
