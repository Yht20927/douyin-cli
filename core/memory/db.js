// core/memory/db.js — SQLite 单例
//
// 设计原则：
// 1. 单例 + lazy 打开：首次调用 getDb() 时才打开数据库；调用方任何时候 require 都安全。
// 2. WAL 模式 + busy_timeout，支持多进程并发读写（CLI + 调度器同时跑）。
// 3. PRAGMA user_version 管理 schema 版本；每个 migration 幂等。
// 4. 自愈：删除 storage/douyin.db 后下次调用自动重建（仅丢失 SQLite 数据，audit.json 仍在）。
// 5. 打开/迁移失败一律抛出：宁可让调用方看见错误，也不要带着一个半迁移的库继续跑。
//    各 memory 模块把**读**异常降级成 []/null 是可以的（界面少显示一点东西而已），
//    但喂给风控计数的读（core/memory/events.js 的 queryStrict、risk-control 的
//    lastOpTs）必须抛出 —— 那里"读不到"被当成"今天还没发过"就等于限流失效。
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
const SCHEMA_VERSION = 13;

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
  const db = new SqliteDatabase(paths.dbFile());
  // 迁移成功之前**绝不能**把连接交出去。
  //
  // 原先这里直接写 `_db = new SqliteDatabase(...)` 再 `migrate(_db)`，于是迁移一抛错，
  // 一个半迁移的连接就被缓存在 `_db` 上，之后每次 getDb() 都在第一行短路返回它 ——
  // 而 memory 层各模块把 SQL 错误统统 catch 成 []/null/0。表现是：界面安静地变空、
  // 日志一个字都没有，policy 那边则把"读不到记录"当成"今天还没发过"，限流直接失效。
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    migrate(db);
  } catch (e) {
    // 关掉半成品，但不要把原始错误盖掉：迁移失败必须能一路抛到启动层并被看见。
    try { db.close(); } catch (_) { /* 忽略：原始错误更重要 */ }
    throw e;
  }
  _db = db;
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
    // v10 → v11：连接过的账号登记表（账号级数据隔离的基础）
    //
    // 油猴脚本注册连接时会上报登录账号（clientVersion ≥ 2）。把"哪个 uid 是
    // 哪个昵称"落库，界面才能在作品列表上标注"这条内容是哪个号发的"，
    // 发布链路才能把"视频归属账号"与"浏览器当前登录账号"做比对。
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          platform TEXT NOT NULL DEFAULT 'douyin',
          uid TEXT NOT NULL,
          nickname TEXT,
          avatar TEXT,
          sec_uid TEXT,
          first_seen INTEGER,
          last_seen INTEGER,
          PRIMARY KEY (platform, uid)
        );
      `);
    },
    // v11 → v12：视频互动数据的历史快照
    //
    // 为什么必须单独一张表：videos 表的 play_count / digg_count 等是**单值列**，
    // 每次「刷新列表」被 `ON CONFLICT DO UPDATE` 覆盖。于是"这条视频这周涨了
    // 多少播放"永远答不出来 —— 而这是运营判断"哪条在持续涨"的唯一依据。
    //
    // 两个设计取舍：
    //
    // 1. **主键带 day**（本地日期 `YYYY-MM-DD`），于是"每个视频每天最多一行"
    //    是表结构保证的，不靠调用方自觉。同一天多次刷新走 UPSERT 覆盖成
    //    当天最后一次读数 —— 那正是"今天的播放数"该有的值。
    // 2. **只给 `ts` 一个毫秒时间戳 + `day` 一个本地日期**，不存时区。
    //    这张表的用途是按天看增长，跨时区没有意义（这是单人本机工具）。
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS video_stats_history (
          platform      TEXT NOT NULL DEFAULT 'douyin',
          aweme_id      TEXT NOT NULL,
          day           TEXT NOT NULL,
          ts            INTEGER NOT NULL,
          play_count    INTEGER,
          digg_count    INTEGER,
          comment_count INTEGER,
          share_count   INTEGER,
          PRIMARY KEY (platform, aweme_id, day)
        );
        CREATE INDEX IF NOT EXISTS idx_vsh_video ON video_stats_history(platform, aweme_id, day DESC);
        CREATE INDEX IF NOT EXISTS idx_vsh_day   ON video_stats_history(platform, day);
      `);
    },
    // v12 → v13：账号级数据隔离
    //
    // 背景：`is_mine=1` 只表示"这是本机某个登录账号的作品"，**不区分是哪个号**。
    // 于是换号之后「我的作品」把两个号的作品混在一张列表里，而所有"我发的评论"
    // 的判断都落到 videos.myUid()（"is_mine 里 author_uid 出现最多的那个"）——
    // 一个全局猜测，两个号时静默挑一个，另一个号的评论被判成路人。
    //
    // 两列：
    //   videos.ops_uid   —— 这一行是**哪个账号的操作**带进来的（拉评论/发回复/补全）。
    //                       别人的视频没有归属账号，只能靠它区分"是谁在运营"。
    //                       旧数据无据可查 → NULL，界面归为「未归属」。
    //   accounts.is_current —— 多账号时用户选定的那个。只有多开时才需要，
    //                       唯一连接时以页面登录的账号为准（自动跟随）。
    () => {
      const vcols = db.prepare(`PRAGMA table_info(videos)`).all().map(c => c.name);
      if (!vcols.includes('ops_uid')) db.exec(`ALTER TABLE videos ADD COLUMN ops_uid TEXT`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_videos_ops_uid ON videos(platform, ops_uid);`);

      const acols = db.prepare(`PRAGMA table_info(accounts)`).all().map(c => c.name);
      if (!acols.includes('is_current')) db.exec(`ALTER TABLE accounts ADD COLUMN is_current INTEGER NOT NULL DEFAULT 0`);

      // drafts 也要认账号：一条草稿是"以某个号的身份回某条评论"，
      // 换号之后它必须从列表里消失 —— 否则 B 号会把 A 号准备的回复发出去
      // （而且是以 B 的登录状态发），这是最危险的一种串号。
      const dcols = db.prepare(`PRAGMA table_info(drafts)`).all().map(c => c.name);
      if (!dcols.includes('account_uid')) db.exec(`ALTER TABLE drafts ADD COLUMN account_uid TEXT`);
      // ⚠️ drafts **没有 platform 列**（它只有一张表、不分平台）。
      // 照抄 videos 的写法加了 platform 会让这条 CREATE INDEX 抛
      // "no such column: platform" → 整个 getDb() 失败 → 被 memory 层的
      // catch 吞成"没有数据"。症状是升级后所有列表都空，而日志里什么都没有。
      db.exec(`CREATE INDEX IF NOT EXISTS idx_drafts_account ON drafts(account_uid, posted);`);

      // ── 旧数据回填 ──
      //
      // 不加这一步，升级后按账号过滤的列表会**全部变空** —— 旧行的 ops_uid
      // 是 NULL，而 NULL 不属于任何账号。用户看到的是"我的作品 0 个"，
      // 而数据明明还在库里，这比原来的"混在一起"更难排查。
      //
      // 只在**有且仅有一个**可能的归属时才回填：is_mine 视频的 author_uid
      // 去重后只有一个 → 本机只运营过这一个号，那些没有归属的行只能是它的。
      // 有两个及以上时**不回填**（无法判断，宁可留 NULL 让界面显示"未归属"，
      // 也不要猜一个然后永远错下去）。
      const owners = db.prepare(
        `SELECT DISTINCT author_uid FROM videos WHERE platform = ? AND is_mine = 1 AND author_uid IS NOT NULL`
      ).all('douyin').map(r => r.author_uid);
      if (owners.length === 1) {
        const uid = owners[0];
        db.prepare(`UPDATE videos SET ops_uid = ? WHERE platform = ? AND ops_uid IS NULL`).run(uid, 'douyin');
        db.prepare(`UPDATE drafts SET account_uid = ? WHERE account_uid IS NULL`).run(uid);
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
