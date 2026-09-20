---
version: 2
name: douyin-tool-design
description: "A refined warm-graphite desktop tool for a single operator babysitting a publishing cadence. The canvas is a deep warm graphite (#211d1a) rather than the category's usual cold gray; text is warm off-white (#f5f2ea) in a four-step ladder. Separation relies on alpha hairlines (warm white at 7-20% opacity) instead of solid brownish grays — alpha lines never introduce a third color between surfaces, which is the #1 cause of muddy dark UIs. Saturation is reserved entirely for status: the only chromatic elements are the can-send / waiting / blocked triad plus tints and glows. Buttons, selection and focus rings are all neutral. Type is the system CJK stack at 13px, with tabular-numerals monospace for anything numeric. Depth comes from glow (status dots with halos, gradient status cards, blurred modal backdrops) rather than heavier borders."
colors:
  canvas: "#211d1a"
  surface-1: "#1a1715"
  surface-2: "#2a2521"
  surface-3: "#352f29"
  surface-4: "#413a33"
  hairline: "rgba(255,240,222,.07)"
  hairline-strong: "rgba(255,240,222,.13)"
  hairline-solid: "rgba(255,240,222,.20)"
  ink: "#f5f2ea"
  ink-2: "#c9c2b4"
  ink-3: "#a69d8f"
  ink-4: "#7a7266"
  status-ok: "#4cc38a"
  status-wait: "#e3a93e"
  status-bad: "#e8655a"
  status-info: "#74a9e8"
  on-primary: "#26211c"
  sunken: "rgba(0,0,0,.22)"
  chart-lo: "#5c5348"
  chart-mid: "#6b6156"
  chart-hi: "#8a7d6a"
typography:
  page-title:
    fontSize: 21px
    fontWeight: 650
    letterSpacing: "-.015em"
  band-word:
    fontSize: 17px
    fontWeight: 650
  countdown:
    fontFamily: ui-monospace / SF Mono / Consolas
    fontSize: 32px
    fontWeight: 650
    textShadow: "0 0 24px status-wait-glow"
  body:
    fontSize: 13px
    lineHeight: 1.6
  caption:
    fontSize: 12px
  micro:
    fontSize: 11px
  numeric:
    fontFamily: ui-monospace / SF Mono / Consolas
    fontSize: 12px
    fontVariantNumeric: tabular-nums
rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
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
    background: "linear-gradient(180deg,#fbf8f0,#ece6d8)"
    textColor: "{colors.on-primary}"
    rounded: "7px"
    fontWeight: 600
  button-secondary:
    backgroundColor: "{colors.surface-3}"
    border: "1px solid {colors.hairline-solid}"
    rounded: "7px"
  button-quiet:
    backgroundColor: transparent
    textColor: "{colors.ink-2}"
  text-input:
    backgroundColor: "{colors.sunken}（凹进去，比卡片暗）"
    border: "1px solid {colors.hairline-strong}"
    focusBorder: "rgba(255,240,222,.35)"
    rounded: "7px"
  list-card:
    backgroundColor: "{colors.surface-2}"
    border: "1px solid {colors.hairline}"
    rounded: "{rounded.lg}"
    topInsetHighlight: "{shadow.3}"
  band:
    background: "status color @5-6% gradient over surface-2"
    border: "status color @18-20%"
    leftBar: "3px status color"
    dot: "8px + halo (currentColor @18% ring)"
    rounded: "{rounded.lg}"
  quota-cell:
    backgroundColor: "{colors.surface-2}"
    border: "1px solid {colors.hairline}"
    rounded: "{rounded.lg}"
    valueFontSize: 17px
  toast:
    background: "surface-3 @88% + backdrop-blur(10px)"
    rounded: "{rounded.lg}"
    leftBar: "3px status color + glow"
  modal:
    background: "{colors.surface-2}"
    backdrop: "rgba(12,9,7,.58) + blur(6px)"
    rounded: "{rounded.xl}"
    shadow: "{shadow.2}"
  section-title:
    marker: "3x11px neutral bar before text"
  sidebar:
    brand: "30px rounded-square mark + name + version"
    activeItem: "surface-3 + 2.5px white marker with glow"
shadow:
  1: "0 1px 2px rgba(0,0,0,.30)"
  2: "0 12px 32px rgba(0,0,0,.45), 0 2px 8px rgba(0,0,0,.30)"
  3: "0 1px 0 rgba(255,240,222,.06) inset（卡片的受光面）"
glow:
  ok: "rgba(76,195,138,.35)"
  wait: "rgba(227,169,62,.35)"
  bad: "rgba(232,101,90,.35)"
---

# DESIGN.md — 抖音评论运营助手（v2 Studio Graphite）

> 这份文件是给**改这个项目界面的人（或 agent）**读的。
> 所有值都在 `app/renderer/src/styles.css` 的 `:root` 里，这里不重复第二份数字 ——
> 两边不一致时以 CSS 为准，并回来改这里。
> v2（2026-09-19）在 v1 的设计原则不变的前提下整体精修：更深更沉的画布、
> alpha 发丝线、辉光状态卡、毛玻璃弹窗、分段标签、自定义滚动条。
> "颜色只表示状态 / 四档文字 / token 化"三条纪律全部保留。


> 这份文件是给**改这个项目界面的人（或 agent）**读的。
> 所有值都在 `app/renderer/src/styles.css` 的 `:root` 里，这里不重复第二份数字 ——
> 两边不一致时以 CSS 为准，并回来改这里。

## Overview

这是一个**单人长时间盯着的桌面工具**，不是网站、不是仪表盘。

它的存在意义只有一件事：让人安全地守在发布节奏里。所以界面所有设计决策的
第一优先级是「**现在能不能发**」这一条信息够不够突出，而不是"页面好不好看"。

设计语言源自 **Warp**（暖炭灰）那一系的深色工具界面，v2 又吸收了 Linear / Raycast
的质感做法：更深的画布、alpha 发丝线、辉光状态、毛玻璃弹窗。选它而不是 Linear / Raycast 那一路冷灰，有两个具体理由：

1. **暖色长时间盯屏更不容易累**，而冷灰在深色下容易显廉价 —— 这是被用户
   直接抱怨"UI 很丑"之后换的。
2. **它是同类里唯一给出应用级组件规格的**（列表行、模态框、空态、通知、
   表格单元格），而不是只有配色和按钮。这个项目缺的正是这些。

## Colors

三层结构，用途严格分开。

### 表面（暖炭灰，四档）

| token | 值 | 用途 |
|---|---|---|
| `--bg` | `#211d1a` | 画布 |
| `--bg-1` | `#1a1715` | 侧栏（比画布**暗**一档） |
| `--bg-2` | `#2a2521` | 卡片 / 列表行 |
| `--bg-3` | `#352f29` | hover / 激活底 / 次级按钮 |
| `--bg-4` | `#413a33` | 最上层（角标等小面积） |

**发丝线是 alpha 白而不是实色棕灰**（v2 最重要的改变）：
`--line: rgba(255,240,222,.07)`、`--line-2: .13`、`--line-3: .20`。
实色线在两层表面之间会形成"第三种颜色"，是深色界面显脏的头号来源；
alpha 线永远只是"主表面色 + 一点点白"，任何相邻两层都协调。

侧栏比画布暗，不是亮 —— 侧栏是"退到后面"的导航，靠降低亮度而不是靠边框
把自己和内容分开。反过来做（侧栏更亮）会让它一直抢注意力。

### 凹槽与图表填充（两个"非状态"的中性值）

| token | 值 | 用途 |
|---|---|---|
| `--sunken` | `rgba(0,0,0,.22)` | 输入框、条形/环形的**底槽**。比卡片暗一档，读作"挖进去" |
| `--chart-lo` | `#5c5348` | 图表中性刻度的最暗端：环形的中性段 / 柱子的根部 |
| `--chart-mid` | `#6b6156` | 横向条的起点 |
| `--chart-hi` | `#8a7d6a` | 最亮端：横向条的末端 / 柱子的顶部 |

这几个是**表面色不是状态色**，所以必须中性（见 The one rule）。改造前它们散落成
四套相近但不同的棕（`#6b6156`/`#857968`/`#8a7d6a`/`#5c5348`）加三处裸写的
`rgba(0,0,0,.22)`，值一样却各写一份 —— 改画布深浅时不会有人记得去改它们。
现在收敛成"一个凹槽 + 三档中性刻度"，都在 `:root` 一处。
`charts.jsx` 里也**不允许**出现颜色字面量，环形的底槽走 `.donut-track` 类。

### 文字（四档，不是三档）

| token | 值 | 用途 |
|---|---|---|
| `--text` | `#f5f2ea` | 主文字、标题 |
| `--text-2` | `#c9c2b4` | 说明、正文 |
| `--text-3` | `#a69d8f` | 元信息、标签 |
| `--text-4` | `#7a7266` | 脚注、占位符、禁用 |

**四档是能看出层次的最小数目。** 改造前只有三档，于是"标题下的说明"和
"最次要的脚注"被迫用同一个颜色 —— 层级一糊，界面就显乱。这是"丑"的
第二大来源（第一大是没有刻度，见 Layout）。

### 状态（屏幕上唯一的彩度）

| token | 值 | soft 变体 |
|---|---|---|
| `--ok` | `#4cc38a` | `--ok-soft` 14% · `--ok-glow` 35% |
| `--wait` | `#e3a93e` | `--wait-soft` · `--wait-glow` |
| `--bad` | `#e8655a` | `--bad-soft` · `--bad-glow` |
| `--info` | `#74a9e8` | `--info-soft` |

每个色配 soft（14%，提示条底色）与 glow（35%，辉光点/发光条）两个变体，
浓度在 `:root` 定死一处。v2 的状态色第一次有了"空间感"：
状态点带 halo、状态带与提示条带同色渐变底光，但面积依然克制。改造前这些是硬编码的 rgba，而且
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
- **全页最大的字是倒计时（32px，`--fs-2xl`）**，不是标题。它配得上这个位置：
  这个工具的存在意义就是让人守在发布节奏里，"还要等多久"是屏幕上最该被看见的数字。

## Layout

### 刻度

间距用 `--sp-1..8`（4/8/12/16/24/32/48/64），字号用 `--fs-xs..2xl`，
圆角用 `--r-xs/sm/md/lg`。

**不要写死数字。** 改造前这里有 25 处内联 `style={{...}}`、5 种散落的字号
（13.5 / 12.5 / 12 / 11.5…）、4 处不在 token 里的圆角。没有刻度就谈不上节奏，
这是"看着乱"最大的来源 —— 比配色影响大得多。

### 宽度与居中

- 普通页面 `.main-col` 上限 920px，**横向居中**。
- 工作台 `.workspace` 上限 1280px（两栏列表 + 详情），同样居中。

改造前两者都没有上限或靠左：1920px 宽的窗口里，工作台会拉到 1700px 以上，
两块面板各自变成"汪洋中的一小撮内容"。靠左则让右侧空出一大块，
看起来像"没做完"而不是"留白"；居中之后空出来的部分左右对称，读起来是刻意的。

### 高度

列表 + 详情的容器用 `flex: 0 1 auto` + `max-height: 68vh`，**不**用 `flex: 1`。

`flex: 1` 会让它无论有几条评论都占满可用高度，一条评论时就是两个巨大的
空盒子。有的内容占多高，超过了才封顶滚动。

## Elevation & Depth

深色下靠**更亮一档的表面 + 更重的影子 + 辉光**表达抬起，不靠边框加粗：

- `--sh-1`：轻抬（批量操作条）
- `--sh-2`：模态框、Toast
- `--sh-3`：卡片顶部的 1px 内亮线（"受光面"），列表卡片因此有了体积感
- **辉光**：状态点的 halo（`box-shadow: 0 0 Npx var(--*-glow)`）、
  倒计时的 text-shadow、进度条的发光填充 —— 状态色的亮度用光表达，
  不用更大的色块

模态框用 `--bg-2`（比画布亮），**不是** `--bg-1` —— 后者比画布还暗，
弹窗会看起来像陷进去。背景用毛玻璃（`backdrop-filter: blur(6px)`）。

## Shapes

v2 放松了半档（4/6/8/12/16）：大面积卡片 8-12px 显精致，控件 6-7px
保持工程感——大圆角全留给"抬起来的东西"（弹窗、提示条）。

- 按钮、输入框：7px（写死一处，两族控件统一）
- 卡片、列表容器、状态带：`--r-lg` 12px
- 模态框：`--r-xl` 16px
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
| `TrendChart` | 折线/面积图。`preserveAspectRatio="none"` 横向拉伸自适应 + `vector-effect` 保持线宽，轴文字走 HTML（拉伸过的 SVG 里文字会变形）。带三档 y 轴刻度与网格线 |
| `LoadingState` | 「正在读」曾经有五种长相（骨架屏 / 骨架屏+空态 / 裸文字 / spinner / **没有**），其中两种长得跟"没有数据"一样。现在按"知不知道内容形状"二选一：知道走骨架屏，不知道走 `EmptyState variant="loading"` |

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

- **没有全局快捷键 / 命令面板**：Warp 与 Raycast 那一系的核心交互，
  对一个"长时间盯着"的工具价值很高，但还没做。
- **没有拖拽**：图片排序、列表排序都只能靠输入框。
- **动效是"微交互"级别**：按钮/行 hover 过渡、状态带呼吸、模态与 Toast 入场
  （带 8px 位移 + scale 的缓动）、进度与骨架循环。有统一的 `.12-.18s ease`
  节奏，但没有成体系的动效编排（页面转场等）。
- 无 `aria-` 标注的旧代码仍有一部分（新组件补了，旧视图没补）。
- **图表的悬停还是原生 `title`**：`DayBars` / `TrendChart` 用 `title` 给数值 ——
  1 秒延迟、不可样式化、深色界面弹浅色系统气泡，键盘与触屏完全拿不到
  （图上已直接标了数字，所以不是信息缺失）。`BarList` 的可点下钻已经做了
  （`onPick`），但这种 hover 交互还没有。
- **窄窗口没做适配**：`.donut-svg` 固定 132px、DayBars 30 格无 min-width。

> 已修（2026-09-19）：P0.5 的加载态统一到 `LoadingState`、设置页数字字段非法输入
> 当场标红并拦住保存、图表颜色全部收进 `:root`；第十一轮把 `BarList` 变成可点
> （下钻到用户详情），并新增了「找视频」「用户详情」两页。
