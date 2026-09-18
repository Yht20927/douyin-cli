// tests/policy-filters.test.js — 评论筛选决策树与回复校验
//
// 这些判定改造前只写在运营文档的散文里，代码零实现（规则见 运营规则说明.md §3）。本文件把
// 文档里的每一条判定固化成可执行的断言 —— 以后再改文档时必须同步改这里。

const f = require('../core/policy/filters');
const config = require('../core/config');

const F = config.get('filters');

/** 便捷：只关心 action */
function act(text, extra = {}, opts = {}) {
  return f.classify({ cid: 'c1', uid: 'u1', text, ...extra }, opts).action;
}

describe('决策树：表情与贴纸', () => {
  it('纯 Unicode 表情 → 表情回复路线', () => {
    expect(act('😊😊')).toBe('emoji_reply');
    expect(act('❤️')).toBe('emoji_reply');
  });

  it('抖音方括号表情 → 表情回复路线（它们不是 Unicode 字符）', () => {
    expect(act('[赞][玫瑰]')).toBe('emoji_reply');
    expect(act('[微笑]')).toBe('emoji_reply');
  });

  it('表情夹标点仍算纯表情', () => {
    expect(act('😊 ~')).toBe('emoji_reply');
  });

  it('表情 + 文字 → 走文字路线，不算纯表情', () => {
    expect(act('😊 这个怎么做的')).toBe('reply');
  });

  it('纯标点（无表情）不算纯表情，按短文本处理', () => {
    expect(f.isEmojiOnly('...')).toBe(false);
    expect(f.isEmojiOnly('')).toBe(false);
  });

  it('贴纸评论跳过（平台标记优先于文本判断）', () => {
    const r = f.classify({ cid: 'c', uid: 'u', text: '好', is_sticker: true });
    expect(r.action).toBe('skip');
    expect(r.reason).toContain('贴纸');
  });

  it('关闭表情回复后，纯表情转为跳过', () => {
    const filters = { ...F, emojiOnly: { ...F.emojiOnly, enabled: false } };
    const r = f.classify({ cid: 'c', uid: 'u', text: '😊' }, { filters });
    expect(r.action).toBe('skip');
  });
});

describe('决策树：水评判定', () => {
  it('短且命中水评词 → 跳过，且原因里带上命中的词', () => {
    const r = f.classify({ cid: 'c', uid: 'u', text: '666' });
    expect(r.action).toBe('skip');
    expect(r.reason).toContain('666');
  });

  it('常见的几类水评都被拦下', () => {
    for (const t of ['666', '哈哈', '哈哈哈', '来了', '前排', '沙发', '打卡', '+1', '顶']) {
      expect(act(t)).toBe('skip');
    }
  });

  it('长度上限是「含」的，且对应文档的「长度 < 4」', () => {
    expect(F.waterCommentMaxLen).toBe(3);
    expect(act('123')).toBe('skip');      // 3 字 → 水评候选
    expect(act('1234')).not.toBe('water'); // 4 字不再是候选（这里会落到"不匹配"）
  });

  it('短但含提问信号 → 不按水评处理，走文字回复', () => {
    expect(act('怎么弄')).toBe('reply');
  });

  it('关闭 skipWater 后水评不再被拦', () => {
    const filters = { ...F, skipWater: false };
    expect(f.classify({ cid: 'c', uid: 'u', text: '666' }, { filters }).action)
      .toBe('skip'); // 仍会落到"不匹配优先回复条件"，但不再标为水评
    const r = f.classify({ cid: 'c', uid: 'u', text: '666' }, { filters });
    expect(r.reason).not.toContain('水评');
  });
});

describe('决策树：优先回复信号', () => {
  it('提问求助', () => {
    expect(act('这个是怎么做到的？')).toBe('reply');
    expect(act('求教程')).toBe('reply');
    expect(act('在哪里买的')).toBe('reply');
  });

  it('高质量反馈（超过阈值长度）', () => {
    const long = '你视频里那个三步拆解的方法我用在自己项目上了效果确实好';
    expect(f.textLength(long)).toBeGreaterThan(F.qualityFeedbackMinLen);
    const r = f.classify({ cid: 'c', uid: 'u', text: long });
    expect(r.action).toBe('reply');
    expect(r.signals).toContain('高质量反馈');
  });

  it('负面情绪', () => {
    expect(act('这期有点失望')).toBe('reply');
    expect(act('完全看不懂，太差了，有点生气')).toBe('reply');
  });

  it('一条评论可以同时命中多个信号', () => {
    const r = f.classify({ cid: 'c', uid: 'u', text: '这个怎么做的？我照着做失败了很失望' });
    expect(r.signals.length).toBeGreaterThanOrEqual(2);
  });

  it('都不命中的普通陈述 → 跳过', () => {
    const r = f.classify({ cid: 'c', uid: 'u', text: '今天的天气挺好的我出门散了会步' });
    expect(r.action).toBe('skip');
    expect(r.reason).toContain('不匹配');
  });
});

describe('决策树：已回复与用户分级', () => {
  it('已回复过的 cid 直接跳过（优先级最高）', () => {
    const r = f.classify(
      { cid: 'done', uid: 'u', text: '这个怎么做' },
      { isReplied: (cid) => cid === 'done' }
    );
    expect(r.action).toBe('skip');
    expect(r.reason).toContain('已回复');
  });

  it('已回复判定优先于信号判定', () => {
    const r = f.classify(
      { cid: 'done', uid: 'u', text: '这个怎么做的？' },
      { isReplied: () => true }
    );
    expect(r.action).toBe('skip');
  });

  it('黑名单 / 垃圾用户跳过', () => {
    for (const tier of ['blacklist', 'spam']) {
      const r = f.classify({ cid: 'c', uid: 'bad', text: '这个怎么做' }, { userTier: () => tier });
      expect(r.action).toBe('skip');
      expect(r.reason).toContain(tier);
    }
  });

  it('vip 用户不被拦（只是标记，不影响是否回复）', () => {
    expect(f.classify({ cid: 'c', uid: 'v', text: '这个怎么做' }, { userTier: () => 'vip' }).action)
      .toBe('reply');
  });

  it('关闭 skipReplied 后已回复的也放行', () => {
    const filters = { ...F, skipReplied: false };
    const r = f.classify({ cid: 'done', uid: 'u', text: '这个怎么做' },
      { filters, isReplied: () => true });
    expect(r.action).toBe('reply');
  });
});

// ═══════════════════════════════════════════════════════════
// 自己发的评论
//
// 评论区里"我以作者身份发出的回复"也会作为评论被拉回来。不排掉的话，
// 工作台里满屏都是自己说过的话，还会提示去回复自己 —— 用户实测反馈
// 某个视频 36 条"评论"里有 25 条其实是他自己发的回复。
// ═══════════════════════════════════════════════════════════

describe('决策树：自己的评论不回复', () => {
  const MY = '1179139456380456';

  it('uid 是我自己的 → 跳过，且原因写明', () => {
    const r = f.classify(
      { cid: 'c', uid: MY, text: '这个是怎么做到的？' },   // 内容本身是"该回复"的
      { myUid: MY }
    );
    expect(r.action).toBe('skip');
    expect(r.reason).toContain('我自己');
  });

  it('优先级最高：即便命中优先信号也跳过', () => {
    const r = f.classify(
      { cid: 'c', uid: MY, text: '这个怎么做的？我照着做失败了很失望' },
      { myUid: MY }
    );
    expect(r.action).toBe('skip');
  });

  it('uid 是别人的照常判定', () => {
    const r = f.classify(
      { cid: 'c', uid: 'other', text: '这个是怎么做到的？' },
      { myUid: MY }
    );
    expect(r.action).toBe('reply');
  });

  it('拿不到 myUid 时不误判（宁可少判也不能把别人当成我）', () => {
    const r = f.classify(
      { cid: 'c', uid: MY, text: '这个是怎么做到的？' },
      {}                      // 没有 myUid
    );
    expect(r.action).toBe('reply');
  });

  it('关闭 skipOwnComments 后自己发的也参与判定', () => {
    const filters = { ...F, skipOwnComments: false };
    const r = f.classify(
      { cid: 'c', uid: MY, text: '这个是怎么做到的？' },
      { filters, myUid: MY }
    );
    expect(r.action).toBe('reply');
  });

  it('uid 类型不一致（数字 / 字符串）也能匹配上', () => {
    const r = f.classify(
      { cid: 'c', uid: 1179139456380456, text: '这个怎么做的' },
      { myUid: MY }
    );
    expect(r.action).toBe('skip');
  });
});

describe('表情回复候选', () => {
  it('按映射表给出对应候选', () => {
    expect(f.pickEmojiReply('❤️')).toEqual(['🌹', '❤️']);
    expect(f.pickEmojiReply('👍')).toEqual(['🤝', '💪']);
    expect(f.pickEmojiReply('😂')).toEqual(['😄', '😂']);
  });

  it('判断不出类型时用兜底池', () => {
    expect(f.pickEmojiReply('🦄')).toEqual(F.emojiOnly.pool);
    expect(f.pickEmojiReply('')).toEqual(F.emojiOnly.pool);
  });

  it('方括号表情同样命中映射', () => {
    expect(f.pickEmojiReply('[玫瑰]')).toEqual(['🌹', '❤️']);
  });
});

describe('回复文本校验（发布前硬门槛）', () => {
  const ok = (t) => f.validateReply(t).ok;
  const rules = (t) => f.validateReply(t).violations.map(v => v.rule);

  it('正常回复通过', () => {
    expect(ok('这个词我也踩过坑，后来发现是缓存的问题')).toBe(true);
  });

  it('空内容拒绝', () => {
    expect(ok('   ')).toBe(false);
  });

  it('长度上下限', () => {
    expect(rules('好')).toContain('过短');
    expect(rules('这是一段很长的回复'.repeat(6) + '再补一点')).toContain('过长');
  });

  it('AI 腔禁用词', () => {
    for (const w of ['值得注意的是', '综上所述', '总而言之', '从某种程度上说']) {
      expect(rules(`前面 ${w} 后面`)).toContain('禁用措辞');
    }
  });

  it('敷衍表达（评论风格指南的禁词）', () => {
    expect(rules('不错')).toContain('禁用措辞');
    expect(rules('学习了')).toContain('禁用措辞');
  });

  it('结构化列表', () => {
    expect(rules('1. 先这样\n2. 再那样')).toContain('结构化列表');
  });

  it('完整 GitHub 链接（会被限流）', () => {
    expect(rules('看 https://github.com/abc/def 就知道了')).toContain('完整 GitHub 链接');
  });

  it('emoji 数量上限', () => {
    expect(rules('😊😊😊😊')).toContain('表情过多');
    expect(ok('😊😊')).toBe(true);
  });

  it('分段上限', () => {
    expect(rules('第一行\n第二行\n第三行\n第四行')).toContain('分段过多');
  });

  it('命中多个禁用词时一次列全（不让人改一个试一次）', () => {
    const v = f.validateReply('值得注意的是，这个方案不错');
    const hit = v.violations.find(x => x.rule === '禁用措辞');
    expect(hit).toBeTruthy();
    expect(hit.hint).toContain('值得注意的是');
    expect(hit.hint).toContain('不错');
  });

  it('一条回复可以同时违反多条不同规则，全部报出来', () => {
    // 既长又有 AI 腔
    const bad = '值得注意的是，' + '这个方案的细节我展开说一下'.repeat(4);
    expect(rules(bad).length).toBeGreaterThanOrEqual(2);
  });

  it('用户填了非法正则不会让校验崩掉', () => {
    const filters = { ...F, forbiddenPatterns: [{ name: '坏正则', pattern: '([', hint: 'x' }] };
    expect(() => f.validateReply('正常内容', { filters })).not.toThrow();
  });
});

describe('文本工具', () => {
  it('textLength 不计空白', () => {
    expect(f.textLength('a b c')).toBe(3);
    expect(f.textLength('你好 世界')).toBe(4);
  });

  it('countEmoji 同时数 Unicode 与方括号表情', () => {
    expect(f.countEmoji('😊')).toBe(1);
    expect(f.countEmoji('[赞]')).toBe(1);
    expect(f.countEmoji('😊[赞]😊')).toBe(3);
    expect(f.countEmoji('没有表情')).toBe(0);
  });

  it('连续调用不因正则 lastIndex 残留而出错', () => {
    for (let i = 0; i < 5; i++) {
      expect(f.isEmojiOnly('😊')).toBe(true);
      expect(f.countEmoji('😊')).toBe(1);
    }
  });

  it('containsAny 返回命中的词而不是布尔值（界面要显示哪个词）', () => {
    expect(f.containsAny('今天来了吗', ['来了', '走了'])).toEqual(['来了']);
    expect(f.containsAny('无关文本', ['来了'])).toEqual([]);
  });
});
