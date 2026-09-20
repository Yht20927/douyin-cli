// core/config/index.js — 配置的单一真源
//
// 为什么需要这一层
// ----------------
// 改造前，config.json 被 4 处独立 require：cli.js:17、server.js:14、risk-control.js:40、
// llm.js:11。这带来三个问题：
//
//   1. **模块级缓存导致改配置不生效**。risk-control.js 有 `_config` 缓存（原 :35-45），
//      改完 config.json 不重启进程永远读不到新值。
//   2. **没有默认值合并**。缺字段时各处自己写 `|| 兜底`，散落且不一致。
//   3. **没有校验**。非法值（如 intervals.write = [0,0]）各自静默回退，用户不知道。
//
// 本模块的约定
// ------------
// - 所有消费方调用 `get()` 取值，**不要在模块级缓存返回值**（否则又变回老问题）。
// - 用户配置只写要改的项，其余从 DEFAULTS 补齐（深合并）。
// - `get()` 每次返回**深拷贝**，调用方改动不会污染缓存。
// - `set()` 原子写盘并刷新内存；桌面设置页保存后无需重启。
// - 校验失败不抛错（配置问题不该让应用起不来），而是回退默认值并记录 warning，
//   由 GUI 诊断页/设置页展示。
//
// 关于 DEFAULTS 的边界
// --------------------
// 这里**只放真正被代码消费的配置项**。改造前的 config.example.json 里 `vision` 块、
// 以及实际 config.json 里的 `multimodal.screenshotCount` / `autoScreenshotRatio`
// 全是死配置（全代码无人读取），本次一并清除。新增配置项时必须同时有消费点，
// 避免重蹈"看着能配、实际不生效"的覆辙。

const fs = require('fs');
const path = require('path');
const paths = require('../paths');
// cycles.js 是纯算法叶子模块（不 require 任何东西），从这里取循环名可以保证
// 「配置校验认的名字」与「取样器实现的名字」永远同一份，不会各写一份然后漂移。
const { CYCLE_NAMES } = require('../reply-source/cycles');

/** 回复来源模式。reply-source 从这里取，不另立一份 */
const REPLY_MODES = ['ai', 'fixed', 'hybrid'];
/** 图片附加的触发方式 */
const IMAGE_MODES = ['always', 'ratio', 'keyword'];

// ═══════════════════════════════════════════════════════════
// 默认值
// ═══════════════════════════════════════════════════════════

const DEFAULTS = {
  app: {
    // 关窗口时最小化到托盘而不是退出（定时拉取要求应用常驻）
    minimizeToTray: true,
  },
  bridge: {
    host: '127.0.0.1',
    port: 19422,
    token: '',
    requestTimeout: 30000,
    // 抖音搜索结果等大响应可能远超 1MB，默认 64MB
    maxBodySize: 67108864,
    // 连接健康监测：桌面应用据此在界面上显示"已连接/离线"
    connectionWatch: {
      // 轮询 /api/status 的间隔
      pollIntervalSec: 5,
      // 连续多久没有活跃连接就判定为离线并提示
      offlineAlertSec: 60,
    },
  },
  llm: {
    api_key: '',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    max_tokens: 4096,
    timeout_ms: 60000,
    max_retries: 3,
  },
  intervals: {
    // 写操作间隔（秒），risk-control 硬强制
    write: [40, 55],
    // 读操作间隔（秒）
    read: [30, 50],
    // 读操作是否也强制阻塞。
    // CLI 下为 false（保持"读操作只建议不阻塞"的既有语义，避免交互式查询每次卡 30s）；
    // 桌面 GUI 下由主进程置 true —— 因为 GUI 里没有 agent 自觉遵守间隔，必须由代码兜住。
    readEnforce: false,
    // 全量拉取时**翻页之间**的间隔（秒）。
    //
    // 与 read 的区别：read 是「两条命令之间」的间隔，且受上面的 readEnforce 开关控制；
    // commentPage 是「同一条命令内部逐次请求之间」的间隔 —— 一次全量拉取会连打几十上百页，
    // 命令入口那次 read 等待拦不住页与页之间的密度，所以单独给一个。
    // 它不接 readEnforce 开关：只要有第二页就生效（实测 ~0.7s/页，不节流等于连发）。
    //
    // `enrich`（补全视频信息）的那 200 次详情请求**共用这一项**（enrich.js 里的 pace）——
    // 那是同一种"一次点下去连发几百个请求"的活。没另开一个键：键名改了会作废
    // 用户已有的配置，而两处的合理取值本来就是同一个数量级。
    commentPage: [1, 3],
  },
  multimodal: {
    // text-only | screenshots | video
    // 注意：screenshots/video 需要本机 ffmpeg/ffprobe，桌面版不内置（D11），
    // 缺依赖时代码会自动降级回 text-only（video-context.js:79-87）
    mode: 'text-only',
  },

  // ═══════════════════════════════════════════════════════════
  // account —— 账号身份
  //
  // 这几个键是从改造前的账号文档抢救来的（改造计划 §5.10 / §9.3）。
  // 那份文档随 P4.4 一并删除，而 **email 在全项目只有那一处**，
  // 不先落到这里就等于永久丢失。
  //
  // 关于"死配置"的例外说明
  // ----------------------
  // 本文件开头的原则是"只放真正被代码消费的配置项"。下面四个里只有一个
  // 符合，另外三个是**纯信息留存**，这一点必须说清楚而不是假装它们有用：
  //
  //   roleProfile  有消费点 —— 非空时注入 AI 的人设背景（core/personas.js）
  //   email        无消费点 —— 改造计划 §11#10 已确认「保留，属纯信息留存」，
  //                界面按敏感字段打码、导出配置时剔除
  //   douyinId     无消费点 —— 记录本机操作的是哪个号，多账号时用来区分
  //   githubOwner  无消费点 —— 原本供 repo-info 使用，该命令已随 D8 移除
  //
  // 这与"看着能配、实际不生效"的旧毛病有区别：那批死配置没有任何说明，
  // 用户改完以为生效了。这里每一项在设置页都标明了是否影响行为。
  // ═══════════════════════════════════════════════════════════
  account: {
    /** 抖音号。仅作记录 */
    douyinId: '',
    /** GitHub 用户名。仅作记录（原供推广功能使用，已移除） */
    githubOwner: '',
    /** 联系邮箱。仅作记录；按敏感字段处理 */
    email: '',
    /**
     * 角色定位（人设背景）。**非空时会注入到 AI 生成时的系统提示里**，
     * 影响生成的语气与视角。留空则不加这一段。
     */
    roleProfile: '',
  },

  // ═══════════════════════════════════════════════════════════
  // reply —— 内容来源：回复从哪来
  //
  // 三种模式由 core/reply-source 分发，接入点是 getReply 命令内部的 cid 分支，
  // 所以 CLI 与桌面应用走的是同一条路径（队列、进度、取消全部复用）。
  //
  // 与 reply-engine 的分工：reply-engine 只管"怎么用 LLM 生成"，
  // 这里管"这一次到底用不用 LLM"。
  // ═══════════════════════════════════════════════════════════
  reply: {
    /** ai = 全部走 LLM；fixed = 只取固定列表（零成本零延迟）；hybrid = 按比例混用 */
    mode: 'ai',
    hybrid: {
      /** hybrid 模式下走 AI 的概率，其余次走固定内容 */
      aiRatio: 0.7,
      /** AI 调用失败/超时时降级到固定内容，而不是整条生成失败 */
      fallbackToFixed: true,
    },
    fixed: {
      /**
       * 固定回复内容。**默认空**，不预置示例文本 ——
       * 预置示例有被连带发布出去的风险，需要什么由用户自己在设置页加。
       * @type {Array<{text:string, weight:number, enabled:boolean}>}
       */
      items: [],
      /** 循环方式，见 core/reply-source/cycles.js（D14 四种全做） */
      cycle: 'shuffle-no-repeat',
      /** 同一句至少间隔多少次才可复用。0 = 不限制 */
      minGapBetweenReuse: 0,
    },
    image: {
      /** 是否在回复时附带图片 */
      enabled: false,
      /** always = 每条都带；ratio = 按比例；keyword = 评论命中关键词才带 */
      mode: 'ratio',
      ratio: 0.3,
      /** mode=keyword 时生效 */
      keywords: [],
      /**
       * 本地图片路径列表（D9：只支持本地文件，不做图库/URL）。
       * 支持 jpg/png/webp/gif/bmp/heic，单张上限 10MB —— 见 core/comment-image.js。
       */
      paths: [],
      /** 多图选取策略，与 fixed.cycle 同一套算法 */
      pick: 'shuffle-no-repeat',
      /** 带图回复是否同时带文字 */
      withText: true,
    },
  },

  // ═══════════════════════════════════════════════════════════
  // personas —— 人格（语气模板）
  //
  // 内置 7 个人格的**定义**在 core/personas.js（那是默认值），这里只放"用户改了什么"。
  // 三者叠加得到实际生效的列表，见 personas.effectivePersonas()。
  //
  // 为什么 overrides / custom 是数组而不是以 id 为键的对象：
  // 设置页的保存走"只允许 DEFAULTS 里已知路径"的守卫（app/main/ipc.js），
  // 以用户数据为键意味着路径无法预先列出。数组形式让每个路径都是静态可知的。
  // ═══════════════════════════════════════════════════════════
  personas: {
    /** 停用的内置人格 id。用"停用"而不是"启用"，是为了让将来新增的内置人格默认可用 */
    disabled: [],
    /**
     * 只覆盖改过的字段，未列出的沿用内置值。
     * @type {Array<{id:string} & Partial<{name:string, weight:number, temperature:number,
     *        lengthRange:[number,number], emojiChance:number, promptPrefix:string,
     *        forbiddenWords:string[], examples:string[], enabled:boolean}>>}
     */
    overrides: [],
    /**
     * 自定义人格，字段与内置同构。id 撞上内置时忽略这一条。
     * @type {Array<object>}
     */
    custom: [],
  },

  // ═══════════════════════════════════════════════════════════
  // policy —— 节奏决策：能发多快
  //
  // 这些默认值全部来自改造前那批运营文档，而当时**代码里一条都没实现**，
  // 只写在 markdown 里靠人自觉。现在由 core/policy 强制，并在界面上可视。
  // 那批文档已随 P4.4 删除；每条规则的默认值、理由与**生效状态**
  // （硬强制 / 只提示 / 不生效）都记在 运营规则说明.md。
  // ═══════════════════════════════════════════════════════════
  policy: {
    // ── 总量与轮次 ──
    /** 每日写操作上限 */
    dailyWriteQuota: 30,
    /** 每日轮次上限 */
    dailyRounds: 3,
    /** 单轮连续写操作上限，达到后强制冷却 */
    roundMaxWrites: 10,
    /** 单轮触顶后的强制冷却时长（秒）。原文档写的是 3-5 分钟，取中 */
    roundCooldownSec: 300,
    /**
     * 超过这个轮次后风控概率显著上升（原文档：第 3 轮起风控概率显著上升）。
     *
     * ⚠️ **不是硬拦截** —— 只在界面上弹一条"本日不建议继续"的黄条。
     * 原文档要求的是"第 3 轮遇风控即当日停写"，那个没有实现，理由见
     * 运营规则说明.md §2：是否"当日不再写"取决于账号状态与是否误伤，
     * 代码拿不到这些信息，硬拦会拦掉本来该继续的情况。
     * 设置页把这一项标为「只提示」，避免误以为它在拦。
     */
    riskEscalateAfterRounds: 2,

    // ── 风控熔断（§11）──
    /** 命中风控码后全局停止写操作的时长（分钟） */
    riskCooldownMin: 30,
    /** 触发熔断的风控错误码 */
    riskCodeStopList: [8, 2053],
    /** 连续失败断路器：窗口内失败次数达到阈值即暂停自动发布 */
    circuitBreaker: { windowMs: 600000, failThreshold: 3 },

    // ── 单轮内的细分上限 ──
    /** 同一作品单轮最多回复多少条 */
    maxPerVideoPerRound: 30,
    /** 同一用户单轮最多回复多少条（不同评论也算） */
    maxPerUidPerRound: 1,
    /** 连续这么多条都不匹配回复条件就停止本轮（避免无意义空转） */
    stopAfterConsecutiveSkips: 5,
  },

  // ═══════════════════════════════════════════════════════════
  // filters —— 内容决策：回不回、怎么回
  //
  // 决策树与词表都是从改造前那批运营文档抢救来的（完整说明见 运营规则说明.md §3 §4）。
  // 词表放这里（而非 prompt 文本里）是为了让
  // **发布前的自动校验**能用同一份数据 —— 见 D22 的"能结构化的就结构化"。
  // ═══════════════════════════════════════════════════════════
  filters: {
    /** 同一个 cid 只回复一次（一生一次，跨日跨轮生效） */
    skipReplied: true,
    /**
     * 跳过自己发的评论。
     * 评论区里我以作者身份发出的回复也会作为评论被拉回来，它们同样带 uid，
     * 不排掉就会被当成交互对象、甚至自己回复自己。
     * 判定依据是 videos.author_uid（由 `my` 命令写入），见 core/memory/videos.myUid()。
     */
    skipOwnComments: true,
    /** 跳过贴纸评论 */
    skipSticker: true,
    /** 跳过无意义水评 */
    skipWater: true,
    /**
     * 短评论判定为水评候选的长度上限（**含**）。
     * 默认 3，对应原文档的「长度 < 4 且无明确语义」。
     * 注意是"候选"：还要么命中 waterWords，要么没有任何优先信号，才会真的跳过。
     */
    waterCommentMaxLen: 3,
    /** 超过这个长度且提到具体细节 → 判定为高质量反馈，优先回复 */
    qualityFeedbackMinLen: 15,

    /** 回复长度约束。prefer 给模型看，hardMin/hardMax 是发布前的硬校验 */
    replyLength: { prefer: [8, 40], hardMin: 3, hardMax: 55 },
    /** 回复中 emoji 数量上限 */
    maxEmojiPerReply: 3,
    /** 回复最多几行（超过视为"过长段落"） */
    maxLines: 3,

    /** 优先回复的信号词。命中任一即进入文字回复路线 */
    prioritySignals: {
      askForHelp: ['怎么', '如何', '为什么', '哪里', '在哪', '求', '?', '？'],
      negativeEmotion: ['失望', '生气', '无语', '抱怨', '垃圾', '差评', '翻车', '骗'],
    },

    /** 水评词。长度 ≤ waterCommentMaxLen 且命中这些词 → 跳过 */
    waterWords: [
      '666', '哈哈', '哈哈哈', '嘿嘿', '来了', '前排', '沙发',
      '路过', '打卡', '+1', 'dd', '顶', '阅', '好', '嗯', '哦',
    ],

    /**
     * 社区调性词。从原文档抢救来的词表。
     *
     * ⚠️ 当前**没有任何生成或校验路径读取它** —— 改它不影响 AI 输出，
     * 也不影响发布校验。保留是因为内容本身有效，删了就找不回来。
     * 设置页把这一项标为「不生效」。理由见 运营规则说明.md §4。
     */
    toneWords: [
      '大佬', '学到了', '太强了', 'yyds', 'DNA动了',
      '狠狠共情了', '破防了', '真实', '谁懂', '绝了',
    ],

    /**
     * 禁止出现的措辞。**这是发布前硬校验用的机器可读清单**，
     * 同时经 {{FORBIDDEN_PHRASES}} 注入 prompt —— 单一来源，不会漂移。
     * 前 8 条是 AI 腔特征，后 3 条是敷衍表达 —— 都从原文档抢救而来。
     */
    /**
     * 合规红线类禁用措辞 —— 与上面那份"文风"清单**分开**存放，因为两者的性质不同：
     *
     *   文风清单（AI 腔、敷衍表达）  —— 影响像不像真人，命中只是"这条写得不好"
     *   合规清单（下面这份）        —— 影响账号安全，命中是"这条不能发"
     *
     * 界面上两者的措辞也应当不同，所以不合并成一个数组。
     *
     * 来源：原文档的「❌ 不承诺效果、不透露隐私、不攻击他人、不竞品贴脸
     * ❌ 不提具体收益、保证效果」。那批文档已随 P4.4 删除，这里是唯一的落点。
     *
     * 默认值只是**几个最典型的句式**，不是穷举 —— 合格的清单取决于你的实际场景。
     * 这一条建议只增不减：删掉等于放开对应的合规约束。
     */
    forbiddenClaims: [
      '保证收益', '保证效果', '稳赚不赔', '包你满意',
      '一定有效', '百分百', '绝对能', '保证能',
    ],

    forbiddenPhrases: [
      '值得注意的是',
      '综上所述',
      '总而言之',
      '总的来说',
      '从某种程度上说',
      '客观来说',
      '笔者认为',
      '感谢您的分享',
      '非常赞同您的观点',
      '不错',
      '很好',
      '学习了',
    ],

    /**
     * 禁止的结构性模式。用正则表达，供发布前校验。
     * 每条带一句说明，界面展示时直接用它，不必再维护一份文案。
     */
    forbiddenPatterns: [
      { name: '结构化列表', pattern: '(?:^|\\n)\\s*[1-9][.、)]\\s*\\S', hint: '不要用 1. 2. 3. 这种列表' },
      { name: '三段式', pattern: '首先[\\s\\S]{0,40}其次', hint: '不要写"首先…其次…最后…"' },
      { name: '完整 GitHub 链接', pattern: 'https?://(?:www\\.)?github\\.com/\\S+', hint: '直贴链接会被限流，改写成 owner/repo' },
      { name: '过长段落', pattern: '\\n[\\s\\S]*\\n[\\s\\S]*\\n', hint: '最多三行' },
      {
        // 来源：原文档的「完整的主谓宾长句（超过 30 字且无停顿）」。
        // 这条规则以前只以散文形式存在于策略 prompt 里 —— 模型"看到了"，
        // 但发布前没有任何校验能拦下它。
        // 只匹配连续中文：放宽到英文/数字会误伤 URL 与版本号。
        name: '长句无停顿',
        pattern: '[\\u4e00-\\u9fa5]{30,}',
        hint: '一句话超过 30 字不停顿，改短或加标点拆开',
      },
    ],

    /**
     * 纯表情评论的回复方式（原文档的表情映射表，见 运营规则说明.md §3）。
     *
     * match 里同时列出 Unicode 与抖音方括号两种形式：接口返回的表情有时是
     * 真实 Unicode 字符，有时就是 `[玫瑰]` 这样的文本（尤其用户从面板里选的表情），
     * 只认一种会漏掉一半情况。
     */
    emojiOnly: {
      enabled: true,
      map: [
        {
          match: ['❤️', '🌹', '😘', '💕', '[玫瑰]', '[爱心]', '[心]', '[亲吻]'],
          reply: ['🌹', '❤️'],
        },
        {
          match: ['👍', '💪', '🔥', '👏', '[赞]', '[强]', '[鼓掌]', '[火]'],
          reply: ['🤝', '💪'],
        },
        {
          match: ['😂', '🤣', '😄', '[笑哭]', '[呲牙]', '[大笑]'],
          reply: ['😄', '😂'],
        },
        {
          match: ['🎉', '🥳', '✨', '[庆祝]', '[撒花]'],
          reply: ['🎉', '❤️'],
        },
      ],
      /** 判断不出类型时的兜底候选 */
      pool: ['🌹', '🤝', '😊', '👍', '❤️', '🎉'],
    },
  },

  // ═══════════════════════════════════════════════════════════
  // ui —— 界面刷新（改造计划 §5.8 的「配置更新时间」）
  //
  // 每个页面隔多久**从本地 SQLite 重读一次**。两条纪律必须写在前面：
  //
  // 1. **只读本地库，永远不碰抖音。** 从抖音拉新数据受风控约束
  //    （读操作间隔 30-50 秒），只能由手动触发或将来的定时拉取（P5）负责。
  //    这里的秒数再小也不会产生任何网络请求。
  // 2. **0 = 不自动刷新。** 用户自己能按刷新按钮，关掉是合法选择。
  //
  // 为什么队列页没有对应键：队列状态是主进程**推**过来的
  // （`queue:changed`），倒计时也是本地每 500ms 重算的 —— 轮询它纯属浪费。
  // 加一个永远不会被读的键，就是这个项目一直在说的"看着能配、实际不生效"。
  //
  // ⚠️ 工作台默认 0（关）：那个页面有编辑区，定时重读会在用户正打字/正选
  // 评论时替换掉列表。别的页面是纯读的，替了就替了。
  // ═══════════════════════════════════════════════════════════
  ui: {
    refreshSec: {
      /** 运营对象列表 */
      targets: 30,
      /** 我的作品列表 */
      works: 30,
      /** 草稿箱 */
      drafts: 30,
      /** 数据分析页（一次全量聚合，比其他页重，所以慢一倍） */
      analytics: 60,
      /** 评论工作台。默认关 —— 见上面的说明 */
      workspace: 0,
    },
  },
};

/**
 * 敏感字段路径（点号分隔）。GUI 默认打码、导出配置时剔除。
 * account.email 是纯信息留存（改造计划 §11#10 确认保留），但它和密钥一样
 * 不该出现在截图、导出文件、诊断报告里，所以一并按敏感处理。
 */
const SENSITIVE_KEYS = ['llm.api_key', 'bridge.token', 'account.email'];

/**
 * describe() 给敏感字段用的打码文案。
 *
 * 单独提出来是因为它有一个**必须被挡住**的用法：界面拿到脱敏快照后，
 * 如果整份配置原样回写，这个占位符就会变成真的 api_key。所以 set() 里
 * 对敏感字段做了显式拒绝（见 looksRedacted）。格式改动时两处一起看。
 */
function redactedPlaceholder(value) {
  return `***已设置（${String(value).length} 字符）***`;
}

/** 判断一个值是不是 describe() 产出的打码文案（而不是用户真的想填这个） */
function looksRedacted(v) {
  return typeof v === 'string' && /^\*\*\*已设置（\d+ 字符）\*\*\*$/.test(v);
}

// ═══════════════════════════════════════════════════════════
// 内部状态
// ═══════════════════════════════════════════════════════════

/** 合并后的配置（含默认值） */
let _merged = null;
/** 用户配置原文（不含默认值），set() 时用于保留未知字段 */
let _raw = null;
/** 上次加载的校验告警 */
let _warnings = [];
/** 运行时覆盖片段（不落盘）。见 setRuntimeOverrides() */
let _runtimeOverrides = null;

// ═══════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 深拷贝（只处理纯对象/数组/原始值，配置项足够） */
function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
    return out;
  }
  return v;
}

/**
 * 深合并：把 src 覆盖到 base 上（数组整体替换，不做元素级合并）。
 * 返回新对象，不修改入参。
 */
function deepMerge(base, src) {
  const out = deepClone(base);
  if (!isPlainObject(src)) return out;
  for (const k of Object.keys(src)) {
    const sv = src[k];
    if (isPlainObject(sv) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], sv);
    } else if (sv !== undefined) {
      out[k] = deepClone(sv);
    }
  }
  return out;
}

/** 按点号路径取值 */
function getByPath(obj, dotPath) {
  if (!dotPath) return obj;
  return dotPath.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/** 按点号路径设值（就地修改 target） */
function setByPath(target, dotPath, value) {
  const keys = dotPath.split('.');
  let cur = target;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isPlainObject(cur[keys[i]])) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function isPositiveNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

// ═══════════════════════════════════════════════════════════
// 校验
// ═══════════════════════════════════════════════════════════

/**
 * 校验用户配置，非法项回退默认值并记录告警。
 * 不抛错 —— 配置问题不该让应用起不来。
 * @param {object} cfg - 深合并后的配置（会被就地修正）
 * @returns {Array<{key:string, message:string, fallback:any}>}
 */
function validate(cfg) {
  const warnings = [];
  const fail = (key, message, fallback) => {
    warnings.push({ key, message, fallback });
    setByPath(cfg, key, deepClone(fallback));
  };

  // app
  if (typeof getByPath(cfg, 'app.minimizeToTray') !== 'boolean') {
    fail('app.minimizeToTray', '需为布尔值', DEFAULTS.app.minimizeToTray);
  }

  // bridge
  // 注意端口 0 是合法的（表示由系统分配空闲端口），故下限为 0
  const port = getByPath(cfg, 'bridge.port');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail('bridge.port', `端口需为 0-65535 的整数（0 表示由系统分配），实际为 ${JSON.stringify(port)}`, DEFAULTS.bridge.port);
  }
  for (const k of ['pollIntervalSec', 'offlineAlertSec']) {
    const v = getByPath(cfg, `bridge.connectionWatch.${k}`);
    if (!isPositiveNumber(v)) {
      fail(`bridge.connectionWatch.${k}`, `需为正数，实际为 ${JSON.stringify(v)}`, DEFAULTS.bridge.connectionWatch[k]);
    }
  }
  const requestTimeout = getByPath(cfg, 'bridge.requestTimeout');
  if (!isPositiveNumber(requestTimeout)) {
    fail('bridge.requestTimeout', `需为正数，实际为 ${JSON.stringify(requestTimeout)}`, DEFAULTS.bridge.requestTimeout);
  }
  const maxBody = getByPath(cfg, 'bridge.maxBodySize');
  if (!Number.isInteger(maxBody) || maxBody <= 0) {
    fail('bridge.maxBodySize', `需为正整数，实际为 ${JSON.stringify(maxBody)}`, DEFAULTS.bridge.maxBodySize);
  }

  // llm
  const maxTokens = getByPath(cfg, 'llm.max_tokens');
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    fail('llm.max_tokens', `需为正整数，实际为 ${JSON.stringify(maxTokens)}`, DEFAULTS.llm.max_tokens);
  }
  for (const k of ['timeout_ms', 'max_retries']) {
    const v = getByPath(cfg, `llm.${k}`);
    if (!isPositiveNumber(v)) {
      fail(`llm.${k}`, `需为正数，实际为 ${JSON.stringify(v)}`, DEFAULTS.llm[k]);
    }
  }
  if (!getByPath(cfg, 'llm.base_url')) {
    fail('llm.base_url', '不能为空', DEFAULTS.llm.base_url);
  }

  // intervals：两个正整数组成的数组，顺序自动纠正
  for (const k of ['write', 'read', 'commentPage']) {
    const v = getByPath(cfg, `intervals.${k}`);
    const ok = Array.isArray(v) && v.length === 2 && v.every(isPositiveNumber);
    if (!ok) {
      fail(`intervals.${k}`, `需为 [最小秒数, 最大秒数] 两个正数，实际为 ${JSON.stringify(v)}`, DEFAULTS.intervals[k]);
    } else if (v[0] > v[1]) {
      setByPath(cfg, `intervals.${k}`, [v[1], v[0]]);
      warnings.push({
        key: `intervals.${k}`,
        message: `最小值大于最大值，已自动纠正为 [${v[1]}, ${v[0]}]`,
        fallback: [v[1], v[0]],
      });
    }
  }
  if (typeof getByPath(cfg, 'intervals.readEnforce') !== 'boolean') {
    fail('intervals.readEnforce', '需为布尔值', DEFAULTS.intervals.readEnforce);
  }

  // policy：全是正整数型的节奏参数
  for (const k of [
    'dailyWriteQuota', 'dailyRounds', 'roundMaxWrites', 'roundCooldownSec',
    'riskEscalateAfterRounds', 'riskCooldownMin',
    'maxPerVideoPerRound', 'maxPerUidPerRound', 'stopAfterConsecutiveSkips',
  ]) {
    const v = getByPath(cfg, `policy.${k}`);
    if (!Number.isInteger(v) || v < 0) {
      fail(`policy.${k}`, `需为不小于 0 的整数，实际为 ${JSON.stringify(v)}`, DEFAULTS.policy[k]);
    }
  }
  for (const k of ['windowMs', 'failThreshold']) {
    const v = getByPath(cfg, `policy.circuitBreaker.${k}`);
    if (!Number.isInteger(v) || v <= 0) {
      fail(`policy.circuitBreaker.${k}`, `需为正整数，实际为 ${JSON.stringify(v)}`, DEFAULTS.policy.circuitBreaker[k]);
    }
  }
  const stopCodes = getByPath(cfg, 'policy.riskCodeStopList');
  if (!Array.isArray(stopCodes) || stopCodes.some(x => !Number.isInteger(x))) {
    fail('policy.riskCodeStopList', `需为整数数组，实际为 ${JSON.stringify(stopCodes)}`, DEFAULTS.policy.riskCodeStopList);
  }

  // filters
  for (const k of ['skipReplied', 'skipSticker', 'skipWater']) {
    if (typeof getByPath(cfg, `filters.${k}`) !== 'boolean') {
      fail(`filters.${k}`, '需为布尔值', DEFAULTS.filters[k]);
    }
  }
  for (const k of ['waterCommentMaxLen', 'qualityFeedbackMinLen', 'maxEmojiPerReply', 'maxLines']) {
    const v = getByPath(cfg, `filters.${k}`);
    if (!Number.isInteger(v) || v < 0) {
      fail(`filters.${k}`, `需为不小于 0 的整数，实际为 ${JSON.stringify(v)}`, DEFAULTS.filters[k]);
    }
  }
  {
    const rl = getByPath(cfg, 'filters.replyLength');
    const preferOk = rl && Array.isArray(rl.prefer) && rl.prefer.length === 2 && rl.prefer.every(isPositiveNumber);
    const boundsOk = rl && Number.isInteger(rl.hardMin) && Number.isInteger(rl.hardMax) && rl.hardMin >= 0 && rl.hardMax >= rl.hardMin;
    if (!preferOk || !boundsOk) {
      fail(
        'filters.replyLength',
        `需为 { prefer:[最小,最大], hardMin, hardMax 且 hardMax>=hardMin }，实际为 ${JSON.stringify(rl)}`,
        DEFAULTS.filters.replyLength
      );
    }
  }
  for (const k of ['waterWords', 'toneWords', 'forbiddenPhrases', 'forbiddenClaims', 'forbiddenPatterns']) {
    if (!Array.isArray(getByPath(cfg, `filters.${k}`))) {
      fail(`filters.${k}`, `需为数组，实际为 ${JSON.stringify(getByPath(cfg, `filters.${k}`))}`, DEFAULTS.filters[k]);
    }
  }
  for (const k of ['askForHelp', 'negativeEmotion']) {
    if (!Array.isArray(getByPath(cfg, `filters.prioritySignals.${k}`))) {
      fail(`filters.prioritySignals.${k}`, '需为数组', DEFAULTS.filters.prioritySignals[k]);
    }
  }
  {
    const eo = getByPath(cfg, 'filters.emojiOnly');
    const ok = eo && typeof eo.enabled === 'boolean' && Array.isArray(eo.map)
      && Array.isArray(eo.pool) && eo.pool.length > 0;
    if (!ok) {
      fail('filters.emojiOnly', `需为 { enabled, map:[], pool:[] }，实际为 ${JSON.stringify(eo)}`, DEFAULTS.filters.emojiOnly);
    }
  }

  // account
  {
    for (const k of ['douyinId', 'githubOwner', 'email', 'roleProfile']) {
      const v = getByPath(cfg, `account.${k}`);
      if (typeof v !== 'string') {
        fail(`account.${k}`, `需为字符串，实际为 ${JSON.stringify(v)}`, DEFAULTS.account[k]);
      }
    }
  }

  // reply —— 回复来源
  {
    const m = getByPath(cfg, 'reply.mode');
    if (!REPLY_MODES.includes(m)) {
      fail('reply.mode', `需为 ${REPLY_MODES.join(' / ')} 之一，实际为 ${JSON.stringify(m)}`, DEFAULTS.reply.mode);
    }

    const ratio = getByPath(cfg, 'reply.hybrid.aiRatio');
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      fail('reply.hybrid.aiRatio', `需为 0-1 之间的数，实际为 ${JSON.stringify(ratio)}`, DEFAULTS.reply.hybrid.aiRatio);
    }
    if (typeof getByPath(cfg, 'reply.hybrid.fallbackToFixed') !== 'boolean') {
      fail('reply.hybrid.fallbackToFixed', '需为布尔值', DEFAULTS.reply.hybrid.fallbackToFixed);
    }

    const cycle = getByPath(cfg, 'reply.fixed.cycle');
    if (!CYCLE_NAMES.includes(cycle)) {
      fail('reply.fixed.cycle', `需为 ${CYCLE_NAMES.join(' / ')} 之一，实际为 ${JSON.stringify(cycle)}`, DEFAULTS.reply.fixed.cycle);
    }
    const gap = getByPath(cfg, 'reply.fixed.minGapBetweenReuse');
    if (!Number.isInteger(gap) || gap < 0) {
      fail('reply.fixed.minGapBetweenReuse', `需为不小于 0 的整数，实际为 ${JSON.stringify(gap)}`, DEFAULTS.reply.fixed.minGapBetweenReuse);
    }
    {
      // 条目逐条筛：单条写坏（比如少了 text）不该把整份列表退回空。
      // 不合格的条目丢掉并告警，其余的照常可用。
      const items = getByPath(cfg, 'reply.fixed.items');
      if (!Array.isArray(items)) {
        fail('reply.fixed.items', `需为数组，实际为 ${JSON.stringify(items)}`, DEFAULTS.reply.fixed.items);
      } else {
        const kept = [];
        const dropped = [];
        items.forEach((it, i) => {
          if (!isPlainObject(it)) { dropped.push(`#${i + 1} 不是对象`); return; }
          if (typeof it.text !== 'string' || !it.text.trim()) { dropped.push(`#${i + 1} 缺少 text`); return; }
          if (it.weight !== undefined && !(typeof it.weight === 'number' && Number.isFinite(it.weight) && it.weight >= 0)) {
            dropped.push(`#${i + 1} weight 需为不小于 0 的数`);
            return;
          }
          if (it.enabled !== undefined && typeof it.enabled !== 'boolean') {
            dropped.push(`#${i + 1} enabled 需为布尔值`);
            return;
          }
          kept.push({
            text: it.text,
            weight: it.weight === undefined ? 1 : it.weight,
            enabled: it.enabled === undefined ? true : it.enabled,
          });
        });
        if (dropped.length) {
          warnings.push({
            key: 'reply.fixed.items',
            message: `有 ${dropped.length} 条固定回复被忽略：${dropped.slice(0, 3).join('；')}${dropped.length > 3 ? ' …' : ''}`,
            fallback: kept,
          });
          setByPath(cfg, 'reply.fixed.items', kept);
        }
      }
    }

    const imgMode = getByPath(cfg, 'reply.image.mode');
    if (!IMAGE_MODES.includes(imgMode)) {
      fail('reply.image.mode', `需为 ${IMAGE_MODES.join(' / ')} 之一，实际为 ${JSON.stringify(imgMode)}`, DEFAULTS.reply.image.mode);
    }
    if (typeof getByPath(cfg, 'reply.image.enabled') !== 'boolean') {
      fail('reply.image.enabled', '需为布尔值', DEFAULTS.reply.image.enabled);
    }
    if (typeof getByPath(cfg, 'reply.image.withText') !== 'boolean') {
      fail('reply.image.withText', '需为布尔值', DEFAULTS.reply.image.withText);
    }
    const imgRatio = getByPath(cfg, 'reply.image.ratio');
    if (typeof imgRatio !== 'number' || !Number.isFinite(imgRatio) || imgRatio < 0 || imgRatio > 1) {
      fail('reply.image.ratio', `需为 0-1 之间的数，实际为 ${JSON.stringify(imgRatio)}`, DEFAULTS.reply.image.ratio);
    }
    const pick = getByPath(cfg, 'reply.image.pick');
    if (!CYCLE_NAMES.includes(pick)) {
      fail('reply.image.pick', `需为 ${CYCLE_NAMES.join(' / ')} 之一，实际为 ${JSON.stringify(pick)}`, DEFAULTS.reply.image.pick);
    }
    for (const k of ['keywords', 'paths']) {
      const v = getByPath(cfg, `reply.image.${k}`);
      if (!Array.isArray(v)) {
        fail(`reply.image.${k}`, `需为字符串数组，实际为 ${JSON.stringify(v)}`, DEFAULTS.reply.image[k]);
        continue;
      }
      // 逐条筛而不是整份回退成空数组。
      // 改动前 `v.every(...)` 为假就 fail(...) → 整份被替换成 []，而且 config.set()
      // 会把这个空数组写进用户的 config.json —— 混进一个 null 就让配好的 20 张图
      // 全部消失，只有一条告警。这与 reply.fixed.items / personas.* 的容错语义
      // 也不一致（那两处都是逐条筛）。
      const kept = v.filter(x => typeof x === 'string' && x.trim());
      if (kept.length !== v.length) {
        warnings.push({
          key: `reply.image.${k}`,
          message: `有 ${v.length - kept.length} 项不是有效路径/关键词，已忽略（其余 ${kept.length} 项保留）`,
          fallback: kept,
        });
        setByPath(cfg, `reply.image.${k}`, kept);
      }
    }
  }

  // personas —— 逐条筛，坏的那条丢掉并告警，其余照常可用
  // （与 reply.fixed.items 同一套思路：一条写坏不该让整份列表失效）
  {
    const disabled = getByPath(cfg, 'personas.disabled');
    if (!Array.isArray(disabled) || disabled.some(x => typeof x !== 'string')) {
      fail('personas.disabled', `需为字符串数组，实际为 ${JSON.stringify(disabled)}`, DEFAULTS.personas.disabled);
    }

    for (const key of ['overrides', 'custom']) {
      const list = getByPath(cfg, `personas.${key}`);
      if (!Array.isArray(list)) {
        fail(`personas.${key}`, `需为数组，实际为 ${JSON.stringify(list)}`, DEFAULTS.personas[key]);
        continue;
      }
      const kept = [];
      const dropped = [];
      list.forEach((it, i) => {
        if (!isPlainObject(it)) { dropped.push(`#${i + 1} 不是对象`); return; }
        if (typeof it.id !== 'string' || !it.id.trim()) { dropped.push(`#${i + 1} 缺少 id`); return; }
        // custom 必须有 promptPrefix：没有它这个"人格"对模型来说什么都不表示
        if (key === 'custom' && (typeof it.promptPrefix !== 'string' || !it.promptPrefix.trim())) {
          dropped.push(`#${i + 1}（${it.id}）缺少 promptPrefix`);
          return;
        }
        if (it.weight !== undefined && !(Number.isFinite(it.weight) && it.weight >= 0)) {
          dropped.push(`#${i + 1}（${it.id}）weight 需为不小于 0 的数`);
          return;
        }
        if (it.temperature !== undefined && !(Number.isFinite(it.temperature) && it.temperature >= 0 && it.temperature <= 2)) {
          dropped.push(`#${i + 1}（${it.id}）temperature 需为 0-2 之间的数`);
          return;
        }
        if (it.emojiChance !== undefined && !(Number.isFinite(it.emojiChance) && it.emojiChance >= 0 && it.emojiChance <= 1)) {
          dropped.push(`#${i + 1}（${it.id}）emojiChance 需为 0-1 之间的数`);
          return;
        }
        // 下面这几个键**必须**查类型：applyOverride 是整体替换语义，
        // 一旦它们不是声明的类型，生成时会在 buildSystemPrompt / buildUserPrefix
        // 里抛 TypeError（forbiddenWords.join / examples.map），
        // 报错是 TypeError 而不是可读原因，配置层还一条告警都不给。
        if (it.name !== undefined && typeof it.name !== 'string') {
          dropped.push(`#${i + 1}（${it.id}）name 需为字符串`);
          return;
        }
        if (it.promptPrefix !== undefined && typeof it.promptPrefix !== 'string') {
          dropped.push(`#${i + 1}（${it.id}）promptPrefix 需为字符串`);
          return;
        }
        for (const arrKey of ['forbiddenWords', 'examples']) {
          const v = it[arrKey];
          if (v !== undefined && !(Array.isArray(v) && v.every(x => typeof x === 'string'))) {
            dropped.push(`#${i + 1}（${it.id}）${arrKey} 需为字符串数组`);
            return;
          }
        }
        const lr = it.lengthRange;
        if (lr !== undefined
          && !(Array.isArray(lr) && lr.length === 2 && lr.every(n => Number.isInteger(n) && n > 0) && lr[0] <= lr[1])) {
          dropped.push(`#${i + 1}（${it.id}）lengthRange 需为 [最小, 最大] 两个正整数`);
          return;
        }
        kept.push(it);
      });
      if (dropped.length) {
        warnings.push({
          key: `personas.${key}`,
          message: `有 ${dropped.length} 条人格设置被忽略：${dropped.slice(0, 3).join('；')}${dropped.length > 3 ? ' …' : ''}`,
          fallback: kept,
        });
        setByPath(cfg, `personas.${key}`, kept);
      }
    }

    // 停用清单里指向不存在的人格只是无效，不是错误 —— 用户可能先停用再删掉自定义人格。
    // 但重复项会让界面上出现两条同样的记录，去个重。
    const uniq = Array.isArray(disabled) ? [...new Set(disabled)] : DEFAULTS.personas.disabled;
    if (Array.isArray(disabled) && uniq.length !== disabled.length) {
      setByPath(cfg, 'personas.disabled', uniq);
    }
  }

  // multimodal
  const mode = getByPath(cfg, 'multimodal.mode');
  if (!['text-only', 'screenshots', 'video'].includes(mode)) {
    fail('multimodal.mode', `需为 text-only / screenshots / video 之一，实际为 ${JSON.stringify(mode)}`, DEFAULTS.multimodal.mode);
  }

  // ui.refreshSec —— 0 是合法的（表示不自动刷新），所以判的是"非负整数"
  for (const k of Object.keys(DEFAULTS.ui.refreshSec)) {
    const v = getByPath(cfg, `ui.refreshSec.${k}`);
    if (!Number.isInteger(v) || v < 0) {
      fail(`ui.refreshSec.${k}`, `需为不小于 0 的整数（秒，0 = 不自动刷新），实际为 ${JSON.stringify(v)}`, DEFAULTS.ui.refreshSec[k]);
    }
  }

  return warnings;
}

// ═══════════════════════════════════════════════════════════
// 读取
// ═══════════════════════════════════════════════════════════

/**
 * 从磁盘读取用户配置原文。
 * 文件不存在或内容为空 → 空对象（正常情况，不是错误）；
 * 内容非法 JSON / 非对象 → 空对象 + 一条 '(file)' 告警。
 * @returns {{raw:object, warning:object|null}}
 */
function readRaw() {
  const file = paths.configFile();
  try {
    if (!fs.existsSync(file)) return { raw: {}, warning: null };
    const text = fs.readFileSync(file, 'utf8').trim();
    if (!text) return { raw: {}, warning: null };
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      return {
        raw: {},
        warning: { key: '(file)', message: `config.json 顶层需为对象，实际为 ${Array.isArray(parsed) ? '数组' : typeof parsed}，已全部使用默认值`, fallback: null },
      };
    }
    return { raw: parsed, warning: null };
  } catch (e) {
    return {
      raw: {},
      warning: { key: '(file)', message: `config.json 解析失败，已全部使用默认值：${e.message}`, fallback: null },
    };
  }
}

/** 加载并缓存。首次调用或 reload() 时执行 */
function ensureLoaded() {
  if (_merged) return;
  const { raw, warning } = readRaw();
  _raw = raw;
  const merged = composeConfig(_raw);
  const warns = validate(merged);
  // 文件级告警放在最前，便于诊断页优先展示
  _warnings = warning ? [warning, ...warns] : warns;
  _merged = merged;
}

/**
 * 重新从磁盘加载配置。桌面设置页保存后、或外部改了 config.json 时调用。
 * @returns {object} 重新加载后的完整配置
 */
function reload() {
  _merged = null;
  ensureLoaded();
  return deepClone(_merged);
}

/**
 * 合成最终配置：内置默认 → 用户配置 → 运行时覆盖（**只填用户没显式设过的键**）。
 *
 * 最后那条限制是关键。运行时覆盖代表"当前形态下的合理默认"（桌面端把
 * readEnforce 打开），它只在用户没表态时生效 —— 一旦用户在设置页把这一项
 * 显式改成了别的值，那份值就写进了 _raw，**用户说了算**。
 *
 * 若让覆盖无脑压过用户配置，就会造出一个假开关：
 * 用户关掉它 → 下次启动又被改回来 → 设置项永远显示的是它想让你看到的那个值。
 *
 * @param {object} raw - 用户配置原文
 */
function composeConfig(raw) {
  const merged = deepMerge(DEFAULTS, raw);
  if (!_runtimeOverrides) return merged;

  const out = deepClone(merged);
  const walk = (node, prefix) => {
    for (const k of Object.keys(node)) {
      const p = prefix ? `${prefix}.${k}` : k;
      const v = node[k];
      if (isPlainObject(v)) { walk(v, p); continue; }
      // 用户显式写过这个路径 → 尊重用户的值
      if (getByPath(raw, p) !== undefined) continue;
      setByPath(out, p, deepClone(v));
    }
  };
  walk(_runtimeOverrides, '');
  return out;
}

/**
 * 设置运行时覆盖：**只影响本进程的内存值，不写盘**。
 *
 * 用在"同一个配置项在 CLI 与桌面端该有不同的默认值"的场合。目前只有一个：
 *
 *   intervals.readEnforce —— 改造计划 §5.4 定的「CLI 下 false（保持交互式查询
 *   不卡 30 秒），桌面 GUI 下 true（GUI 里没有 agent 自觉遵守间隔，必须由代码兜住）」。
 *
 * 为什么不让主进程直接 config.set()：那会把值写进用户的 config.json。
 * 用户在设置页关掉它之后，下次启动又会被主进程改回来 —— 配置项就变成了假的。
 * 运行时覆盖不落盘，用户显式改过的那份始终说了算。
 *
 * @param {object|null} obj - 覆盖片段（深合并到内存配置之上），null 表示清除
 */
function setRuntimeOverrides(obj) {
  _runtimeOverrides = obj ? deepClone(obj) : null;
  _merged = null;   // 下次 get() 重新合并
  ensureLoaded();
  return deepClone(_merged);
}

/**
 * 取配置。
 * @param {string} [dotPath] - 点号路径，如 'llm.model'。省略则返回完整配置
 * @returns {*} 值的深拷贝
 */
function get(dotPath) {
  ensureLoaded();
  return deepClone(getByPath(_merged, dotPath));
}

/**
 * 取用户配置原文（不含默认值补齐项）。
 * 导出配置、或在设置页展示"用户显式改过什么"时用。
 */
function getRaw() {
  ensureLoaded();
  return deepClone(_raw);
}

/** 上次加载产生的校验告警 */
function getWarnings() {
  ensureLoaded();
  return _warnings.map(w => ({ ...w }));
}

// ═══════════════════════════════════════════════════════════
// 写入
// ═══════════════════════════════════════════════════════════

/**
 * 深合并写入用户配置并刷新内存。
 *
 * 只写用户配置原文（保留未知字段），不把默认值固化进文件 —— 这样默认值
 * 以后调整时老用户能自动享受新默认值。
 *
 * @param {object} patch - 要合并进去的配置片段，如 { llm: { model: 'x' } }
 * @returns {{config:object, warnings:Array}}
 */
function set(patch) {
  ensureLoaded();
  if (!isPlainObject(patch)) throw new TypeError('config.set(patch) 需要一个对象');

  // 拒绝把 describe() 的打码文案当真实值写回。
  //
  // 这条防护针对的是一个很容易踩中的场景：设置页加载脱敏快照 → 用户改了一个
  // 无关字段 → 保存时把整份配置回写 → api_key 变成 "***已设置（48 字符）***"。
  // 它不会报任何错，只会让所有 AI 调用在下一次失败，属于最难查的那类故障。
  for (const key of SENSITIVE_KEYS) {
    const v = getByPath(patch, key);
    if (looksRedacted(v)) {
      throw new Error(
        `拒绝写入 ${key}：这是一个打码后的占位符，不是真实值。` +
        '如果你确实要改它，请填写新的完整值；不想改就不要提交这个字段。'
      );
    }
  }

  const nextRaw = deepMerge(_raw, patch);
  // 用 composeConfig 而不是裸的深合并：合成规则只有一处，
  // 否则"保存后立刻生效的值"与"重启后加载的值"可能不是同一个
  const probe = composeConfig(nextRaw);
  const warnings = validate(probe);

  // 把校验修正回写到用户配置，保证落盘的文件里不含非法值。
  // 用户原始输入不丢 —— 通过返回值里的 warnings 告知调用方改了什么。
  for (const w of warnings) {
    if (w.key === '(file)') continue;
    setByPath(nextRaw, w.key, deepClone(w.fallback));
  }

  const file = paths.configFile();
  paths.ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(nextRaw, null, 2) + '\n');
  fs.renameSync(tmp, file);

  _raw = nextRaw;
  _merged = probe;
  _warnings = warnings;

  return { config: deepClone(_merged), warnings };
}

// ═══════════════════════════════════════════════════════════
// 诊断
// ═══════════════════════════════════════════════════════════

/**
 * 脱敏后的配置快照，供诊断页展示。
 * @returns {{file:string, exists:boolean, sensitiveKeys:string[], config:object, warnings:Array}}
 */
function describe() {
  ensureLoaded();
  const redacted = deepClone(_merged);
  for (const key of SENSITIVE_KEYS) {
    const v = getByPath(redacted, key);
    if (v) setByPath(redacted, key, redactedPlaceholder(v));
  }
  const file = paths.configFile();
  return {
    file,
    exists: fs.existsSync(file),
    sensitiveKeys: SENSITIVE_KEYS,
    config: redacted,
    // 设置页每项要显示"默认值是多少"、并提供逐项恢复默认，因此把默认值一并给出。
    // 敏感项的默认值都是空串，不会泄露任何东西。
    //
    // 注意这里给的是 **composeConfig({})**（= DEFAULTS 叠加运行时覆盖），
    // 而不是裸的 DEFAULTS。差别在「恢复默认」按钮上：
    // 桌面端用运行时覆盖把 intervals.readEnforce 打开，如果这里回 DEFAULTS 的 false，
    // 用户点一下「恢复默认」就会把那个键**显式写进** config.json，
    // 而"用户显式写过"会让运行时覆盖从此失效 —— 一次点错就永久关掉了读操作强制间隔，
    // 而界面上还显示"已恢复默认"。
    defaults: composeConfig({}),
    warnings: getWarnings(),
  };
}

/**
 * 列出所有合法的配置叶子路径（点号分隔），供界面做"只允许改已知项"的守卫。
 * @returns {string[]}
 */
function listLeafPaths() {
  const out = [];
  const walk = (node, prefix) => {
    if (isPlainObject(node)) {
      for (const k of Object.keys(node)) walk(node[k], prefix ? `${prefix}.${k}` : k);
      return;
    }
    if (prefix) out.push(prefix);
  };
  walk(DEFAULTS, '');
  return out;
}

/** 清空内存缓存（测试用） */
function reset() {
  _merged = null;
  _raw = null;
  _warnings = [];
  _runtimeOverrides = null;
}

module.exports = {
  DEFAULTS,
  SENSITIVE_KEYS,
  REPLY_MODES,
  IMAGE_MODES,
  get,
  getRaw,
  getWarnings,
  set,
  reload,
  setRuntimeOverrides,
  describe,
  listLeafPaths,
  reset,
  // 供测试与工具使用
  _internal: { deepMerge, deepClone, validate },
};
