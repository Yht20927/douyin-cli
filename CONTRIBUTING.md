# Contributing

> 适用版本: v3 · 最后更新: 2026-07-07 · 维护者: Yht20927

感谢参与 douyin-cli！本文档说明如何搭建开发环境、跑测试、以及代码约定。

---

## 开发环境

```bash
git clone https://github.com/Yht20927/douyin-cli.git
cd douyin-cli
npm install            # better-sqlite3 原生模块，需预编译
cp config.example.json config.json   # 填 bridge.token + llm.api_key

# Bridge Server（常驻，跨 session 复用）
bash scripts/bridge.sh ensure

# Chrome 装 Tampermonkey + scripts/douyin.user.js，打开 douyin.com 并登录
node cli.js my          # 验证连通
```

依赖：Node.js 18+、Chrome + Tampermonkey、（可选）OpenAI 兼容 LLM key。

---

## 测试

```bash
npm test               # = vitest run，全量
npm run test:watch     # 监听模式
npx vitest run tests/p4-campaign.test.js   # 单文件
```

测试隔离约定（见 `tests/*.test.js` 的 `withTempProject`）：
- `DOUYIN_STORAGE_DIR` / `DOUYIN_LOG_DIR` 指向临时目录，不污染主项目 `storage/`
- `vitest.config.js` 设 `DOUYIN_NO_THROTTLE=1`，防 `risk-control` 守卫阻塞测试
- 每个 test file 独立 require cache 清理，保证模块状态隔离

**CI**（`.github/workflows/test.yml`）：push / PR 到 `main` 时在 Node 18 跑 `npm test`。提 PR 前请本地确保全绿。

---

## 代码结构

```
cli.js                    CLI 入口（命令路由 + help）
server.js                 Bridge Server
lib/commands/             命令模块（每命令一文件）
lib/commands/index.js     命令注册表
lib/memory/               SQLite 记忆层（db/events/users/comments/videos/corpus/failures/campaigns）
lib/risk-control.js       请求节奏守卫 + 自适应风控
lib/llm.js                LLM 客户端（人格化 + 上下文注入）
lib/jitter.js             节奏与拟人化延迟
lib/dashboard.js          HTML 仪表盘
scripts/douyin.user.js    油猴脚本（页面上下文 fetch）
scripts/_template.user.js 新站点油猴脚本模板
```

---

## 约定

### 新增 CLI 命令
1. `lib/commands/<name>.js` — 导出 `async function cmdX(ctx, args) {...}`
2. 注册到 `lib/commands/index.js`
3. 加 help 行到 `cli.js` 的 `printHelp()`
4. 命令间调用走 `ctx.cmdX([...])`（延迟绑定，见 `cli.js` 的 `ctx`）

### 记忆层（`lib/memory/*`）
- **写操作 try/catch，失败返回 false/null，不抛异常**（主流程不被 SQLite 拖垮）
- 所有表带 `platform TEXT NOT NULL DEFAULT 'douyin'`，主键/UNIQUE 用 `(platform, *)` 复合形式（为跨平台预留）
- corpus 文本匹配走 `md5(normalize(text))`
- failures 用 `(platform, signature)` UPSERT 累加 hit_count

### Schema 迁移
1. `lib/memory/db.js` 的 `migrations` 数组追加 `() => { db.exec('CREATE TABLE IF NOT EXISTS ...') }`，**必须幂等**
2. `SCHEMA_VERSION` +1
3. 迁移前会自动备份 `douyin.db.bak.<v>`，WAL checkpoint
4. 补测试到对应 `tests/p<N>-*.test.js`

### 节奏守卫（`lib/risk-control.js`）
- 间隔单一源 = `config.json:intervals`（write 40-55s / read 30-50s）
- 写命令入口调 `enforceDelay('write')`；命令内部调用（suggest/campaign）传 `--no-throttle` 由各自节奏接管
- 新增写命令记得接线 `enforceDelay`，否则守卫失效

### 提交信息
沿用现有风格：`feat:` / `fix:` / `docs:` / `chore:` / `refactor:` + 简述（中英不限）。末尾保留 `Co-Authored-By` 行。

---

## 新增站点（油猴脚本）

参考 `scripts/_template.user.js`：实现 `window.__bridge` 的 site 适配，`CONFIG.site` 设为新域名，复用 Bridge Server。记忆层通过 `platform` 字段区分。

---

## 提 PR

1. 从 `main` 切分支
2. 确保本地 `npm test` 全绿
3. PR 描述写清动机 + 测试方式
4. 涉及 schema 变更务必说明迁移路径
