# 🎵 Douyin Comment CLI

[![test](https://github.com/Yht20927/douyin-cli/actions/workflows/test.yml/badge.svg)](https://github.com/Yht20927/douyin-cli/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> 最后更新: 2026-09-18 · 维护者: Yht20927

> 抖音评论运营工具。基于 Bridge Framework（Bridge Server + 油猴脚本），
> 通过**你自己浏览器里已登录的抖音页面**执行操作。提供**桌面应用**（主推）与**命令行**两种用法，
> 共用同一套 `core/`。

核心亮点：**把运营规则从文档变成代码强制** —— 改造前 15 条红线只写在 markdown 里靠自觉遵守，
代码零实现；现在由 PolicyEngine 拦截，裸调命令行也跳不掉。
配套 **ReplyEngine 评论生成引擎**（三层上下文 + 人格绑定）+ **固定内容/AI 可切换的回复来源** +
**Anthropic & OpenAI 双 Provider 支持**。

> 每条运营规则的默认值、理由与**生效状态**（硬强制 / 只提示 / 不生效）见
> [`运营规则说明.md`](./运营规则说明.md)。

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
| 🖥️ **桌面应用** | Electron 界面：队列倒计时、发布二次确认（**发布永远由人点**）、任务可取消 |
| 🔍 视频搜索 / 💬 评论获取 | 含嵌套回复，`--new` 增量拉取 |
| 🖼️ **图片评论** | 发表带图评论/回复（ImageX 上传链路，`--image` 可多张） |
| 🧠 **ReplyEngine** | 独立评论生成引擎：三层上下文隔离 + 人格绑定 + 5 种 prompt 组装器 |
| 🎭 **7 种人格** | 参数（权重/温度/长度/emoji 概率/禁用词/示例语料）全部可在界面改，可加自定义人格 |
| 🔀 **回复来源可切** | AI / 固定内容 / 混合三种模式；固定内容支持**顺序 / 随机 / 洗牌不重复 / 加权**四种循环 |
| 🛡️ **PolicyEngine** | 运营规则代码化：每日配额、轮次、单轮上限、去重、熔断、发布前内容校验 |
| ⏱️ **随机器节奏** | 写操作 40–55s / 读操作 30–50s 随机（两个间隔分别生效），写间隔硬强制 |
| 💾 持久化记忆 | SQLite schema v10（评论/用户/视频/语料/失败模式/草稿/用量） |
| 📝 草稿箱 | 生成→审核→发布全流程；草稿可带附图 |
| 🧩 **配置全部可改** | 9 个分组、60+ 项，改完立即生效；未生效的项目在界面上会被明确标出 |

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

### 桌面应用（推荐）

```bash
npm install

# 构建渲染层并启动
npm run app:start
```

首次启动后：

1. **连接页**点「安装油猴脚本」——脚本里的 bridge token 由服务端现场注入，不需要手工复制
2. Chrome 里确认 Tampermonkey 已启用该脚本
   （Chrome 用户需在扩展设置里打开「允许访问文件网址」，见下方疑难排解）
3. 打开并登录 `douyin.com`，**保持这个页面开着**
4. 连接页显示「已连接」即可开始

配置、人格、提示词都在**设置页**里改，保存即生效。

### 命令行

```bash
node server.js                 # 启动 Bridge Server（桌面应用已内嵌，CLI 下需单独起）
node cli.js my                 # 验证连接
node cli.js search "关键词"
node cli.js get <aweme_id> --new --depth 1        # 只拉最新一页
node cli.js get <aweme_id> --all                  # 全量：翻到底，页间等 1-3 秒
node cli.js getReply <aweme_id> <cid>      # 按配置的 reply.mode 生成
node cli.js post <aweme_id> "内容" --reply-to <cid>
```

命令行与桌面应用共用 `core/`，配置也是同一份。

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
- **多模态**（video-context）：支持 text-only / screenshots（ffmpeg 取帧）/ video 三种模式。
  桌面版不内置 ffmpeg，缺依赖时会**自动降级**回 text-only

**回复策略的单一真源**是 `prompts/partial-reply-strategy.md`，由各模板的
`{{STRATEGY_BLOCK}}` 注入。以前这份策略在三个地方各存一份且内容不同（其中一份还被
从中间截断到 500 字，导致后半部分策略从未生效），现已合并为一处，可在设置页的
「提示词」里编辑。

> `getReply` 会按配置的 `reply.mode` 分发到 **AI / 固定内容 / 混合** 三种来源，
> `--mode` 可临时覆盖。所以上面的命令在「固定内容」模式下不调用任何 LLM。

---

## 🤖 AI 人格化回复

**7 种内置人格自动轮换**，每条评论风格不同：

| 人格 | 特征 | 示例 |
|------|------|------|
| 随和朋友型 | 口语短句，1-2 个 emoji | "哈哈哈这也太真实了😂" |
| 好奇提问型 | 以问句为主，真诚追问 | "这个是在哪里买的呀？" |
| 经验分享型 | "我之前也..." | "我之前试过，确实不错" |
| 热情追捧型 | 感叹号+emoji，情绪化 | "啊啊啊这个绝了！！" |
| 温和探讨型 | "我觉得..."委婉补充 | "说得挺有道理的，不过..." |
| 轻松幽默型 | 玩梗、自嘲、夸张 | "我的手：我会了 我的脑：不你不会" |
| 简短反应型 | 极简，3-15 字 | "真实👍" "马住了" |

这 7 个只是**默认值**。权重、温度、长度区间、emoji 概率、禁用词、示例语料都能在
设置页的「人格」里改，也可以加自定义人格、停用不想要的。

> ⚠️ 默认的示例语料是**美妆/购物语境**（从原项目继承的占位内容）。它只用来给模型
> 示范句子长度与口气，不影响你发什么。把它们换成你自己领域里的例句，是提升生成
> 质量最直接的一步。

使用：
```bash
# 生成建议（不发布，看风格）
node cli.js suggest <aweme_id>

# 自动发布（人格轮换 + 随机延迟）
node cli.js suggest <aweme_id> --auto

# ReplyEngine 单条回复（自动绑定人格 + 用户画像注入）
node cli.js getReply <aweme_id> <cid>
```

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

> 桌面应用里这些能力都在界面上；命令行适合脚本化与调试。
> 完整的 28 个命令见 [`SKILL.md`](./SKILL.md)。

### 读

| 命令 | 用途 |
|------|------|
| `my` | 我的作品列表 |
| `user <sec_user_id\|主页URL>` | 用户主页作品 |
| `search "关键词"` | 搜索视频 |
| `get <aweme_id>` | 拉取评论（`--new` 增量 / `--all` 全量 / `--depth` 嵌套）。`--all` 逐页拉到底，跨页按 cid 去重、页间等 `intervals.commentPage`（默认 1-3 秒） |
| `replies <aweme_id> <cid>` | 单条评论的回复列表 |
| `dm` | 私信会话与消息 |

### 写（受策略闸门 + 节奏强制）

| 命令 | 用途 |
|------|------|
| `post <aweme_id> "内容"` | 发表评论/回复（`--reply-to <cid>`、`--image <路径>`） |
| `upload-image <路径>` | 仅上传图片取 uri，不发布（调试链路） |
| `like <aweme_id>` | 点赞/取消点赞 |
| `delete-comment <cid>` | 删除自己的评论 |

### AI

| 命令 | 用途 |
|------|------|
| `analyze <aweme_id>` | AI 分析评论情感/优先级 |
| `suggest <aweme_id>` | AI 回复建议 |
| `getReply <aweme_id> [<cid>]` | 生成回复，**按配置的 `reply.mode` 分发**（AI/固定内容/混合），`--mode` 可临时覆盖 |
| `validate-prompts` | 校验提示词模板格式与占位符 |

### 记忆层与运维

| 命令 | 用途 |
|------|------|
| `whois` / `profile` / `note` | 用户画像 / 交互历史 / 标记 |
| `comment` / `corpus` / `failures` | 单条评论 / 回复语料库 / 失败模式 top-N |
| `dedup` / `replied` | 查重护栏 / 已回复 cid |
| `draft` | 草稿箱 |
| `events` / `log` | 事件流 / 操作日志 |
| `preflight` | 节奏自检（现在能不能写、还要等多久） |
| `cleanup` | 清理过期记忆（TTL） |

> 输出约定：**stdout 只放 JSON**，日志走 stderr，可安全管道给 `jq`。

---

## ⚙️ 配置

**桌面应用里在设置页改**（9 个分组、60+ 项，保存即生效）。命令行下也可以直接编辑
`<数据目录>/config.json` —— 只写你要改的项，其余用内置默认值。

带注释的完整参考见 [`config.example.json`](./config.example.json)（`bridge` / `llm` /
`intervals` / `multimodal` 四组）；其余分组（`account` / `personas` / `reply` / `policy` /
`filters`）的默认值见 `core/config/index.js` 的 `DEFAULTS`，在设置页里逐项都有说明。

```jsonc
{
  "bridge": { "host": "127.0.0.1", "port": 19422, "token": "..." },
  "llm": {
    "api_key": "sk-...",
    "base_url": "https://api.openai.com/v1",
    "model": "gpt-4o-mini"
  },
  "intervals": { "write": [40, 55], "read": [30, 50] },
  "policy":  { "dailyWriteQuota": 30, "dailyRounds": 3 },
  "reply":   { "mode": "ai" },          // ai | fixed | hybrid
  "personas": { "disabled": [], "overrides": [], "custom": [] }
}
```

**几条例外，值得单独说**：

- `bridge.token` **不要在界面上改** —— 它由应用生成并注入油猴脚本，
  手改会让浏览器里已装的那份对不上，症状是「明明连上了却一直认证失败」且没有提示。
  要换 token 请重连一次（连接页有一键安装）。所以它不在设置页里。
- `intervals.readEnforce`：命令行下默认关（否则每次查询卡 30 秒），
  桌面端由主进程在启动时打开。**你在设置页显式改过之后，就以你的为准** ——
  这个"形态默认"不会把你的选择覆盖掉。
- 非法值不会让应用起不来：校验失败会回退默认值，并把告警显示在设置页与诊断页。

**LLM Provider 自动检测**：`base_url` 含 `anthropic.com` → Anthropic 原生 Messages API；
含 `xiaomimimo.com` → MiMo 分支；其余按 OpenAI 兼容格式。

环境变量（优先级更高）：`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`。

---

## 🏗️ 架构

```
桌面应用 / CLI ──HTTP──▶ 内嵌 Bridge Server (:19422) ──长轮询──▶ 油猴脚本 ──▶ 页面 fetch ──▶ 抖音
```

**签名安全**：油猴脚本在页面上下文执行，用页面原生 `fetch`，自动携带真实 Cookie 与签名。
Node 侧除了本地文件读写之外不直接访问抖音。

**核心模块**：

| 模块 | 职责 |
|------|------|
| `core/policy/` | PolicyEngine —— 把运营规则变成代码强制（配额/轮次/熔断/去重/内容校验） |
| `core/reply-source/` | 回复来源分发：AI / 固定内容 / 混合 + 四种循环方式 + 图片附加 |
| `core/reply-engine/` | ReplyEngine 评论生成引擎（5 模块，三层上下文隔离） |
| `core/runtime/` | 可嵌入化运行时：串行任务队列、结构化日志、可取消的等待 |
| `core/risk-control.js` | 请求节奏守卫（写操作硬强制，间隔单一源） |
| `core/personas.js` | 人格：内置定义 + 配置叠加 → 生效列表 |
| `core/llm.js` | LLM 客户端（OpenAI + Anthropic 双 Provider，Token 追踪） |

---

## 🛡️ 节奏与拟人化设计

> 语义边界：这是 rate-limit pacing（请求节奏化）+ content humanization（内容拟人化），
> 服务于用户**自有账号**的代管运营，避免触发接口频控、维护账号健康。
> 它不是"逃避平台内容审核"——内容真实性与反刷量由内容校验 + 语料去重保证。

| 维度 | 对策 |
|------|------|
| **固定时间间隔** | 写操作 40–55s 硬强制；桌面端读操作同样强制（读用自己的 30–50s，不占写间隔） |
| **AI 内容特征** | 7 种人格轮换 + AI 特征词黑名单 + 发布前硬校验 |
| **重复内容** | 语料库 UNIQUE 去重 + 固定内容支持「洗牌不重复」 |
| **回复质量** | 长度硬校验（3–55 字）、行数上限、结构化模式正则 |
| **高频失败** | 10 分钟窗口断路器（非累计值） |
| **请求指纹** | browser_version 动态获取、paste_edit_method / enter_from 随机化 |

> ⚠️ 改造前这里还写着「每发 ~5 条穿插 browse 浏览+点赞」「禁止单字回复，最少 8 字」等。
> browse 功能已移除；长度下限的实际值是 3 字（见 `运营规则说明.md §4`）。

---

## 📁 项目结构

```
douyinToolApp/
├── core/                     # 业务逻辑（Electron 主进程直接 require，无原生依赖）
│   ├── config/               # 配置单一真源（默认值 + 校验 + 热重载 + 运行时覆盖）
│   ├── paths.js              # 运行时路径解析（数据目录可重定向）
│   ├── runtime/              # logger / context / run-command / task-queue / abort
│   ├── policy/               # PolicyEngine（运营规则代码化）+ filters（评论筛选决策树）+ rounds
│   ├── reply-source/         # 回复来源分发（ai/fixed/hybrid）+ 四种循环方式 + 图片附加
│   ├── reply-engine/         # ReplyEngine（人格绑定 + 三层上下文 + 5 种 prompt 组装）
│   ├── memory/               # SQLite（经 sqlite-driver 适配 node:sqlite，schema v10）
│   ├── commands/             # 28 个命令
│   ├── server/               # 内嵌 Bridge Server（可 start/stop）
│   ├── shared/               # 序列化 / 解析 / 协议 / 清洗
│   ├── personas.js           # 人格：内置定义 + 配置叠加 → 生效列表
│   ├── prompts.js            # 提示词模板读写 / 备份 / 恢复默认 / 缓存失效
│   ├── comment-image.js      # 评论图片：校验 / 分块 / 经 Bridge 上传
│   ├── risk-control.js       # 请求节奏守卫
│   └── llm.js                # LLM 客户端（OpenAI + Anthropic + Token 追踪）
├── app/                      # Electron 应用
│   ├── main/                 # 数据目录 / 桥接管理 / 窗口 / 托盘 / IPC
│   ├── preload/              # contextBridge 白名单
│   └── renderer/             # React 界面
│       ├── views/            # 队列 / 作品 / 工作台 / 草稿箱 / 设置 / 连接 / 诊断
│       └── settings/         # 设置页字段表 + 通用控件 + 人格/提示词编辑器
├── prompts/                  # 6 个内置 prompt 模板（用户覆盖写 <数据目录>/prompts/）
├── scripts/                  # 油猴脚本源模板 + 构建脚本
├── tests/                    # vitest（39 文件 / 675 用例）
├── cli.js                    # 命令行入口（薄壳，调 core/runtime/run-command）
└── server.js                 # 独立 Bridge Server 入口（调试用）
```

数据目录（`<安装目录>/data` 优先，不可写则回退用户数据目录）：
`config.json` / `storage/douyin.db` / `reply-state.json` / `prompts/` / `logs/`。

---

## 📦 依赖

- Node.js 18+
- `node:sqlite`（Node 内置，无原生模块）— SQLite
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
| `Unauthorized` | token 不匹配 | 油猴脚本里的 token 是安装时由服务端注入的。若你手工改过 `bridge.token`，两边就对不上了 —— 到连接页重装一次脚本即可 |
| `抖音返回了 HTML 页面` | 登录态失效 | 刷新 `douyin.com` 并重新登录 |
| `Request timeout` | 浏览器未打开 douyin.com，或页面被休眠 | 打开并登录抖音，把标签页保持在前台附近；长时间挂后台会被浏览器回收 |
| 写操作频繁失败 | 触发风控 | 等待 30 分钟后再试，检查 `preflight` 状态 |
| `Request body too large`（服务端日志） | 搜索结果等响应超过请求体上限 | 默认上限 64MB（`bridge.maxBodySize`，单位字节），一般无需调整 |
| 固定内容模式报「列表是空的」 | `reply.fixed.items` 没配 | 设置页 → 回复策略，加几条；或把模式改回 AI |
| 发了但评论区看不到 | 抖音审核中 | 等 1–2 分钟，通常会自动出现 |

---

## 🤝 贡献与安全

- 贡献指南、开发环境、代码约定见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- 安全策略、漏洞报告、密钥安全、授权边界见 [`SECURITY.md`](./SECURITY.md)
- 免责声明见 [`DISCLAIMER.md`](./DISCLAIMER.md)

---

## 📝 License

MIT
