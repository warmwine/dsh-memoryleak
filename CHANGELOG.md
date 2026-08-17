# Changelog

版本号写在 `package.json`，日期是提交当天。只记用户能感知的变化，内部重构一笔带过。

## 0.12.0（2026-08-17）

- **`/ml init`：严格化的目录设置入口**：新增命令（不带参数），弹出目录选择卡（Tab 补全 + 「浏览…」系统对话框）指定或更换 Vault；已设置时提问会显示当前值。**Vault 未设置时，除 `help` / `init` 外的一切命令直接报错**并提示「先执行 /ml init」——取代之前的「任意命令自动弹引导」（自动引导在快速打开等入口下不可预期）。快速打开面板的「初始化 Vault 目录…」条目也改为执行 `/ml init`。
- **设置页 Vault 行新增「清除」按钮**：一键置空 Vault 目录（保存后生效，之后命令回到「先 /ml init」状态）；「浏览…」与输入框保持同行。

## 0.11.4（2026-08-17）

- **目录选择全面改用官方能力（撤掉自造 PowerShell 方案）**：设置页「浏览…」与 Vault 引导卡新增的「浏览…」按钮都走官方 `workspaces.pickDirectory`（宿主组合的 directory-picker 后端负责跨平台：Windows/macOS/Linux 各按系统方式弹窗）。自造的 `POST /api/memoryleak/pick-directory` 路由与 PowerShell 脚本整体移除——此前的「点击无反应」正是那段脚本的语法错误所致，与其修平台脚本不如不维护平台脚本。
- **修复菜单选中 `/ml` 后无下文**：Vault 未设置时快速打开面板给一个「初始化 Vault 目录…」条目，选中即执行 `/ml view` 触发引导（不再空面板卡住）；候选拉取失败同样走该条目。
- **修复设置页 Vault 行溢出**：改为块级布局——标签与说明在上，「浏览…」+ 输入框一行占满（输入框弹性收缩），窄面板不再出现横向滚动条。

## 0.11.3（2026-08-17）

- **修复「浏览…」按钮点击无反应**：目录选择对话框的 PowerShell 脚本误用了 C# 的 `::Write` 语法（PowerShell 要用 `.Write`），整段静默失败。重写脚本：修正语法、输出前设 UTF-8 编码（中文路径不乱码）、对话框挂 TopMost owner（不弹到所有窗口后面）。
- **修复 Vault 未设置时命令菜单选 `/ml` 直接报错**：快速打开面板拉不到候选（400）会把整条命令拦住，引导卡因此永远不出现。现在候选拉取失败一律返回空列表——面板空着，手输 `/ml <文本>` 回车照常触发 Vault 引导。
- **修复设置页 Vault 行布局溢出**：「浏览…」按钮被 flex-grow 布局推出可视区、需要横向滚动才能看到。改为与其他设置行一致的固定宽度排列。

## 0.11.2（2026-08-17）

- 修复：Vault 目录补全的 `E:`（带冒号的盘符）形式拼出 `E::\` 双冒号，导致该形式无候选——现在正确规范化为 `E:\` 并列出其子目录。

## 0.11.1（2026-08-17）

- **Vault 引导不再裸手输路径**：`ml-vault` 提问改为专用目录选择卡——路径输入框 + 实时候选列表（列出当前目录下的子目录），**Tab 补全 / ↑↓ 换高亮 / Enter 确认 / Esc 取消**；支持 `~` 开头（用户目录）与 Windows 单字母盘符探测（输 `e` 补全 `E:\`）；「当前会话的工作区」快捷按钮保留；路径不存在时 Enter 仍可确认（宿主自动创建）。
- **设置页 Vault 行新增「浏览…」按钮**：一键打开系统目录选择对话框（Windows 为原生 FolderBrowserDialog），选中即填入；取消静默，非 Windows 平台回退手动输入。
- 新增 `GET /api/memoryleak/path/complete`（目录补全候选，读失败静默空）与 `POST /api/memoryleak/pick-directory`（系统对话框结果透传）两条路由。

## 0.11.0（2026-08-17）

- **Vault：统一存放目录，不再跟随会话工作区**：新增 `vault` 设置（默认空）。刚安装时执行任意 `/ml` 命令（help 除外）都会弹一次性引导——输入本地文件夹路径或直接选当前工作区；目录不存在会自动创建。设置后所有日志、待办、`/ml view`、快速打开都以 Vault 为根，换项目换会话记的事都在同一处。Vault 也可在 GUI 设置里直接填写。
- **设置分两层**：全局层仍是 `~/.dsh/settings.yaml` 的 `memoryleak:` 段（DSH 官方统一位置）；选定 Vault 时自动把当时的设置复制为 Vault 内的 `.memoryleak.yaml`（已存在则保留）。之后 vault 文件里的键优先级更高（整个 Vault 拷到别的机器，设置跟着走）；缺键回退全局层，再回退默认值；vault 文件损坏按缺失处理，不崩。
- `/api/memoryleak/files` 改按 Vault 定位（不再需要 session 参数）；宿主 inject 相应收窄（去掉 sessions）。

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
