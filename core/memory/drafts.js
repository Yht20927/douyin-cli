// lib/memory/drafts.js — 回复草稿管理
const { getDb } = require('./db');

const PLATFORM = 'douyin';

function save(fields) {
  if (!fields || !fields.awemeId || !fields.text) return null;
  try {
    const db = getDb();
    const info = db.prepare(`
      INSERT INTO drafts (aweme_id, reply_to_cid, text, persona_id, created_at)
      VALUES (@awemeId, @replyToCid, @text, @personaId, @createdAt)
    `).run({
      awemeId: String(fields.awemeId),
      replyToCid: fields.replyToCid || null,
      text: String(fields.text),
      personaId: fields.personaId || null,
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

function list(opts = {}) {
  try {
    const db = getDb();
    const where = [];
    const params = [];
    if (opts.awemeId) { where.push('aweme_id = ?'); params.push(String(opts.awemeId)); }
    if (opts.posted != null) { where.push('posted = ?'); params.push(opts.posted ? 1 : 0); }
    const limit = Math.min(Number(opts.limit) || 50, 200);
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
    return getDb().prepare(`
      SELECT count(*) AS n FROM drafts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    `).get(...params)?.n || 0;
  } catch (e) { return 0; }
}

module.exports = { save, get, list, markPosted, remove, count };
