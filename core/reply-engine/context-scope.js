// lib/reply-engine/context-scope.js — 上下文隔离
//
// 三层 scoped context 构建：
//   L1: Video-scoped（本视频的语料/已回复）— 严格隔离
//   L2: Semi-scoped（全局成功语料）— 补充丰富性
//   L3: Global failures（通用失败模式）— 所有视频共享
//
// 从 xiaohongshu-cli 移植，适配抖音 DB schema（note_id → aweme_id）。

let _memory = null;
let _memoryFailed = false;

function getMemory() {
  // 首次失败后每次调用都重试（避免因早期初始化失败导致永久降级）
  if (!_memory || _memoryFailed) {
    try {
      _memory = {
        corpus: require('../memory/corpus'),
        failures: require('../memory/failures'),
        comments: require('../memory/comments'),
      };
      _memoryFailed = false;
    } catch (e) {
      if (process.env.DOUYIN_DEBUG) console.warn('[context-scope] 记忆层加载失败:', e.message);
      _memory = false;
      _memoryFailed = true;
    }
  }
  return _memory || null;
}

/** 重置记忆层状态（测试用） */
function resetMemory() {
  _memory = null;
  _memoryFailed = false;
}

/**
 * 按 replyText 去重（保留首次出现）
 */
function dedupeByText(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  return items.filter(item => {
    const key = (item.replyText || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 构建三层 scoped context
 * @param {string} awemeId - 视频 ID
 * @param {object} [opts]
 * @param {string} [opts.commentUid] - 评论者 uid（用于加载用户画像）
 * @returns {{ corpus: Array, avoid: Array, failures: Array, myRepliesOnVideo: Array, userProfile: object|null }}
 */
function buildScopedContext(awemeId, opts = {}) {
  const m = getMemory();
  if (!m) return { corpus: [], avoid: [], failures: [], myRepliesOnVideo: [], userProfile: null };

  // L1: Video-scoped — 单查询获取 corpus + avoid
  let videoCorpus = [];
  let videoAvoid = [];
  let myRepliesOnVideo = [];
  try {
    const videoRecent = m.corpus.recent({ awemeId, limit: 15 });
    videoCorpus = videoRecent.slice(0, 10);
    videoAvoid = videoRecent.map(r => r.replyText).filter(Boolean);
    // 本视频已发回复：从 reply_corpus 表查询实际回复文本
    const botReplies = m.corpus.recent({ awemeId, limit: 10 });
    myRepliesOnVideo = botReplies.map(r => r.replyText).filter(Boolean).slice(0, 10);
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[context-scope] L1 查询失败:', e.message);
  }

  // L2: Global 成功语料（仅取有 srcText 的回复对，过滤无上下文的独立回复）
  let globalCorpus = [];
  try {
    const allRecent = m.corpus.recent({ limit: 10 });
    // 优先取有 srcText 的（回复对），没有 srcText 的独立回复不适合做 few-shot
    globalCorpus = allRecent.filter(c => c.srcText).slice(0, 5);
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[context-scope] L2 查询失败:', e.message);
  }

  // L3: Global failures
  let failures = [];
  try { failures = m.failures.top(5); } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[context-scope] L3 查询失败:', e.message);
  }

  // User Memory: 加载评论者画像（用于回复时个性化）
  let userProfile = null;
  if (opts.commentUid) {
    try {
      const users = require('../memory/users');
      const u = users.get(opts.commentUid);
      if (u) {
        userProfile = {
          uid: u.uid,
          nickname: u.nickname,
          tier: u.tier,
          commentCount: u.commentCount,
          tags: u.tags || [],
          firstSeen: u.firstSeen,
          lastSeen: u.lastSeen,
        };
      }
    } catch (e) {
      if (process.env.DOUYIN_DEBUG) console.warn('[context-scope] User Memory 查询失败:', e.message);
    }
  }

  // 合并：L1 优先 → L2 补充
  const corpus = dedupeByText([...videoCorpus, ...globalCorpus]).slice(0, 15);

  return {
    corpus,
    avoid: videoAvoid,
    failures,
    myRepliesOnVideo,
    userProfile,
  };
}

module.exports = { buildScopedContext, dedupeByText, resetMemory };
