// lib/memory/drafts.js — 回复草稿管理
const { getDb } = require('./db');

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
    const limit = clampLimit(opts.limit);
    const rows = db.prepare(`
      SELECT * FROM drafts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC LIMIT ${limit}
    `).all(...params);
    return rows;
  } catch (e) { return []; }
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

function count(opts = {}) {
  try {
    const where = [];
    const params = [];
    if (opts.posted != null) { where.push('posted = ?'); params.push(opts.posted ? 1 : 0); }
    if (opts.accountUid) { where.push('account_uid = ?'); params.push(String(opts.accountUid)); }
    return getDb().prepare(`
      SELECT count(*) AS n FROM drafts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    `).get(...params)?.n || 0;
  } catch (e) { return 0; }
}

module.exports = { save, get, list, markPosted, remove, count, MAX_LIMIT, clampLimit };
