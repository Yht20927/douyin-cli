// core/memory/db.js — SQLite 单例
//
// 设计原则：
// 1. 单例 + lazy 打开：首次调用 getDb() 时才打开数据库；调用方任何时候 require 都安全。
// 2. WAL 模式 + busy_timeout，支持多进程并发读写（CLI + 调度器同时跑）。
// 3. PRAGMA user_version 管理 schema 版本；每个 migration 幂等。
// 4. 自愈：删除 storage/douyin.db 后下次调用自动重建（仅丢失 SQLite 数据，audit.json 仍在）。
// 5. 失败不抛：上层用 try/catch 包住，SQLite 异常降级为日志，不影响主流程。
//
// 驱动：node:sqlite（经 core/memory/sqlite-driver.js 适配成 better-sqlite3 的调用形状）。
// 不再使用 better-sqlite3 原生模块 —— 它的 ABI 与 Electron 不匹配，会导致
// 桌面应用里所有读本地数据的页面静默变空（详见驱动层文件头的说明）。
//
// ⚠️ 时间戳单位约定（重要，曾经踩过）
// ----------------------------------
//   **抖音原生时间字段一律是「秒」，本项目自己产生的一律是「毫秒」。**
//
//   秒：comments.created_at、videos.create_time   ← 直接来自抖音 API 的 create_time
//   毫秒：first_seen / last_seen / last_get_ts / last_post_ts / events.ts / drafts.created_at
//
//   两处消费点都依赖这个区别，改动前务必一起看：
//     - commands/get.js 的 --new 增量过滤：create_time(秒) > cutoff，而
//       events.findLastFetchTime() 特意做了 Math.floor(ms/1000) 转成秒，所以是一致的
//     - data/views.js 给界面用之前会把秒归一成毫秒（界面按毫秒算"多久之前"）
//   把某一侧改成另一种单位而不动另一侧，会静默产生"永远拿不到新评论"这类故障。

const fs = require('fs');
const path = require('path');

const paths = require('../paths');
const { Database: SqliteDatabase } = require('./sqlite-driver');

// 当前 schema 版本（每次新增 migration → 自增）
const SCHEMA_VERSION = 10;

let _db = null;

function ensureStorageDir() {
  paths.ensureDir(paths.dbDir());
}

/**
 * 获取数据库单例。
 * 任何调用方都应通过此函数访问，禁止直接 new Database()。
 */
function getDb() {
  if (_db) return _db;
  ensureStorageDir();
  _db = new SqliteDatabase(paths.dbFile());
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('busy_timeout = 5000');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  return _db;
}

/**
 * 执行 schema 迁移。幂等：每次启动都跑，但只追加未应用的版本。
 */
function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  if (current >= SCHEMA_VERSION) return;

  const migrations = [
    // v0 → v1：events 表
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          ts           INTEGER NOT NULL,
          session_id   TEXT,
          command      TEXT NOT NULL,
          status       TEXT NOT NULL,
          duration_ms  INTEGER,
          aweme_id     TEXT,
          uid          TEXT,
          cid          TEXT,
          args_json    TEXT,
          summary_json TEXT,
          error        TEXT,
          result_path  TEXT,
          platform     TEXT NOT NULL DEFAULT 'douyin'
        );
        CREATE INDEX IF NOT EXISTS idx_events_video   ON events(aweme_id, ts);
        CREATE INDEX IF NOT EXISTS idx_events_uid     ON events(uid, ts);
        CREATE INDEX IF NOT EXISTS idx_events_command ON events(command, ts);
        CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      `);
    },
    // v1 → v2：实体表 users / videos / comments
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          uid             TEXT NOT NULL,
          platform        TEXT NOT NULL DEFAULT 'douyin',
          sec_uid         TEXT,
          nickname        TEXT,
          first_seen      INTEGER,
          last_seen       INTEGER,
          comment_count   INTEGER NOT NULL DEFAULT 0,
          reply_count     INTEGER NOT NULL DEFAULT 0,
          tier            TEXT,
          tags_json       TEXT,
          notes           TEXT,
          PRIMARY KEY (platform, uid)
        );
        CREATE INDEX IF NOT EXISTS idx_users_tier     ON users(tier);
        CREATE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname);

        CREATE TABLE IF NOT EXISTS videos (
          aweme_id            TEXT NOT NULL,
          platform            TEXT NOT NULL DEFAULT 'douyin',
          title               TEXT,
          author_uid          TEXT,
          is_mine             INTEGER NOT NULL DEFAULT 0,
          total_comments_seen INTEGER NOT NULL DEFAULT 0,
          last_get_ts         INTEGER,
          last_post_ts        INTEGER,
          campaign_id         INTEGER,
          PRIMARY KEY (platform, aweme_id)
        );
        CREATE INDEX IF NOT EXISTS idx_videos_author ON videos(author_uid);

        CREATE TABLE IF NOT EXISTS comments (
          cid         TEXT NOT NULL,
          platform    TEXT NOT NULL DEFAULT 'douyin',
          aweme_id    TEXT NOT NULL,
          uid         TEXT,
          text        TEXT,
          text_hash   TEXT,
          digg        INTEGER,
          created_at  INTEGER,
          is_sticker  INTEGER NOT NULL DEFAULT 0,
          parent_cid  TEXT,
          sentiment   TEXT,
          priority    INTEGER,
          replied     INTEGER NOT NULL DEFAULT 0,
          reply_cid   TEXT,
          first_seen  INTEGER,
          last_seen   INTEGER,
          PRIMARY KEY (platform, cid)
        );
        CREATE INDEX IF NOT EXISTS idx_comments_video  ON comments(aweme_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_comments_uid    ON comments(uid, created_at);
        CREATE INDEX IF NOT EXISTS idx_comments_hash   ON comments(text_hash);
        CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_cid);
      `);
    },
    // 后续版本在此追加：v2 → v3、v3 → v4 ...
    // v2 → v3：reply_corpus + failure_patterns
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reply_corpus (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          platform      TEXT NOT NULL DEFAULT 'douyin',
          src_cid       TEXT,
          src_text      TEXT,
          reply_text    TEXT NOT NULL,
          reply_hash    TEXT,
          aweme_id      TEXT,
          posted_at     INTEGER,
          outcome       TEXT,
          effectiveness REAL
        );
        CREATE INDEX IF NOT EXISTS idx_corpus_hash    ON reply_corpus(platform, reply_hash);
        CREATE INDEX IF NOT EXISTS idx_corpus_posted  ON reply_corpus(platform, posted_at);
        CREATE INDEX IF NOT EXISTS idx_corpus_outcome ON reply_corpus(outcome);
        CREATE INDEX IF NOT EXISTS idx_corpus_video   ON reply_corpus(aweme_id);

        CREATE TABLE IF NOT EXISTS failure_patterns (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          platform     TEXT NOT NULL DEFAULT 'douyin',
          signature    TEXT NOT NULL,
          hit_count    INTEGER NOT NULL DEFAULT 1,
          last_hit     INTEGER,
          example_text TEXT,
          mitigation   TEXT,
          UNIQUE(platform, signature)
        );
        CREATE INDEX IF NOT EXISTS idx_failures_lasthit ON failure_patterns(last_hit DESC);
      `);
    },
    // v3 → v4：reply_corpus 加 reply_cid（我们发出的回复 cid，用于 delete 时关联语料 outcome）
    () => {
      db.exec(`
        ALTER TABLE reply_corpus ADD COLUMN reply_cid TEXT;
        CREATE INDEX IF NOT EXISTS idx_corpus_reply_cid ON reply_corpus(platform, reply_cid);
      `);
    },
    // v4 → v5：reply_corpus (platform, reply_hash) UNIQUE 约束（防重复行 + 并发预占基础）
    () => {
      db.exec(`
        DELETE FROM reply_corpus WHERE id NOT IN (SELECT MAX(id) FROM reply_corpus GROUP BY platform, reply_hash);
        DROP INDEX IF EXISTS idx_corpus_hash;
        CREATE UNIQUE INDEX idx_corpus_hash_unique ON reply_corpus(platform, reply_hash);
      `);
    },
    // v5 → v6：campaigns + campaign_tasks（P4 推广引擎）
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS campaigns (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          platform        TEXT NOT NULL DEFAULT 'douyin',
          name            TEXT NOT NULL,
          goal            TEXT,
          template_json   TEXT,
          videos_json     TEXT,
          filters_json    TEXT,
          daily_quota     INTEGER NOT NULL DEFAULT 50,
          per_user_quota  INTEGER NOT NULL DEFAULT 1,
          status          TEXT NOT NULL DEFAULT 'draft',
          started_at      INTEGER,
          stats_json      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(platform, status);

        CREATE TABLE IF NOT EXISTS campaign_tasks (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          campaign_id     INTEGER NOT NULL,
          cid             TEXT NOT NULL,
          aweme_id        TEXT,
          reply_text      TEXT,
          scheduled_at    INTEGER,
          executed_at     INTEGER,
          outcome         TEXT NOT NULL DEFAULT 'pending',
          failure_reason  TEXT,
          UNIQUE(campaign_id, cid)
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_due      ON campaign_tasks(outcome, scheduled_at);
        CREATE INDEX IF NOT EXISTS idx_tasks_campaign ON campaign_tasks(campaign_id, outcome);
      `);
    },
    // v6 → v7：videos 表富文本扩展 + llm_usage + drafts
    () => {
      const cols = db.prepare(`PRAGMA table_info(videos)`).all().map(c => c.name);
      const newCols = ['desc', 'type', 'tags_json', 'images_json', 'cover_url', 'briefing', 'context_refreshed_at'];
      for (const col of newCols) {
        if (!cols.includes(col)) db.exec(`ALTER TABLE videos ADD COLUMN ${col} TEXT`);
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS llm_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          model TEXT NOT NULL,
          purpose TEXT,
          aweme_id TEXT,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          total_tokens INTEGER,
          cost_estimate REAL,
          duration_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_llm_usage_ts ON llm_usage(ts DESC);

        CREATE TABLE IF NOT EXISTS drafts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          aweme_id TEXT NOT NULL,
          reply_to_cid TEXT,
          text TEXT NOT NULL,
          persona_id TEXT,
          created_at INTEGER NOT NULL,
          posted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_drafts_aweme ON drafts(aweme_id, created_at DESC);
      `);
    },
    // v7 → v8：comments 表 replied 索引（高频过滤列，加速未回复评论查询）
    () => {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_replied ON comments(aweme_id, replied);`);
    },
    // v8 → v9：videos 表补上互动数据
    //
    // v7 给 videos 加了 desc / cover_url 等列，但 upsert 从来没写过它们 ——
    // 属于"列建了、路没通"的死列。作品列表要显示播放/点赞/封面，必须把写入路径
    // 一并补上，所以这次连数据列一起加，并在 core/memory/videos.js 里接到位。
    () => {
      const cols = db.prepare(`PRAGMA table_info(videos)`).all().map(c => c.name);
      const newCols = ['play_count', 'digg_count', 'comment_count', 'share_count', 'create_time'];
      for (const col of newCols) {
        if (!cols.includes(col)) db.exec(`ALTER TABLE videos ADD COLUMN ${col} INTEGER`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_videos_mine ON videos(platform, is_mine, last_get_ts DESC);`);
    },
    // v9 → v10：草稿支持附图（D9 图片回复：本地文件路径）
    //
    // 图片回复生成出来的草稿如果记不住图片路径，"存草稿→稍后发布"就会静默丢掉
    // 附图，只剩文字发出去 —— 这正是本表要避免的那种"不报错、只是结果不对"。
    () => {
      const cols = db.prepare(`PRAGMA table_info(drafts)`).all().map(c => c.name);
      if (!cols.includes('image_path')) {
        db.exec(`ALTER TABLE drafts ADD COLUMN image_path TEXT`);
      }
    },
  ];

  // 备份再迁移（schema 版本递增前的兜底）
  if (current > 0) {
    try {
      // 先 checkpoint WAL，确保未提交的 WAL 内容写回主 db，备份才完整
      db.pragma('wal_checkpoint(TRUNCATE)');
      const bak = paths.dbFile() + '.bak.v' + current;
      fs.copyFileSync(paths.dbFile(), bak);
    } catch (e) { /* 忽略备份失败 */ }
  }

  const applyAll = db.transaction((from) => {
    for (let v = from; v < SCHEMA_VERSION; v++) {
      const fn = migrations[v];
      if (!fn) throw new Error(`Missing migration step v${v} → v${v + 1}`);
      fn();
      db.pragma(`user_version = ${v + 1}`);
    }
  });
  applyAll(current);
}

/**
 * 关闭数据库（测试用；正常进程退出由 SQLite 自身处理）。
 */
function closeDb() {
  if (_db) {
    try { _db.close(); } catch (e) { /* ignore */ }
    _db = null;
  }
}

/**
 * 获取数据库文件路径（脚本 / 测试用）。
 */
function getDbPath() { return paths.dbFile(); }

module.exports = { getDb, closeDb, getDbPath, SCHEMA_VERSION };
