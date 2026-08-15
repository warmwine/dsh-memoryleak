# dsh-notes 开发要则（DEVELOPMENT.md）

本仓库是 DSH（DeepSeek Harness）的「记事本」插件：面向 AI 时代的待办与笔记。
本文是所有贡献者必须遵守的开发宪法 —— 先读这里，再动代码。

---

## 1. 项目主张

1. **记事本的核心资产是数据模型，不是界面。** 界面（设置窗口、命令卡片）随时
   可以换，`src/core/` 里的查询模型与格式引擎必须长期稳定。
2. **为 AI 预留接缝，但不提前实现。** V1 只做 `- [ ]` 单行待办；但查询
   （`TodoQuery`）、解析（`TodoFormat`）、输出（`renderTodoJson`）都以「结构化
   数据优先」设计，未来 AI 生成特定格式、按结构化条件过滤时，只加 Strategy、
   不改引擎。
3. **let-it-crash：问题越早暴露，成本越低。** 绝不静默吞错、绝不 `catch {}`
   空捕获、绝不用默认值掩盖畸形状态。见 §2 的故障分级。
4. **可测试性是架构属性，不是事后补丁。** 核心域零框架依赖、零 I/O 依赖，
   I/O 通过端口（`FileSource`）注入，因此测试不需要 mock 库。

## 2. 故障分级（let-it-crash 的落地规则）

每一处可能失败的地方，先归类再处理；归类错误按 bug 处理：

| 类别 | 例子 | 处理方式 |
| --- | --- | --- |
| **程序员错误 / 不可能状态** | 重复注册格式 id、畸形 Strategy 契约、值对象字段非法、限额越界 | `invariant()` / 专用错误在**装配期或最早边界抛出**，让进程/插件加载失败。禁止 try-catch 掩盖。 |
| **人类用法错误** | `/todo create x`、非法过滤词 | `TodoUsageError`，命令层转成 `{ kind: 'error', text }` 给用户看，不崩溃。 |
| **环境故障** | 工作区目录不存在、文件被锁、文件超大 | 明确上报：目录级 → 命令错误结果；文件级 → 记入 `report.errors` / `report.skipped` 并在渲染尾部展示，**其余文件继续**（故障隔离）。 |
| **协作取消** | 用户中止命令 | `TodoScanAbortedError`，在文件之间检查 signal。 |

判据：**这段代码的错，还是这个世界的错？** 前者崩；后者上报；分不清时按前者处理。

## 3. 架构与设计模式地图

```
src/
├── core/                    纯域（无 node:、无框架 import；vitest 直测）
│   ├── todo-item.js         Value Object：构造即校验、构造即冻结
│   ├── formats/             Strategy：TodoFormat 单行解析契约
│   ├── registry.js          Registry：注册期契约校验、priority 顺序、可逆注册
│   ├── filter.js            Specification：TodoQuery 数据 + 编译出的谓词
│   ├── file-source.js       Port（DIP）：list/read 契约 + 装配期断言
│   ├── walk-policy.js       共享遍历策略（两个适配器同一语义）
│   ├── scan.js              扫描器：组合 Registry+FileSource，产出冻结报告
│   ├── render.js            渲染器：文本（命令卡片）+ JSON（AI 契约）
│   └── command.js           /todo 文法（纯函数）
├── adapters/                适配器（边缘）
│   ├── node-file-source.js  真实 fs 绑定（宿主）
│   └── memory-file-source.js 内存绑定（测试 / 未来预览）
├── settings-schema.js       schemastery schema + 默认值（settings.yaml 段）
├── routes.js                /api/notes/* 同源 JSON 桥（webServer 模式）
├── index.js                 宿主半：组装根（命令/设置/路由注册，全部可逆）
└── client.js                浏览器半：settings.section 设置窗口
```

| 模式 | 位置 | 解决什么 |
| --- | --- | --- |
| Strategy | `core/formats/` | 多种待办格式的可替换解析（未来 AI 格式零侵入接入） |
| Registry | `core/registry.js` | 格式的注册、排序、重复检测、注销 |
| Specification | `core/filter.js` | 查询 = 数据 + 可组合谓词（open/done/文本/上限） |
| Value Object | `core/todo-item.js` | 待办条目不可变、非法即拒 |
| Ports & Adapters (DIP) | `core/file-source.js` + `adapters/` | 核心不碰 fs；测试与生产同一语义 |
| Assembly Root（组装根） | `src/index.js` | 唯一发生「new/装配」的地方 |
| Facade | `createTodoScanner().scan()` | 一条命令一个入口的简化面 |

## 4. 编码规则

1. **模块边界**：`core/` 禁止 import `node:*`、schemastery、React、任何
   `@deepseek-ai/*`。违者测试目录即拒绝（`test/` 直接以相对路径 import core，
   若 core 偷偷依赖宿主，测试环境立刻崩 —— 这本身就是守门测试）。
2. **不可变性**：跨模块边界传递的数据一律 `Object.freeze`；函数返回的集合
   冻结；禁止输出可变共享引用。
3. **命名**：工厂函数 `createXxx`；断言 `assertXxx`（失败必抛）；布尔判断
   `isXxx/shouldXxx`；错误类以 `Error` 结尾。
4. **注释**：每个模块头一段「职责 + 设计决策」；决策写「为什么」，不写「是什么」。
5. **纯函数优先**：同一逻辑能写成 `(input) => output` 就不写类；类仅用于
   需要封装私有状态时（目前只有 `TodoFormatRegistry`）。
6. **副作用可逆**：宿主半每个注册（路由、命令、设置命名空间）都必须挂在自身
   Fiber / 返回注销函数；插件停用后不留任何残留。
7. **禁止 `any` 式逃逸**：不写 `catch (e) { /* ignore */ }`；捕获后要么处理、
   要么转译后上抛、要么记入报告 —— 三选一。
8. **错误信息面向用户**：环境/用法错误的 message 必须人话（中文、含上下文）；
   invariant 信息面向开发者（含收到的值）。

## 5. 测试要则

1. **测试金字塔**：core 纯函数（绝大多数）→ 适配器（真实 tmpdir / 内存树）→
   宿主半集成（伪 ctx 端到端跑 `/todo` 与 HTTP 路由）。
2. **每个 bug 一个回归测试**：修 bug 前先写能复现的失败测试。
3. **契约测试**：`settings-schema.test.js` 校验 schema 键与默认值不漂移；
   `registry.test.js` 校验 Strategy 契约本身。
4. **同语义双跑**：排除目录/扩展名/上限的语义测试写在 core 层，由 node 与
   memory 两个适配器共享 `walk-policy`，语义漂移会在适配器测试暴露。
5. 命令行跑法：`pnpm test`（CI 一次性）/ `pnpm run test:watch`。
6. 提交前必须全绿；测试文件与被测文件同目录结构（`test/` 镜像 `src/`）。

## 6. git 纪律

- 提交信息：`<scope>: <what>`（如 `core: 围栏内任务行不再计数`）。
- 一次提交做一件事；重构与功能不混提。
- `main` 始终可发布：全绿才允许合并/推送。

## 7. 版本与兼容

- `TodoItem` 字段、`renderTodoJson` 输出结构、settings.yaml 的 `notes:` 段、
  `/api/notes/*` 响应体 —— 这四样是对外契约，**只加不破**。
- 破坏性变更必须升主版本号并在 README 声明迁移路径。
- 新的待办格式 = 新 Strategy + 注册进 `createDefaultRegistry`（或由其他插件
  运行时注入），格式 id 一经发布不可复用为其他含义。

## 8. 未来路线（设计时已预留的接缝）

- **AI 生成待办**：新 `TodoFormat` Strategy 识别 AI 输出的特定 markdown 格式；
  AI 以 `renderTodoJson` 的形状消费扫描结果、以 `TodoQuery` 形状下发过滤。
- **更多命令**：`/todo done <n>`、`/todo add <text>` —— 扩展 `parseTodoArgs`
  的 action 枚举，处理器复用同一扫描/渲染管线。
- **设置窗口预览**：`MemoryFileSource` + `scan()` 直接在设置页渲染示例结果。
- **文件监听**：在适配器层加 watcher，核心域不变。
