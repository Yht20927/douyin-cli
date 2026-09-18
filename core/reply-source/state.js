// core/reply-source/state.js — 循环取样的运行时状态落盘
//
// 为什么是独立文件而不是写进 config.json
// ------------------------------------
// 改造计划 §4.3 原本写的是"游标存于配置"。实现时改成独立文件，理由有三：
//
//   1. config.json 是**用户手写**的（改完导出、恢复默认都以它为准）。
//      把 `cursor: 7` 这类机器状态混进去，"用户显式改过什么"就说不清了。
//   2. config.set() 是深合并 + 原子写。每发一条固定回复就重写一遍用户配置，
//      既无谓放大了写入面，也让用户在编辑器里看到的文件一直在变。
//   3. 用户改列表长度后游标必须跟着修正（见 cycles.normalize），属于运行期
//      自愈逻辑，不该要求用户理解。
//
// 代价是"当前进度"多了一个文件要看。设置页会把进度与「重置」按钮直接做出来，
// 用户不需要去翻文件。
//
// 文件：<dataDir>/reply-state.json，与 config.json 同级。
// 丢失或损坏都不影响功能 —— 当作空状态重新开始，并留一条日志。

const fs = require('fs');
const path = require('path');
const paths = require('../paths');
const logger = require('../runtime/logger');
const { emptyState } = require('./cycles');

/** 需要在文件里保留的键。新增取样器时在这里加一条即可 */
const SECTIONS = ['fixed', 'image'];

function stateFile() {
  return path.join(paths.dataDir(), 'reply-state.json');
}

function blank() {
  const out = {};
  for (const s of SECTIONS) out[s] = emptyState();
  return out;
}

/**
 * 读状态。任何异常都降级为空状态 ——
 * 状态文件坏了不该让"生成回复"整个不可用。
 * @returns {object} 每个 section 一份 cycles 状态
 */
function load() {
  const file = stateFile();
  const out = blank();
  let parsed;
  try {
    if (!fs.existsSync(file)) return out;
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  } catch (e) {
    logger.warn(`[reply-source] 状态文件读取失败，已从空状态开始：${e.message}`);
    return out;
  }

  for (const s of SECTIONS) {
    const v = parsed[s];
    if (!v || typeof v !== 'object') continue;
    out[s] = {
      cursor: Number.isInteger(v.cursor) ? v.cursor : 0,
      deck: Array.isArray(v.deck) ? v.deck.filter(Number.isInteger) : [],
      recent: Array.isArray(v.recent) ? v.recent.filter(Number.isInteger) : [],
    };
  }
  return out;
}

/**
 * 写状态（原子写：先写 .tmp 再 rename）。
 * 写失败只告警不抛错 —— 退化成"下次从头开始"，不影响本次生成。
 */
function save(state) {
  const file = stateFile();
  try {
    paths.ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (e) {
    logger.warn(`[reply-source] 状态文件写入失败，本次循环进度不会保留：${e.message}`);
  }
}

/**
 * 读 → 交给回调改 → 写回。
 *
 * 每次取样只动一个 section，用这个包起来可以避免调用方漏掉 save()：
 * 漏掉的话表现为"重启后从头开始"，是个很难被发现的不报错故障。
 *
 * @param {'fixed'|'image'} section
 * @param {(state:object) => any} fn - 就地修改 state[section]，返回值原样透出
 */
function withSection(section, fn) {
  const state = load();
  const result = fn(state[section]);
  save(state);
  return result;
}

/**
 * 循环进度的可读快照，给设置页显示"现在轮到第几条了"用。
 *
 * 状态里存的是**下标**，用户看不懂；这里换算成"第 N 条 / 共 M 条"。
 * 下标越界时（刚改过列表）如实标出来 —— 下一次生成会自愈，
 * 提前说清楚比让用户对着一个不动的数字猜要好。
 *
 * @param {number} [fixedCount] - 固定内容当前的可选条数
 */
function describe(fixedCount) {
  const state = load();
  const n = Number.isInteger(fixedCount) ? fixedCount : null;
  const fixed = state.fixed;
  return {
    fixed: {
      cursor: fixed.cursor,
      // 人为从 1 开始：这是给人看的
      nextIndex: n ? (fixed.cursor % n) + 1 : null,
      total: n,
      deckRemaining: fixed.deck.length,
      recent: fixed.recent.length,
    },
    image: {
      deckRemaining: state.image.deck.length,
    },
  };
}

/** 清空状态（设置页的「重置循环进度」按钮用） */
function reset(section) {
  const state = load();
  if (section) {
    if (!SECTIONS.includes(section)) throw new Error(`未知的取样区段: ${section}`);
    state[section] = emptyState();
  } else {
    for (const s of SECTIONS) state[s] = emptyState();
  }
  save(state);
  return state;
}

module.exports = { stateFile, load, save, withSection, describe, reset, SECTIONS };
