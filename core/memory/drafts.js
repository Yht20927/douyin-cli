// lib/memory/drafts.js — 回复草稿管理
const { getDb } = require('./db');
const logger = require('../runtime/logger');

const PLATFORM = 'douyin';

function save(fields) {
  // 文字与附图至少要有一个：纯图回复是合法草稿（image.withText = false）。
  // 判定"有没有文字"必须 trim —— 只含空白的草稿发出去就是一条空评论，
  // 存进来时看不出来，等发布失败才发现。
  if (!fields || !fields.awemeId) return null;
  const rawText = fields.text == null ? '' : String(fields.text);
  const text = rawText.trim() ? rawText : '';
  const imagePath = fields.imagePath || null;
  if (!text && !imagePath) return null;
  try {
    const db = getDb();
    const info = db.prepare(`
      INSERT INTO drafts (aweme_id, reply_to_cid, text, persona_id, image_path, account_uid, created_at)
      VALUES (@awemeId, @replyToCid, @text, @personaId, @imagePath, @accountUid, @createdAt)
    `).run({
      awemeId: String(fields.awemeId),
      replyToCid: fields.replyToCid || null,
      text,
      personaId: fields.personaId || null,
      imagePath,
      // 这条草稿准备以哪个号的身份发出去。换号后它就不该出现在列表里 ——
      // 否则 B 号会把 A 号准备的回复发出去（且以 B 的登录状态发）
      accountUid: fields.accountUid ? String(fields.accountUid) : null,
      createdAt: Date.now(),
    });
    return Number(info.lastInsertRowid);
  } catch (e) { return null; }
}

function get(id) {
  if (!id) return null;
  try {
    return getDb().prepare('SELECT * FROM drafts WHERE id = ?').get(Number(id)) || null;
  } catch (e) { return null; }
}

/**
 * list 的 limit 硬上限。
 *
 * 导出的理由与 comments.MAX_LIMIT 一样：谁拥有 SQL 里的 LIMIT，谁负责把这个数
 * 说清楚。views.listDrafts 要用它判断"我拿到的列表是不是被截断了"，
 * 而此前它自己写了个 200 传给下面 —— 两个 200 各写一份，改一处就会悄悄失真。
 */
const MAX_LIMIT = 200;

/** 夹到 [1, MAX_LIMIT]；缺省沿用历史默认 50 */
function clampLimit(n) {
  const v = Number(n);
  return Math.max(1, Math.min(Number.isFinite(v) && v > 0 ? v : 50, MAX_LIMIT));
}

/**
 * 把关键词转成 LIKE 的参数。
 *
 * `%` 与 `_` 在 LIKE 里是通配符：用户搜「100%」时不该匹配所有以 100 开头的正文，
 * 搜 `_` 也不该匹配任意单字，所以按字面量转义（配合 SQL 里的 ESCAPE '\'）。
 */
function likePattern(q) {
  const s = String(q == null ? '' : q).trim();
  if (!s) return null;
  return `%${s.replace(/[\\%_]/g, ch => '\\' + ch)}%`;
}

/**
 * 搜索条件的 SQL 片段 —— list 与 count **必须共用这一份**。
 *
 * 为什么条件在 SQL 里而不是界面过滤：list 只有最近 MAX_LIMIT 条，在已加载的那一页
 * 里过滤会让"没有命中"成为假话（库里可能还有几十条），而"共 N 条"会说成过滤前的数。
 *
 * 命中三者之一即算命中：草稿正文、它所属视频的标题、被回复那条评论的原文
 * （运营者的搜索意图多半是"我回那个说贵的那个视频"，而不是记得 cid）。
 *
 * @returns {{sql: string, params: Array<string>}} sql 为空串表示不过滤
 */
function searchWhere(q) {
  const pattern = likePattern(q);
  if (!pattern) return { sql: '', params: [] };
  const LIKE = `LIKE ? ESCAPE '\\'`;
  return {
    // 三个占位符对应三个 ? —— 少一个 SQLite 会报"参数个数不符"而不是静默错
    sql: `(text ${LIKE}
        OR EXISTS (SELECT 1 FROM videos v WHERE v.aweme_id = drafts.aweme_id AND v.title ${LIKE})
        OR EXISTS (SELECT 1 FROM comments c WHERE c.cid = drafts.reply_to_cid AND c.text ${LIKE}))`,
    params: [pattern, pattern, pattern],
  };
}

function list(opts = {}) {
  try {
    const db = getDb();
    const where = [];
    const params = [];
    if (opts.awemeId) { where.push('aweme_id = ?'); params.push(String(opts.awemeId)); }
    if (opts.posted != null) { where.push('posted = ?'); params.push(opts.posted ? 1 : 0); }
    // 账号隔离。NULL 的旧草稿在指定账号时**不返回** —— 无法判断它属于谁，
    // 而"可能属于别人"的草稿被当作自己的发出去，是最危险的串号。
    if (opts.accountUid) { where.push('account_uid = ?'); params.push(String(opts.accountUid)); }
    // 放在最后：占位符顺序必须与 params 一致
    const search = searchWhere(opts.q);
    if (search.sql) { where.push(search.sql); params.push(...search.params); }
    const limit = clampLimit(opts.limit);
    const rows = db.prepare(`
      SELECT * FROM drafts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC LIMIT ${limit}
    `).all(...params);
    return rows;
  } catch (e) {
    logger.warn(`[drafts] 查询草稿失败${opts.q ? `（关键词 ${JSON.stringify(String(opts.q).slice(0, 20))}）` : ''}: ${e.message}`);
    return [];
  }
}

function markPosted(id) {
  if (!id) return false;
  try {
    getDb().prepare('UPDATE drafts SET posted = 1 WHERE id = ?').run(Number(id));
    return true;
  } catch (e) { return false; }
}

function remove(id) {
  if (!id) return false;
  try {
    getDb().prepare('DELETE FROM drafts WHERE id = ?').run(Number(id));
    return true;
  } catch (e) { return false; }
}

/**
 * 批量删除，返回**真正删掉的条数**。
 *
 * accountUid 一定要传：草稿箱界面按账号过滤，用户看不见的草稿不该被这一批 id
 * 删掉（换号后 id 仍可能留在前端的选中集合里）。返回值与请求数不等时，
 * 界面要照实说"删了 N 条（另有 M 条不属于当前账号）"，而不是报一个好看的数字。
 */
function removeMany(ids, opts = {}) {
  const list_ = [...new Set((ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!list_.length) return 0;
  try {
    const where = [`id IN (${list_.map(() => '?').join(',')})`];
    const params = [...list_];
    if (opts.accountUid) { where.push('account_uid = ?'); params.push(String(opts.accountUid)); }
    const info = getDb().prepare(`DELETE FROM drafts WHERE ${where.join(' AND ')}`).run(...params);
    return Number(info.changes) || 0;
  } catch (e) {
    // 不能静默返回 0：那在界面上长得像"这些草稿本来就不存在"
    logger.warn(`[drafts] 批量删除 ${list_.length} 条失败: ${e.message}`);
    return -1;
  }
}

function count(opts = {}) {
  try {
    const where = [];
    const params = [];
    if (opts.posted != null) { where.push('posted = ?'); params.push(opts.posted ? 1 : 0); }
    if (opts.accountUid) { where.push('account_uid = ?'); params.push(String(opts.accountUid)); }
    // 只服务于这个统计：没有标明归属账号的草稿。列表按账号过滤时它们不会出现，
    // 界面必须能说出"还有 N 条藏在这里"，否则就又是"数据在库里但界面找不到"
    if (opts.unattributed) where.push('account_uid IS NULL');
    // 与 list 同一份条件：否则"共 N 条"与列表内容说的不是同一个集合
    const search = searchWhere(opts.q);
    if (search.sql) { where.push(search.sql); params.push(...search.params); }
    return getDb().prepare(`
      SELECT count(*) AS n FROM drafts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    `).get(...params)?.n || 0;
  } catch (e) {
    logger.warn(`[drafts] 统计草稿条数失败: ${e.message}`);
    return 0;
  }
}

module.exports = { save, get, list, markPosted, remove, removeMany, count, MAX_LIMIT, clampLimit };
