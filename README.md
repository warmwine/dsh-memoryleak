# dsh-memoryleak —— DSH MemoryLeak 插件

> MemoryLeak：数据模型优先、格式可扩展、问题尽早暴露。
> 一切走命令面：**零 token、不进模型历史、不影响 KV cache**。

[English](README.md) · 更新历史见 [CHANGELOG.md](CHANGELOG.md) · 开发要则见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)

## 这是什么

MemoryLeak 是 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)的记事本插件：把「随手记一笔」和「结构化待办」放进你的**工作区本身**（Markdown 文件），而不是某个应用的数据库里。所有操作都是斜杠命令——不经过 LLM，零 token，毫秒级。

核心场景：

- **记一笔**：`/ml 修好了登录页的样式` —— 写进工作区根目录的日志（`2026-08-16.md`）或周志（`2026W33.md`）的 `## MemoryLeak` 模块
- **待办管理**：`/ml todo add`（固定表单选类型/优先级）→ `/ml todo list`（sleep 型到日自动唤醒）→ `/ml todo d 3`（按序号完成）/ `u`（撤销）
- **快速查看**：`/ml view <片段>` 模糊匹配打开任意工作区文件；手动输入时输入框上方弹**实时候选卡**（↑↓/Tab/Enter，VSCode Ctrl+P 手感）

## 命令与入口一览

| 命令 / 入口                           | 作用                                                                                                                                                                                          | token 消耗                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `/ml help`（或 `h`）                  | 命令一览：全部命令与效果的汇总说明（命令菜单里的注册描述也导向这里）                                                                                                                          | **0**                             |
| `/ml <文本>`                          | 记一笔：写入工作区根目录的日志/周志 `## MemoryLeak` 模块（不存在则按模板新建文件）                                                                                                            | **0**（命令面，不过模型）         |
| `/ml view [文件名片段]`（或 `v`）     | 快速查看：无参数 = 当前日志/周志；带片段 = VSCode Ctrl+P 风格模糊匹配工作区文件（唯一强匹配直接打开，多候选列出供加长片段消歧）                                                               | **0**                             |
| 手动输入 `/ml view <片段>`            | **实时候选卡**：输入框上方弹出过滤候选（焦点留在输入框，打字即过滤），**当前日志/周志默认置顶**（标「· 当前」），↑↓ 切换高亮、Tab 补全文件名进草稿、Enter 直接打开高亮项、Esc 关闭            | **0**                             |
| 命令菜单选中 `/ml`                    | **快速打开面板**（popupSelect）：同款候选卡，弹窗内搜索、Enter 打开                                                                                                                           | **0**                             |
| `/ml todo add <文本>`（或 `n`）       | 加结构化待办：固定格式提问类型（deadline/sleep/anytime）与重要程度（紧急/中等/低），deadline/sleep 再问日期；写入日志/周志的 `## Todo` 模块（建在 `## MemoryLeak` 之后）                      | **0**（提问为固定表单，不过模型） |
| `/ml todo list`（或 `l`）             | 扫描当前工作区 Markdown 待办（默认过滤可在设置改），**默认隐藏未唤醒的 sleep 型**，按文件分组返回；**到日的 sleep 自动唤醒**（源文件转写为 active）并显示 ☀ 计数；每条带序号，供 `d <n>` 寻址 | **0**（命令面，不过模型）         |
| `/ml todo list all` / `open` / `done` | 同上，指定状态；`all` 同时包含未唤醒的 sleep 型                                                                                                                                               | **0**                             |
| `/ml todo list <关键词>`              | 同上，按关键词过滤（大小写不敏感，可与状态词组合）                                                                                                                                            | **0**                             |
| `/ml todo d <n>`（或 `done <n>`）     | 切换**最近一次 l** 结果中第 n 条的完成态（序号是 l 作用域的；未 l 先报错提示）                                                                                                                | **0**                             |
| `/ml todo u`（或 `undo`）             | 撤销最近一次 `d`（可连续撤销，LIFO；d 之后该行被外部修改则拒绝撤销）                                                                                                                          | **0**                             |
| `/ml todo`                            | 省略操作默认 `l`，等价 `/ml todo l`                                                                                                                                                           | **0**                             |
| 设置窗口「MemoryLeak」分区            | 读写扫描扩展名、排除目录、上限、默认过滤词、日志模式与模板（`/api/memoryleak/*` HTTP 路由）                                                                                                   | **0**                             |

## 日志与待办的文件格式

日志/周志（按设置的「日志模式」选择）：

```markdown
start: 2026-08-10          ← 仅周志模板默认带（ISO 周一起止）
end: 2026-08-16

## MemoryLeak              ← /ml <文本> 的记录区（无则自动创建）
- 上午重构了扫描器
- 下午修了候选卡错位

## Todo                    ← /ml todo add 的落点（永远在 MemoryLeak 之后）
- [ ] (ml:deadline 2026-09-01 urgent) 完成设计稿
- [ ] (ml:sleep 2026-12-01 low) 学一遍内部源码
- [ ] (ml:anytime medium) 整理收藏夹
- [x] (ml:active low) 复盘一次上线
```

结构化待办四种类型（`## Todo` 模块内，`/ml todo` 系列的读写契约）：

| 类型       | 日期 | 行为                                                                            |
| ---------- | ---- | ------------------------------------------------------------------------------- |
| `deadline` | 必填 | 固定截止日，列表徽章 `[截止 2026-09-01·紧急]`                                   |
| `sleep`    | 必填 | 唤醒日前 `list` 默认隐藏；到日（含当天）自动唤醒                                |
| `anytime`  | 无   | 随时记录，徽章 `[随时·中等]`                                                    |
| `active`   | 无   | sleep 唤醒后的落盘形态（`list` 时源文件转写，三重校验防误写），徽章 `[唤醒·低]` |

优先级：`urgent`（紧急）/ `medium`（中等）/ `low`（低）。属性块损坏的行自动降级为普通待办（不丢数据）。

## 安装（本机 DSH）

```bash
dsh plugin --profile web add link:<本仓库路径>
# 重启 dsh web 后生效；卸载：dsh plugin --profile web remove dsh-memoryleak
```

改动生效方式：

| 改动位置                                            | 生效方式                                  |
| --------------------------------------------------- | ----------------------------------------- |
| `src/client.js`（浏览器半）                         | client-hmr 自动热重载（几秒），或刷新页面 |
| `src/index.js`、`src/core/`、路由、schema（宿主半） | **必须重启 `dsh web`**                    |
| `package.json` bundles / `cordis.patch.yml`         | 必须重启 `dsh web`                        |

## 架构一览

```
src/core/       纯域（零依赖，vitest 直测）
  errors.js       Typed errors + let-it-crash invariant
  todo-item.js    Value Object：构造即校验、构造即冻结（含 meta）
  formats/        Strategy：markdown-checkbox + memoryleak-todo（结构化）
  registry.js     Registry：注册期契约校验 + priority + 可逆注册
  filter.js       Specification：TodoQuery（status/text/today/sleep 谓词）
  fuzzy.js        模糊匹配：子序列评分 DP + resolveViewTarget 四态解析
  journal.js      日志/周志：ISO 周、模板渲染、模块插入、行切换/替换（纯函数）
  file-source.js  Port：FileSource 契约（DIP）
  walk-policy.js  共享遍历策略（node/memory 同语义）
  scan.js         扫描器：Registry + FileSource → 冻结的 ScanReport
  render.js       渲染器：TUI 文本（命令卡片）+ JSON（AI 预留契约）
  command.js      /ml 文法（journal/todo/view/help 四家族）+ renderMlHelp
src/adapters/   node（真实 fs）/ memory（测试·预览）双适配器
src/settings-schema.js  schemastery schema + 默认值（settings.yaml 段）
src/journal.js  宿主胶水：定位/读建/写回、唤醒转写、行切换、文件清单
src/routes.js   /api/memoryleak/* 同源 JSON 桥（settings/formats/files）
src/index.js    宿主半：组装根（/ml 命令、设置命名空间、路由）
src/client.js   浏览器半：设置窗口 + 命令卡片展开视图 + 实时候选卡
```

设计模式与 let-it-crash 故障分级见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 开发

```bash
pnpm install
pnpm test            # vitest 全量（240 个）
pnpm run test:watch
```

- 纯域零依赖直测；适配器跑真实 tmpdir；宿主半用伪 ctx 端到端
- 回归守卫：宿主源码所有 `ctx.<service>` 访问逐一断言在 inject 声明中（Guard 缺口桩测不出，静态锁死）
- 每个 bug 一个回归测试；提交信息 `<scope>: <what>`

## 为 AI 预留的接缝（已就位、暂未启用）

- 新待办格式 = 新 `TodoFormat` Strategy，注册即生效，扫描器零改动；
- 结构化消费 = `renderTodoJson(report, query)` 的稳定 JSON 契约；
- 结构化过滤 = `TodoQuery`（action/status/text/limit/today）数据模型。

## 已知行为

**新会话 blank 状态**（DSH 上游设计，非本插件缺陷）：发出第一条 LLM 消息前会话不挂载对话时间线——此时执行 `/ml`，结果不会立即显示（官方 `/plan`、`/goal` 同样如此）；发出第一条消息后，历史命令卡片随时间线补显。命令事件已持久化，不会丢失。

## License

MIT
