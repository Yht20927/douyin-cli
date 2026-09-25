// app/renderer/src/settings/schema.js — 设置页的字段表
//
// 为什么是「数据表 + 通用渲染」而不是手写一堆 JSX
// ------------------------------------------------
// 需求(2) 要的是"尽可能多的人工可配置项"，config 里现有 60 多个叶子路径。
// 手写表单意味着每加一个配置项要改两处（core/config 一处、界面一处），
// 而改漏的那一侧不会报错，只会表现为"界面上找不到这一项"。
// 这里把「标签 / 说明 / 控件类型 / 分组」集中成一份数据，
// 由 fields.jsx 统一渲染，新增普通配置项只需要在 DEFAULTS 和这里各加一行。
//
// 这份表只描述**界面**（中文标签、提示文案、控件形态），所以它放在渲染层。
// 它不复制默认值也不复制校验规则 —— 那两样始终以 core/config 为准，
// 界面通过 config.describe() 拿到。
//
// 覆盖性由 tests/settings-schema.test.js 保证：DEFAULTS 里的每个叶子路径
// 要么出现在下面的 GROUPS 里，要么在 NOT_EXPOSED 里写明**为什么不暴露**。
// 两者都没有 = 测试失败，于是"新加了配置项但忘了做界面"会被当场发现。

/** 控件类型。fields.jsx 里每种对应一个渲染分支 */
export const T = {
  BOOL: 'bool',
  INT: 'int',
  TEXT: 'text',
  PASSWORD: 'password',
  TEXTAREA: 'textarea',
  ENUM: 'enum',
  /** [最小, 最大] 两个数 */
  RANGE2: 'range2',
  /** 字符串数组，一行一条 */
  STR_LIST: 'strList',
  /** 数字数组，一行一条 */
  INT_LIST: 'intList',
  /** 结构比较复杂、用 JSON 编辑（带实时解析校验） */
  JSON: 'json',
  /** 0–1 之间的小数（比例），界面用百分比输入 */
  RATIO: 'ratio',
  /** 以下三种是专用组件，不是通用控件 */
  FIXED_ITEMS: 'fixedItems',
  IMAGE_PATHS: 'imagePaths',
  RESET_CYCLE: 'resetCycle',
};

export const GROUPS = [
  // ═══════════════════════════════════════════════════════════
  {
    key: 'personas',
    label: '人格',
    desc: 'AI 生成回复时用的语气模板。内置 7 个，每个的参数、示例语料都可以改，也可以加自己的。',
    // 这一组不走通用字段渲染：它编辑的是「内置 + 覆盖 + 自定义」三份数据叠加出来的列表，
    // 不是几个孤立的配置项。见 PersonasField.jsx。
    component: 'personas',
    fields: [],
    // 专用组件改了哪些配置路径。必须显式列出 —— 覆盖性测试靠它知道这些路径
    // 已经有人负责了，否则会误报"加了配置项却没做界面"。
    covers: ['personas.disabled', 'personas.overrides', 'personas.custom'],
  },
  {
    key: 'prompts',
    label: '提示词',
    desc: '发给模型的模板原文。改这里等于改 AI 的行为，保存前会自动备份，随时可以恢复默认。',
    // 同上，这一组编辑的是磁盘上的模板文件，不是 config —— 所以它自带保存按钮，
    // 不参与页面底部的统一保存。见 PromptsField.jsx。
    component: 'prompts',
    fields: [],
    // 模板文件不在 config 里，所以没有要 "cover" 的路径
    covers: [],
  },

  // ═══════════════════════════════════════════════════════════
  {
    key: 'reply',
    label: '回复策略',
    desc: '回复从哪来：AI 生成、固定内容（含随机挑选），还是两者混用。'
      + '工作台里的「批量生成」用的是同一套设置 —— 想批量发随机内容，'
      + '就在「回复模式」选「固定内容」、下面的「循环方式」选「随机」。',
    fields: [
      {
        path: 'reply.mode',
        type: T.ENUM,
        label: '回复模式',
        options: [
          { value: 'ai', label: 'AI 生成' },
          { value: 'fixed', label: '固定内容' },
          { value: 'hybrid', label: '混合' },
        ],
        hint: '固定内容模式完全不调用 AI，零成本、秒出结果。',
      },
      {
        path: 'reply.hybrid.aiRatio',
        type: T.RATIO,
        label: '混合模式里 AI 的占比',
        hint: '0 = 全用固定内容，1 = 全用 AI。只在上面的模式选「混合」时生效。',
        showWhen: (cfg) => cfg['reply.mode'] === 'hybrid',
      },
      {
        path: 'reply.hybrid.fallbackToFixed',
        type: T.BOOL,
        label: 'AI 失败时降级到固定内容',
        hint: '关掉的话，AI 调用失败这条生成就整体失败。',
        showWhen: (cfg) => cfg['reply.mode'] === 'hybrid',
      },

      // ⚠️ 这一组（固定内容 / 循环方式 / 复用间隔）**不按模式隐藏**。
      //
      // 它们此前带 showWhen(mode !== 'ai')，而默认模式正是 ai ——
      // 于是绝大多数用户在设置页里根本看不到它们：想配"随机回复内容"，
      // 翻遍设置也找不到入口，只能得出"这个功能没做"的结论。
      // 功能的入口被自己的显示条件藏起来，比功能没做更难排查。
      //
      // 现在始终显示，只在当前模式确实用不到时**说清楚**（见 status/statusNote）。
      {
        path: 'reply.fixed.items',
        type: T.FIXED_ITEMS,
        label: '固定回复内容',
        hint: '一行一条。配合下面的「循环方式」使用 —— 选「随机」就是随机挑一条回复。'
          + '权重只在「加权」循环下生效，权重为 0 表示这条不参与抽取。',
        status: (cfg) => (cfg['reply.mode'] === 'ai' ? 'inactive' : null),
        statusNote: (cfg) => (cfg['reply.mode'] === 'ai'
          ? '当前回复模式是「AI 生成」，下面这些内容不会被读取。'
            + '要让它生效，把上面的「回复模式」改成「固定内容」或「混合」。'
          : null),
      },
      {
        path: 'reply.fixed.cycle',
        type: T.ENUM,
        label: '循环方式',
        options: [
          { value: 'sequential', label: '顺序（取完回到第一条）' },
          { value: 'random', label: '随机（可能连续重复）' },
          { value: 'shuffle-no-repeat', label: '洗牌不重复（用尽再洗）' },
          { value: 'weighted', label: '加权（按权重随机）' },
        ],
        hint: '进度会保存，重启应用后接着上次继续。选「随机」时每次从上面列表里随机挑一条。',
        status: (cfg) => (cfg['reply.mode'] === 'ai' ? 'inactive' : null),
        statusNote: (cfg) => (cfg['reply.mode'] === 'ai'
          ? '当前模式是「AI 生成」，这个循环方式不会被用到。'
          : null),
      },
      {
        path: 'reply.fixed.minGapBetweenReuse',
        type: T.INT,
        label: '同一句至少间隔几次才可复用',
        hint: '0 = 不限制。设成比条目总数还大时该限制会自动失效（否则会取不出内容）。',
        status: (cfg) => (cfg['reply.mode'] === 'ai' ? 'inactive' : null),
      },
      {
        path: 'reply.fixed.cursorReset',
        type: T.RESET_CYCLE, // 不是配置项，是操作按钮
        label: '循环进度',
      },

      { path: 'reply.image.enabled', type: T.BOOL, label: '回复时附带图片' },
      {
        path: 'reply.image.mode',
        type: T.ENUM,
        label: '什么时候带图',
        options: [
          { value: 'always', label: '每条都带' },
          { value: 'ratio', label: '按比例' },
          { value: 'keyword', label: '评论命中关键词才带' },
        ],
        showWhen: (cfg) => cfg['reply.image.enabled'] === true,
      },
      {
        path: 'reply.image.ratio',
        type: T.RATIO,
        label: '带图比例',
        showWhen: (cfg) => cfg['reply.image.enabled'] === true && cfg['reply.image.mode'] === 'ratio',
      },
      {
        path: 'reply.image.keywords',
        type: T.STR_LIST,
        label: '触发带图的关键词',
        hint: '评论里出现任一关键词就带图。',
        showWhen: (cfg) => cfg['reply.image.enabled'] === true && cfg['reply.image.mode'] === 'keyword',
      },
      {
        path: 'reply.image.paths',
        type: T.IMAGE_PATHS,
        label: '图片列表',
        hint: '只支持本地文件。支持 jpg / png / webp / gif / bmp / heic，单张上限 10MB。',
        showWhen: (cfg) => cfg['reply.image.enabled'] === true,
      },
      {
        path: 'reply.image.pick',
        type: T.ENUM,
        label: '多图选取方式',
        options: [
          { value: 'sequential', label: '顺序' },
          { value: 'random', label: '随机' },
          { value: 'shuffle-no-repeat', label: '洗牌不重复' },
          { value: 'weighted', label: '加权' },
        ],
        showWhen: (cfg) => cfg['reply.image.enabled'] === true,
      },
      {
        path: 'reply.image.withText',
        type: T.BOOL,
        label: '带图时也带文字',
        hint: '关掉就是只发图不写字。',
        showWhen: (cfg) => cfg['reply.image.enabled'] === true,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════
  {
    key: 'intervals',
    // advanced：技术性分组，默认收进「高级设置」，避免第一次进设置页被 60+ 项劝退
    advanced: true,
    label: '节奏间隔',
    desc: '两次操作之间至少要隔多久。写间隔是代码硬强制的，不受界面开关影响。',
    fields: [
      {
        path: 'intervals.write',
        type: T.RANGE2,
        label: '写操作间隔（秒）',
        hint: '发布、点赞、删除这类操作之间的随机等待区间。调太快会显著提高风控概率。',
      },
      {
        path: 'intervals.read',
        type: T.RANGE2,
        label: '读操作间隔（秒）',
        hint: '拉取评论、搜索这类操作之间的随机等待区间。',
      },
      {
        path: 'intervals.readEnforce',
        type: T.BOOL,
        label: '读操作也强制等待',
        hint: '关掉的话读操作只提示不阻塞（命令行下就是这样，避免每次查询都卡 30 秒）。',
      },
      {
        path: 'intervals.commentPage',
        type: T.RANGE2,
        label: '批量抓取逐条间隔（秒）',
        hint: '用在两处：全量拉取一个作品时翻下一页之间、以及「补全视频信息」时一个视频接一个视频之间。'
          + '这两件事都是点一次要连发几十上百个请求，全靠这一段等待把节奏拉开 —— 调小快但有风控风险，调大稳但耗时。',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════
  {
    key: 'policy',
    // advanced：技术性分组，默认收进「高级设置」，避免第一次进设置页被 60+ 项劝退
    advanced: true,
    label: '运营红线',
    desc: '这些是改造前只写在 markdown 里、靠自觉遵守的规则，现在由代码强制拦截。',
    fields: [
      { path: 'policy.dailyWriteQuota', type: T.INT, label: '每日写操作上限' },
      {
        path: 'policy.dailyRounds',
        type: T.INT,
        label: '每日轮次提示阈值',
        status: 'advisory',
        statusNote: '只提示、不拦截 —— 达到后界面上出现黄条「建议明天再继续」，但不会阻止你继续发。'
          + '真正管量的是上面的「每日写操作上限」与下一项的触顶冷却',
      },
      {
        path: 'policy.roundMaxWrites',
        type: T.INT,
        label: '单轮连续写操作上限',
        hint: '一轮 = 一批连续写操作：写满这个条数这一轮就结束，强制冷却（时长在下一项），'
          + '冷却后的第一条开启新一轮。中间隔多久不写都算同一轮。',
      },
      {
        path: 'policy.roundCooldownSec',
        type: T.INT,
        label: '单轮触顶后的冷却时长（秒）',
        hint: '它同时是「轮」的唯一边界：冷却结束后写下的第一条才算新一轮。设成 0 = 关闭单轮上限'
          + '（写满即可继续，不再强制休息）。',
      },
      {
        path: 'policy.riskEscalateAfterRounds',
        type: T.INT,
        label: '超过几轮后提示风控风险',
        status: 'advisory',
        statusNote: '只提示、不拦截 —— 触发时界面上出现黄条「本日不建议继续」，但不会阻止你继续发',
      },
      { path: 'policy.riskCooldownMin', type: T.INT, label: '命中风控后全局停写（分钟）' },
      { path: 'policy.circuitBreaker.failThreshold', type: T.INT, label: '连续失败几次后暂停发布' },
      { path: 'policy.circuitBreaker.windowMs', type: T.INT, label: '失败统计窗口（毫秒）' },
      // 下面两项的窗口是**今日**，不是"本轮" —— 口径曾经跟着"轮"的定义漂移，
      // 同一份数据能算出三种"本轮已回几条"（见 core/policy/rounds.js 文件头）。
      // 配置键名保留 maxPerXxxPerRound 以免重置你已设的值，标签以界面为准。
      { path: 'policy.maxPerVideoPerRound', type: T.INT, label: '单个作品每天最多回复几条' },
      { path: 'policy.maxPerUidPerRound', type: T.INT, label: '同一个用户每天最多回复几条' },
      {
        path: 'policy.stopAfterConsecutiveSkips',
        type: T.INT,
        label: '连续几条不匹配就停止本轮',
        status: 'inactive',
        statusNote: '当前不生效 —— 评论筛选不经过累计跳过的计数路径，这个数字在运行时恒为 0',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════
  {
    key: 'filters',
    // advanced：技术性分组，默认收进「高级设置」，避免第一次进设置页被 60+ 项劝退
    advanced: true,
    label: '评论筛选与措辞',
    desc: '哪些评论值得回，以及回复里不该出现的措辞。词表同时用于生成时的提示与发布前的硬校验。',
    fields: [
      { path: 'filters.skipReplied', type: T.BOOL, label: '同一条评论只回复一次' },
      {
        path: 'filters.skipOwnComments',
        type: T.BOOL,
        label: '跳过自己发的评论',
        hint: '我以作者身份发出的回复也会作为评论被拉回来，不排掉会自己回复自己。',
      },
      { path: 'filters.skipSticker', type: T.BOOL, label: '跳过贴纸评论' },
      { path: 'filters.skipWater', type: T.BOOL, label: '跳过水评' },
      { path: 'filters.waterCommentMaxLen', type: T.INT, label: '水评的长度上限（含）' },
      {
        path: 'filters.qualityFeedbackMinLen',
        type: T.INT,
        label: '高质量反馈的长度下限',
        hint: '超过这个长度且提到具体细节的评论会被优先回复。',
      },
      { path: 'filters.replyLength.prefer', type: T.RANGE2, label: '期望回复长度（字）' },
      { path: 'filters.replyLength.hardMin', type: T.INT, label: '回复最少几个字（硬校验）' },
      { path: 'filters.replyLength.hardMax', type: T.INT, label: '回复最多几个字（硬校验）' },
      { path: 'filters.maxEmojiPerReply', type: T.INT, label: '回复里最多几个 emoji' },
      { path: 'filters.maxLines', type: T.INT, label: '回复最多几行' },
      {
        path: 'filters.prioritySignals.askForHelp',
        type: T.STR_LIST,
        label: '提问求助的信号词',
        hint: '命中任一即进入文字回复路线（而不是跳过或只回表情）。',
      },
      {
        path: 'filters.prioritySignals.negativeEmotion',
        type: T.STR_LIST,
        label: '负面情绪的信号词',
      },
      { path: 'filters.waterWords', type: T.STR_LIST, label: '水评词表' },
      {
        path: 'filters.toneWords',
        type: T.STR_LIST,
        label: '鼓励使用的社区调性词',
        status: 'inactive',
        statusNote: '词表已就位，但当前没有任何生成或校验路径读取它 —— 改这里不会影响 AI 的输出，也不会影响发布校验',
      },
      {
        path: 'filters.forbiddenPhrases',
        type: T.STR_LIST,
        label: '禁止出现的措辞（文风类）',
        hint: '发布前硬校验，命中直接拦下。同时也是给 AI 的禁用词表。这一类命中只说明"这条写得不像真人"。',
      },
      {
        path: 'filters.forbiddenClaims',
        type: T.STR_LIST,
        label: '合规红线措辞（承诺/保证类）',
        hint: '⚠ 建议只增不减：删掉一条等于放开对应的合规约束。命中后发布会被直接拦下，'
          + '报的是「合规红线」而不是「禁用措辞」——因为处置方式不同，这类是"发出去有风险"。'
          + '默认只列了几个最典型的句式，合格的清单取决于你的实际场景。',
      },
      {
        path: 'filters.forbiddenPatterns',
        type: T.JSON,
        label: '禁止的结构性模式',
        hint: '正则。每条形如 {"name":"名称","pattern":"正则","hint":"提示"}。正则写错只会跳过该条，不会让校验崩掉。',
      },
      { path: 'filters.emojiOnly.enabled', type: T.BOOL, label: '纯表情评论只回表情' },
      {
        path: 'filters.emojiOnly.pool',
        type: T.STR_LIST,
        label: '兜底表情池',
        hint: '判断不出表情类型时从这里挑。',
      },
      {
        path: 'filters.emojiOnly.map',
        type: T.JSON,
        label: '表情映射表',
        hint: '形如 [{"match":["❤️","🌹"],"reply":["🌹","❤️"]}]。match 里建议同时写 Unicode 与抖音的方括号形式。',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════
  {
    key: 'account',
    label: '账号',
    desc: '账号身份信息。只有「角色定位」会影响生成结果，其余三项仅作记录 —— 每项下面都写明了。',
    fields: [
      {
        path: 'account.roleProfile',
        type: T.TEXTAREA,
        label: '角色定位（人设背景）',
        hint: '⚠ 会影响生成：非空时这段文字会注入 AI 的系统提示，决定它看问题的视角。留空则不加。',
      },
      {
        path: 'account.douyinId',
        type: T.TEXT,
        label: '抖音号',
        hint: '不影响任何行为，仅作记录（多账号时用来区分）。',
      },
      {
        path: 'account.githubOwner',
        type: T.TEXT,
        label: 'GitHub 用户名',
        hint: '不影响任何行为。原来供推广功能使用，那个功能已移除。',
      },
      {
        path: 'account.email',
        type: T.PASSWORD,
        label: '邮箱',
        hint: '不影响任何行为，仅作信息留存。按敏感字段处理：界面打码、不写进导出配置。留空表示不修改。',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════
  {
    key: 'llm',
    label: 'AI 模型',
    desc: 'AI 生成回复时用的模型服务。固定内容模式完全用不到这一组。',
    fields: [
      {
        path: 'llm.api_key',
        type: T.PASSWORD,
        label: 'API Key',
        // 判据只能读已落盘的那一份：cfg（草稿）里敏感字段一律被抹成空串，
        // 从没填过与填过了在输入框里长得一模一样。
        status: (cfg, saved) => (saved['llm.api_key'] ? null : 'unset'),
        statusNote: (cfg, saved) => (saved['llm.api_key'] ? null
          : cfg['reply.mode'] === 'fixed'
            ? '这里还没有 Key。当前「回复模式」是「固定内容」，生成用不到它；'
              + '哪天改成「AI 生成」或「混合」之前先把它填上。'
            : '这里还没有 Key —— 用到 AI 的回复模式（「AI 生成」「混合」）生成不了内容。'
              + '填一个 Key，或把上面的「回复模式」改成「固定内容」。'),
        hint: '留空表示不修改 —— 所以这一格也清不掉已设置的 Key（要换就填新的）。'
          + '已设置时显示为打码值，界面上不会回显真实内容。',
      },
      {
        path: 'llm.base_url',
        type: T.TEXT,
        label: '接口地址',
        hint: '含 anthropic.com 会自动切换到原生 Messages API；含 xiaomimimo.com 走 MiMo 分支。',
      },
      { path: 'llm.model', type: T.TEXT, label: '模型名' },
      { path: 'llm.max_tokens', type: T.INT, label: '单次生成的最大 token 数' },
      { path: 'llm.timeout_ms', type: T.INT, label: '超时（毫秒）' },
      { path: 'llm.max_retries', type: T.INT, label: '失败重试次数' },
    ],
  },

  // ═══════════════════════════════════════════════════════════
  {
    key: 'app',
    // advanced：技术性分组，默认收进「高级设置」，避免第一次进设置页被 60+ 项劝退
    advanced: true,
    label: '应用与桥接',
    desc: '桌面应用自身的行为。桥接相关的几项改完要重启应用才生效。',
    fields: [
      { path: 'app.minimizeToTray', type: T.BOOL, label: '关窗口时最小化到托盘' },
      {
        path: 'bridge.port',
        type: T.INT,
        label: '桥接服务端口',
        hint: '改完需要重启应用；油猴脚本里的地址也要跟着变，重装一次脚本即可。',
      },
      { path: 'bridge.host', type: T.TEXT, label: '桥接服务地址' },
      {
        path: 'bridge.connectionWatch.pollIntervalSec',
        type: T.INT,
        label: '连接健康检查间隔（秒）',
      },
      {
        path: 'bridge.connectionWatch.offlineAlertSec',
        type: T.INT,
        label: '多久没连接就提示离线（秒）',
      },
      {
        path: 'bridge.requestTimeout',
        type: T.INT,
        label: '单次请求超时（毫秒）',
      },
      {
        path: 'multimodal.mode',
        type: T.ENUM,
        label: '视频理解模式',
        options: [
          { value: 'text-only', label: '只看文字（推荐）' },
          { value: 'screenshots', label: '截图（需要本机 ffmpeg）' },
          { value: 'video', label: '视频（需要本机 ffmpeg）' },
        ],
        hint: '桌面版不内置 ffmpeg，缺依赖时会自动降级回「只看文字」。',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════
  {
    key: 'ui',
    label: '界面',
    desc: '各页面隔多久从本地数据库重读一次。只读本机数据，不会产生任何抖音请求。',
    fields: [
      {
        path: 'ui.refreshSec.targets',
        type: T.INT,
        label: '运营对象列表刷新间隔（秒）',
        hint: '0 = 不自动刷新，用页面上的「刷新」按钮手动刷。',
      },
      { path: 'ui.refreshSec.works', type: T.INT, label: '我的作品刷新间隔（秒）' },
      { path: 'ui.refreshSec.drafts', type: T.INT, label: '草稿箱刷新间隔（秒）' },
      {
        path: 'ui.refreshSec.analytics',
        type: T.INT,
        label: '数据页刷新间隔（秒）',
        hint: '这一页每次要全量扫一遍本地库，所以默认比别的页慢一倍。',
      },
      {
        path: 'ui.refreshSec.workspace',
        type: T.INT,
        label: '评论工作台刷新间隔（秒）',
        status: cfg => (Number(cfg['ui.refreshSec.workspace']) > 0 ? 'active' : 'inactive'),
        statusNote: cfg => (Number(cfg['ui.refreshSec.workspace']) > 0
          ? '开着时，每隔这么久重读一次评论列表 —— 如果你经常在别的终端跑命令，打开它能让列表自己跟上。'
          : '默认关闭：这个页面有编辑框，定时重读会在你正打字或正选评论时替换掉列表。要刷新点页面上的「刷新」。'),
      },
    ],
  },
];

/**
 * 刻意**不**放进界面的配置项，以及原因。
 *
 * 这份清单由 tests/settings-schema.test.js 强制核对：DEFAULTS 里新出现的叶子路径
 * 必须二选一（要么进 GROUPS，要么进这里），否则测试会失败。
 * 目的是逼着人回答"这个配置项用户能不能改"，而不是默认忘记。
 */
export const NOT_EXPOSED = {
  'bridge.token':
    '由应用生成并注入油猴脚本。手改会让脚本里的 token 与浏览器里已装的那份对不上，' +
    '表现为「明明连上了却一直认证失败」，而且没有任何提示。要换 token 请重装脚本（连接页有一键入口）。',
  'bridge.maxBodySize':
    '大响应上限，64MB 已经远超实际需要。调小会让搜索结果拉不回来，调大没有收益。',
  'policy.riskCodeStopList':
    '触发全局熔断的抖音错误码。改错（比如漏掉一个）会让风控熔断静默失效 —— ' +
    '这是安全相关的一组数字，要改请直接编辑 config.json 并自行确认。',
};
