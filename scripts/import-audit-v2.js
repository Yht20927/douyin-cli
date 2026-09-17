#!/usr/bin/env node
// scripts/import-audit-v2.js — 把历史 logs/audit.json 全量回灌到 SQLite events 表
//
// 用法：
//   node scripts/import-audit-v2.js          # 默认读 logs/audit.json
//   node scripts/import-audit-v2.js path/to/audit.json
//
// 幂等：用 (session_id, command, ts) 三元组去重；重复运行只会 imported=0。
// 注意：v2 audit.json 的 session 已被截断到最近 50 个，更早的历史无法找回。

const fs = require('fs');
const path = require('path');
const { getDb } = require('../core/memory/db');

const argPath = process.argv[2];
const AUDIT_FILE = argPath
  ? path.resolve(argPath)
  : path.join(__dirname, '..', 'logs', 'audit.json');

function main() {
  if (!fs.existsSync(AUDIT_FILE)) {
    console.error(`audit.json 不存在: ${AUDIT_FILE}`);
    console.error('（如果是全新项目，没有历史可导入是正常的）');
    process.exit(0);
  }

  let audit;
  try {
    audit = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  } catch (e) {
    console.error(`audit.json 解析失败: ${e.message}`);
    process.exit(1);
  }

  const db = getDb();
  // 已存在的事件指纹：session_id + command + ts，避免重复导入
  const existing = new Set(
    db.prepare("SELECT session_id || '|' || command || '|' || ts AS key FROM events").all().map(r => r.key)
  );

  const insert = db.prepare(`
    INSERT INTO events (
      ts, session_id, command, status, duration_ms,
      aweme_id, uid, cid, args_json, summary_json,
      error, result_path, platform
    ) VALUES (
      @ts, @sessionId, @command, @status, @durationMs,
      @awemeId, @uid, @cid, @argsJson, @summaryJson,
      @error, @resultPath, 'douyin'
    )
  `);

  let imported = 0;
  let skipped = 0;
  let malformed = 0;

  const tx = db.transaction(() => {
    for (const session of (audit.sessions || [])) {
      const sid = session.sessionId || null;
      for (const op of (session.operations || [])) {
        if (!op.command) { malformed++; continue; }
        const ts = op.ended
          ? new Date(op.ended).getTime()
          : (op.started ? new Date(op.started).getTime() : 0);
        if (!ts) { malformed++; continue; }

        const key = `${sid}|${op.command}|${ts}`;
        if (existing.has(key)) { skipped++; continue; }

        insert.run({
          ts,
          sessionId: sid,
          command: op.command,
          status: op.status || 'unknown',
          durationMs: op.durationMs ?? null,
          awemeId: op.args && op.args.aweme_id || null,
          uid: op.args && op.args.uid || null,
          cid: op.args && op.args.cid || null,
          argsJson: op.args ? JSON.stringify(op.args) : null,
          summaryJson: op.summary ? JSON.stringify(op.summary) : null,
          error: op.error || null,
          resultPath: op.resultFile || null,
        });
        existing.add(key);
        imported++;
      }
    }
  });
  tx();

  console.log(`✓ 导入完成: imported=${imported}, skipped(已存在)=${skipped}, malformed=${malformed}`);
  console.log(`  events 表当前总行数: ${db.prepare('SELECT count(*) AS n FROM events').get().n}`);
}

main();
