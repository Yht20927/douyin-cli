---
name: douyin-cli
description: 抖音 CLI 命令手册 — 只说明命令怎么调用（参数/输出/错误码）。作品、用户作品、搜索、评论(含嵌套回复)、发评论/回复(含图片)、点赞、删除、下载、私信、AI 生成、记忆层查询、仪表盘。Bridge Framework（油猴 + WebSocket）。
---

# 抖音 CLI

本 skill 只描述命令如何调用，不含业务策略。

命令一律在 skill 目录下执行（`~/.claude/skills/douyin-cli/` 或 `~/project/douyin-cli/`，两份等价）：

```bash
cd ~/.claude/skills/douyin-cli
```

- Bridge Server 端口 `19422`；配置在 `config.json`（缺省时 `cp config.example.json config.json`）。

## 前置条件

```bash
bash scripts/bridge.sh ensure   # 幂等地保证 Bridge Server 在线；返回 0 = 在线
node cli.js help                # 打印全部命令
```

浏览器侧需：Tampermonkey 启用 + 已装 `scripts/douyin.user.js` + 打开并登录 `douyin.com` 任意页面。

确认油猴已连上：

```bash
curl -s http://127.0.0.1:19422/api/status | grep -o '"douyin.com"' || echo OFFLINE
```

输出 `OFFLINE` 时刷新 `douyin.com` 页面 / 检查 Tampermonkey 是否启用 / 重装 `scripts/douyin.user.js`。重启 server 不会修好油猴未连接。

`scripts/bridge.sh stop` 只能在首次 `start` 的目录执行（PID 文件所在侧）；server 是常驻的，跨 session 复用，通常不需要 stop。

## 调用约束

- 命令**串行**执行，不得并发。
- 写操作（`post` / `like` / `delete-comment` / 图片上传）由 `risk-control` 硬强制 40-55 秒随机间隔：调用会阻塞等待后才返回，**不要在外面再叠加 sleep**。带等待的 Bash 调用把 `timeout` 设到 120000 以上。`--no-throttle` 可跳过节流（调试用）。
- 读操作（`get` / `search` / `replies` / `my` / `user` / `download`）不内置节流。
- 间隔**按账号分桶**：A 号刚发完不影响 B 号的节奏窗口。

## 多账号

一个浏览器容器/窗口登录一个账号，油猴脚本探测当前登录 uid 并据此注册连接（`channel = douyin.com#<uid>`）。服务端按账号分别持有连接，可同时在线多个。

**未登录的标签页不会连接**：油猴只认 `/aweme/v1/web/query/user/` 接口返回的 uid（不走 cookie/localStorage 兜底——`UIFID` 之类的残留值在同设备多账号下甚至会把两个号算成同一个）。拿不到 uid 就不注册，每 15 秒重试；登录后自动接入。服务端也拒收无账号的连接。

> ⚠️ **改协议后必须重装油猴脚本**：脚本头部没有 `@updateURL`，Tampermonkey 不会自动更新。旧脚本注册时不带 `account` 字段，会被服务端以 `client_outdated` 拒掉——**表现就是"明明登录了却连不上"**。每个浏览器容器/资料都要各自重装 `scripts/douyin.user.js`。服务端会区分两种情况：
> - `client_outdated` = 完全没带 account → 脚本太旧，去重装
> - `account_required` = account 是空串 → 该标签页没探测到登录态，去登录
>
> **怎么自证脚本是新的**：脚本会把注册契约版本（`clientVersion`）随注册上报，`accounts` 里能看到。版本对不上时 `accounts` 会标 `scriptOutdated: true`，每次调用的横幅也会打一行 `⚠ … 的油猴脚本不是最新版 … 去 Tampermonkey 重装 scripts/douyin.user.js`。这是「脚本太旧」与「新脚本但探测失败」的唯一区分手段——两者在服务端都表现为字段为空。

每次调用都会往 **stderr** 打一行账号横幅（stdout 的 JSON 不受影响）：

```
$ node cli.js get <aweme_id>
[账号] 在线 2：主号(ACC_A)、ACC_B（读操作按账号轮换）
[账号] 本次由 主号(ACC_A) 服务
{ ...JSON... }

$ node cli.js post <aweme_id> "内容" --account 主号
[账号] 指定 主号(ACC_A)（在线 2：主号(ACC_A)、ACC_B）
{ ...JSON... }
```

**展示名优先级：别名 > 平台昵称 > uid**（括号里始终带 uid，它是唯一能被 `--account` 精确定位的标识）。昵称随注册上报，**仅用于展示**——不参与 `--account` 寻址（昵称会改、也可能重名）。

昵称来源（douyin）：只读零请求的 `localStorage.user_info`，且**必须与严格探测出的 uid 一致**才采用——那份本地数据可能是别的账号或登出残留写下的，uid 对不上就宁可不要昵称，也不能把 A 号的名字挂到 B 号上。拿不到就留空，不影响接入。

> `/aweme/v1/web/query/user/` 换哪组参数都只回顶层 `{id, user_uid, user_uid_type, status_code}`，**没有昵称、也没有 `user` 对象**——别想从这个接口要昵称或 `sec_uid`。昵称读本地来源（`localStorage.user_info`，与严格 uid 对齐）；`sec_uid` 读 `/aweme/v1/web/user/profile/self/` 的 `user.sec_uid`（见下）。

```jsonc
// node cli.js accounts
{ "id": "主号", "account": "1179139456380456", "nickname": "Ya 小九.", "alias": "主号", "online": true }
{ "id": "小号B", "account": "123456789", "nickname": "小号B", "alias": null, "online": true }
```

无账号在线时会提示 `[账号] 无账号在线 — 确认浏览器已登录对应账号并打开站点页面`。设 `DOUYIN_NO_ACCOUNT_BANNER=1` 可关掉横幅。

| 场景 | 行为 |
|------|------|
| 公共读操作未指定 `--account` | 服务端按账号**轮换**（每号独立冷却；刚写过的号排到后面）；**同一条命令内钉扎**——首个子请求选中哪个号，后续分页/子调用都跟着它，避免跨号拼 cursor |
| 读操作指定 `--account` | 精确路由到该账号，找不到就报错（**不会**回退到别的账号） |
| 写操作 / 读取自身数据（`my`、`dm list`、`dm listen`）未指定 `--account`，在线账号 > 1 | 直接报错退出，列出可用账号 |
| 同上，在线账号 = 1 | 自动采用该账号（保持单账号时的旧行为） |

> **为什么 `my`/`dm list` 与写操作同等待遇**：它们返回的是「当前账号自己」的数据，多号下不指定就是「随机挑一个号的作品/私信当成通用结果」，必须显式指定。

```bash
node cli.js accounts                              # 列出账号：id / account / nickname / alias / 在线 / 最近服务时间
node cli.js accounts alias <uid> 主号              # 给账号起别名，之后 --account 主号 即可

node cli.js --account 主号 get <aweme_id>          # 用指定账号拉评论
node cli.js search "关键词" --account <uid>          # 别名和 uid 都收
node cli.js post <aweme_id> "内容" --account 主号    # 写操作：多账号时必须显式指定
```

`--account` 也可用环境变量 `DOUYIN_ACCOUNT` 提供（`campaign` 的 daemon 子进程靠它继承身份）。

**跨账号的共享与隔离**：

- 「已回复 cid」（`comments.replied`）与回复语料（`reply_corpus`）**全局共享**——任一账号回过的评论，其他账号都不会再回。
- 事件（`events`）、草稿（`drafts`）、活动（`campaigns`）按账号记录。`events.account` 记的是**实际服务该次调用的账号**（含按轮换落到的号）。
- 视频（`videos`）的 `is_mine` 是**归属声明**，`videos.account` 记它属于哪个号（非 is_mine 的视频为 NULL）。
- **本地查询命令 `log` / `events` / `dashboard` / `profile` 也吃 `--account`**：作为过滤条件只看该账号的记录；不指定 = 全部账号。
- 油猴端收到写操作时会先比对自身登录账号，不一致则**拒绝执行**并把错误回传（防止容器/登录态切换的竞态用错号发评论）。

不用浏览器也能验一遍服务端契约（起临时 server + 两个假客户端，跑完自动收尾）：

```bash
node scripts/smoke-accounts.js
```

## 命令

### 作品与用户

```bash
node cli.js my                                   # 我的作品（多账号必须 --account：读的是「哪个号」自己的作品）
node cli.js my --count 20
node cli.js my --account 主号                     # 多账号下指定是哪个号
# sec_uid 来源：权威来源 = /aweme/v1/web/user/profile/self/ 回包的 user.sec_uid（随会话走，
#   天然是当前账号）；接口失败才退回本地来源并做 uid 对齐（CLI 把 --account 落到的号经
#   myPosts 第 3 参传入）。取不到就**明确报错**，不再用空 sec_user_id 静默查询。

node cli.js user <sec_user_id>                   # 任意用户主页作品
node cli.js user <主页URL>                        # URL 形式亦可
node cli.js user <sec_user_id> --count 18
node cli.js user <sec_user_id> --cursor 1782389806000   # 翻页，用上次返回的 max_cursor
```

`user` 输出：

```json
{
  "user": { "uid": "2988943290152652", "sec_uid": "MS4wLjAB...", "nickname": "Ya 小九." },
  "has_more": 1, "max_cursor": 1783213200000, "min_cursor": 0, "count": 6,
  "aweme_list": [{
    "aweme_id": "7631450655144736931", "desc": "...", "time": 1776835569,
    "duration": 37408, "is_top": true,
    "stats": { "plays": 0, "likes": 18600, "comments": 109, "shares": 513, "collects": 1123 },
    "cover": "https://..."
  }]
}
```

- `count` 是建议值，实际可能略多（置顶 `is_top=true` 不占配额）；他人作品 `plays` 恒为 0（接口限制）。
- 他人作品以 `isMine=false` 落库并记录 `author_uid`。

### 搜索视频

```bash
node cli.js search "周杰伦"
node cli.js search "周杰伦" --offset 10 --count 20
```

```json
[{ "aweme_id": "7533234103531261243", "desc": "...", "author": "瓶妞Lottie英语",
   "uid": "83925411173", "time": 1754007300, "plays": 0 }]
```

搜索接口不返回播放/点赞数（`plays` 恒为 0）。

### 获取评论

```bash
node cli.js get <aweme_id>                          # 默认 1 页 20 条
node cli.js get <aweme_id> --pages 5
node cli.js get <aweme_id> --count 20
node cli.js get <aweme_id> --all                    # 全部一级评论
node cli.js get <aweme_id> --all --depth 1          # 含嵌套回复（每条最多 50 条）
node cli.js get <aweme_id> --all --depth 1 --reply-limit 20
node cli.js get <aweme_id> --new                    # 增量：上次成功 get 之后的新评论
node cli.js get <aweme_id> --new --depth 1
node cli.js get <aweme_id> --since 1780238354        # 增量：create_time > 指定 Unix 秒
```

`--depth 1` 递归一层、`--depth 2` 递归两层。`--new` 依据审计日志中该视频上次成功 `get` 的时间戳，无历史时退化为全量。

`--depth 1` 时每条一级评论带 `children`：

```json
[{ "cid": "7646...", "text": "一级评论内容", "likes": 1, "replies": 3, "time": 1780238354,
   "user": { "nickname": "用户", "uid": "123", "avatar": "https://..." },
   "children": [{ "cid": "7647...", "text": "回复内容", "likes": 0, "replies": 0,
                  "time": 1780239000, "user": { "nickname": "回复者", "uid": "456", "avatar": "https://..." } }] }]
```

### 单条评论的回复列表

```bash
node cli.js replies <cid> <aweme_id>
node cli.js replies <cid> <aweme_id> --count 20 --cursor <ts>
```

输出格式同 `get` 的结果项（无 `children`）。

### 发表评论 / 回复

```bash
node cli.js post <aweme_id> "好看！"
node cli.js post <aweme_id> "说得对" --reply-to <cid>
node cli.js post <aweme_id> "@1179139456380456 内容" --reply-to <cid> --at <uid> <sec_uid>
node cli.js post <aweme_id> "回复子回复" --reply-to <cid> --reply-to-reply <rrid>
```

输出：

```json
{ "cid": "7646...", "text": "好看！", "time": 17802..., "status": "published" }
```

失败时返回 `{ "error": "status_code=8" }`。文本中的引号会被自动转义。

`post` 是写操作，受 40-55s 间隔约束并计入风控断路器。

### 图片评论

```bash
node cli.js post <aweme_id> "这个封面绝了" --image cover.jpg
node cli.js post <aweme_id> "看下我的版本" --reply-to <cid> --image v1.png
node cli.js post <aweme_id> "对比一下" --image a.jpg,b.jpg,c.jpg   # 可重复 / 逗号分隔
node cli.js upload-image --image cover.jpg                        # 只上传不发，返回 uri
```

```json
{ "cid": "7646...", "text": "这个封面绝了", "status": "published",
  "images": [{ "uri": "tos-cn-i-xxx/abc", "width": 240, "height": 180, "format": "jpeg" }],
  "image_count": 1 }
```

`upload-image` 输出 `{ "uri": "...", "width": 240, "height": 180, "format": "jpeg", "size": 494 }`。

- 格式：`jpg` / `jpeg` / `png` / `webp` / `gif` / `bmp` / `heic`，单张 ≤ 10MB。
- 返回 `image_count: 0` 且带 `warning` → 服务端回包没带图，图片没挂上，但评论已按纯文本发出。
- 图片评论是灰度能力，账号或视频未开放时接口直接拒绝。

### 点赞 / 取消点赞

```bash
node cli.js like <aweme_id>
node cli.js like <aweme_id> --unlike
```

```json
{ "aweme_id": "7629735841874726179", "action": "liked", "status": "success", "status_code": 0 }
```

### 删除评论

```bash
node cli.js delete-comment <cid>
```

```json
{ "cid": "7649651851377640192", "status": "deleted", "status_code": 0 }
```

只能删自己发表的评论。

### 下载视频

```bash
node cli.js download <aweme_id>
node cli.js download <aweme_id> --audio-only    # 仅 BGM
node cli.js download <aweme_id> --out ~/Videos
```

默认存到 `./downloads/`，文件名 `<aweme_id>_<作者>_<标题>.mp4`；`--out` 目录不存在会自动创建。默认超时 120s。

```json
{ "awemeId": "...", "title": "...", "author": "...",
  "files": [{ "type": "video", "path": "./downloads/xxx.mp4", "size": 12345678 },
            { "type": "audio", "path": "./downloads/xxx_audio.mp3", "size": 1234567 }] }
```

### LLM 分析 / 建议

```bash
node cli.js analyze <aweme_id> [--mode text-only|screenshots|video] [--screenshots N] [--all] [--depth N] [--force]
node cli.js suggest <aweme_id> [--auto] [--force] [--fast] [--min-priority N] [--interval ms]
                             [--mode text-only|screenshots|video] [--screenshots N] [--reply-to <cid>]
```

- `analyze` 返回 `[{ "cid", "sentiment", "category", "priority", "summary" }]`。
- `suggest` 生成回复建议，`--auto` 自动发布。
- 两者默认跳过 `comments.replied=1` 的 cid；`--force` 覆盖跳过。
- 需 `config.json` 中的 `llm.api_key`。

### AI 回复生成（ReplyEngine）

```bash
node cli.js getReply <aweme_id>                      # 生成视频顶级评论（只输出文本，不发布）
node cli.js getReply <aweme_id> <cid>                # 生成对特定评论的回复
node cli.js getReply <aweme_id> --count 3            # 多条候选
node cli.js getReply <aweme_id> --persona <id>       # 指定人格
node cli.js getReply <aweme_id> --batch              # 对未回复评论批量生成
node cli.js getReply <aweme_id> <cid> --interactive  # 生成→编辑→发布
```

`--persona` 取值：`casual_friend` / `curious_asker` / `experienced_sharer` / `enthusiastic_fan` / `thoughtful_critic` / `humor_maker` / `brief_reactor`。

### 草稿

```bash
node cli.js draft list [--video <aweme_id>]
node cli.js draft save <aweme_id> "文本" [--reply-to <cid>] [--persona <id>]
node cli.js draft show <draft_id>
node cli.js draft post <draft_id>
node cli.js draft delete <draft_id>
```

### 私信

```bash
node cli.js dm send <sec_user_id> "私信内容"
node cli.js dm listen [--timeout N]
node cli.js dm list
```

### 记忆层查询

```bash
node cli.js profile <uid> [--account <uid|别名>] # 用户交互历史（事件流；--account 只看该号）
node cli.js whois <uid>                        # 用户全量画像（评论 + 我的回复 + 标签）
node cli.js note <uid> [--tier vip|normal|blacklist|spam] [--tag T] [--untag T] [--notes "..."] [--clear]
node cli.js events [--tail N] [--video <id>] [--uid <uid>] [--cmd <cmd>] [--status success|error] [--since <ts>] [--json] [--account <uid|别名>]
node cli.js corpus <search|recent|stats> [...] [--limit N] [--video <id>]
node cli.js replied [--json] [--aweme <aweme_id>] [--count]
node cli.js comment <cid>                      # 查询单条评论实体
node cli.js failures [--limit N] [--recent] [--mitigate <sig> "<缓解措施>"]
node cli.js dedup "<候选文本>"                   # 是否发过
node cli.js cleanup [--days 90] [--dry-run]
```

### 节奏与事实守卫

```bash
node cli.js preflight            # 当前节奏状态（距上次写 / 距下次可写）
node cli.js preflight post       # 预检某命令当前是否可执行

node cli.js repo-info [<owner/repo>] [--refresh] [--json]   # 默认 Yht20927/douyin-cli；缓存 1h
node cli.js factcheck "<文本>"                                # 校对文本中的 star 数/仓库名/版本号
```

### 模拟浏览 / 仪表盘 / 日志

```bash
node cli.js browse [--max-notes N] [--count N] [--pages N] [--like-chance 0.2] [--fast]

node cli.js dashboard [--video <aweme_id>] [--days 14] [--account <uid|别名>]   # 生成本地 HTML 并自动打开

node cli.js log [--tail N] [--video <aweme_id>] [--uid <uid>] [--command <cmd>] [--failed] [--account <uid|别名>]
```

### 推广活动（campaign）

```bash
node cli.js campaign create --name "618新品" --videos v1,v2 --daily-quota 20 [--goal ...] [--per-user-quota N]
node cli.js campaign plan <id> [--pages N] [--min-priority N]
node cli.js campaign run <id> [--limit N] [--daemon] [--no-throttle]
node cli.js campaign pause <id> | resume <id> | stop <id>
node cli.js campaign status <id> | list
```

`run --daemon` 以 detached 子进程跑 `run`，PID 写 `storage/campaign-<id>.pid`，日志写 `logs/campaign-<id>.log`。`stop` 杀 daemon + 清 PID + 置 paused（幂等）。未被执行的 task 保持 pending，下次 `run` 续跑。

### 账号

```bash
node cli.js accounts                              # 列出账号（uid / 别名 / 在线 / 最近服务时间）
node cli.js accounts alias <uid> <别名>             # 设置别名（写回 config.json）
```

### 提示词模板

```bash
node cli.js validate-prompts [<template>]   # 校验 prompts/ 下模板格式
```

模板位于 `prompts/`：`analyze.md` / `suggest.md` / `comment.md` / `reply.md` / `replies-batch.md` / `partial-reply-strategy.md`。修模板后跑 `validate-prompts`。

## 通用选项

| 选项 | 作用 |
|------|------|
| `--raw` | 原始输出 |
| `--no-log` | 本次不写审计日志 |
| `--no-throttle` | 跳过写操作的 40-55s 节流（调试用） |

## 错误码与返回语义

| 返回 / 症状 | 含义 |
|-------------|------|
| `status_code=8` | 评论被拦截（内容过短 / 重复 / 风控） |
| `status_code=3002121` | 内容级拦截；不触发风控断路器 |
| `status_code` 非 0（like / delete-comment） | 风控或参数错误 |
| `Bridge Server not running` / `ECONNREFUSED` | Bridge Server 未启动 → `bash scripts/bridge.sh ensure` |
| `No connection for site 'douyin.com'` | 油猴未连接：刷新 douyin.com 页面 / 检查 Tampermonkey |
| `Unauthorized` | `config.json` 的 `bridge.token` 不匹配 |
| `HTML 页面` / `非 JSON` / `空响应` | 油猴侧非 JSON 返回，通常需刷新 douyin.com 页面 |
| 搜索结果 `[]` | 油猴 bridge 未加载，刷新 douyin.com 页面等自动重连 |
| 多个 douyin 连接 | 存在 iframe 或多 tab，Server 自动选第一个活跃连接 |
| `post` 返回 published 但页面上看不到 | comment.status:7 审核中，等 1-2 分钟再看 |
| 回复贴纸评论看不到 | 贴纸评论不支持文字回复 |
| `--new` 无历史记录时拉全量 | 首次 `--new` 等价于 `--all` |
| 下载无 URL | 视频已删除 / 私密 / 被限流 |

## 结果与日志落盘

```
logs/
├── audit.json                      操作元数据（sessions → operations → apiCalls）
└── results/
    ├── get-<aweme_id>-<ts>.json    评论获取完整结果
    └── search-<kw>-<ts>.json       搜索结果
```

- 每条操作记录命令、参数、起止时间、耗时、成功/失败、摘要；每个 API 调用记录端点、参数、耗时、返回条数。
- 大结果（`get` / `search` / `my` / `replies`）落地为独立 JSON；小结果（`post` / `like` / `delete-comment` / `download` / `ping` / `stop`）内联在 `audit.json`。

## 数据落盘

SQLite 记忆层在 `storage/douyin.db`（WAL）。注意本 skill 在 `~/.claude/skills/douyin-cli/` 与 `~/project/douyin-cli/` 各有一份，**两张库互相独立**——跨目录查询会漏数据。
