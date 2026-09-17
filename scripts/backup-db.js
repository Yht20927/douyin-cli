#!/usr/bin/env node
// scripts/backup-db.js — SQLite 在线备份（VACUUM INTO 同步压缩副本）+ 清理 7 天前备份
// 用法：node scripts/backup-db.js  （建议 crontab 每日 + post 批次后增量）
//
// 防止 storage/*.db 损坏/误删导致 reply_corpus/users 标签/failure_patterns 全丢。

const path = require('path');
const fs = require('fs');
const { getDb, getDbPath } = require('../core/memory/db');

const dbPath = getDbPath();
const storageDir = path.dirname(dbPath);
const backupDir = path.join(storageDir, 'backups');
fs.mkdirSync(backupDir, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
const backupPath = path.join(backupDir, `db-${ts}.db`);

const db = getDb();
// VACUUM INTO 同步创建压缩副本（SQLite 3.27+，better-sqlite3 自带）
db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
console.log('✓ 备份到', backupPath);

// 清理 7 天前备份
const cutoff = Date.now() - 7 * 86400000;
let cleaned = 0;
for (const f of fs.readdirSync(backupDir)) {
  const fp = path.join(backupDir, f);
  if (f.endsWith('.db') && fs.statSync(fp).mtimeMs < cutoff) {
    fs.unlinkSync(fp);
    cleaned++;
  }
}
if (cleaned) console.log(`✓ 清理 ${cleaned} 个 7 天前备份`);
