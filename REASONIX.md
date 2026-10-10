# REASONIX.md — douyin-comment-cli (Bridge Framework v2)

> 适用版本: v4 · 最后更新: 2026-10-10 · 维护者: Yht20927

## Stack
- **Node.js** — vanilla, no framework
- **Bridge Framework** — 本地 WebSocket Server + 油猴脚本，替代 CDP
- **Tampermonkey** — 浏览器扩展，注入 `window.__bridge` API
- **Target platform**: 抖音 (Douyin) web，全浏览器支持

## Layout
- `cli.js` — 入口：命令路由、Bridge 通信、审计日志
- `server.js` — Bridge Server 入口（WebSocket + HTTP API）
- `lib/audit.js` — 审计日志模块（操作记录/结果持久化/增量查询）→ v3 起对 SQLite 双写
- `lib/dashboard.js` — HTML 仪表盘生成（Chart.js）
- `lib/llm.js` — OpenAI-compatible LLM 客户端（支持视觉/多模态）
- `lib/personas.js` — 7 种评论人格模板
- `lib/commands/` — CLI 命令模块（每个命令独立文件）
- `lib/memory/` — **v3 持久化记忆层**（SQLite 单例 / 事件流；P2 实体表 / P3 语料 / P4 campaigns 均已完成）
- `lib/risk-control.js` — **请求节奏守卫 + P4 自适应风控**（enforceDelay / adaptiveInterval / preflightPublish）
- `lib/commands/campaign.js` — **P4 推广引擎命令族**（create/plan/run[--daemon]/stop/pause/resume/status/list）
- `lib/dashboard.js` — HTML 仪表盘生成（Chart.js + P4 推广活动进度卡片）
- `lib/reply-engine/` — **多模态评论生成引擎**（视频上下文 / prompt 构建 / 截图提取）
  - `video-context.js` — 视频详情获取 + ffmpeg 截图 + base64 编码
  - `prompt-builder.js` — 模板加载 + prompt 组装 + 图片注入
- `prompts/` — **可编辑 prompt 模板**（suggest.md / analyze.md）
- `lib/server/` — Bridge Server 核心（registry / router / ws-hub）
- `lib/client/` — HTTP 客户端封装（CLI / SDK 共用）
- `lib/shared/` — 共享协议定义 + 序列化工具
- `storage/douyin.db` — **v3 SQLite 数据库**（WAL，gitignore）
- `config.json` — Bridge 连接 + LLM + 多模态配置
- `package.json` — 依赖：`ws` + `better-sqlite3`（v3）
- `scripts/douyin.user.js` — 油猴脚本（GM_xmlhttpRequest 绕过 PNA，注入 __bridge API）
- `scripts/_template.user.js` — 油猴脚本模板（新站点参考）
- `scripts/import-audit-v2.js` — **v3 历史回灌脚本**（logs/audit.json → events 表，幂等）
- `docs/v3-roadmap.md` — **v3 升级路线图**（P0-P5 逐阶段任务/schema/验收）
- `docs/multi-account-roadmap.md` — **多账号路线图**（channel 寻址 / 归属 / 准入 / 未提交变更索引）
- `scripts/smoke-accounts.js` — 多账号端到端冒烟（隔离 server + 假客户端，无需浏览器）
- `SKILL.md` — agent 操作手册
- `reply-strategy.md` — 自动回复策略模板

## 架构

```
node cli.js ──HTTP──→ Bridge Server (:19422) ──WebSocket──→ 油猴脚本（浏览器 Tab）
                       ↑ server.js (本项目)                   ↑ scripts/douyin.user.js
```

Bridge Server 代码已本地化（server.js + lib/server/ + lib/client/ + lib/shared/）。CLI 不再管理 daemon 生命周期，Bridge Server 独立启动，油猴脚本随页面自动注入建连。

## Commands

| 命令 | 用途 |
|------|------|
| `node cli.js search <kw> [--offset N] [--count N]` | 搜索视频 |
| `node cli.js get <id> [--pages N\|--all] [--depth N] [--count N] [--reply-limit N] [--new] [--since <ts>]` | 获取评论 |
| `node cli.js replies <cid> <aweme_id>` | 获取回复列表 |
| `node cli.js my [--count N]` | 我的作品 |
| `node cli.js user <sec_user_id\|主页URL> [--count N] [--cursor <ts>]` | 查看用户作品信息 |
| `node cli.js post <id> "<text>" [--reply-to <cid>] [--at <uid> <sec_uid>]` | 发表评论 |
| `node cli.js like <id> [--unlike]` | 点赞/取消点赞视频 |
| `node cli.js delete-comment <cid>` | 删除评论 |
| `node cli.js download <id> [--audio-only] [--out <dir>]` | 下载视频（含音频） |
| `node cli.js analyze <id> [--mode text-only|screenshots|video] [--screenshots N]` | LLM 分析评论（支持多模态视频理解） |
| `node cli.js suggest <id> [--auto] [--min-priority N] [--mode text-only|screenshots|video] [--screenshots N]` | LLM 回复建议（支持多模态视频理解） |
| `node cli.js dashboard [--video <id>] [--days N]` | 运营仪表盘 |
| `node cli.js log [--tail N] [--video <id>] [--failed]` | 操作日志 |
| `node cli.js profile <uid>` | 用户交互历史 |

## 前置条件
1. Bridge Server 运行中：`node server.js`（本目录）
2. 浏览器已安装 Tampermonkey + `scripts/douyin.user.js`
3. 浏览器已打开 `douyin.com` 任意页面并登录

## Watch out for
- **Bridge Server 必须先启动** — 否则所有命令报 `Bridge Server not running`。启动命令：`node server.js`
- **site key 为 `douyin.com`** — 与油猴脚本中的 `CONFIG.site` 一致
- **表达式必须带 `window.` 前缀** — 如 `window.__bridge.search(...)`（间接 eval 在全局作用域执行）
- **`status_code=8`** — 评论被风控拦截，换内容重试
- **回复评论有延迟** — 发布后可能 1-2 分钟才在 replies 中出现（comment.status 从 7 变为 1）
- **贴纸评论无法回复** — 纯贴纸/sticker 评论不支持文字回复
- **@ 提及语法** — `--at <uid> <sec_uid>`，文本中写 `@<uid>`（如 `@1179139456380456`），抖音自动渲染为昵称
- **点赞/取消点赞** — `type=1` 点赞，`type=0` 取消，同一接口 `/commit/item/digg/`
- **删除评论** — 只能删除自己的评论，接口 `/comment/delete?cid=`，POST 无 body
- **视频下载** — 通过 `/aweme/detail/` 获取视频详情，`play_addr` / `bit_rate` 提取视频 URL，`music.play_url` 提取 BGM；下载保存到 `./downloads/`（已 gitignore）
- **零 npm 依赖** — ~~安装后无需 `npm install`~~ → v3 起需 `npm install`（新增 `better-sqlite3`，原生模块需要预编译）

---

## 多账号（Multi-account）

一个浏览器容器/窗口 = 一个登录账号；服务端按 **channel = `site#uid`**（`lib/shared/protocol.js` `channelOf`）寻址。完整设计与进度见 `docs/multi-account-roadmap.md`。

### 不变量（改代码前必读）
- **未登录标签页不接入**：握手 `validateHello` 强校验 `account`，空则 400 `account_required` —— 身份不明的连接既不能承接写、也无法做护栏校验。
- **写 / 自身数据必须显式账号**：`cli.js` `isWriteInvocation` / `isIdentityScoped` 判定；多账号下缺 `--account` 直接拒绝（服务端再拦一次兜底）。读操作未指定 → 服务端按 `lastWriteAt` 轮换，且**同命令内钉扎**（`bridgeCall` 里 `currentAccount` 一旦确定就不再变，避免分页 cursor 跨号错乱）。
- **`--account` 双语义**：路由用（`get`/`post`/…）严格解析，未知账号**报错不回退**；本地查询用（`log`/`events`/`profile`/`dashboard`，见 `LOCAL_QUERY`）当**过滤条件**，允许离线历史账号。
- **字段必须穿过 `BridgeClient.call`**：`account`/`opType`/`noThrottle` 少解构一个就会静默退化成「未指定读操作」——曾踩过（`--account` 形同虚设 + 写护栏失效），`tests/bridge-client.test.js` 钉住透传。
- **`clientVersion` 契约**：改注册契约或改脚本语义时，同步升 `lib/commands/helpers.js` 的 `CLIENT_PROTOCOL_VERSION` 与 `scripts/douyin.user.js` 的 `CLIENT_VERSION`，否则旧脚本会被当新版静默用错（横幅/`accounts` 会打 ⚠ 提示重装）。
- **归属注入**：命令未指定 `account` 时，`AuditLogger.setAccount` 用本次实际服务账号兜底写 `events.account`（含读命令）。

### 归属 vs 共享
- **记 `account`**：`events` / `videos`(schema v10) / `drafts` / `campaigns`
- **全局共享（刻意不加 account）**：`comments` / `users` / `reply_corpus` —— 两个自己的号去回同一条评论是明显的异常信号

### 身份探测（油猴端）
- `_getMyUidStrict`：**只认接口** `/aweme/v1/web/query/user/` 顶层 `user_uid`；cookie/localStorage 兜底会串号，一律不用。
- `_getMyNickname` / `_getMySecUid`：零请求本地来源（`localStorage.user_info` / `__INITIAL_STATE__`），**必须与严格探测出的 uid 对齐**，不符宁可不要。
- `myPosts` 依赖 `_getMySecUid`，取不到直接报错（旧实现读 `info.user.sec_uid` 恒空 —— 那个接口只回顶层 `{id,user_uid,...}`）。

---

## 多模态评论生成（新增）

> 参考 xiaohongshu-cli 多模态架构重构，适配抖音视频场景。

### 三种模式

| 模式 | CLI flag | 说明 |
|------|----------|------|
| `text-only` | `--mode text-only` | 仅视频标题+点赞数+描述等文本信息（默认，向后兼容） |
| `screenshots` | `--mode screenshots` | 提取视频多帧截图 → base64 → 注入支持视觉的 LLM |
| `video` | `--mode video` | 传递视频 URL 给支持视频输入的 LLM |

**始终包含基本文本**：标题、作者、点赞/评论/播放统计、BGM、内容摘要。

### 配置（config.json）

```json
{
  "multimodal": {
    "mode": "text-only",
    "screenshotCount": 4,
    "autoScreenshotRatio": 0.7
  }
}
```

- `mode`：默认模式，CLI `--mode` 参数覆盖
- `screenshotCount`：截图数量（2-10）
- `autoScreenshotRatio`：`auto` 模式下使用 vision 的概率

### 截图提取流程

1. Bridge `getDetail` → 获取视频 URL
2. `ffprobe` 获取视频时长
3. `ffmpeg -vf fps=1/N` 均匀取帧（跳过首尾 1s）
4. 缩放至 1024 宽，JPEG q=5
5. 编码为 data:image/jpeg;base64 注入 LLM API
6. `DOUYIN_DISABLE_VISION=1` 可强制禁用视觉

### 文件结构

```
lib/reply-engine/
  video-context.js    — 视频详情 + ffmpeg 截图 + base64
  prompt-builder.js   — 模板加载 + prompt 组装 + 截图注入
prompts/
  suggest.md          — 回复建议模板（含视频上下文占位符）
  analyze.md          — 评论分析模板（含视频上下文占位符）
```

### 环境变量

| 变量 | 用途 |
|------|------|
| `DOUYIN_DISABLE_VISION=1` | 禁用所有视觉输入 |

### Watch out for
- **screenshots 模式依赖 ffmpeg** — 确保系统安装了 ffmpeg 和 ffprobe
- **截图是流式提取**（不下载完整视频），但 ffmpeg 仍会缓冲部分数据
- **截图缓存**：`.screenshots/` 目录临时存储截图，下次同名 aweme_id 会覆盖
- **模型必须支持视觉** — 如果使用不支持 vision 的模型（如 DeepSeek 纯文本版），screenshots/video 模式自动降级到 text-only

---

## v3 Memory Layer（P0–P4 已完成）

> 完整路线图见 `docs/v3-roadmap.md`。当前 schema **v10**。

### 设计要点
- **双写过渡**：所有 v2 命令仍旧写 `logs/audit.json`，AuditLogger 末尾旁路写入 SQLite `events` 表。SQLite 写失败不抛异常，audit.json 仍是真实之源。
- **存储**：`storage/douyin.db`（WAL 模式，多进程并发安全），`PRAGMA user_version` 管理 schema 版本。
- **自愈**：删除 `storage/` 后任意命令自动重建库 + 跑 schema 迁移到最新版本。
- **跨平台预留**：所有表带 `platform TEXT NOT NULL DEFAULT 'douyin'` 字段，未来与 xiaohongshu skill 共享 reply_corpus / users。

### 当前 schema（v10）
- `events` — 操作事件流（替代 audit.json 全表扫），v9 起带 `account`
- `users` / `comments` / `videos` — P2 实体表（`videos` v10 起带 `account` + `is_mine` 归属）
- `reply_corpus` / `failure_patterns` — P3 语料与避雷清单（文本匹配走 `md5(normalize(text))`）
- `campaigns` / `campaign_tasks` — P4 推广活动，v9 起带 `account`
- `drafts` — v9 起带 `account`

### 模块入口
- `lib/memory/db.js` — `getDb()` 单例 + WAL + 自动迁移
- `lib/memory/events.js` — `append() / query() / count() / findLastFetchTime()`
- `lib/memory/` 下 `users.js` / `videos.js` / `campaigns.js` / `drafts.js` 等实体模块
- `scripts/import-audit-v2.js` — 历史 audit.json → events 表，幂等

### Watch out for（v3）
- **schema 演进**：在 `lib/memory/db.js` 的 `migrations` 数组追加新版本，并把 `SCHEMA_VERSION` +1。每个 migration 必须幂等（用 `CREATE * IF NOT EXISTS`）。
- **better-sqlite3 跨平台**：Win/Mac/Linux 预编译包通常自动装上；如失败手动 `npm rebuild better-sqlite3`。
- **events 写入是只写不阻塞**：上层永远不应 `await` 它的副作用；查询路径如果走 SQL 失败应回退到 audit.json。
