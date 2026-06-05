# REASONIX.md — douyin-comment-cli (Bridge Framework v2)

## Stack
- **Node.js** — vanilla, no framework
- **Bridge Framework** — 本地 WebSocket Server + 油猴脚本，替代 CDP
- **Tampermonkey** — 浏览器扩展，注入 `window.__bridge` API
- **Target platform**: 抖音 (Douyin) web，全浏览器支持

## Layout
- `cli.js` — 入口：命令路由、Bridge 通信、审计日志
- `lib/audit.js` — 审计日志模块（操作记录/结果持久化/增量查询）
- `lib/dashboard.js` — HTML 仪表盘生成（Chart.js）
- `lib/llm.js` — OpenAI-compatible LLM 客户端
- `lib/commands/` — 命令模块（预留）
- `config.json` — Bridge 连接 + LLM 配置
- `package.json` — 零外部依赖
- `SKILL.md` — agent 操作手册
- `reply-strategy.md` — 自动回复策略模板

## 架构

```
node cli.js ──HTTP──→ Bridge Server (:19422) ──WebSocket──→ 油猴脚本（浏览器 Tab）
                       ↑ D:\projects\tools\socketServers\     ↑ scripts/douyin.user.js
```

CLI 不再管理 daemon 生命周期。Bridge Server 独立启动，油猴脚本随页面自动注入建连。

## Commands

| 命令 | 用途 |
|------|------|
| `node cli.js search <kw> [--offset N] [--count N]` | 搜索视频 |
| `node cli.js get <id> [--pages N\|--all] [--depth N] [--new] [--since <ts>]` | 获取评论 |
| `node cli.js replies <cid> <aweme_id>` | 获取回复列表 |
| `node cli.js my [--count N]` | 我的作品 |
| `node cli.js post <id> "<text>" [--reply-to <cid>] [--at <uid> --at-sec-uid <sec>]` | 发表评论 |
| `node cli.js analyze <id>` | LLM 分析评论 |
| `node cli.js suggest <id> [--auto] [--min-priority N]` | LLM 回复建议 |
| `node cli.js dashboard [--video <id>] [--days N]` | 运营仪表盘 |
| `node cli.js log [--tail N] [--video <id>] [--failed]` | 操作日志 |
| `node cli.js profile <uid>` | 用户交互历史 |

## 前置条件
1. Bridge Server 运行中：`node D:\projects\tools\socketServers\server.js`
2. 浏览器已安装 Tampermonkey + `scripts/douyin.user.js`
3. 浏览器已打开 `douyin.com` 任意页面并登录

## Watch out for
- **Bridge Server 必须先启动** — 否则所有命令报 `Bridge Server not running`
- **site key 为 `douyin.com`** — 与油猴脚本中的 `CONFIG.site` 一致
- **表达式必须带 `window.` 前缀** — 如 `window.__bridge.search(...)`（Function 构造器在全局作用域执行）
- **`status_code=8`** — 评论被风控拦截，换内容重试
- **零 npm 依赖** — 安装后无需 `npm install`
