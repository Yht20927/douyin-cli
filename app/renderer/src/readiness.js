// app/renderer/src/readiness.js — 「现在点这颗按钮有没有结果」的唯一判据
//
// 从 WorkspaceView 抽出来的原因和 status.js 一样：三颗按钮的 disabled、两处 title、
// 一块提示区都在读同一份 reply.describe() 的结果，以前各处自己写一遍"没读回来时
// 先当作可用"。那句话在**还在读**的时候是对的，在**读失败**的时候是假话 ——
// 而屏幕上这两种情况长得一模一样（§2.44 同一类）。

import { errorText } from './errors.js';

export const FIXED_EMPTY = '固定回复列表里还没有可用内容 —— 先到设置页的「回复策略」添加几条，'
  + '或把被禁用的启用起来';

const FIXED_OK_HINT = '只这一批用固定回复列表：不改全局「回复模式」，也不调 AI，秒完成。'
  + '结果同样进草稿箱，发布仍由你在草稿箱里确认。';

/** 读失败时按 AI 走的那两颗必须拦下来 —— 拦下不是惩罚，是不替用户保证一个自己不知道的事 */
const UNREADABLE_BLOCK = '现在没法判断这次点下去有没有结果 —— 回复来源（AI / 固定内容 / 混合）'
  + '没读回来。原因：';

/**
 * @param {object|null} desc - reply:describe 的 data，null 表示还没读回来
 * @param {string|Error|null} error - 这一次读**失败**的理由（没失败就别传）
 * @returns {{state:'loading'|'ready'|'stale'|'unreadable', modeHint:string|null,
 *   fixedUsable:number, fixedReady:boolean, fixedDisabled:boolean, fixedHint:string,
 *   aiOk:boolean, aiReason:string, genBlock:string|null}}
 */
export function replyReadiness(desc, error) {
  // 「有几条固定内容能用」这件事只有 core 知道（被禁用、正文空白、weighted 下权重 0
  // 都不算），界面不重复这套规则 —— 这里只是把它的数读过来用。
  const fixedUsable = (desc && desc.fixed && desc.fixed.usable) || 0;
  const aiReason = (desc && desc.ai && desc.ai.reason) || 'AI 现在还生成不了';

  if (error && !desc) {
    return {
      state: 'unreadable',
      modeHint: null,
      fixedUsable: 0,
      fixedReady: false,
      // 固定那颗不拦：它不调 AI、秒完成，成不成由结果那一句当场说；
      // 拦掉它等于把"我们读不到一份配置摘要"变成"这个应用不能干活"
      fixedDisabled: false,
      fixedHint: '回复来源没读回来，所以现在不知道固定内容列表里有没有可用条目 —— '
        + '这一颗仍然会去用那个列表（不调 AI），能不能成要等结果那一句才知道。',
      aiOk: false,
      aiReason: `${UNREADABLE_BLOCK}${errorText(error)}`,
      genBlock: `${UNREADABLE_BLOCK}${errorText(error)}`
        + ' —— 读回来之前按 AI 走的按钮先停一下，'
        + '免得占掉一个任务位、等过一轮间隔才换回一句报错。旁边那颗「重新读取」可以再试一次。',
    };
  }

  const modeHint = desc && {
    ai: 'AI 生成较慢',
    fixed: '当前是固定内容模式，秒回',
    hybrid: `当前是混合模式（AI 占 ${Math.round(desc.hybridRatio * 100)}%）`,
  }[desc.mode];

  const fixedReady = !desc || fixedUsable > 0;
  const aiOk = !desc || !desc.ai || desc.ai.ok;

  /**
   * 按全局「回复模式」走的那两颗按钮（「生成回复」「批量生成」）现在点下去有没有结果。
   *
   * 不拦的话 core 也会拒（llm.complete() 里刚补了同样的检查），但那是入队之后 ——
   * 占掉一个任务位、等过一轮间隔，才换回一句报错。混合模式不拦：固定列表还能兜底，
   * 降级这件事由结果里的来源标签说。
   */
  const genBlock = !desc ? null
    : desc.mode === 'fixed' ? (fixedReady ? null : FIXED_EMPTY)
      : aiOk ? null
        : (desc.mode === 'hybrid' && fixedUsable > 0) ? null
          : `${aiReason}；把「回复模式」改成「固定内容」不需要它`;

  return {
    state: desc ? (error ? 'stale' : 'ready') : 'loading',
    modeHint,
    fixedUsable,
    fixedReady,
    fixedDisabled: !fixedReady,
    fixedHint: fixedReady ? FIXED_OK_HINT : FIXED_EMPTY,
    aiOk,
    aiReason,
    genBlock,
  };
}
