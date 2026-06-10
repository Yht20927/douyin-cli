# 🎵 Douyin Comment CLI v2.0

基于 Bridge Framework（油猴 + HTTP 轮询）的抖音全自动评论管理工具。搜索视频、爬取全量评论（含嵌套回复）、AI 智能回复、运营仪表盘。

**功能**：作品列表 / 搜索视频 / 获取评论（含嵌套回复） / 发表回复评论 / 点赞取消点赞 / 删除评论 / 下载视频（含音频） / AI 智能分析 / 运营仪表盘

## 快速开始

```bash
# 1. 启动 Bridge Server
cd D:\projects\skills\douyin
npm install
node server.js

# 2. 浏览器安装 Tampermonkey 扩展
#    复制 scripts/douyin.user.js → Tampermonkey 新建脚本 → 粘贴保存
# 3. 打开 douyin.com 任意页面并登录（控制台应显示 ✓ Registered）

# 4. 开始使用
cd D:\projects\skills\douyin
node cli.js my
node cli.js search "关键词"
node cli.js get <aweme_id> --all --depth 1
node cli.js post <aweme_id> "内容"
node cli.js like <aweme_id>
node cli.js delete-comment <cid>
node cli.js download <aweme_id>
```

## 命令清单

| 命令 | 用途 | 示例 |
|------|------|------|
| `my` | 我的作品列表 | `node cli.js my --count 10` |
| `search` | 搜索视频 | `node cli.js search "周杰伦" --offset 0` |
| `get` | 获取评论（含嵌套回复） | `node cli.js get <id> --all --depth 1` |
| `replies` | 单条评论的回复列表 | `node cli.js replies <cid> <aweme_id>` |
| `post` | 发表/回复评论 | `node cli.js post <id> "内容" --reply-to <cid>` |
| `like` | 点赞视频 | `node cli.js like <id>` |
| `like --unlike` | 取消点赞 | `node cli.js like <id> --unlike` |
| `delete-comment` | 删除评论 | `node cli.js delete-comment <cid>` |
| `download` | 下载视频（含音频） | `node cli.js download <id>` |
| `analyze` | AI 分析评论情感/优先级 | `node cli.js analyze <id>` |
| `suggest` | AI 回复建议（可自动发布） | `node cli.js suggest <id> --auto` |
| `dashboard` | 运营仪表盘 HTML | `node cli.js dashboard --video <id>` |
| `profile` | 用户交互历史 | `node cli.js profile <uid>` |
| `log` | 操作日志 | `node cli.js log --tail 20 --failed` |

## 通用选项

| 选项 | 作用 |
|------|------|
| `--raw` | 输出完整响应（含元数据） |
| `--no-log` | 本次不写入审计日志 |
| `--all` | 获取全部评论 |
| `--depth 1` | 展开嵌套回复 |
| `--new` | 增量拉取（自上次 fetch 后的新评论） |
| `--since <ts>` | 指定时间戳增量 |
| `--pages N` | 翻页数 |
| `--auto` | suggest 命令自动发布 |
| `--min-priority N` | 最低回复优先级 |
| `--reply-to <cid>` | 回复目标评论 |
| `--unlike` | 取消点赞（like 命令） |
| `--audio-only` | 仅下载音频（download 命令） |
| `--out <dir>` | 指定下载输出目录（download 命令） |

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│  CLI (douyin/cli.js)                                         │
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

```
douyin/
├── cli.js                    # CLI 入口（HTTP → Bridge Server）
├── server.js                 # Bridge Server 入口
├── config.json               # Bridge + LLM 配置（已 gitignore）
├── config.example.json       # 配置模板
├── lib/
│   ├── audit.js              # 审计日志（sessions → operations）
│   ├── dashboard.js          # Chart.js 仪表盘 HTML 生成
│   ├── llm.js                # OpenAI-compatible LLM 封装
│   ├── commands/             # CLI 命令模块
│   │   ├── index.js          # 命令注册表
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
│   │   ├── dashboard.js      # 仪表盘
│   │   ├── log.js            # 操作日志
│   │   ├── profile.js        # 用户交互历史
│   │   └── helpers.js        # 共享辅助函数
│   ├── client/               # Bridge 客户端
│   ├── server/               # Bridge Server 核心
│   └── shared/               # 共享协议/序列化
├── scripts/
│   └── douyin.user.js        # 油猴脚本（注入 __bridge API）
├── downloads/                # 下载的视频/音频（已 gitignore）
├── logs/
│   ├── audit.json            # 操作审计
│   └── results/              # 大结果 JSON 落地
├── reply-strategy.md         # 回复策略模板
├── SKILL.md                  # Agent 技能文档
├── REASONIX.md               # 架构决策文档
└── package.json              # 零外部依赖（仅 ws）
```

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

**LLM API Key**（推荐使用环境变量，避免明文存储）：

```bash
export OPENAI_API_KEY="sk-..."        # 优先级最高
export OPENAI_BASE_URL="https://..."  # 可选，自定义 API 地址
export OPENAI_MODEL="gpt-4o-mini"     # 可选，模型名称
```

## 前置条件

```
1. Bridge Server 运行 → node server.js（本目录）
2. Tampermonkey + douyin.user.js 油猴脚本
3. 浏览器打开 douyin.com 任意页面并登录
```

> **无需 Chrome 调试模式 / CDP** — GM_xmlhttpRequest 绕过 Chrome PNA loopback 限制，`unsafeWindow.eval()` 注入页面上下文执行。

## 审计日志

所有操作自动记录到 `logs/audit.json`。大结果（get/search/my）落地为独立 JSON 文件，便于增量拉取（`--new`）。

## 依赖

- Node.js 18+
- `ws` — Bridge Server 依赖（`npm install` 安装）
- Chrome + Tampermonkey 扩展
- （可选）OpenAI API key — `analyze` / `suggest` 命令
