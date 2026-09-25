// tests/reply-strategy.test.js — 回复策略的单一真源（D20）
//
// 回归背景（改造前）：
//   - 策略有三份副本：prompts/partial-reply-strategy.md（仅批量用）、
//     prompts/reply.md 内嵌全文、项目根目录 replay-strategy.md（被 getReply / suggest 读取）
//   - 根目录那份被两处截断：personas.js 的 slice(0,300) 与 suggest.js 的 substring(0,500)，
//     而它共 1135 字符、「绝对禁止的 AI 特征」在第 574 字符处
//   - 结果：这 8 条 AI 特征禁令**从未进入过任何 prompt**
//
// 本文件锁住修复后的不变量。

const fs = require('fs');
const path = require('path');

const pb = require('../core/reply-engine/prompt-builder');
const personas = require('../core/personas');
const paths = require('../core/paths');

/** 策略块里应当出现在所有回复路径中的内容 */
const MUST_HAVE = [
  ['AI 特征禁令小节', '绝对禁止的 AI 特征'],
  ['禁令词条：值得注意的是', '值得注意的是'],
  ['禁令词条：结构化列表', '结构化列表'],
  ['禁令词条：主谓宾长句', '主谓宾长句'],
  ['接地要求', '接地要求'],
  ['鼓励的表达', '鼓励的表达'],
  // 长度指引：策略文件**不再写死数字**，只指向系统提示里的「通用约束」——
  // 区间由 personas.effectiveLengthRange() 夹出来（设置页 prefer ∩ 人格风格 ∩
  // validateReply 真正会判的 hardMin/hardMax），写在这里就是第三份副本。
  // 所以这里锁的是"它会指向通用约束"，而不是某个具体区间。
  ['长度指引（指向通用约束）', '「通用约束」给出的那个区间'],
  ['语言规则', '语言规则'],
];

function combined(out) {
  return `${out.systemPrompt || ''}\n${out.userPrompt || ''}`;
}

function assertContains(label, text, out) {
  const all = combined(out);
  for (const [name, needle] of MUST_HAVE) {
    if (!all.includes(needle)) {
      throw new Error(`${label} 缺少「${name}」（${needle}）`);
    }
  }
  expect(all.length).toBeGreaterThan(100);
  return all;
}

describe('单一真源：策略进入全部回复路径', () => {
  const persona = personas.pickPersona();

  it('单条评论（comment.md）', () => {
    assertContains('comment', null, pb.buildGenerateCommentPrompt({
      vctx: null, persona, count: 1, mode: 'text-only',
    }));
  });

  it('单条回复（reply.md）', () => {
    assertContains('reply', null, pb.buildGenerateReplyPrompt({
      vctx: null, comment: { cid: '1', text: '怎么做' }, persona, scopedCtx: {}, mode: 'text-only',
    }));
  });

  it('批量回复（replies-batch.md）', () => {
    assertContains('replies-batch', null, pb.buildGenerateRepliesPrompt({
      vctx: null,
      comments: [{ cid: '1', text: 'a' }, { cid: '2', text: 'b' }, { cid: '3', text: 'c' }],
      persona, scopedCtx: {}, mode: 'text-only',
    }));
  });

  it('建议回复（suggest.md）', () => {
    assertContains('suggest', null, pb.buildSuggestPrompt({
      vctx: null, comments: [{ cid: '1', text: 'a' }], persona, llmContext: {}, strategyText: '',
    }));
  });
});

describe('按上下文渲染：风格多样化节只在批量出现', () => {
  const persona = personas.pickPersona();
  const HEADING = '风格多样化';

  it('batchCount<=1 时略去该节', () => {
    const single = combined(pb.buildGenerateCommentPrompt({ vctx: null, persona, count: 1, mode: 'text-only' }));
    expect(single).not.toContain(HEADING);
  });

  it('batchCount>1 时渲染该节并替换掉占位符', () => {
    const batch = combined(pb.buildGenerateRepliesPrompt({
      vctx: null,
      comments: [{ cid: '1', text: 'a' }, { cid: '2', text: 'b' }],
      persona, scopedCtx: {}, mode: 'text-only',
    }));
    expect(batch).toContain(HEADING);
    expect(batch).toContain('2 条回复');
    // 占位符必须被渲染掉，不能把 {{BATCH_COUNT}} 原样送进模型
    expect(batch).not.toContain('{{BATCH_COUNT}}');
  });
});

describe('buildStrategyBlock 本身', () => {
  it('单条时不含风格多样化，批量时含', () => {
    expect(pb.buildStrategyBlock(1)).not.toContain('风格多样化');
    expect(pb.buildStrategyBlock(0)).not.toContain('风格多样化');
    expect(pb.buildStrategyBlock(5)).toContain('风格多样化');
  });

  it('批量时把条数渲染进正文', () => {
    expect(pb.buildStrategyBlock(12)).toContain('12 条回复');
  });

  it('空参数按单条处理（不出现"共 undefined 条"）', () => {
    const b = pb.buildStrategyBlock(undefined);
    expect(b).not.toContain('undefined');
    expect(b).not.toContain('风格多样化');
  });

  it('不再有未渲染的占位符残留', () => {
    for (const n of [1, 2, 10]) {
      expect(pb.buildStrategyBlock(n)).not.toMatch(/\{\{\w+\}\}/);
    }
  });
});

describe('单一真源的物理事实', () => {
  it('根目录的 reply-strategy.md 已不存在（内容已并入唯一真源）', () => {
    expect(fs.existsSync(path.join(paths.appRoot(), 'reply-strategy.md'))).toBe(false);
  });

  it('唯一真源位于 prompts/partial-reply-strategy.md', () => {
    const file = path.join(paths.promptsDir(), 'partial-reply-strategy.md');
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, 'utf8');
    for (const [, needle] of MUST_HAVE) expect(content).toContain(needle);
  });

  it('reply.md 不再内嵌策略副本，改由 {{STRATEGY_BLOCK}} 注入', () => {
    const raw = fs.readFileSync(path.join(paths.promptsDir(), 'reply.md'), 'utf8');
    expect(raw).toContain('{{STRATEGY_BLOCK}}');
    // 内嵌副本的特征句不应再出现在模板里
    expect(raw).not.toContain('A. 提问型（问链接/问方法/问地点/问效果/问价格）');
  });

  it('comment.md 不再保留与全局冲突的长度规则', () => {
    const raw = fs.readFileSync(path.join(paths.promptsDir(), 'comment.md'), 'utf8');
    expect(raw).toContain('{{STRATEGY_BLOCK}}');
    // 改造前这里写的是「长度 5-50 字」「禁止超过 60 字」，与 D17 的全局 8-40/55 冲突
    expect(raw).not.toContain('5-50 字');
    expect(raw).not.toContain('超过 60 字');
  });
});

describe('不再有截断', () => {
  it('personas.buildSystemPrompt 不截断策略文本', () => {
    const persona = personas.pickPersona();
    const long = '策略甲。'.repeat(200); // 1000 字符
    const sys = personas.buildSystemPrompt(persona, long);
    expect(sys).toContain(long);
  });

  it('长策略能完整出现在 comment prompt 里', () => {
    const persona = personas.pickPersona();
    const long = '策略乙'.repeat(300);
    const out = pb.buildGenerateCommentPrompt({ vctx: null, persona, count: 1, mode: 'text-only', strategyText: long });
    expect(combined(out)).toContain(long);
  });
});
