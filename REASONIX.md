# REASONIX.md — douyin-comment-cli (Bridge Framework v2)

## Stack
- **Node.js** — vanilla, no framework
- **Bridge Framework** — 本地 WebSocket Server + 油猴脚本，替代 CDP
- **Tampermonkey** — 浏览器扩展，注入 `window.__bridge` API
- **Target platform**: 抖音 (Douyin) web，全浏览器支持

## Layout
- `cli.js` — 入口：命令路由、Bridge 通信、审计日志
- `server.js` — Bridge Server 入口（WebSocket + HTTP API）
- `lib/audit.js` — 审计日志模块（操作记录/结果持久化/增量查询）
- `lib/dashboard.js` — HTML 仪表盘生成（Chart.js）
- `lib/llm.js` — OpenAI-compatible LLM 客户端
- `lib/commands/` — CLI 命令模块（每个命令独立文件）
- `lib/server/` — Bridge Server 核心（registry / router / ws-hub）
- `lib/client/` — HTTP 客户端封装（CLI / SDK 共用）
- `lib/shared/` — 共享协议定义 + 序列化工具
- `config.json` — Bridge 连接 + LLM 配置
- `package.json` — 零外部依赖（仅 ws 需 npm install）
- `scripts/douyin.user.js` — 油猴脚本（GM_xmlhttpRequest 绕过 PNA，注入 __bridge API）
- `scripts/_template.user.js` — 油猴脚本模板（新站点参考）
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
| `node cli.js post <id> "<text>" [--reply-to <cid>] [--at <uid> <sec_uid>]` | 发表评论 |
| `node cli.js like <id> [--unlike]` | 点赞/取消点赞视频 |
| `node cli.js delete-comment <cid>` | 删除评论 |
| `node cli.js download <id> [--audio-only] [--out <dir>]` | 下载视频（含音频） |
| `node cli.js analyze <id>` | LLM 分析评论 |
| `node cli.js suggest <id> [--auto] [--min-priority N]` | LLM 回复建议 |
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
- **零 npm 依赖** — 安装后无需 `npm install`
