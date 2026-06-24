---
name: douyin-cli
description: 抖音评论 CLI — 作品列表 / 搜索视频 / 获取评论(含嵌套回复) / 发表回复评论 / 点赞取消点赞 / 删除评论 / 下载视频(含音频)。Bridge Framework（油猴+HTTP轮询）方案。
---

# 抖音运营 Skill

## ⚠️ 核心安全规则（违反任意一条 → 立即停止本轮）

> **以下规则具有最高优先级，必须在每个执行步骤中严格遵守。**

### 🔴 规则 1：命令串行 + 强制随机间隔

```
┌─────────────────────────────────────────────────────────────┐
│  ❌ 严禁并发执行任何 CLI 命令                                  │
│  ❌ 严禁使用固定间隔（必须每次重新随机）                         │
│  ❌ 严禁跳过 sleep（即使"感觉"不需要）                          │
│                                                              │
│  ✅ 所有命令必须逐条串行执行                                   │
│  ✅ 写操作（post/like/delete-comment）：40-55 秒随机间隔        │
│  ✅ 读操作（get/search/replies/my/download）：30-50 秒随机间隔  │
│  ✅ 每次等待前必须重新生成随机数                                │
└─────────────────────────────────────────────────────────────┘
```

**强制执行模板**（复制使用，不要修改结构）：

```bash
# ═══ 执行单条命令的模板（写操作）═══
execute_with_delay() {
  local cmd="$1"
  local type="${2:-write}"  # write 或 read
  local delay
  
  if [ "$type" = "read" ]; then
    delay=$((30 + RANDOM % 21))  # 30-50 秒随机值
  else
    delay=$((40 + RANDOM % 16))  # 40-55 秒随机值
  fi
  
  echo "▶ 执行: $cmd"
  eval "$cmd"
  
  if [ $? -eq 0 ]; then
    echo "✓ 成功，等待 ${delay} 秒..."
    sleep "$delay"
  else
    echo "✗ 失败，跳过等待"
  fi
}

# ═══ 使用示例 ═══
execute_with_delay 'node cli.js search "AI Agent" --count 20' read
execute_with_delay 'node cli.js get <aweme_id> --all --depth 1' read
execute_with_delay 'node cli.js post <aweme_id> "评论内容"'
```

**为什么必须这样做**：
- 抖音对高频操作敏感，并发或过快间隔会触发风控
- 风控后果：限流、验证码、封号
- 宁可慢不可快 — 如果拿不准，取更长的间隔

### 🔴 规则 2：不重复回复

```
┌─────────────────────────────────────────────────────────────┐
│  ❌ 同一条评论 cid 一生只能被回复一次（跨日跨轮均生效）           │
│  ❌ 同一作者短期内不重复（≥ 7 天冷却期）                        │
│                                                              │
│  ✅ 执行前必须初始化 REPLIED_CIDS 集合                         │
│  ✅ 每次回复前必须检查 cid 是否在集合中                         │
│  ✅ 回复成功后必须将 cid 加入集合                               │
└─────────────────────────────────────────────────────────────┘
```

**强制执行流程**：

```bash
# ═══ Step 1: 初始化 REPLIED_CIDS ═══
# 从 SQLite comments 表获取所有已回复的 cid
node cli.js replied > /tmp/replied_cids.txt

# ═══ Step 2: 检查是否已回复 ═══
is_replied() {
  local cid="$1"
  grep -q "$cid" /tmp/replied_cids.txt 2>/dev/null
  return $?
}

# ═══ Step 3: 回复前检查 ═══
if is_replied "target_cid"; then
  echo "⏭ 跳过：已回复过该评论"
else
  execute_with_delay 'node cli.js post <aweme_id> "内容" --reply-to target_cid'
  echo "target_cid" >> /tmp/replied_cids.txt  # 记录已回复
fi
```

### 🔴 规则 3：内容禁令

```
❌ 不直贴完整 GitHub 链接（抖音会限流）
   ✅ 可写"GitHub 上搜 yht20927"或"主页有链接"

❌ 不承诺效果、不透露隐私、不攻击他人、不竞品贴脸
❌ 不发纯广告、刷屏、诱导点击
❌ 不提具体收益、保证效果
❌ 不使用同一份固定模板连发（每轮 ≥ 3 种风格）
```

## 前置条件

- 浏览器已安装 Tampermonkey + `scripts/douyin.user.js` 油猴脚本
- 浏览器已打开 `douyin.com` 任意页面并**登录抖音**
- 零依赖：无需 `npm install`

## 通用选项

## 文件结构

本 Skill 由以下模块组成，执行前按顺序加载：

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
node cli.js my --count 20
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

## 文件结构

| 文件 | 作用 | 何时加载 |
|------|------|----------|
| `用户配置.md` | 账号信息、基础配置 | 每次执行 |
| `全局规则.md` | 硬性禁令、评论筛选规则、安全规则 | 每次执行 |
| `执行模板.md` | **必须使用的执行模板和函数** | 每次执行 |
| `快速参考卡.md` | 快速查阅必须记住的规则和函数 | 每次执行 |
| `评论风格指南.md` | 抖音评论风格模板 | 生成评论时 |
| `评论区运营.md` | 工作流：自有视频评论区运营 | 执行评论区运营任务时 |
| `推广引流.md` | 工作流：针对特定目标推广 | 执行推广任务时 |

## 评论筛选规则

评论筛选规则已整合到 `全局规则.md` 第 4 节，包含：
- **跳过类型**：纯表情/贴纸、简短感叹、无意义水评
- **优先回复类型**：提问求助、高质量反馈、负面情绪
- **判断标准**：有实质内容、可能引发讨论、话题相关、能体现价值

`推广引流.md` 在此基础上增加了推广场景专用的筛选规则（视频筛选 + 评论筛选）。

## 执行协议

### 1. 启动前检查（必须全部完成）

```
□ 加载 用户配置.md
□ 加载 全局规则.md（含评论筛选过滤规则）
□ 加载 执行模板.md（必须使用的执行模板和函数）
□ 确认 Bridge Server 在线：bash ~/.claude/skills/douyin-cli/scripts/bridge.sh ensure
□ 确认油猴连接：node cli.js status
□ 初始化 REPLIED_CIDS 集合（使用执行模板.md中的 init_replied_cids 函数）
```

### 2. 工作流选择

根据任务目标选择对应工作流：

- **评论区运营**：提升互动率、活跃评论区 → 加载 `评论区运营.md`
  - 适用场景：自有视频评论回复、互动提升
  - 核心流程：获取我的作品 → 获取评论 → 筛选 → 回复

- **推广引流**：针对特定话题/作者、引导流量 → 加载 `推广引流.md`
  - 适用场景：推广自己的内容、与目标作者互动
  - 核心流程：确定目标 → 搜索/筛选 → 生成推广内容 → 评论/回复

### 3. 评论生成

生成评论时加载 `评论风格指南.md`，确保符合抖音社区调性：
- 评论区运营：优先使用热情分享型、共鸣互动型、轻松调侃型
- 推广引流：优先使用专业解读型、解答引导型、价值分享型

### 4. 执行后记录

每个工作流执行完成后，输出执行报告（参考各工作流的 Step 6/7）。

## 与 douyin-cli 的关系

本 Skill 负责**策略层**（决定做什么、怎么做），douyin-cli 负责**执行层**（实际调用 API）。

```
本 Skill（策略）→ 生成指令 → douyin-cli（执行）→ 调用 API → 抖音
```

## 命令映射

| Skill 动作 | CLI 命令 |
|------------|----------|
| 搜索视频 | `node cli.js search "关键词"` |
| 获取评论 | `node cli.js get <aweme_id> --all --depth 1` |
| 获取增量评论 | `node cli.js get <aweme_id> --new --depth 1` |
| 发表评论 | `node cli.js post <aweme_id> "内容"` |
| 回复评论 | `node cli.js post <aweme_id> "内容" --reply-to <cid>` |
| 点赞视频 | `node cli.js like <aweme_id>` |
| 查看日志 | `node cli.js log --tail 20` |

**⚠️ 重要：增量获取评论优先使用 `--new`**
- ❌ 错误：每次全量获取所有评论（浪费请求，可能触发风控）
- ✅ 正确：`node cli.js get <aweme_id> --new --depth 1`（只获取新评论，安全高效）

## 执行检查清单

**每执行 5 条命令后，必须检查**：
- [ ] 是否所有命令都是串行执行的？
- [ ] 写操作每条命令之间是否等待了 40-55 秒？
- [ ] 读操作每条命令之间是否等待了 30-50 秒？
- [ ] 是否检查了 REPLIED_CIDS？
- [ ] 是否使用了 ≥ 3 种不同风格？
- [ ] 是否违反了内容禁令？

**如果发现违规**：立即停止本轮，记录原因到执行报告。