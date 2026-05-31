# 抖音评论 CLI v2.0

基于 Chrome DevTools Protocol 的抖音全自动评论管理工具。

**功能**：作品列表 / 搜索视频 / 获取评论（含嵌套回复） / 发表回复评论 / AI 智能分析 / 运营仪表盘

## 快速开始

```bash
cd D:\projects\skills\douyin
npm install

# 1. 启动 Chrome 调试模式（chrome://inspect/#remote-debugging 开关）
# 2. 打开 douyin.com 并登录
# 3. 启动 daemon
node cli.js daemon

# 4. 开始使用
node cli.js ping
node cli.js my
node cli.js search "关键词"
node cli.js get <aweme_id> --all --depth 1
node cli.js post <aweme_id> "内容"
```

## 命令清单

| 命令 | 用途 | 示例 |
|------|------|------|
| `daemon` | 启动后台 CDP 守护进程 | `node cli.js daemon` |
| `ping` | 探活 daemon | `node cli.js ping` |
| `stop` | 停止 daemon | `node cli.js stop` |
| `my` | 我的作品列表 | `node cli.js my --count 10` |
| `search` | 搜索视频 | `node cli.js search "周杰伦" --offset 0` |
| `get` | 获取评论 | `node cli.js get <id> --all --depth 1` |
| `replies` | 单条评论的回复 | `node cli.js replies <cid> <aweme_id>` |
| `post` | 发表/回复评论 | `node cli.js post <id> "内容" --reply-to <cid>` |
| `analyze` | AI 分析评论 | `node cli.js analyze <id>` |
| `suggest` | AI 回复建议 | `node cli.js suggest <id> --auto --min-priority 3` |
| `dashboard` | 生成仪表盘 | `node cli.js dashboard --video <id>` |
| `profile` | 用户画像 | `node cli.js profile <uid>` |

## 通用选项

| 选项 | 作用 |
|------|------|
| `--raw` | 输出完整 API 原始 JSON |
| `--pages N` | 翻页数（get 命令） |
| `--all` | 获取全部评论（等价 `--pages 999`） |
| `--depth 1` | 获取嵌套回复（get 命令） |
| `--new` | 增量获取新评论（get 命令） |
| `--since <unix_ts>` | 指定时间戳（get 命令） |
| `--auto` | 自动发布（suggest 命令） |
| `--min-priority N` | 最低优先级过滤（suggest 命令） |
| `--reply-to <cid>` | 回复目标评论（post 命令） |

## 架构

```
douyin/
├── cli.js                    # 入口（daemon + CLI 路由）
├── config.json               # LLM + daemon 配置（可选）
├── lib/
│   ├── daemon.js             # PID JSON 锁、重连、页面感知、心跳
│   ├── cdp.js                # CDP WebSocket 客户端
│   ├── llm.js                # OpenAI-compatible LLM 封装
│   └── commands/             # 命令模块（待拆分）
├── templates/
│   └── dashboard.html        # 仪表盘 HTML 模板（Chart.js）
├── logs/
│   ├── audit.json            # 审计日志
│   └── results/              # 命令结果
├── SKILL.md                  # Agent 技能文档
├── REASONIX.md               # 项目参考文档
├── reply-strategy.md         # 回复策略模板
└── package.json
```

## 配置

复制 `config.json` 并按需修改：

```json
{
  "llm": {
    "api_key": "sk-...",
    "base_url": "https://api.openai.com/v1",
    "model": "gpt-4o-mini"
  },
  "daemon": {
    "port": 19422,
    "heartbeat_interval": 60000,
    "max_reconnect_attempts": 5,
    "inactive_timeout": 1200000
  }
}
```

LLM key 也可用环境变量 `OPENAI_API_KEY`。

## Daemon 生命周期

```
┌── session 开始 ──┐
│ node cli.js daemon │  ← run_background
│ 等待 Listening ... │
├── 操作阶段 ────────┤
│ ping 探活           │
│ get / post / ...    │
├── session 结束 ────┤
│ node cli.js stop    │
└────────────────────┘
```

- 一个 session 只启动一次 daemon
- 首次连接 Chrome 弹"允许调试"，点一次即可
- 20 分钟无操作自动退出
- PID JSON 锁防重复启动 + 僵尸检测

## 审计日志

所有操作自动记录到 `logs/audit.json`，大结果落地为独立 JSON 文件。支持增量拉取（`--new`）。

## 依赖

- Node.js 18+（内置 WebSocket + fetch）
- `ws` — CDP WebSocket 客户端
- Chrome 浏览器（`chrome://inspect/#remote-debugging` 开关）
- （可选）OpenAI API key — `analyze` / `suggest` 命令
