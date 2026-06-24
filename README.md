# 🎵 Douyin Comment CLI

> 抖音评论管理 CLI 工具。基于 Bridge Server + 油猴脚本方案，支持视频搜索、评论爬取、AI 智能分析、运营仪表盘。

**功能**：作品列表 / 搜索视频 / 获取评论（含嵌套回复） / 发表回复评论 / 点赞取消点赞 / 删除评论 / 下载视频（含音频） / AI 智能分析 / 回复语料库 / 去重护栏 / 运营仪表盘

## 快速开始

```bash
npm install

# 1. 启动 Bridge Server
node server.js

# 2. Chrome 安装油猴脚本 scripts/douyin.user.js，打开 douyin.com 并登录

# 3. 验证连接
node cli.js status

# 4. 开始使用
node cli.js my
node cli.js search "关键词"
node cli.js get <aweme_id> --all --depth 1
node cli.js post <aweme_id> "内容"
```

## 命令清单

### 核心操作

| 命令 | 用途 | 示例 |
|------|------|------|
| `my` | 我的作品列表 | `node cli.js my --count 20` |
| `search` | 搜索视频 | `node cli.js search "关键词" --offset 0 --count 20` |
| `get` | 获取评论（含嵌套回复） | `node cli.js get <id> --all --depth 1` |
| `replies` | 单条评论的回复列表 | `node cli.js replies <cid> <aweme_id>` |
| `post` | 发表/回复评论 | `node cli.js post <id> "内容" --reply-to <cid>` |
| `like` | 点赞视频 | `node cli.js like <id>` |
| `like --unlike` | 取消点赞 | `node cli.js like <id> --unlike` |
| `delete-comment` | 删除评论 | `node cli.js delete-comment <cid>` |
| `download` | 下载视频（含音频） | `node cli.js download <id> [--audio-only] [--out <dir>]` |

### AI 分析

| 命令 | 用途 | 示例 |
|------|------|------|
| `analyze` | AI 分析评论情感/优先级 | `node cli.js analyze <id>` |
| `suggest` | AI 生成回复建议（可自动发布） | `node cli.js suggest <id> --auto --min-priority 3` |

### 反馈闭环（基于 SQLite 记忆层）

| 命令 | 用途 | 示例 |
|------|------|------|
| `replied` | 已回复 cid 列表（去重用） | `node cli.js replied [--json] [--aweme <id>] [--count]` |
| `corpus search` | 搜索历史成功回复语料 | `node cli.js corpus search <keyword>` |
| `corpus recent` | 最近发布过的回复 | `node cli.js corpus recent --limit 20` |
| `corpus stats` | 语料统计 | `node cli.js corpus stats` |
| `failures` | 失败模式 top 10 | `node cli.js failures [--recent]` |
| `dedup` | 查重护栏：文本是否曾发过 | `node cli.js dedup "<候选文本>"` |

### 运维

| 命令 | 用途 | 示例 |
|------|------|------|
| `dashboard` | 生成运营仪表盘 HTML | `node cli.js dashboard --video <id> --days 14` |
| `profile` | 用户交互历史 | `node cli.js profile <uid>` |
| `events` | 原始事件流（调试用） | `node cli.js events --cmd post --json` |
| `log` | 操作日志 | `node cli.js log --tail 20 [--video <id>] [--failed]` |
| `whois` | 用户信息查询 | `node cli.js whois <uid>` |
| `note` | 用户备注管理 | `node cli.js note <uid> [--tier ...] [--tag ...] [--notes ...]` |
| `status` | Bridge 连接状态 | `node cli.js status` |

## 通用选项

| 选项 | 作用 |
|------|------|
| `--raw` | 输出完整响应（含元数据） |
| `--no-log` | 本次不写入审计日志 |
| `--count N` | 返回条数（上限 20，风控安全） |
| `--offset N` | 搜索偏移量 |
| `--all` | 获取全部评论（谨慎使用） |
| `--depth N` | 嵌套回复深度 |
| `--pages N` | 翻页数 |
| `--new` | 增量拉取（自上次 fetch 后的新评论） |
| `--since <ts>` | 指定时间戳增量 |
| `--reply-to <cid>` | 回复目标评论 |
| `--reply-limit N` | 每条评论最多拉取回复数 |
| `--auto` | suggest 命令自动发布 |
| `--min-priority N` | 最低回复优先级 |
| `--unlike` | 取消点赞（like 命令） |
| `--audio-only` | 仅下载音频（download 命令） |
| `--out <dir>` | 指定下载输出目录（download 命令） |

## 配置

```bash
cp config.example.json config.json   # 首次使用时复制模板
```

`config.json`（已加入 `.gitignore`，不会提交到版本控制）：

```json
{
  "bridge": {
    "host": "127.0.0.1",
    "port": 19422
  },
  "llm": {
    "api_key": "sk-...",
    "base_url": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "max_tokens": 4096,
    "timeout_ms": 60000,
    "max_retries": 3
  }
}
```

**LLM API Key**（推荐使用环境变量）：

```bash
export OPENAI_API_KEY="sk-..."        # 优先级最高
export OPENAI_BASE_URL="https://..."  # 可选，自定义 API 地址
export OPENAI_MODEL="gpt-4o-mini"     # 可选，模型名称
```

## 前置条件

1. Bridge Server 运行 → `node server.js`
2. Chrome + Tampermonkey + `scripts/douyin.user.js` 油猴脚本
3. 浏览器打开 `douyin.com` 任意页面并登录

> **无需 Chrome 调试模式 / CDP** — GM_xmlhttpRequest 绕过 Chrome PNA loopback 限制，`unsafeWindow.eval()` 注入页面上下文执行。

## 架构

```
douyin-cli/
├── cli.js                    # CLI 入口
├── server.js                 # Bridge Server 入口
├── config.json               # 配置（从 config.example.json 复制）
├── lib/
│   ├── commands/             # 命令模块
│   │   ├── get.js            # 获取评论
│   │   ├── post.js           # 发表评论
│   │   ├── like.js           # 点赞/取消点赞
│   │   ├── delete-comment.js # 删除评论
│   │   ├── download.js       # 下载视频（含音频）
│   │   ├── search.js         # 搜索视频
│   │   ├── my.js             # 我的作品
│   │   ├── replies.js        # 回复列表
│   │   ├── analyze.js        # LLM 分析
│   │   ├── suggest.js        # LLM 回复建议
│   │   ├── dashboard.js      # 运营仪表盘
│   │   ├── corpus.js         # 回复语料库
│   │   ├── failures.js       # 失败模式分析
│   │   ├── dedup.js          # 文本去重护栏
│   │   ├── replied.js        # 已回复追踪
│   │   ├── events.js         # 原始事件流
│   │   ├── whois.js          # 用户查询
│   │   ├── note.js           # 用户备注
│   │   ├── profile.js        # 用户交互历史
│   │   └── helpers.js        # 共享辅助函数
│   ├── memory/               # SQLite 持久化记忆层
│   │   ├── db.js             # 数据库单例 + schema 迁移
│   │   ├── events.js         # 事件流读写
│   │   ├── comments.js       # 评论实体（含 replied 追踪）
│   │   ├── notes.js          # 视频实体
│   │   ├── users.js          # 用户实体
│   │   ├── corpus.js         # 回复语料
│   │   └── failures.js       # 失败模式
│   ├── server/               # Bridge Server 组件
│   ├── client/               # Bridge Client
│   ├── shared/               # 共享工具
│   ├── audit.js              # 审计日志
│   ├── dashboard.js          # Chart.js 仪表盘 HTML 生成
│   └── llm.js                # LLM 封装
├── scripts/
│   └── douyin.user.js        # 油猴脚本
├── storage/
│   └── douyin.db             # SQLite 数据库（记忆层）
├── downloads/                # 下载的视频/音频（已 gitignore）
├── logs/
│   ├── audit.json            # 审计日志
│   └── results/              # 命令结果落盘
├── docs/
│   └── superpowers/specs/    # 设计文档
├── SKILL.md                  # Agent 技能文档
├── reply-strategy.md         # 回复策略模板
├── REASONIX.md               # 架构决策文档
└── package.json
```

## 通信架构

```
┌──────────────────────────────────────────────────────────────┐
│  CLI (cli.js)                                                │
│  ── HTTP POST /api/call ──►                                  │
│                              Bridge Server (:19422)           │
│                                 ├─ Connection Registry        │
│                                 ├─ Poll Queue / Waiters       │
│                                 └─ Request → Response         │
│                                     │                         │
│  ── HTTP 长轮询 ◄─────────── 油猴脚本（GM_xmlhttpRequest）── │
│     /api/poll  /api/result       ├─ sandbox: 通信             │
│                                  └─ unsafeWindow: __bridge →  │
│                                    页面 fetch/cookie/eval     │
└──────────────────────────────────────────────────────────────┘
```

## 持久化记忆层

所有命令在写 `logs/audit.json` 的同时旁路写入 `storage/douyin.db`（SQLite），提供：

- **评论去重**：`comments.replied` 追踪所有已回复 cid，跨日跨轮生效
- **回复语料**：`reply_corpus` 累积成功回复，支持搜索和查重
- **失败模式**：`failure_patterns` 记录风控/错误签名，辅助避雷
- **增量拉取**：`events` 表索引覆盖 `--new` / `--since`，O(log N) 查询

## 审计日志

所有操作自动记录到 `logs/audit.json`。大结果（get/search/my）落地为独立 JSON 文件，便于增量拉取（`--new`）。

## 依赖

- Node.js 18+
- `ws` — WebSocket 客户端
- `better-sqlite3` — SQLite 持久化记忆层
- Chrome + Tampermonkey 扩展
- （可选）OpenAI API key — `analyze` / `suggest` 命令
