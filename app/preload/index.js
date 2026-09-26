// app/preload/index.js — 渲染层可用的能力白名单
//
// 渲染层没有 Node 权限（contextIsolation 开、nodeIntegration 关），
// 只能通过这里经 contextBridge 暴露出去的方法与主进程通信。
// 原则：只暴露具体动作，不暴露 ipcRenderer 本身 —— 否则等于把整个 IPC 面开放出去。

const { contextBridge, ipcRenderer } = require('electron');

/** 订阅主进程推送；返回取消函数，组件卸载时必须调用，否则监听器会泄漏 */
function subscribe(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('dy', {
  /** 应用与运行环境信息（版本、数据目录、配置文件位置…） */
  info: () => ipcRenderer.invoke('app:info'),

  /** 用系统浏览器打开外链（会校验只允许 http/https） */
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  /** 退出应用 */
  quit: () => ipcRenderer.invoke('app:quit'),

  /** 当前账号：界面据此显示"现在在看哪个号"，多账号时用来切换 */
  account: {
    /** { ok, data: { uid, needsChoice, candidates, accounts[] } } */
    state: () => ipcRenderer.invoke('account:state'),
    /** 选定当前账号（多开时用）。传 null 清除选择，回到自动跟随 */
    set: (uid) => ipcRenderer.invoke('account:set', uid),
  },

  app: {
    /** 检查 GitHub 最新 release。{ok, hasUpdate, latest, current, url} 或 {ok:false, error} */
    checkUpdate: () => ipcRenderer.invoke('app:check-update'),
    /** 复制一段文本（诊断页的路径用）。排障第一件事就是把这些贴给别人 */
    copyText: (text) => ipcRenderer.invoke('app:copy-text', text),
    /** 在系统文件管理器里打开数据目录（数据库、配置都在里面） */
    openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
    /** 把本地数据库备份到用户选的位置 */
    backupData: () => ipcRenderer.invoke('data:backup'),
  },

  bridge: {
    /** 取当前状态（立即返回，不用等推送） */
    status: () => ipcRenderer.invoke('bridge:status'),
    /** 立即重新检测一次 */
    refresh: () => ipcRenderer.invoke('bridge:refresh'),
    /** 用系统浏览器打开一键安装地址（Tampermonkey 会弹安装页） */
    openUserscript: () => ipcRenderer.invoke('bridge:open-userscript'),
    /** 复制安装地址（浏览器里打开当兜底路径） */
    copyUserscriptUrl: () => ipcRenderer.invoke('bridge:copy-userscript-url'),
    /** 订阅状态变化，返回取消订阅函数 */
    onStatusChanged: (cb) => subscribe('bridge:status-changed', cb),
  },

  config: {
    /** 脱敏后的配置快照（api_key / token 已打码）+ 默认值（供逐项恢复默认） */
    describe: () => ipcRenderer.invoke('config:describe'),
    /**
     * 保存设置页改动。**只传改动过的字段**，不要整份回写 ——
     * 手里那份是脱敏的，整份回写会把 api_key 写成打码文案。
     * 主进程与 core/config 各有一道拦截，但传补丁才是正确用法。
     */
    set: (patch) => ipcRenderer.invoke('config:set', patch),
  },

  queue: {
    /** 任务列表 + 队列统计 + 策略统计（一次取全，避免界面出现不一致的组合） */
    state: () => ipcRenderer.invoke('queue:state'),
    /** 入队一个命令 */
    enqueue: (spec) => ipcRenderer.invoke('queue:enqueue', spec),
    /** 取消单个任务 */
    cancel: (id) => ipcRenderer.invoke('queue:cancel', id),
    /** 取消所有尚未开始的任务 */
    cancelPending: () => ipcRenderer.invoke('queue:cancel-pending'),
    /**
     * 取某个任务的完整结果（按需调用）。
     * 「生成回复」的产出就是一段文本，队列状态里只有摘要，拿不到正文。
     */
    result: (id) => ipcRenderer.invoke('queue:result', id),
    /** 订阅队列变化，返回取消订阅函数 */
    onChanged: (cb) => subscribe('queue:changed', cb),
  },

  policy: {
    /** 只取策略统计（配额/轮次/熔断），不拉任务列表 */
    stats: () => ipcRenderer.invoke('policy:stats'),
    /** 发布前预检：能不能发、为什么不能、还要等多久 */
    check: (meta) => ipcRenderer.invoke('policy:check', meta),
  },

  /** 本地数据读取。都是同步读 SQLite，不走队列也不碰抖音。 */
  data: {
    /** @param {{scope?: 'all'|'mine'}} [opts] 缺省 all */
    overview: (opts) => ipcRenderer.invoke('data:overview', opts),
    /** 我发的作品。注意这不是工作台的唯一入口了 —— 见 targets */
    videos: (limit) => ipcRenderer.invoke('data:videos', limit),
    /**
     * 运营对象：别人的视频里我互动过的评论区，按待回复/最近互动排序。
     * @param {{order?: 'pending'|'recent'|'comments', limit?: number}} [opts]
     */
    targets: (opts) => ipcRenderer.invoke('data:targets', opts),
    /**
     * 一批视频在本地库里的状态。返回 { [awemeId]: { inLibrary, mineOfCurrent, commentCount, … } }
     * @param {string[]} ids
     */
    targetStatus: (ids) => ipcRenderer.invoke('data:targetStatus', ids),
    video: (awemeId) => ipcRenderer.invoke('data:video', awemeId),
    videoStats: (awemeId) => ipcRenderer.invoke('data:videoStats', awemeId),
    comments: (awemeId, opts) => ipcRenderer.invoke('data:comments', awemeId, opts),
    comment: (cid) => ipcRenderer.invoke('data:comment', cid),
    /** 查重：这段文本以前发过没有（纯本地读，即时返回） */
    checkDup: (text) => ipcRenderer.invoke('data:checkDup', text),
    /** 最近的操作事件（诊断页用） */
    events: (opts) => ipcRenderer.invoke('data:events', opts),
    /** 清理预演：按 TTL 算"会删掉多少行"，不删 */
    cleanupPreview: (opts) => ipcRenderer.invoke('data:cleanupPreview', opts),
    /** 某个评论者的画像（whois 的视图版） */
    userProfile: (uid, opts) => ipcRenderer.invoke('data:userProfile', uid, opts),
    /** 某个用户的交互历史（profile 的视图版） */
    userEvents: (uid, opts) => ipcRenderer.invoke('data:userEvents', uid, opts),
    /** 评论列表可用的排序方式（由 core 提供） */
    commentOrders: () => ipcRenderer.invoke('data:commentOrders'),
    /**
     * 草稿箱列表。
     * @param {{q?: string}} [opts] q = 关键词（命中草稿正文 / 视频标题 / 被回复的评论原文）。
     *   搜索在 SQLite 里做，不是在已加载的那一页里过滤 —— 后者会把"没有命中"说成假话。
     */
    drafts: (opts) => ipcRenderer.invoke('data:drafts', opts),
    /**
     * 数据分析页的全量聚合（作品对比 / 每日评论 / 判定分布 / Top 榜）。
     * @param {{scope?: 'all'|'mine'}} [opts] 缺省 all
     */
    analytics: (opts) => ipcRenderer.invoke('data:analytics', opts),
  },

  /** 用户分级 / 标签 / 备注（本地写，不碰抖音） */
  user: {
    setNote: (uid, patch) => ipcRenderer.invoke('user:setNote', uid, patch),
  },

  draft: {
    save: (spec) => ipcRenderer.invoke('draft:save', spec),
    remove: (id) => ipcRenderer.invoke('draft:delete', id),
    /**
     * 批量删除（主进程限定在当前账号内）。
     * @param {number[]} ids
     * @returns data 为 `{ deleted, requested }` —— deleted 是**真正删掉的条数**，
     *   比 requested 小说明有些 id 已经不属于当前账号的草稿箱，界面要照实说。
     */
    removeMany: (ids) => ipcRenderer.invoke('draft:delete-many', ids),
    /**
     * 改草稿正文的**唯一**入口（主进程限定在当前账号内）。单条编辑也走这里，
     * ids 传一个 —— 旧做法是"存一条新的再删旧的"，id 和 created_at 都会变，
     * 而两步之间失败会留下两条内容相同的待发草稿。
     *
     * @param {number[]} ids
     * @param {{text?: string}|{find: string, replace?: string}} patch
     *   整批替换给 `text`；查找替换给 `find`＋`replace`（按字面量，不是正则）
     * @param {{dryRun?: boolean}} [opts] dryRun 只算不写，给确认框做预览
     * @returns data 为 `{ changed, requested, skipped, preview }` —— changed 是
     *   **真正改掉的条数**，skipped 按原因分类计数（已发出/不属于当前账号/
     *   已被别处删掉/改完是空的/本来就一样），preview 是逐条改后的正文（仅 dryRun）。
     *   条数与 requested 不等时界面要照实说动了哪些、没动哪些。
     */
    updateMany: (ids, patch, opts) => ipcRenderer.invoke('draft:update-many', ids, patch, opts),
    /** 发布成功后标记草稿已发布（否则它会一直留在草稿箱里） */
    markPosted: (id) => ipcRenderer.invoke('draft:mark-posted', id),
  },

  personas: {
    /** 生效人格（内置 + 覆盖 + 自定义 - 停用）、内置默认值、以及相关配置 */
    describe: () => ipcRenderer.invoke('personas:describe'),
  },

  prompts: {
    /** 模板清单：来自哪个目录、是否被覆盖、是不是 partial 片段 */
    list: () => ipcRenderer.invoke('prompts:list'),
    /** 读一个模板（同时带出内置原文，供"恢复默认"预览） */
    read: (name) => ipcRenderer.invoke('prompts:read', name),
    /** 保存（会自动备份上一版并清模板缓存，改完立即生效） */
    save: (name, text) => ipcRenderer.invoke('prompts:save', name, text),
    /** 完整格式校验（与 `validate-prompts` 命令同一份实现） */
    validate: (name) => ipcRenderer.invoke('prompts:validate', name),
    /** 恢复默认：删掉用户目录那份，回退到内置 */
    reset: (name) => ipcRenderer.invoke('prompts:reset', name),
    /** 历史备份（新→旧） */
    backups: (name) => ipcRenderer.invoke('prompts:backups', name),
    /** 从某个备份恢复 */
    restore: (name, file) => ipcRenderer.invoke('prompts:restore', name, file),
  },

  reply: {
    /** 当前回复来源模式（ai/fixed/hybrid）与固定内容、图片配置的可用情况 */
    describe: () => ipcRenderer.invoke('reply:describe'),
    /** 选图时的即时预检：文件是否存在、格式是否支持、是否超限 */
    checkImage: (p) => ipcRenderer.invoke('reply:check-image', p),
    /** 固定内容 / 图片的循环跑到第几条了 */
    cycleProgress: () => ipcRenderer.invoke('reply:cycle-progress'),
    /** 重置循环进度（只清状态文件，不动配置） */
    resetCycle: (section) => ipcRenderer.invoke('reply:reset-cycle', section),
  },

  /** 系统文件选择器。只返回路径，可用性由 reply.checkImage 判定。 */
  pickImages: () => ipcRenderer.invoke('dialog:pick-images'),
});
