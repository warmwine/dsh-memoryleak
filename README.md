# dsh-memoryleak —— DSH 记忆泄露插件

> memoryleak，取「内存泄露」同名梗：把记忆外化成文件，泄露给未来的自己。
> 数据模型优先、格式可扩展、问题尽早暴露。

[English](README.md) · 开发要则见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)

## 功能

- **设置窗口**：GUI 设置面板新增「记忆泄露」分区（与「字体」设置页同款位置），
  可配置扫描扩展名、排除目录、文件/条目上限与 `/ml todo` 默认过滤词，持久化在
  `~/.dsh/settings.yaml` 的 `memoryleak:` 段，支持多窗口乐观并发。
- **`/ml todo list` 命令**：扫描当前工作区 Markdown 文件中的待办
  （`- [ ] 未完成` / `- [x] 已完成`），在命令卡片中按文件分组返回。
  - `/ml todo list` —— 按默认过滤（可在设置中改为 open/done/all）
  - `/ml todo list all|open|done` —— 指定状态
  - `/ml todo list deploy` —— 关键词过滤（大小写不敏感）
  - 围栏代码块内的任务行不计入；`node_modules`、`.git` 等目录默认排除。
- `/ml` 是命令家族前缀：todo 只是第一个成员，note / plan 等子命令在文法上
  已预留同层扩展位（见 `src/core/command.js`）。

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
src/index.js   宿主半：/ml todo 命令 · notes 设置命名空间 · /api/memoryleak/* 路由
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
