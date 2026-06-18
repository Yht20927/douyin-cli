---
name: douyin-cli
description: 抖音评论 CLI — 作品列表 / 搜索视频 / 获取评论(含嵌套回复) / 发表回复评论 / 点赞取消点赞 / 删除评论 / 下载视频(含音频)。Bridge Framework（油猴+HTTP轮询）方案。
---

# 抖音评论 Skill

## 前置条件

- 浏览器已安装 Tampermonkey + `scripts/douyin.user.js` 油猴脚本
- 浏览器已打开 `douyin.com` 任意页面并**登录抖音**
- 零依赖：无需 `npm install`

## 通用选项

所有命令均支持以下选项：

| 选项 | 作用 |
|------|------|
| `--raw` | 输出完整 API 原始 JSON（调试用） |
| `--no-log` | 本次执行不写入审计日志 |

## Bridge Server 启动协议（强约束）

Bridge Server 是常驻 HTTP/WebSocket 桥接服务，必须**和主会话解耦**地运行。
不要：在主会话直接 `node server.js`（会阻塞 agent，所有后续 CLI 调用都卡住）；
不要：把启动甩给用户（用户不知道端口、PID、日志位置）。

**唯一正确做法**：使用本目录提供的 `scripts/bridge.sh`，它通过 `setsid + nohup` 双重 detach，
PID 文件 + `/api/status` 探测保证幂等，启动一次后跨多个 agent session 可复用。

### 每轮工作开始前（必做一次）

```bash
cd ~/.claude/skills/douyin-cli && bash scripts/bridge.sh ensure
```

`ensure` = `status || start`。返回 0 即代表 server 在线（http://127.0.0.1:19422）；
返回非 0 时按提示读 `logs/bridge-server.log` 定位（最常见原因：未 `cp config.example.json config.json`）。

### 验证油猴已连接

server 在线只代表 HTTP 桥可用，**还要确认浏览器侧的油猴脚本已上线**：

```bash
curl -s http://127.0.0.1:19422/api/status | grep -o '"douyin.com"' || echo "OFFLINE"
```

如果输出 `OFFLINE`，引导用户：(1) 打开/刷新 `douyin.com` 任一页面；(2) 检查 Tampermonkey 是否启用；(3) 必要时手动重装 `scripts/douyin.user.js`。**不要在 server.js 上反复重启来"修"这个**——油猴未连接和 server 进程无关。

### 何时停止

通常**不需要**停止——server 是常驻的，跨多个 Claude session 复用。
仅在以下情况执行 `bash scripts/bridge.sh stop`：

- 端口要让给别的进程
- 升级 server.js 代码
- 怀疑 server 进程卡死（`status` 返回非 200 但 PID 文件存在 → 直接 stop 再 start）

> **跨目录注意**：本 skill 同时在 `~/.claude/skills/douyin-cli/` 和 `~/project/douyin-cli/` 部署。`bridge.sh` 通过 `/api/status` 探测端口共享同一个 server——但 `stop` 只能从**首次 `start` 的那个目录**执行（PID 文件在哪边）。从另一目录看会显示 `online (pid=unknown)`，那是预期行为。

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

### 点赞/取消点赞

```bash
node cli.js like 7629735841874726179              # 点赞
node cli.js like 7629735841874726179 --unlike      # 取消点赞
```

输出：
```json
{ "aweme_id": "7629735841874726179", "action": "liked", "status": "success", "status_code": 0 }
```

### 删除评论

```bash
node cli.js delete-comment 7649651851377640192
```

输出：
```json
{ "cid": "7649651851377640192", "status": "deleted", "status_code": 0 }
```

> **注意**：只能删除自己发表的评论。删除他人评论会返回错误。

### 下载视频

```bash
node cli.js download 7629735841874726179              # 下载视频 + 音频
node cli.js download 7629735841874726179 --audio-only  # 仅下载 BGM
node cli.js download 7629735841874726179 --out ~/Videos  # 指定输出目录
```

默认保存到 `./downloads/` 目录，文件名格式：`<aweme_id>_<作者>_<标题>.mp4`

输出：
```json
{
  "awemeId": "7629735841874726179",
  "title": "视频标题",
  "author": "作者昵称",
  "files": [
    { "type": "video", "path": "./downloads/xxx.mp4", "size": 12345678 },
    { "type": "audio", "path": "./downloads/xxx_audio.mp3", "size": 1234567 }
  ]
}
```

> **说明**：视频 URL 通常带水印，音频（BGM）通过 `music.play_url` 单独提取。`--out` 目录不存在时会自动创建。

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

> **业务策略与工作流（评论区运营、推广引流、个人信息、硬性禁令）见 [`reply-strategy.md`](./reply-strategy.md)。** 本文件只描述 CLI 工具如何调用，不包含"做什么 / 不做什么"的策略判断。

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
| 点赞/取消点赞 `status_code` 非 0 | 风控或参数错误 | 等待 30 分钟后重试，确认 aweme_id 正确 |
| 删除评论失败 | 无权限（非自己的评论）或 cid 已删除 | 确认 cid 来源于 `get` 命令的返回值 |
| 下载视频无 URL | 视频已删除、私密或被限流 | 确认视频可正常播放，重试或换视频 |
| 下载超时 | 网络不稳或视频文件过大 | 检查网络，大文件耐心等待；默认超时 120s |

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
- 小结果（`post`/`like`/`delete-comment`/`download`/`ping`/`stop`）内联在 audit.json
- `--no-log` 可跳过记录


## 请求速率限制

**所有发布/读取类操作的间隔与并发约束统一在 [`reply-strategy.md` §2.4](./reply-strategy.md) 定义。**
SKILL.md 不再重复，避免两份说明漂移。

要点：

- 串行执行，禁并发
- 每条命令之间 sleep 随机 40–55 秒（写操作）/ 30–50 秒（读操作）
- 带 sleep 的 Bash 调用记得设 `timeout: 120000`
