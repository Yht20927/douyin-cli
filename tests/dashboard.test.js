// tests/dashboard.test.js — 仪表盘 HTML 注入防护
//
// audit.js / db.js 的目录常量在 require 时求值，必须在 import 前 set env。

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DOUYIN_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-dash-logs-'));
process.env.DOUYIN_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-dash-store-'));

const { generateDashboardHTML } = require('../lib/dashboard');

describe('dashboard HTML 注入防护', () => {
  it('videoId 注入 <script> 被转义', () => {
    const html = generateDashboardHTML('<script>alert(1)</script>', 7);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('title 与 subtitle 均使用转义后的 videoId', () => {
    const malicious = '<img src=x onerror=alert(2)>';
    const html = generateDashboardHTML(malicious, 14);
    expect(html).toContain(`<title>视频 &lt;img src=x onerror=alert(2)&gt; 评论仪表盘</title>`);
    expect(html).not.toContain(`<h1>视频 ${malicious}`);
  });

  it('正常 videoId 与空态渲染不受影响', () => {
    const html = generateDashboardHTML('7629735841874726179', 3);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('视频 7629735841874726179 评论仪表盘');
    expect(html).toContain('评论总数');
  });
});

// ── 多账号：仪表盘按账号过滤（P3）──
describe('dashboard 多账号过滤', () => {
  const auditFile = path.join(process.env.DOUYIN_LOG_DIR, 'audit.json');

  function writeAudit(ops) {
    fs.writeFileSync(auditFile, JSON.stringify({
      version: '2.0', updated: new Date().toISOString(),
      sessions: [{ sessionId: 's1', started: new Date().toISOString(), ended: null, operations: ops }],
    }));
  }
  // 一条成功的 get 操作；account 决定它归属哪个号
  const getOp = (account, comments) => ({
    command: 'get', status: 'success',
    started: new Date().toISOString(),
    args: { aweme_id: 'v1' }, summary: { comments }, account,
  });
  // 从 HTML 里抠出「评论总数」卡片的值（0 会渲染成 —）
  const totalOf = (html) => {
    const m = html.match(/评论总数<\/div><div class="value">([^<]+)</);
    return m ? m[1] : null;
  };

  it('不指定账号 → 统计全部账号', () => {
    writeAudit([getOp('ACC_A', 3), getOp('ACC_B', 5)]);
    expect(totalOf(generateDashboardHTML(null, 7))).toBe('8');
  });

  it('指定账号 → 只统计该账号', () => {
    writeAudit([getOp('ACC_A', 3), getOp('ACC_B', 5)]);
    expect(totalOf(generateDashboardHTML(null, 7, 'ACC_A'))).toBe('3');
    expect(totalOf(generateDashboardHTML(null, 7, 'ACC_B'))).toBe('5');
  });

  it('该账号无数据 → 显示 —（不把别的号算进来）', () => {
    writeAudit([getOp('ACC_B', 5)]);
    expect(totalOf(generateDashboardHTML(null, 7, 'ACC_A'))).toBe('—');
  });

  it('账号名走 HTML 转义（防注入）', () => {
    writeAudit([getOp('ACC_A', 1)]);
    expect(generateDashboardHTML(null, 7, '<b>x</b>')).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
