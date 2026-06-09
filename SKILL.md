---
name: douyin
description: 抖音评论 CLI — 作品列表 / 搜索视频 / 获取评论(含嵌套回复) / 发表回复评论。Bridge Framework（油猴+HTTP轮询）方案。
---

# 抖音评论 Skill

## 前置条件

- **Bridge Server 运行中**：`node server.js`（本目录）
- 浏览器已安装 Tampermonkey + `scripts/douyin.user.js` 油猴脚本
- 浏览器已打开 `douyin.com` 任意页面并**登录抖音**
- 零依赖：无需 `npm install`
## 通用选项

所有命令均支持以下选项：

| 选项 | 作用 |
|------|------|
| `--raw` | 输出完整 API 原始 JSON（调试用） |
| `--no-log` | 本次执行不写入审计日志 |

## Bridge Server 前置条件

**Bridge Server 必须独立启动**（不在本 skill 管理范围内）。

启动方式：
```bash
node server.js
```

用 `run_background` 运行，等待输出 `[server] Bridge Server ready — http://127.0.0.1:19422`。

验证可用：
```bash
curl http://127.0.0.1:19422/api/status
# 应显示 douyin.com 连接在线
```

> Bridge Server 是常驻服务，不需要每次 stop。油猴脚本随页面自动建连，页面关闭/重开自动重连。

> **无需任何人工确认** — 油猴脚本随页面静默注入，不弹对话框。

---

## 命令参考

### 我的作品

```bash
node cli.js my
node cli.js my --count 30
```

输出（清洁模式）：
```json
[{
  "aweme_id": "7629735841874726179",
  "desc": "视频描述前80字...",
  "time": 1780238354,
  "stats": { "plays": 1234, "likes": 56, "comments": 12, "shares": 3 }
}]
```

### 搜索视频

```bash
node cli.js search "周杰伦"
node cli.js search "周杰伦" --offset 10 --count 20
```

输出：
```json
[{
  "aweme_id": "7533234103531261243",
  "desc": "视频描述...",
  "author": "瓶妞Lottie英语",
  "uid": "83925411173",
  "time": 1754007300,
  "plays": 0
}]
```

### 获取评论

```bash
node cli.js get 7629735841874726179                  # 默认 1 页 20 条
node cli.js get 7629735841874726179 --pages 5        # 指定页数
node cli.js get 7629735841874726179 --all             # 全部一级评论
node cli.js get 7629735841874726179 --all --depth 1   # 含嵌套回复（每条最多50条回复）
node cli.js get 7629735841874726179 --all --depth 1 --reply-limit 20   # 限制每条最多20条回复
node cli.js get 7629735841874726179 --new             # 增量：只拉上次获取之后的新评论
node cli.js get 7629735841874726179 --new --depth 1   # 增量 + 嵌套回复
node cli.js get 7629735841874726179 --since 1780238354  # 增量：指定 Unix 时间戳
```

输出（`--depth 1` 时有 `children`）：
```json
[{
  "cid": "7646...",
  "text": "一级评论内容",
  "likes": 1,
  "replies": 3,
  "time": 1780238354,
  "user": { "nickname": "用户", "uid": "123", "avatar": "https://..." },
  "children": [{
    "cid": "7647...",
    "text": "回复内容",
    "likes": 0,
    "replies": 0,
    "time": 1780239000,
    "user": { "nickname": "回复者", "uid": "456", "avatar": "https://..." }
  }]
}]
```

- `--depth 1`：拉所有一级评论 + 每条下所有回复
- `--depth 2`：递归两层（回复的回复）

#### 增量获取（`--new` / `--since`）

基于时间戳过滤，只拉取新评论，请求数最少。

**`--new`**：自动从审计日志中找到该视频上次成功 `get` 的时间，只拉此后的新评论。无历史记录时退化为全量。

**`--since <unix_ts>`**：显式指定 Unix 时间戳（秒），只拉 `create_time > ts` 的评论。

```bash
# 首次全量
node cli.js get 7629735841874726179 --all --depth 1

# 后续增量（通常只需 1 次请求）
node cli.js get 7629735841874726179 --new --depth 1
```

**原理**：从 `cursor=0` 逐页拉取，每页过滤 `create_time > cutoff`，遇到旧评论立即停止。通常 1-2 次请求即可完成。

### 单条回复列表

```bash
node cli.js replies <cid> <aweme_id>
```

输出格式同 `get` 的结果项（无 `children`）。

### 查看操作日志

```bash
node cli.js log                              # 最近 10 条操作
node cli.js log --tail 20                    # 最近 20 条
node cli.js log --video <aweme_id>           # 指定视频的所有操作
node cli.js log --failed                     # 只看失败的
```

输出示例：
```
✅ [2026-05-31T21:13:04] get {"aweme_id":"7259245704948747575","mode":"all","depth":1} 25.0s
   result: logs/results/get-7259245704948747575-20260531T211304.json
   summary: {"comments":200,"pages":10}
✅ [2026-05-31T21:15:00] post {"aweme_id":"7259245704948747575","text":"好看！"} 1.2s
   result: {"cid":"7648...","text":"好看！","status":"published"}
```

### 发表评论

```bash
node cli.js post 7629735841874726179 "好看！"
node cli.js post 7629735841874726179 "说得对" --reply-to 7646065507817734949
```

输出：
```json
{ "cid": "7646...", "text": "好看！", "time": 17802..., "status": "published" }
```

失败：
```json
{ "error": "status_code=8" }
```

> **注意**：评论内容中的引号会被自动转义。`status_code=8` 通常表示内容过短、重复或被风控拦截，换内容重试。

### LLM 分析

```bash
node cli.js analyze <aweme_id>
```

调用 LLM 批量分析评论，返回情感/分类/优先级。需配置 `config.json` 中的 `llm.api_key`。

输出：
```json
[{
  "cid": "7646...",
  "sentiment": "positive",
  "category": "question",
  "priority": 5,
  "summary": "询问滤镜位置"
}]
```

### LLM 回复建议

```bash
node cli.js suggest <aweme_id>              # 仅建议
node cli.js suggest <aweme_id> --auto       # 自动发布
node cli.js suggest <aweme_id> --min-priority 4
```

结合分析结果和回复策略，生成回复建议。`--auto` 自动发布。

### 运营仪表盘

```bash
node cli.js dashboard
node cli.js dashboard --video <aweme_id> --days 14
```

生成本地自包含 HTML 仪表盘，含情感分布饼图、评论趋势折线图。生成后自动打开浏览器。

---

## 智能回复工作流

配合策略文件 `reply-strategy.md`，agent 可自动判断哪些评论需要回复、生成回复内容并发布。

### 首次执行

```
1. 读取策略文件（reply-strategy.md）
2. node cli.js get <aweme_id> --all --depth 1
3. 根据策略逐条判断：
     → 跳过 → 记录原因
     → 需回复 → 根据风格指南生成回复内容
              → node cli.js post <aweme_id> "内容" --reply-to <cid>
4. 输出执行报告
```

### 后续增量执行

```
1. 读取策略文件
2. node cli.js get <aweme_id> --new --depth 1   # 只拉新评论
3. 对新评论逐条判断并回复
4. 输出执行报告（标注增量模式 + 跳过旧评论数）
```

> `--new` 自动从审计日志中找到上次拉取时间，通常只需 1-2 次 API 请求。

### 策略文件

项目根目录 `reply-strategy.md` 包含完整策略模板：优先回复规则、跳过条件、风格指南、限制参数、特殊需求占位区。每次使用前可根据场景编辑"特殊需求"部分。

### 限制遵循

agent 在执行时必须遵守策略中的硬限制：
- 每视频最多回复 30 条：达到上限立即停止
- 同一用户不重复回复：不回复自己或已回复过的评论
- 连续 5 条不匹配则停止：避免无效遍历

---

## 推广引流

利用自身 CLI 在相关视频下评论，自然引流到 GitHub 项目。

### 策略

1. **选视频** — 搜索 AI 编程/自动化/自媒体运营/开源项目 关键词，找近期活跃视频
2. **筛选** — 优先评论数 <100 的视频（自己的评论不会被淹没）
3. **风格轮换** — 每轮 10 条，不要全部用同一模板：
   - 🗣️ 自然聊天 — "我也做了个类似的..."
   - 🤔 提问式 — "有人做过这个方向吗？"
   - 😂 自嘲式 — "打工人帮自己写了个工具..."
   - 💡 技术对比 — "CDP 方案比 xxx 更轻量..."
   - 🙏 价值分享 — "免费开源的，欢迎交流"
4. **节奏** — 每轮 ≤10 条，间隔 ≥1 分钟，一天不超过 2 轮
5. **绝不做** — 纯广告、刷屏、竞品攻击、诱导点击

### 执行

```bash
# 搜索目标视频
node cli.js search "AI编程效率提升" --count 5
node cli.js search "程序员副业" --count 5

# 逐条评论（间隔自然）
node cli.js post <aweme_id> "真诚评论内容..."
```

### 追踪

所有推广记录在 `logs/audit.json` 中，可通过 `profile <uid>` 查看是否引来了新的关注/评论。

---

## 故障排查

| 症状 | 原因 | 解法 |
|------|------|------|
| `Bridge Server not running` | Bridge Server 未启动 | 启动 `node server.js` |
| `No connection for site 'douyin.com'` | 浏览器未打开抖音页面或油猴脚本未安装 | 检查 Tampermonkey 是否启用 + 打开 douyin.com |
| `status_code=8` | 评论被拦截 | 换内容重试（更长/更自然） |
| 搜索结果为空 `[]` | 油猴脚本 bridge 未加载 | 刷新 douyin.com 页面，等待脚本自动重连 |
| `--new` 无历史记录仍拉全量 | 该视频未被拉取过 | 预期行为，首次执行 `--new` 等价于 `--all` |
| 多个 douyin 连接 | 存在 iframe 或额外 tab | 正常现象，Server 自动选第一个活跃连接 |
| 发布评论返回 published 但看不到 | 正常延迟（comment.status:7 审核中） | 等待 1-2 分钟再查，不是错误 |
| 回复贴纸评论看不到 | 抖音限制，贴纸评论不支持文字回复 | 跳过纯贴纸评论，只回复文字评论 |

---

## 审计日志

所有 CLI 操作自动记录到 `logs/audit.json`，便于追踪和增量拉取。

```
logs/
├── audit.json              ← 操作元数据（sessions → operations → apiCalls）
└── results/
    ├── get-<aweme_id>-<ts>.json    ← 评论获取的完整结果
    ├── search-<kw>-<ts>.json       ← 搜索结果
    └── ...
```

- 每个操作记录：命令、参数、开始/结束时间、耗时、成功/失败、摘要
- 每个 API 调用记录：端点、参数、耗时、返回条数
- 大结果（`get`/`search`/`my`/`replies`）落地为独立 JSON 文件
- 小结果（`post`/`ping`/`stop`）内联在 audit.json
- `--no-log` 可跳过记录


## 请求速率限制

为避免触发抖音风控，**每次调用 CLI 命令之间必须插入随机等待**。

### 规则

| 操作类型 | 最小间隔 | 说明 |
|----------|----------|------|
| 读操作（`get` / `search` / `replies` / `my`） | 30-50 秒 | 数据拉取类 |
| 写操作（`post` 评论/回复） | 40-60 秒 | 发布类，风控更严 |
| 混合场景（先读后写） | 写操作单独计时 | 读写各自满足对应间隔 |

### 执行方式

在 Bash 命令前加 `sleep`，间隔值从上述范围中**随机选取**，不要固定同一个值：

```bash
# ✅ 正确：随机间隔 38 秒
sleep 38 && cd ~/.claude/skills/douyin && node cli.js search "AI编程" --count 5

# ✅ 正确：随机间隔 47 秒
sleep 47 && cd ~/.claude/skills/douyin && node cli.js post <aweme_id> "内容"

# ❌ 错误：无间隔连续调用
node cli.js search "AI编程" && node cli.js search "Claude Code"
```

### 批量执行注意事项

- **单轮上限**：连续操作不超过 10 次，之后暂停 3-5 分钟
- **日上限**：同一账号一天不超过 2 轮（共 20 次写操作）
- **超时设置**：带 `sleep` 的命令需设置 `timeout: 120000`（2 分钟）
- **并行禁止**：不要同时发起多个 CLI 调用，严格串行执行
