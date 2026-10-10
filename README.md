# 🎵 Douyin Comment CLI

[![test](https://github.com/Yht20927/douyin-cli/actions/workflows/test.yml/badge.svg)](https://github.com/Yht20927/douyin-cli/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> 适用版本: v4 · 最后更新: 2026-08-27 · 维护者: Yht20927

> 抖音评论运营 CLI 工具。基于 Bridge Framework（Bridge Server + 油猴脚本），支持视频搜索、评论获取、**AI 人格化回复**、**ReplyEngine 独立生成**、**草稿管理**、运营仪表盘。

核心亮点：**ReplyEngine 评论生成引擎**（generateComment / generateReply / generateReplies）+ **A-F 六类回复策略** + **Anthropic & OpenAI 双 Provider 支持** + **Token 用量追踪**，让代管自有账号的评论运营全流程自动化。

---

## 🌐 同系列项目（Bridge Framework 全家桶）

同一套 Bridge Server + 油猴脚本架构的姊妹项目，欢迎 Star 与交流：

| 项目 | 一句话简介 |
|------|-----------|
| [BossZhipin-cli](https://github.com/Yht20927/BossZhipin-cli) | BOSS 直聘命令行工具：搜索职位、智能匹配评分、LLM 批量打招呼 |
| [xiaohongshu-cli](https://github.com/Yht20927/xiaohongshu-cli) | 小红书评论 CLI：笔记搜索、评论获取、AI 人格化回复、行为模拟 |
| [douyin-living](https://github.com/Yht20927/douyin-living) | 抖音直播全自动录制 + AI 智能切片系统（录制 → 弹幕 → 语音识别 → 高光剪辑） |
| [tiktok-cli](https://github.com/Yht20927/tiktok-cli) | TikTok 评论 CLI：视频搜索、评论获取、AI 回复（参考 douyin-cli 架构） |
| [ths-cli](https://github.com/Yht20927/ths-cli) | 同花顺行情命令行工具：实时行情、K 线、多因子技术分析 |

---

## ✨ 核心功能

| 功能 | 说明 |
|------|------|
| 🔍 视频搜索 | 关键词搜索视频 |
| 💬 评论获取 | 获取评论及嵌套回复，`--new` 增量拉取 |
| 🖼️ **图片评论** | 发表带图评论/回复（ImageX 上传链路，`--image` 可多张） |
| 🧠 **ReplyEngine** | 独立评论生成引擎，3 种模式 + 人格绑定 + 上下文隔离 |
| 🤖 **AI 人格化回复** | 7 种人格自动轮换，A-F 六类回复策略，避免"AI 味" |
| 📝 **草稿管理** | 回复草稿 save/list/show/post/delete 完整生命周期 |
| 🎭 **行为模拟** | 模拟真实浏览（搜索→看视频→点赞），穿插在发布流程中 |
| ⏱️ **随机延迟** | 发布间隔 40-55s 随机 + 疲劳累加，模拟真人节奏 |
| 🎲 **请求参数随机化** | browser_version 动态获取、paste_edit_method / enter_from 随机切换 |
| 🛡️ 风控断路器 | 10 分钟内 post 失败 ≥3 次自动暂停 |
| 📥 视频下载 | 下载视频+音频（BGM），支持 ffmpeg 截图多模态分析 |
| 📊 运营仪表盘 | 本地 HTML 可视化，含推广活动卡片 |
| 💾 持久化记忆 | SQLite schema v8（events / users / videos / comments / corpus / failures / campaigns / llm_usage / drafts） |

---

## 🖼️ 图片评论

发表带图评论或回复。`--image` 可重复，也可用逗号分隔一次传多张：

```bash
# 图片评论
node cli.js post <aweme_id> "这个封面做得真好" --image cover.jpg

# 图片回复（回复某条评论）
node cli.js post <aweme_id> "看下我的版本" --reply-to <cid> --image v1.png

# 多张
node cli.js post <aweme_id> "对比一下" --image a.jpg,b.jpg,c.jpg

# 只上传不发（拿 uri 复用 / 调试）
node cli.js upload-image --image cover.jpg
```

**上传链路**（`scripts/douyin.user.js` 内实现，CLI 只负责递数据）：

| 步骤 | 接口 | 说明 |
|------|------|------|
| 1 | `GET /aweme/v1/web/comment/upload/auth/` | 取 ImageX STS 临时凭证（`service_id` / `upload_domain` / 密钥） |
| 2 | `GET imagex.bytedanceapi.com/?Action=ApplyImageUpload` | AWS SigV4 签名，换上传地址 + `StoreUri` |
| 3 | `PUT https://<UploadHost>/<StoreUri>` | 传字节，带 `Content-CRC32` 与 `X-Storage-U` |
| 4 | `POST ?Action=CommitImageUpload` | 提交，返回 `ImageUri` / 宽 / 高 / 格式 |
| 5 | `POST /aweme/v1/web/comment/publish/` | 文本 + `image_uri_list` / `image_formats` / `image_widths` / `image_heights` |

要点与限制：

- **格式**：`jpg` / `jpeg` / `png` / `webp` / `gif` / `bmp` / `heic`（按扩展名校验），单张上限 10MB，超过 4MB 建议先压缩
- **签名**：全链路在浏览器页面上下文完成，`crypto.subtle` 做 SHA-256 / HMAC；签名算法对齐抖音前端内置的 ImageX SDK（region `cn-north-1`、service `imagex`）
- **base64 分块递送**：图片按 512KB 分片经 Bridge 送进页面缓冲，避免单条 eval 表达式塞进数 MB 字符串
- **结果自检**：发布后用服务端回包的 `image_list` 校验图片张数，不符会在结果里给出 `warning`
- **功能可用性**：图片评论是抖音灰度的能力，账号/视频未开放时接口会拒绝；若发布结果出现 `image_count: 0` 警告，说明图片没挂上

---

## 🚀 快速开始

```bash
npm install

# 1. 复制配置
cp config.example.json config.json
# 编辑 config.json：填入 bridge.token 和 llm.api_key
# 支持 OpenAI 兼容 API 和 Anthropic 原生 Messages API（自动检测切换）

# 2. 启动 Bridge Server
node server.js

# 3. Chrome 安装油猴脚本 scripts/douyin.user.js
#    ⚠️ Chrome 用户：需先在 Tampermonkey 中启用"允许访问文件网址"
#    详见下方「疑难排解」→ Chrome 连接问题
#    打开 douyin.com 并登录

# 4. 验证连接
node cli.js my

# 5. 开始使用
node cli.js search "关键词"
node cli.js get <aweme_id> --pages 1 --count 5
node cli.js suggest <aweme_id> --auto
node cli.js getReply <aweme_id> --batch
```

---

## 👥 多账号（多号同时驱动）

同一套 Bridge 可同时驱动多个抖音账号（一个浏览器容器/窗口登录一个号）。

**核心规则**：

- 一条连接 = 一个「站点 + 登录账号」，服务端按通道 `site#uid` 区分；**未登录的标签页不接入**。
- **公共读操作**（`get` / `search` / `user` …）未指定账号时按账号**轮换**，且**同一条命令内钉扎在同一账号**（避免分页 cursor 跨号错乱）。
- **写操作**（`post` / `like` / `delete-comment` / `dm send` …）与**读取自身数据**（`my` / `dm list`）在**多账号下必须 `--account` 显式指定**，绝不静默改投；指定了未知账号会直接报错并列出可用账号。
- `log` / `events` / `profile` / `dashboard` 的 `--account` 是**过滤条件**，账号离线也能查历史（不参与路由）。

```bash
# 列出在线账号（uid / 别名 / 昵称 / 最近服务时间）
node cli.js accounts

# 给账号起个好记的别名（之后 --account 可用别名）
node cli.js accounts alias <uid> 主号

# 指定账号（读：只落该号；写/自身数据：多号时必填）
node cli.js my --account 主号
node cli.js post <aweme_id> "内容" --account 主号

# 本地记忆按账号过滤（不用 --account = 全部账号）
node cli.js log --account 主号
node cli.js events --account 主号
```

**数据归属**：`events` / `videos` / `drafts` / `campaigns` 记 `account`，可回答「这件事是哪个号做的」；平台内容表（`comments` / `users` / `reply_corpus`）**全局共享**（刻意设计：两个自己的号去回同一条评论是明显的异常信号）。

**脚本版本**：油猴脚本会向服务端上报 `clientVersion`；脚本落后于当前注册契约时，`accounts` 与横幅会打 ⚠ 提示去 Tampermonkey 重装 `scripts/douyin.user.js`。

> 设计细节与后续计划见 [`docs/multi-account-roadmap.md`](./docs/multi-account-roadmap.md)。

---

## 🧠 ReplyEngine 评论生成引擎

独立于 suggest 命令的新一代评论生成系统，支持三种模式：

```bash
# 评论模式：以普通用户身份生成视频的顶级评论
node cli.js getReply <aweme_id>
node cli.js getReply <aweme_id> --count 3           # 多条候选
node cli.js getReply <aweme_id> --persona casual_friend  # 指定人格

# 回复模式：以博主身份回复单条评论
node cli.js getReply <aweme_id> <cid>               # 自动加载视频上下文 + 用户画像
node cli.js getReply <aweme_id> <cid> --interactive  # 交互式审核（生成→编辑→发布）

# 批量模式：对视频下所有未回复评论批量生成回复
node cli.js getReply <aweme_id> --batch              # 自动跳过作者自评
```

**ReplyEngine 架构**：
- **人格绑定**（persona-binder）：同视频复用人格，第 8 条自动换风格，microAdjust 微调温度
- **上下文隔离**（context-scope）：L1 本视频语料 → L2 全局成功语料 → L3 失败模式避雷
- **多模态**（video-context）：支持 text-only / screenshots（ffmpeg 取帧）/ video 三种模式
- **A-F 回复策略**：提问型 / 赞美型 / 讨论型 / 简短型 / 批评质疑型 / 艾特型

---

## 🤖 AI 人格化回复

**7 种内置人格自动轮换**，每条评论风格不同：

| 人格 | 特征 | 示例 |
|------|------|------|
| casual 朋友 | 口语短句，1-2 个 emoji | "哈哈哈这也太真实了😂" |
| 好奇提问型 | 以问句为主，真诚追问 | "这个是在哪里买的呀？" |
| 经验分享型 | "我之前也..." | "我之前试过，确实不错" |
| 热情追捧型 | 感叹号+emoji，情绪化 | "啊啊啊这个绝了！！" |
| 温和探讨型 | "我觉得..."委婉补充 | "说得挺有道理的，不过..." |
| 轻松幽默型 | 玩梗、自嘲、夸张 | "我的手：我会了 我的脑：不你不会" |
| 简短反应型 | 极简，3-15 字 | "真实👍" "马住了" |

使用：
```bash
# 生成建议（不发布，看风格）
node cli.js suggest <aweme_id>

# 自动发布（人格轮换 + 随机延迟 + 浏览穿插）
node cli.js suggest <aweme_id> --auto

# ReplyEngine 单条回复（自动绑定人格 + 用户画像注入）
node cli.js getReply <aweme_id> <cid>
```

---

## 🎭 行为模拟（browse）

模拟真实用户浏览行为，解决"只发不看"的账户不对称检测：

```bash
# 随机搜索热门词 → 看 1-2 个视频 → 偶尔点赞评论
node cli.js browse --max-notes 2 --like-chance 0.2

# 指定关键词浏览
node cli.js browse 穿搭 美食 --max-notes 3
```

`suggest --auto` 已内置 browse 穿插：**每发约 5 条评论自动穿插一次浏览+点赞**。

---

## 🎲 请求参数随机化

抖音油猴脚本内置多项请求参数随机化：

| 参数 | 随机化策略 |
|------|-----------|
| `browser_version` | 动态读取 `navigator.userAgent`（非硬编码） |
| `paste_edit_method` | 90% `non_paste` / 10% `paste` |
| `enter_from` | 85% `others_homepage` / 15% `search_result` |
| `previous_page` | 85% `others_homepage` / 15% `homepage` |

---

## 📋 命令清单

### 核心操作

| 命令 | 用途 | 示例 |
|------|------|------|
| `my` | 我的作品列表 | `node cli.js my` |
| `user` | 查看用户作品信息 | `node cli.js user <sec_user_id\|主页URL>` |
| `search` | 搜索视频 | `node cli.js search "关键词" --count 5` |
| `get` | 获取评论 | `node cli.js get <id> --pages 1 --count 5` |
| `replies` | 获取回复列表 | `node cli.js replies <cid> <aweme_id>` |
| `post` | 发表评论/回复 | `node cli.js post <id> "内容" --reply-to <cid>` |
| `post --image` | 发表图片评论/回复 | `node cli.js post <id> "内容" --image cover.jpg` |
| `upload-image` | 仅上传图片取 uri（不发评论） | `node cli.js upload-image --image cover.jpg` |
| `like` | 点赞视频 | `node cli.js like <id>` |
| `delete-comment` | 删除评论 | `node cli.js delete-comment <cid>` |
| `download` | 下载视频+音频 | `node cli.js download <id> [--audio-only]` |

### AI 与运营

| 命令 | 用途 | 示例 |
|------|------|------|
| `analyze` | AI 分析评论情感/优先级 | `node cli.js analyze <id>` |
| `suggest` | AI 回复建议 + 自动发布 | `node cli.js suggest <id> --auto` |
| `getReply` | **ReplyEngine 生成评论/回复** | `node cli.js getReply <id> [<cid>] [--batch]` |
| `draft` | **草稿管理** | `node cli.js draft <list\|save\|show\|post\|delete>` |
| `browse` | 模拟浏览行为 | `node cli.js browse --max-notes 2` |
| `dashboard` | 运营仪表盘 HTML | `node cli.js dashboard` |

### 反馈闭环（SQLite 记忆层）

| 命令 | 用途 |
|------|------|
| `replied` | 已回复 cid 列表 |
| `corpus search/recent/stats` | 回复语料库 |
| `failures` | 失败模式 top-N（避雷清单） |
| `dedup` | 查重护栏 |
| `whois` | 用户全量画像 |
| `note` | 用户标记（tier/tag/notes） |
| `comment` | **单条评论实体查询** |
| `profile` | 用户交互历史 |
| `events` | 原始事件流 |
| `log` | 操作日志 |

### 守卫与推广

| 命令 | 用途 |
|------|------|
| `preflight` | 节奏守卫自检 |
| `repo-info` | GitHub 仓库真实信息（推广事实源） |
| `factcheck` | 推广评论发布前事实校验 |
| `campaign` | 推广引擎（create/plan/run/stop/status） |
| `validate-prompts` | **校验提示词模板格式** |

### 其他

| 命令 | 用途 |
|------|------|
| `dm` | 私信发送/监听/列表 |
| `accounts` | 多账号：列出在线账号 / `accounts alias <uid> <别名>` |
| `cleanup` | 清理过期记忆（TTL） |

---

## ⚙️ 配置

`config.json`（从 `config.example.json` 复制）：

```json
{
  "bridge": {
    "host": "127.0.0.1",
    "port": 19422,
    "token": "your-bridge-token"
  },
  "llm": {
    "api_key": "sk-...",
    "base_url": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "max_tokens": 4096,
    "timeout_ms": 60000,
    "max_retries": 3
  },
  "vision": {
    "screenshot_count": 4,
    "screenshot_width": 1024
  }
}
```

**LLM Provider 自动检测**：
- `base_url` 含 `anthropic.com` → Anthropic 原生 Messages API
- `base_url` 含 `xiaomimimo.com` → MiMo API（api-key 头）
- 其他 → OpenAI 兼容格式（Bearer token）

环境变量（优先级更高）：
```bash
export OPENAI_API_KEY="sk-..."
export OPENAI_BASE_URL="https://..."
export OPENAI_MODEL="gpt-4o-mini"
```

---

## 🏗️ 架构

```
CLI (cli.js) → HTTP/WS → Bridge Server (:19422) → 油猴脚本 → 页面 fetch → 抖音 API
```

**签名安全**：油猴脚本在页面上下文执行，使用页面原生 `fetch`，自动携带真实 Cookie 和签名。

**核心模块**：
- `lib/reply-engine/` — ReplyEngine 评论生成引擎（5 模块）
- `lib/risk-control.js` — 请求节奏守卫（写操作硬强制，单一间隔源）
- `lib/jitter.js` — 节奏与拟人化延迟工具库
- `lib/personas.js` — 7 种人格模板池
- `lib/llm.js` — LLM 客户端（OpenAI + Anthropic 双 Provider，A-F 策略，Token 追踪）
- `lib/commands/browse.js` — 模拟浏览行为
- `lib/commands/campaign.js` — P4 推广引擎

---

## 🛡️ 节奏与拟人化设计

> 语义边界：这是 rate-limit pacing（请求节奏化）+ content humanization（内容拟人化），
> 服务于用户**自有账号**的代管运营，避免触发接口频控、维护账号健康。
> 它不是"逃避平台内容审核"——内容真实性与反刷量由 内容禁令 + corpus 去重 + factcheck 保证。

| 维度 | 对策 |
|------|------|
| **固定时间间隔** | 写操作 40-55s 硬强制（`risk-control` 守卫，读 config.json:intervals） |
| **AI 内容特征** | 7 种人格轮换 + A-F 六类回复策略 + AI 特征词黑名单 |
| **只发不看** | 每发 ~5 条穿插 browse 浏览+点赞 |
| **静态请求指纹** | browser_version 动态获取、paste_edit_method / enter_from 随机化 |
| **重复内容** | reply_corpus UNIQUE 去重 + LLM 重写 |
| **回复质量** | 禁止单字/单表情回复，最少 8 字，ReplyEngine 上下文隔离 |
| **高频失败** | 10 分钟窗口断路器（非累计值） |

---

## 📁 项目结构

```
douyin-cli/
├── cli.js                    # CLI 入口（命令路由 + help）
├── server.js                 # Bridge Server（WebSocket + HTTP /api/status）
├── config.example.json       # 配置模板（bridge + llm + vision）
├── CONTRIBUTING.md           # 贡献指南
├── SECURITY.md               # 安全策略
├── DISCLAIMER.md             # 免责声明
├── lib/
│   ├── commands/             # 命令模块（33 个命令，注册在 index.js）
│   │   ├── get/post/like/delete-comment.js    # 核心 CRUD
│   │   ├── upload-image.js                    # 仅上传图片取 uri（图片评论辅助）
│   │   ├── search/my/user/replies/download.js # 读取类
│   │   ├── analyze/suggest.js                 # LLM 分析与回复
│   │   ├── getReply.js                        # ReplyEngine 评论/回复生成
│   │   ├── draft.js                           # 草稿管理
│   │   ├── comment.js                         # 单条评论查询
│   │   ├── validatePrompts.js                 # 提示词模板校验
│   │   ├── browse.js                          # 模拟浏览行为
│   │   ├── campaign.js                        # P4 推广引擎
│   │   ├── preflight/repo-info/factcheck.js   # 节奏与事实守卫
│   │   ├── whois/note/events/log/profile.js   # 记忆层查询
│   │   ├── corpus/failures/dedup/replied.js   # 语料 / 失败 / 查重
│   │   └── dashboard/dm/cleanup.js
│   ├── reply-engine/         # ReplyEngine 评论生成引擎（v4 新增）
│   │   ├── index.js          # 主类（generateComment/generateReply/generateReplies）
│   │   ├── persona-binder.js # 人格绑定 + microAdjust
│   │   ├── context-scope.js  # 三层上下文隔离（L1/L2/L3）
│   │   ├── prompt-builder.js # 5 种 Prompt 模式组装器
│   │   └── video-context.js  # 视频上下文加载（含 ffmpeg 截图）
│   ├── memory/               # SQLite 持久化记忆层
│   │   ├── db.js             # 单例 + WAL + schema 迁移（v8）
│   │   ├── events/users/comments/videos.js
│   │   ├── corpus/failures/campaigns.js
│   │   ├── drafts.js         # 草稿管理（v4 新增）
│   │   └── llm-usage.js      # LLM Token 用量追踪（v4 新增）
│   ├── shared/               # 共享工具
│   │   ├── serialize.js / parseResponse.js / protocol.js
│   │   ├── sanitize.js       # 评论清洗 / 引号剥离 / HTML 转义
│   │   └── caseConvert.js    # camelCase → snake_case（v4 新增）
│   ├── client/               # Bridge 客户端
│   ├── server/               # WS Hub + Router + Registry
│   ├── comment-image.js      # 评论图片：校验 / 分块 / 经 Bridge 上传
│   ├── risk-control.js       # 请求节奏守卫 + 自适应风控
│   ├── llm.js                # LLM 客户端（OpenAI + Anthropic + Token 追踪）
│   ├── personas.js           # 7 种人格模板池
│   ├── jitter.js             # 节奏与拟人化延迟
│   ├── audit.js              # 审计日志（SQLite 双写）
│   └── dashboard.js          # HTML 仪表盘
├── prompts/                  # LLM Prompt 模板（用户可编辑，单一真源）
│   ├── analyze.md            # 评论分析 Prompt
│   ├── suggest.md            # 回复建议 Prompt
│   ├── comment.md            # 顶级评论生成 Prompt
│   ├── reply.md              # 单条回复 Prompt
│   ├── replies-batch.md      # 批量回复 Prompt
│   └── partial-*.md          # 跨模板共享策略块（A-F 策略等，validate-prompts 跳过）
├── scripts/
│   ├── douyin.user.js        # 油猴脚本（页面 fetch + 参数随机化）
│   ├── _template.user.js     # 新站点油猴模板
│   └── bridge.sh             # Bridge Server 生命周期管理
├── tests/                    # vitest（321 用例，24 文件）
│   ├── server/               # Router 三路分发 / WS 心跳测试
│   ├── shared/               # 共享工具测试
│   ├── reply-engine/         # ReplyEngine 测试（v4 新增）
│   ├── drafts.test.js        # 草稿测试（v4 新增）
│   └── caseConvert.test.js   # caseConvert 测试（v4 新增）
├── storage/                  # SQLite DB（gitignore）
└── logs/                     # 审计日志 + 结果文件（gitignore）
```

---

## 📦 依赖

- Node.js 18+
- `ws` — WebSocket
- `better-sqlite3` — SQLite
- Chrome + Tampermonkey + 油猴脚本
- LLM API key（OpenAI 兼容或 Anthropic 原生）

---

## 🔧 疑难排解

### Chrome 连接问题（Firefox 正常但 Chrome 无法连接）

**现象**：`node cli.js my` 报错 `Bridge Server 未启动` 或 `Request timeout`，但 Bridge Server 确实在运行，且 Firefox 浏览器连接正常。

**原因**：Chrome 的 Private Network Access（PNA）安全策略会阻止公网站点（`douyin.com`）访问本地地址（`127.0.0.1`）。油猴脚本通过 `GM_xmlhttpRequest` 绕过此限制，但需要 Tampermonkey 扩展获得相应权限。

**解决步骤**：

1. 在 Chrome 中打开 Tampermonkey 扩展，确保 **"允许访问文件网址"** 已开启：
   - 打开 `chrome://extensions/`
   - 找到 **Tampermonkey** → 点击 **详情**
   - 开启 ✅ **允许访问文件网址（Allow access to file URLs）**
   
   参考文档：https://www.tampermonkey.net/faq.php?q=Q209#Q209

2. 确保油猴脚本的 `@connect` 权限已授权：
   - 打开 Tampermonkey 管理面板 → 找到 **"Bridge: Douyin"** 脚本
   - 切换到 **设置** 标签 → **用户连接（User connections）**
   - 确认 `127.0.0.1` 和 `localhost` 均为 **允许（Allow）**

3. 刷新 `douyin.com` 页面，打开 F12 → Console，确认看到：
   ```
   [Bridge] ✓ Registered with Bridge Server
   ```

4. 验证连接：`node cli.js my`

### 其他常见问题

| 现象 | 可能原因 | 解决 |
|------|----------|------|
| `Unauthorized` | token 不匹配 | 检查 `config.json` 和油猴脚本中的 `token` 是否一致 |
| `抖音返回了 HTML 页面` | 登录态失效 | 刷新 `douyin.com` 并重新登录 |
| `Request timeout` | 浏览器未打开 douyin.com | 确保已打开并登录抖音 |
| 写操作频繁失败 | 触发风控 | 等待 30 分钟后再试，检查 `preflight` 状态 |
| `Request body too large`（服务端日志） | 搜索结果等响应超过请求体上限 | 默认上限 64MB（`config.json` → `bridge.maxBodySize`，单位字节），一般无需调整；若仍触发可调大后重启 `node server.js` |

---

## 🤝 贡献与安全

- 贡献指南、开发环境、代码约定见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- 安全策略、漏洞报告、密钥安全、授权边界见 [`SECURITY.md`](./SECURITY.md)
- 免责声明见 [`DISCLAIMER.md`](./DISCLAIMER.md)

---

## 📝 License

MIT
