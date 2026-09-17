// lib/jitter.js — 请求节奏与内容拟人化工具库（抖音版）
//
// 设计语义：这是 rate-limit pacing（请求节奏化）+ content humanization（内容拟人化），
// 目的是让代管自有账号的请求节奏贴近正常用户使用习惯，避免触发接口频控、维护账号健康。
// 它不是"逃避平台内容审核"——内容真实性与反刷量由 内容禁令 + corpus 去重 + factcheck 保证，
// 节奏工具只负责"多快发一次、像不像人手操作"。

const DELAY_RANGES = {
  page_turn:      [800,   2500],   // 翻页/滚动
  read_comment:   [3000,  12000],  // 阅读一条评论
  think_reply:    [5000,  20000],  // 思考回复内容
  post_interval:  [45000, 180000], // 两次发布之间的间隔
  browse_idle:    [1000,  5000],   // 浏览时的随机停顿
  type_char:      [300,   1500],   // 打字（逐字符延迟）
  scroll:         [300,   1200],   // 快速滚动
  switch_tab:     [2000,  8000],   // 切换标签/页面
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, Math.max(0, ms)));
}

async function randomSleep(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return sleep(ms);
}

async function maybeDelay(probability, minMs, maxMs) {
  if (Math.random() < probability) {
    await randomSleep(minMs, maxMs);
  }
}

function jitter(baseMs, percent) {
  const delta = baseMs * percent;
  return baseMs + (Math.random() * 2 - 1) * delta;
}

async function humanDelay(type) {
  return sleep(humanDelayMs(type));
}

function humanDelayMs(type) {
  const [min, max] = DELAY_RANGES[type] || [1000, 3000];
  return min + Math.random() * (max - min);
}

module.exports = {
  sleep,
  randomSleep,
  maybeDelay,
  jitter,
  humanDelay,
  humanDelayMs,
};
