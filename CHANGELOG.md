# Changelog

版本号写在 `package.json`，日期是提交当天。只记用户能感知的变化，内部重构一笔带过。

## 0.10.2（2026-08-17）

- **`/ml todo add` 首轮选完即提交**：类型 + 重要程度两问在 web 端合并为一张卡，各点一项，第二项选中的瞬间自动提交——通用问答 UI 里最后一题选完还要点一下「提交」的步骤没有了（先选重要程度再选类型同样成立；补全前随时可改选）。提问 id 同步命名空间化（`ml-type` / `ml-prio` / `ml-date`），客户端只认领自己的问题，不影响其他插件的问答。
- **`/ml todo add` 日期选择器**：deadline / sleep 的日期轮在 web 端不再手打 yyyy-mm-dd——接管输入区渲染「日历 + 快捷键（今天 / 明天 / 本周 / 本月）」，点击即确认，Esc 取消；本周=本周日、本月=当月最后一天（周一起始）。其余环境（TUI/原生）仍走自由输入，答案与校验不变。
- **待办完成时间**：`/ml todo d` 完成一条待办时，自动在文件里记上完成日期（`done:2026-08-16`），列表徽章显示 `✓2026-08-16`；取消完成或 `u` 撤销时自动清掉。已有文件不用改，下次操作自然写入。
- **待办列表排版**：长文本换行后从正文位置对齐（不再顶到行首）；已完成的条目置灰加删除线；纯文本输出格式不变，TUI 场景不受影响。
- 删掉 README 英文版链接，README 重写为面向使用者的说明。

## 0.10.1（2026-08-16）

- **快速打开候选：当前日志/周志默认置顶**——空片段时第一项即当前文件（按设置的日志模式定位），带「· 当前」标记；不存在也显示，选中即经宿主创建路径查看。
- 重写 README（场景导向 + 完整命令表 + 文件格式约定 + 生效方式表），新建 CHANGELOG。
- 修复：`/files` 路由的 `dailyFileName/weeklyFileName` 误从 journal.js 导入导致宿主加载失败（改自 core/journal.js）。

## 0.10.0（2026-08-16）

- **`/ml view <片段>` 手动输入时的实时候选卡**（combobox 模式）：官方 popupSelect 只在从命令菜单选中 `/ml` 时触发，手动输入无任何备选 UI——自建 `conversation.input.overlay` 槽候选卡，监听草稿匹配 `/^\/ml\s+(view|v)\b/` 即弹出；焦点留在输入框，打字实时过滤（本地子序列评分）。
- 键盘（capture 拦截）：↑↓ 切高亮（默认第 1 项）、Tab 补全文件名进草稿、Enter 直接执行并清空输入框、Esc 关闭；IME 组合输入不拦；候选空时 Enter 放行给宿主模糊解析兜底。
- 多候选场景（如 `08-1` 命中两天）现在直接在卡里选择，不再落到 error 文本。

## 0.9.x 修复（2026-08-16）

- **候选卡错位与报错（两连修）**：
  - 错位：overlay 锚点是 `display:contents`，文档流内联块掉进对话列——对齐官方 MenuView 定位契约（`position:absolute; bottom:calc(100%+4px)`），视觉令牌同步官方菜单。
  - 报错 `cannot get property "sessions" without inject`：候选卡 fetch 的 `/files` 路由在**宿主侧**访问 `ctx.sessions` 但宿主 inject 未声明（Cordis Guard 在属性访问时拦截，测试桩无 Guard 测不出）——宿主 inject 补 `sessions`。
- **新增回归守卫**：扫描宿主源码全部 `ctx.<service>` 访问，逐一断言在 inject 声明中——与此前 `agent.id`（ASK_MISSING_AGENT）同类缺口从此静态锁死。

## 0.9.0（2026-08-16）

- **`/ml view [片段]` 模糊快速打开**：
  - `core/fuzzy.js`：子序列评分 DP（边界 +3 / 连续 +4 / 跳过 -0.1 / 短候选折扣），测试锁定「连续运行 > 散点命中」。
  - `resolveViewTarget` 四态解析：exact（完整文件名/去扩展名唯一）/ unique（强匹配直接开）/ ambiguous（列候选要求加长片段）/ none。
  - `GET /api/memoryleak/files?session=`：按会话定位工作区返回文件清单（新文件在前）。
  - 客户端 `commandUi.decorate(/ml)`：从命令菜单选中 `/ml` 时弹官方 popupSelect 快速打开面板。

## 0.8.0（2026-08-16）

- **`/ml view`**：无参数显示当前日志/周志（未创建友好提示，不自动创建）。
- help 补全 `add`/`list` 全称（此前只有 `n`/`l` 简写主条目，搜不到全称）。

## 0.7.0（2026-08-16）

- **别名**：`/ml todo n`（add）、`/ml todo l`（list）、`/ml h`（help）。
- **`/ml help`**：命令一览汇总（纯函数 `renderMlHelp`，测试断言覆盖全部已注册命令且不含未实现命令）；无工作区绑定也可查看。
- 注册描述改为一句话导向 help：`MemoryLeak 记事本 · 输入 /ml help 查看全部命令`。

## 0.6.0（2026-08-16）

- **list 去掉行号列**（与序号混淆；序号仍是 `d` 的唯一寻址键）。
- **`/ml todo u`（undo）**：撤销最近一次 `d`，LIFO 可连续；撤销前严格校验该行未被外部修改（d 时捕获行内容，变化即拒绝）；按会话隔离。

## 0.5.0（2026-08-16）

- **sleep 到日自动唤醒**：`list` 时把到日、未完成的 sleep 行在源文件转写为 `active` 新类型（文件+行号+raw 三重校验，行变化跳过；单文件故障隔离）；列表尾显示 `☀ 已唤醒 N 条`；徽章 `[唤醒·中等]`。
- **`/ml todo d <n>`（done）**：按最近一次 list 的序号切换完成态；序号是 list 作用域的；未 list 先 d 报错提示；超界报错；快照按 agent 会话隔离。

## 0.4.1 修复（2026-08-16）

- `/ml todo add` 提问请求携带 `agent`（修复 `web user interaction requires an agent-owned session`）：web Provider 依赖 `request.agent.id` 路由弹窗到正确会话；加回归断言每个 ask 请求必须有 `agent.id`。

## 0.4.0（2026-08-16）

- **`/ml todo add <文本>`**：固定表单（userQuestions）两轮提问——类型（deadline/sleep/anytime）+ 重要程度（紧急/中等/低），deadline/sleep 追问日期（yyyy-mm-dd）；全程无 LLM。
- **结构化待办格式**（第二个 Strategy：`memoryleak-todo`，priority 50 先于 markdown-checkbox）：`- [ ] (ml:<type>[ <date>] <prio>) 文本`；属性块损坏自动降级为普通待办。
- TodoItem 携带 meta；列表徽章 `[截止 2026-09-01·紧急]` 等。
- **sleep 语义**：`list` 默认隐藏未唤醒的 sleep（唤醒日含当天即显示），`all` 显示全部。
- `## Todo` 模块插入算法：永远建在 `## MemoryLeak` 之后（两者皆无则一并创建）。

## 0.3.x（2026-08-16）

- 0.3.1：恢复 `/ml` 命令卡片默认展开视图（`conversation.chat.commandview` key=ml，记录与待办两家族共用）——此前因「空结果不显示」误撤，后确认那是 blank 会话无时间线的上游行为，与槽位无关。
- 0.3.0：**`/ml <文本>` 记录命令**——写入工作区日志/周志的 `## MemoryLeak` 模块；ISO 8601 周（含跨年/53 周边界）；模板占位 `{date}{week}{start}{end}`；模块插入算法（daily 平铺 / weekly 按日期分组子列表；头部 `start:/end:` 配置块与一级标题保留；输出统一单换行结尾）；设置新增 journalMode/dailyTemplate/weeklyTemplate。

## 0.2.x（2026-08-16）

- 0.2.1：品牌文案统一为 **MemoryLeak**（不翻译）——设置分区 label、命令描述前缀、README/DEVELOPMENT 同步。
- 0.2.0：更名 `dsh-notes` → `dsh-memoryleak`；命令统一 `/ml` 前缀（新文法 `/ml todo list [all|open|done] [关键词]`，`/ml todo` 省略操作默认 list）；设置段 `notes:` → `memoryleak:`；API `/api/notes/*` → `/api/memoryleak/*`。

## 0.1.0（2026-08-16）

首个可用版本：

- **设置窗口**：GUI 设置面板「MemoryLeak」分区（扫描扩展名/排除目录/上限/默认过滤词），持久化 `~/.dsh/settings.yaml` 的 `memoryleak:` 段，乐观并发（409 重载提示）。
- **`/ml todo list`**：扫描工作区 Markdown 待办（`- [ ]`/`- [x]`，围栏代码块不计入），TUI 排版（分组头/序号/选票符号/警告块）按文件分组返回；状态与关键词过滤。
- **架构**：纯域（`src/core/` 零依赖）+ 双适配器（node/memory FileSource，共享遍历策略）+ 宿主/浏览器双半；Strategy/Registry/Specification/Value Object/Ports & Adapters/组装根；let-it-crash 故障分级（程序员错误启动崩溃 / 用法错误用户可见 / 环境故障隔离上报）；110 个测试。
