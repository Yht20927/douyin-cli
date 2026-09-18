---
version: alpha
name: douyin-tool-design
description: "A warm-charcoal desktop tool for a single operator babysitting a publishing cadence. The canvas is warm near-black (#2b2622) rather than the category's usual cold gray; text is warm off-white (#f7f5f0) in a four-step ladder. Saturation is reserved entirely for status: the screen's only chromatic element is the can-send / waiting / blocked triad plus its tints. Buttons, selection and focus rings are all neutral. Type is the system CJK stack at 13px, with tabular-numerals monospace for anything numeric — countdowns, IDs, quota counters — because in this UI the numbers ARE the information."
colors:
  canvas: "#2b2622"
  surface-1: "#252120"
  surface-2: "#383330"
  surface-3: "#423c37"
  surface-4: "#4d4642"
  hairline: "#3f3a36"
  hairline-strong: "#55504a"
  ink: "#f7f5f0"
  ink-2: "#c9c0ad"
  ink-3: "#aea69c"
  ink-4: "#7d766d"
  status-ok: "#5cbe8b"
  status-wait: "#d9a33f"
  status-bad: "#de6a5e"
  status-info: "#7ba7d4"
  on-primary: "#2b2622"
typography:
  page-title:
    fontFamily: system CJK stack
    fontSize: 20px
    fontWeight: 600
  band-word:
    fontFamily: system CJK stack
    fontSize: 17px
    fontWeight: 600
  countdown:
    fontFamily: ui-monospace / SF Mono / Consolas
    fontSize: 30px
    fontWeight: 600
  body:
    fontFamily: system CJK stack
    fontSize: 13px
    lineHeight: 1.55
  caption:
    fontSize: 12px
  micro:
    fontSize: 11px
  numeric:
    fontFamily: ui-monospace / SF Mono / Consolas
    fontSize: 12px
    fontVariantNumeric: tabular-nums
rounded:
  xs: 3px
  sm: 4px
  md: 6px
  lg: 10px
  pill: 9999px
spacing:
  s1: 4px
  s2: 8px
  s3: 12px
  s4: 16px
  s5: 24px
  s6: 32px
  s7: 48px
  s8: 64px
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.sm}"
    padding: 6px 13px
  button-primary-hover:
    backgroundColor: "#fffdf8"
  button-secondary:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.ink}"
    border: "1px solid {colors.hairline-strong}"
    rounded: "{rounded.sm}"
  button-quiet:
    backgroundColor: transparent
    textColor: "{colors.ink-2}"
  text-input:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    border: "1px solid {colors.hairline-strong}"
    rounded: "{rounded.sm}"
  list-row:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    borderTop: "1px solid {colors.hairline}"
  band:
    backgroundColor: "{colors.surface-2}"
    border: "1px solid {colors.hairline}"
    rounded: "{rounded.md}"
    accentBar: "3px, status color"
  progress-track:
    backgroundColor: "{colors.surface-3}"
    height: 4px
    rounded: "{rounded.pill}"
  progress-fill:
    backgroundColor: "{colors.ink-3}"
    transition: "width .3s ease-out"
  toast:
    backgroundColor: "{colors.surface-3}"
    border: "1px solid {colors.hairline-strong}"
    rounded: "{rounded.md}"
    shadow: "{shadow.2}"
  modal:
    backgroundColor: "{colors.surface-2}"
    border: "1px solid {colors.hairline-strong}"
    rounded: "{rounded.lg}"
    shadow: "{shadow.2}"
shadow:
  1: "0 1px 2px rgba(0,0,0,.35)"
  2: "0 8px 24px rgba(0,0,0,.45)"
---

# DESIGN.md — 抖音评论运营助手

> 这份文件是给**改这个项目界面的人（或 agent）**读的。
> 所有值都在 `app/renderer/src/styles.css` 的 `:root` 里，这里不重复第二份数字 ——
> 两边不一致时以 CSS 为准，并回来改这里。

## Overview

这是一个**单人长时间盯着的桌面工具**，不是网站、不是仪表盘。

它的存在意义只有一件事：让人安全地守在发布节奏里。所以界面所有设计决策的
第一优先级是「**现在能不能发**」这一条信息够不够突出，而不是"页面好不好看"。

设计语言取自 **Warp**（暖炭灰）那一系的深色工具界面：暖色画布、极淡的发丝线、
偏紧的圆角、克制的层级。选它而不是 Linear / Raycast 那一路冷灰，有两个具体理由：

1. **暖色长时间盯屏更不容易累**，而冷灰在深色下容易显廉价 —— 这是被用户
   直接抱怨"UI 很丑"之后换的。
2. **它是同类里唯一给出应用级组件规格的**（列表行、模态框、空态、通知、
   表格单元格），而不是只有配色和按钮。这个项目缺的正是这些。

## Colors

三层结构，用途严格分开。

### 表面（暖炭灰，四档）

| token | 值 | 用途 |
|---|---|---|
| `--bg` | `#2b2622` | 画布 |
| `--bg-1` | `#252120` | 侧栏（比画布**暗**一档） |
| `--bg-2` | `#383330` | 卡片 / 输入框 / 列表行 |
| `--bg-3` | `#423c37` | hover / 激活底 |
| `--bg-4` | `#4d4642` | 最上层（极少用） |

侧栏比画布暗，不是亮 —— 侧栏是"退到后面"的导航，靠降低亮度而不是靠边框
把自己和内容分开。反过来做（侧栏更亮）会让它一直抢注意力。

### 文字（四档，不是三档）

| token | 值 | 用途 |
|---|---|---|
| `--text` | `#f7f5f0` | 主文字、标题 |
| `--text-2` | `#c9c0ad` | 说明、正文 |
| `--text-3` | `#aea69c` | 元信息、标签 |
| `--text-4` | `#7d766d` | 脚注、占位符、禁用 |

**四档是能看出层次的最小数目。** 改造前只有三档，于是"标题下的说明"和
"最次要的脚注"被迫用同一个颜色 —— 层级一糊，界面就显乱。这是"丑"的
第二大来源（第一大是没有刻度，见 Layout）。

### 状态（屏幕上唯一的彩度）

| token | 值 | soft 变体 |
|---|---|---|
| `--ok` | `#5cbe8b` | `--ok-soft` `rgba(92,190,139,.15)` |
| `--wait` | `#d9a33f` | `--wait-soft` |
| `--bad` | `#de6a5e` | `--bad-soft` |
| `--info` | `#7ba7d4` | `--info-soft` |

每个色配一个 15% 的 soft 变体做底色。改造前这些是硬编码的 rgba，而且
两处浓度还不一样（警示 `.07`、成功 `.14`）—— 同一个界面里两种深浅，
看起来就是"没做完"。

## The one rule

> **颜色只用来表示状态。**

按钮、选中态、焦点环一律中性（暖白 / 炭灰）。饱和度整个让给
「已连接 / 等待 / 中断」三态，以及提示条、拦截标签这类**本身就是状态**的元素。

理由：这个工具最重要的信息永远是"现在能不能发"。如果按钮也是彩色的，
状态色就会被稀释；现在它是屏幕上唯一有彩度的东西，一眼就能看到。

**这条规则有例外，但例外必须满足同一个条件**：这个元素**本身表达状态**。
提示条（成功/失败）、拦截标签（不能发/要等待）、状态说明块都属于此类。
"让按钮好看一点"不属于。

## Typography

- 界面默认 13px。中文在 13px 下仍然清晰，再大就会让列表密度掉下来。
- **凡是数字，一律等宽 + `tabular-nums`**（`code, .num`）。倒计时、配额计数、
  ID、路径 —— 在这个界面里数字本身就是信息，**让它们对齐比让它们好看重要**。
  倒计时每 500ms 重算一次，不用定宽数字就会左右抖动。
- 状态带的主词（「已熔断」）是 17px —— 比正文大一档，但不抢倒计时的位置。
- **全页最大的字是倒计时（30px，`--fs-2xl`）**，不是标题。它配得上这个位置：
  这个工具的存在意义就是让人守在发布节奏里，"还要等多久"是屏幕上最该被看见的数字。

## Layout

### 刻度

间距用 `--sp-1..8`（4/8/12/16/24/32/48/64），字号用 `--fs-xs..2xl`，
圆角用 `--r-xs/sm/md/lg`。

**不要写死数字。** 改造前这里有 25 处内联 `style={{...}}`、5 种散落的字号
（13.5 / 12.5 / 12 / 11.5…）、4 处不在 token 里的圆角。没有刻度就谈不上节奏，
这是"看着乱"最大的来源 —— 比配色影响大得多。

### 宽度与居中

- 普通页面 `.main-col` 上限 880px，**横向居中**。
- 工作台 `.workspace` 上限 1240px（两栏列表 + 详情），同样居中。

改造前两者都没有上限或靠左：1920px 宽的窗口里，工作台会拉到 1700px 以上，
两块面板各自变成"汪洋中的一小撮内容"。靠左则让右侧空出一大块，
看起来像"没做完"而不是"留白"；居中之后空出来的部分左右对称，读起来是刻意的。

### 高度

列表 + 详情的容器用 `flex: 0 1 auto` + `max-height: 68vh`，**不**用 `flex: 1`。

`flex: 1` 会让它无论有几条评论都占满可用高度，一条评论时就是两个巨大的
空盒子。有的内容占多高，超过了才封顶滚动。

## Elevation & Depth

深色下靠**更亮一档的表面 + 更重的影子**表达抬起，不靠边框加粗：

- `--sh-1`：轻抬（几乎不用）
- `--sh-2`：模态框、提示条

模态框用 `--bg-2`（比画布亮），**不是** `--bg-1` —— 后者比画布还暗，
弹窗会看起来像陷进去。

## Shapes

圆角偏紧（Warp 那一系）：3 / 4 / 6 / 10px。大圆角在这个尺寸的控件上
会显得软而不可信；"工程感"来自小圆角。

- 按钮、输入框：`--r-sm` 4px
- 卡片、列表容器：`--r-md` 6px
- 模态框：`--r-lg` 10px
- 标签、进度条、圆点：`--r-pill`

## Components

组件在 `app/renderer/src/components/`。以下每一个都是**改造后新增的** ——
在此之前这个项目只有 4 个组件（侧栏 / 状态带 / 发布弹窗 / 错误边界）。

| 组件 | 解决的问题 |
|---|---|
| `ProgressBar` | core 一直上报 `progress.current/total`，渲染层从没读过 —— 批量生成 50 条只有一行小字。有 total 走确定进度，没有则走滚动条纹（**不能**退化成 0% 实心条，那会被读成"卡住了"） |
| `Spinner` | 改造前全项目 0 个 spinner，只有 5 个按钮改文案，其余按钮点下去界面纹丝不动 |
| `Toast` | 改造前成功与失败长得完全一样，后一条覆盖前一条，不能关，也没有 `aria-live` |
| `EmptyState` | 改造前"正在读取…"和"没有数据"共用同一个样式 —— 前者要等、后者要动手，是两种处境 |
| `Modal` | 改造前唯一的弹窗没有 Esc、没有焦点陷阱、没有 `role="dialog"` |
| `Skeleton` | 改造前 0 个。骨架屏的价值不在好看，在**占住和真实内容一样的形状**，数据回来时不重排 |

### 反馈的粒度

一条操作从点击到结果，中间必须**一直有东西在动**。分三档：

1. **入队瞬间** —— 按钮进入 disabled + spinner
2. **排队 / 等待** —— 队列页显示倒计时；工作台的批量操作显示进度条
3. **执行中** —— 进度条（知道总量）或滚动条纹（不知道）

改造前大量操作只有第 3 档的"完成"这一帧，中间全是空白。

## Do's and Don'ts

**Do**

- 新组件先看 `:root` 里有没有现成的 token，没有再考虑加 token（而不是加数字）
- 数字一律 `.num`；状态一律用 `--ok/--wait/--bad`
- 让界面**如实说明它不知道的事**（"回复内容未记录"、"结果没有保留"）

**Don't**

- 不要用颜色表达"重要"或"好看" —— 只能用颜色表达状态
- 不要把"正在读"和"没有数据"显示成同一个东西
- 不要在没有进行中态的情况下让一个按钮跑两次 IPC（草稿"编辑保存"就是这样
  产生重复草稿的）
- 不要在界面上放一个禁用但没有作用的按钮（比不放置更糟）

## Known Gaps

诚实记录，避免下一个人以为"这里已经做完了"：

- **加载态还不统一**：`WorkspaceView` 用骨架屏，`WorksView` / `DiagnosticsView`
  还是纯文字占位。
- **设置页的 INT / TEXT 字段没有校验反馈**：输入非法值会被静默丢弃
  （`fields.jsx` 直接 `return`），用户敲的字符不进去也没有任何提示。
- **没有全局快捷键 / 命令面板**：Warp 与 Raycast 那一系的核心交互，
  对一个"长时间盯着"的工具价值很高，但还没做。
- **没有拖拽**：图片排序、列表排序都只能靠输入框。
- **动画只有三处 keyframes**（呼吸 / 提示条入场 / 模态淡入）+ 进度与骨架的
  循环动效。足够，但谈不上有动效系统。
- 无 `aria-` 标注的旧代码仍有一部分（新组件补了，旧视图没补）。
