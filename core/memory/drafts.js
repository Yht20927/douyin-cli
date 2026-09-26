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
 * 改草稿正文的**唯一**入口 —— 单条编辑与批量改都走这里。
 *
 * 为什么必须有真 UPDATE：这模块此前只有 save / remove，界面的"编辑"是
 * 存一条新的再删旧的。于是 id 变了、created_at 变成现在（这条在列表里跳到最前），
 * 而两步之间任何一步失败都会留下**两条内容相同的待发草稿** —— 用户接着批量发布
 * 就是把同一句话发两遍。
 *
 * **只允许改 text。** `persona_id` 是"这句话是谁写的"的溯源记录（发布链路只读 text，
 * 见 core/reply-source），批量换个标签不会让正文变成那个人格写的口吻，
 * 那样草稿行上的人格名就成了假话。要换口吻得回工作台重新生成。
 *
 * 两种补丁形状：
 *   `{ text }`                整批替换成同一句
 *   `{ find, replace }`       每条在自己的正文里把 find 换成 replace
 *
 * 逐条判定先一次 SELECT 拿现状，再决定每一条的命运 —— 界面必须说得出
 * "改了 N 条、M 条已发出所以没动"，而不是报一个好看的数。
 *
 * @param {number[]} ids
 * @param {{text?: string, find?: string, replace?: string}} patch
 * @param {object} [opts]
 * @param {string|null} [opts.accountUid] 当前账号。**没有理由让一次批量改碰到
 *   用户在界面上根本看不见的草稿**（换号后旧 id 可能还留在前端勾选集合里）
 * @param {boolean} [opts.dryRun] 只算不改（确认框用它显示"会改动 N 条"，
 *   预览与执行因此必然是同一套判据）
 * @returns {{changed: number[], skipped: {missing:number,posted:number,foreign:number,empty:number,noop:number},
 *   preview: Array<{id:number, from: string, to: string}>, requested: number}}
 *   preview 是每一条**计划改成什么**（dryRun 时就是"会改动这些"，执行时是"已改成这些"）；
 *   requested 是净化后的请求条数
 */
function updateMany(ids, patch = {}, opts = {}) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : [])
    .map(Number).filter(n => Number.isInteger(n) && n > 0))];
  const skipped = { missing: 0, posted: 0, foreign: 0, empty: 0, noop: 0 };
  const changed = [];
  // 净化后的请求条数从这里返回，而不是让每个调用方再抄一遍
  // 「去重 + 只留正整数」那套规则 —— ipc.js 与探针都要报这个数，抄两份迟早不一样
  const requested = wanted.length;
  if (!wanted.length) return { changed, skipped, preview: [], requested };

  const hasAssign = typeof patch.text === 'string';
  const hasFind = typeof patch.find === 'string' && patch.find !== '';
  if (!hasAssign && !hasFind) throw new Error('没有要改的内容（给 text 或给 find＋replace）');
  if (hasAssign && hasFind) throw new Error('整批替换与查找替换只能选一种');
  const repl = String(patch.replace == null ? '' : patch.replace);

  let rows;
  try {
    rows = getDb().prepare(`
      SELECT id, text, image_path, posted, account_uid FROM drafts
      WHERE id IN (${wanted.map(() => '?').join(',')})
    `).all(...wanted);
  } catch (e) {
    logger.warn(`[drafts] 批量改正文读现状失败（${wanted.length} 条）: ${e.message}`);
    throw new Error('批量改正文失败（原因已记入日志）');
  }
  const byId = new Map(rows.map(r => [Number(r.id), r]));

  // 用 split/join 而不是 String.replace：替换串里的 `$&` / `$1` 会被 replace
  // 当成"引用匹配到的内容"，于是用户敲进去的正常汉字凭空长出别的东西；
  // 而 find 若直接当模式用，`(` `.` `+` 这些字面量会变成正则元字符。
  const nextText = (cur) => (hasAssign
    ? patch.text
    : String(cur == null ? '' : cur).split(patch.find).join(repl));

  const plan = [];
  for (const id of wanted) {
    const row = byId.get(id);
    if (!row) { skipped.missing += 1; continue; }
    if (row.posted) { skipped.posted += 1; continue; }
    // 与 list / removeMany 同一个口径：account_uid 为 NULL 的旧草稿在指定账号时
    // 本来就不显示，这里也必须一动不动
    if (opts.accountUid && String(row.account_uid || '') !== String(opts.accountUid)) {
      skipped.foreign += 1; continue;
    }
    const raw = nextText(row.text);
    // 与 save 同一条规则：只含空白的正文一律存成空串（有附图时它是合法的纯图草稿），
    // 否则库里会留下一条"看着有字、发出去是空评论"的草稿
    const next = String(raw).trim() ? raw : '';
    // 与 save 同一条底线：文字与附图至少要有一个。只含空白的正文发出去就是
    // 一条空评论，存的时候看不出来，等发布失败才发现
    if (!next && !row.image_path) { skipped.empty += 1; continue; }
    if (next === row.text) { skipped.noop += 1; continue; }
    plan.push({ id, from: row.text, next });
  }
  // 预览与执行用的是同一个 plan：确认框里"会改成这样"的那几句，
  // 跟真按下去之后的结果不可能对不上。界面若自己重算一遍替换，
  // 就等于把上面那条判据抄第二份 —— 两份迟早不一致，症状是
  // "预览说改 12 条、实际改了 11 条"。
  const preview = plan.map(p => ({ id: p.id, from: p.from, to: p.next }));
  if (!plan.length || opts.dryRun) {
    return { changed: opts.dryRun ? plan.map(p => p.id) : changed, skipped, preview, requested };
  }

  try {
    const db = getDb();
    const stmt = db.prepare('UPDATE drafts SET text = ? WHERE id = ? AND posted = 0');
    // 事务：中途失败时不能留下"改了一半"的状态 —— 那会儿界面上批次的
    // 每一条都写着同一句话，而实际上还有几条是旧文案
    const tx = db.transaction((items) => {
      const done = [];
      for (const it of items) {
        const info = stmt.run(it.next, it.id);
        if (Number(info.changes) > 0) done.push(it.id);
      }
      return done;
    });
    changed.push(...tx(plan));
  } catch (e) {
    logger.warn(`[drafts] 批量改正文写入失败（计划 ${plan.length} 条）: ${e.message}`);
    throw new Error('批量改正文失败（原因已记入日志）');
  }
  return { changed, skipped, preview, requested };
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

module.exports = { save, get, list, markPosted, remove, updateMany, removeMany, count, MAX_LIMIT, clampLimit };
