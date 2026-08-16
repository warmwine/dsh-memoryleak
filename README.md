# dsh-memoryleak —— DSH MemoryLeak 插件

> MemoryLeak：数据模型优先、格式可扩展、问题尽早暴露。

[English](README.md) · 开发要则见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)

## 功能

- **设置窗口**：GUI 设置面板新增「MemoryLeak」分区（与「字体」设置页同款位置），
  可配置扫描扩展名、排除目录、文件/条目上限与 `/ml todo` 默认过滤词，持久化在
  `~/.dsh/settings.yaml` 的 `memoryleak:` 段，支持多窗口乐观并发。
- **`/ml todo list` 命令**：扫描当前工作区 Markdown 文件中的待办
  （`- [ ] 未完成` / `- [x] 已完成`），在命令卡片中按文件分组返回。
  - 围栏代码块内的任务行不计入；`node_modules`、`.git` 等目录默认排除。
  - 全部变体见下方「命令与入口一览」表。

## 命令与入口一览

| 命令 / 入口 | 作用 | token 消耗 |
| --- | --- | --- |
| `/ml <文本>` | 记一笔：写入工作区根目录的日志/周志 `## MemoryLeak` 模块（不存在则按模板新建文件） | **0**（命令面，不过模型） |
| `/ml todo add <文本>` | 加结构化待办：固定格式提问类型（deadline/sleep/anytime）与重要程度（紧急/中等/低），deadline/sleep 再问日期；写入日志/周志的 `## Todo` 模块（建在 `## MemoryLeak` 之后） | **0**（提问为固定表单，不过模型） |
| `/ml todo list` | 扫描当前工作区 Markdown 待办（默认过滤可在设置改），**默认隐藏未唤醒的 sleep 型**，按文件分组返回；**到日的 sleep 自动唤醒**（源文件转写为 active）并显示 ☀ 计数；每条带序号，供 `d <n>` 寻址 | **0**（命令面，不过模型） |
| `/ml todo list all` / `open` / `done` | 同上，指定状态；`all` 同时包含未唤醒的 sleep 型 | **0** |
| `/ml todo list <关键词>` | 同上，按关键词过滤（大小写不敏感，可与状态词组合） | **0** |
| `/ml todo d <n>`（或 `done <n>`） | 切换**最近一次 list** 结果中第 n 条的完成态（序号是 list 作用域的；未 list 先报错提示） | **0** |
| `/ml todo u`（或 `undo`） | 撤销最近一次 `d`（可连续撤销，LIFO；d 之后该行被外部修改则拒绝撤销） | **0** |
| `/ml todo` | 省略操作默认 `list`，等价 `/ml todo list` | **0** |
| 设置窗口「MemoryLeak」分区 | 读写扫描扩展名、排除目录、上限、默认过滤词、日志模式与模板（`/api/memoryleak/*` HTTP 路由） | **0** |

> 原理：`/ml` 注册在 dsh-commands 人类命令面（`ctx.commands.register`），命令文本与结果都不进模型历史（`command/run`/`command/done` 是 log-only 事件），因此零 token、不影响 KV cache。文件创建与写入是纯本地字符串操作，`/ml todo add` 的提问走 userQuestions 固定表单，均不涉 LLM。命令卡片通过 `conversation.chat.commandview`（key=ml）默认展开显示（命令回显 + 主题样式正文块），无需点击。
>
> 日志/周志约定：日志模式写入 `yyyy-mm-dd.md`，记录为模块下的一行 `- 文本`；周志模式写入 `yyyyWww.md`（ISO 周，模板默认带 `start:`/`end:` 配置），记录按日期分组 `- yyyy-mm-dd` → 子项 `  - 文本`。`todo` 是保留字——记录文本以 todo 开头时请换措辞。
>
> 结构化待办格式（`## Todo` 模块内，`/ml todo` 系列的读写契约）：
>
> ```
> - [ ] (ml:deadline 2026-09-01 urgent) 完成设计稿   ← 截止型：固定终结日
> - [ ] (ml:sleep 2026-12-01 low) 学一遍内部源码      ← 睡眠型：到日唤醒（唤醒日前 list 默认不显示）
> - [ ] (ml:anytime medium) 整理收藏夹                ← 随时型：无日期
> - [x] (ml:active low) 复盘一次上线                  ← 唤醒型：sleep 到日唤醒后的落盘形态
> ```
>
> 徽章展示形如 `[截止 2026-09-01·紧急]`；属性块损坏的行自动降级为普通待办（不丢数据）。`/ml todo list` 时到日的 sleep 行会在源文件中转写为 active（按 文件+行号+原文 三重校验，行已变化则跳过），列表尾部显示 `☀ 已唤醒 N 条`。
>
> 已知行为（DSH 上游设计，非本插件缺陷）：**新会话在发出第一条 LLM 消息前处于 blank 状态，不挂载对话时间线**——此时执行 `/ml`，结果不会立即显示（官方 `/plan`、`/goal` 同样如此）；发出第一条消息后，历史命令卡片会随时间线一起补显。命令事件已持久化，不会丢失。

## 安装（本机 DSH）

```bash
dsh plugin --profile web add link:<本仓库路径>
# 重启 dsh web 后生效；卸载：dsh plugin --profile web remove dsh-memoryleak
```

## 架构一览

```
src/core/      纯域（零依赖，vitest 直测）
  formats/       Strategy：单行待办格式解析（markdown-checkbox）
  registry.js    Registry：注册期契约校验 + priority + 可逆注册
  filter.js      Specification：TodoQuery（数据 + 谓词）
  file-source.js Port：FileSource 契约（DIP）
  scan.js        扫描器：Registry + FileSource → 冻结的 ScanReport
  render.js      文本渲染（命令卡片）+ JSON 渲染（AI 预留契约）
  journal.js     日志/周志：ISO 周、模板渲染、## MemoryLeak 插入算法（纯函数）
src/adapters/  node（真实 fs）/ memory（测试·预览）双适配器
src/journal.js 宿主胶水：定位文件 → 读/模板建 → 插入 → 写回（无 LLM）
src/index.js   宿主半：/ml 命令 · memoryleak 设置命名空间 · /api/memoryleak/* 路由
src/client.js  浏览器半：设置窗口（settings.section 槽位）
```

设计模式与 let-it-crash 故障分级见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 开发

```bash
pnpm install
pnpm test          # vitest 全量测试
pnpm run test:watch
```

## 为 AI 预留的接缝（V1 已就位、暂未启用）

- 新待办格式 = 新 `TodoFormat` Strategy，注册即生效，扫描器零改动；
- 结构化消费 = `renderTodoJson(report, query)` 的稳定 JSON 契约；
- 结构化过滤 = `TodoQuery`（action/status/text/limit）数据模型。

## License

MIT
