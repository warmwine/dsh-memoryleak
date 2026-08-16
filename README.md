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
| `/ml todo list` | 扫描当前工作区 Markdown 待办，按默认过滤（设置中可改 open/done/all），按文件分组返回 | **0**（命令面，不过模型） |
| `/ml todo list all` / `open` / `done` | 同上，指定状态：全部 / 未完成 / 已完成 | **0** |
| `/ml todo list <关键词>` | 同上，按关键词过滤（大小写不敏感，可与状态词组合） | **0** |
| `/ml todo` | 省略操作默认 `list`，等价 `/ml todo list` | **0** |
| 设置窗口「MemoryLeak」分区 | 读写扫描扩展名、排除目录、上限、默认过滤词（`/api/memoryleak/*` HTTP 路由） | **0** |

> 原理：`/ml` 注册在 dsh-commands 人类命令面（`ctx.commands.register`），命令文本与结果都不进模型历史（`command/run`/`command/done` 是 log-only 事件），因此零 token、不影响 KV cache。
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
src/adapters/  node（真实 fs）/ memory（测试·预览）双适配器
src/index.js   宿主半：/ml todo 命令 · memoryleak 设置命名空间 · /api/memoryleak/* 路由
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
