/**
 * dsh-memoryleak —— 宿主半（Cordis 插件）。
 *
 * 职责（组装根）：
 *   1. 装配核心引擎：Registry（内置 markdown-checkbox Strategy）+ NodeFileSource
 *   2. 注册 `memoryleak` 设置命名空间（持久化到 ~/.dsh/settings.yaml）
 *   3. 暴露 /api/memoryleak/* JSON 路由（设置窗口的读写桥）
 *   4. 注册 /ml 命令（dsh-commands 人类命令面）：记录日志 + 待办列表
 *      + /ml note（当前模型压缩区间对话 → MOMENTO/ 知识库 + 日志 ## NOTE）
 *
 * 所有副作用挂在自身 Fiber 上：settings 注册随插件停用自动回收，路由与命令
 * 用 ctx.effect 显式回收。故障分级遵循 docs/DEVELOPMENT.md §2：用法/环境错
 * 误转成命令错误结果；未知异常上抛给 dsh-commands 记为 command/done: error
 * （let it crash 的可见出口）。
 *
 * @module dsh-memoryleak
 */
import { createDefaultRegistry } from './core/registry.js'
import { createScanLimits, createTodoScanner } from './core/scan.js'
import { createNodeFileSource } from './adapters/node-file-source.js'
import { makeMemoryleakRoutes } from './routes.js'
import { recordJournalNote, recordTodoLine, JournalIoError } from './journal.js'
import { buildStructuredTodoLine } from './core/formats/memoryleak-todo.js'
import { formatDate } from './core/journal.js'
import {
  MEMORYLEAK_SETTINGS_NAMESPACE,
  MEMORYLEAK_SETTINGS_DEFAULTS,
  memoryleakSettingsSchema,
  resolveMemoryleakSettings,
} from './settings-schema.js'
import { parseMlArgs, renderMlHelp } from './core/command.js'
import { applyTodoQuery, createTodoQuery } from './core/filter.js'
import { renderTodoText } from './core/render.js'
import { TodoError, TodoRootError, TodoScanAbortedError, TodoUsageError } from './core/errors.js'
import { wakeupSleepingTodos, toggleTodoAt, cancelTodoAt, postponeTodoAt, restoreTodoAt, readJournalFile, listWorkspaceFiles, readWorkspaceFile } from './journal.js'
import { resolveViewTarget } from './core/fuzzy.js'
import { prepareVaultDir, resolveEffectiveSettings, writeVaultSettingsFile, VAULT_SETTINGS_FILENAME } from './vault.js'
import { runNoteCommand, NoteLlmError } from './note.js'
import { NoteParseError } from './core/note.js'

/**
 * 稳定的 cordis 插件名（与 cordis.patch.yml 的 insert id 一致）。
 */
export const name = 'memoryleak'

/**
 * /ml todo add 提问轮的问题 id：宿主与客户端的共享协议（两处必须同步改）。
 * web 端客户端半（src/client.js）据此认领 composer：首轮（ml-type + ml-prio）
 * 渲染「两问同卡、各选一项、选完即自动提交」的组合卡（省掉最后的提交
 * 点击），日期轮（ml-date）渲染「日历 + 快捷键」选择器；其余环境仍走
 * 通用问答 UI。答案协议不变：选项走 selected，日期走 custom: yyyy-mm-dd。
 */
const ML_TYPE_QUESTION_ID = 'ml-type'
const ML_PRIO_QUESTION_ID = 'ml-prio'
const ML_DATE_QUESTION_ID = 'ml-date'
const ML_VAULT_QUESTION_ID = 'ml-vault'

/**
 * 硬依赖：webServer（API 路由）、commands（/ml）、settings（持久化设置 +
 * Vault 引导写入）、llm（/ml note 的压缩调用，与官方 compaction 同款依赖）。
 * 工作区定位不再依赖会话 —— 一切以设置的 Vault 为根。
 */
export const inject = ['webServer', 'commands', 'settings', 'llm']

export { createDefaultRegistry, createTodoScanner, createScanLimits }

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // ---- 组装核心（纯域 + 适配器）----
  const registry = createDefaultRegistry()
  const fileSource = createNodeFileSource()

  // 每个会话最近一次 /ml todo list 的展示顺序（/ml todo d <n> 的寻址表）。
  // 序号是 list 作用域的：list 时写入，d 时消费；进程内生命周期即可。
  const lastListByAgent = new Map()

  // 每个会话的 d 撤销栈（LIFO）：u 弹栈并翻回；条目含 d 后的行内容做严格校验。
  const undoStackByAgent = new Map()

  // ---- 设置命名空间（非法的存储段会让本次注册抛错 → 插件加载失败；带病运行不如早崩）----
  const scope = ctx.settings.register(MEMORYLEAK_SETTINGS_NAMESPACE, memoryleakSettingsSchema, { base: MEMORYLEAK_SETTINGS_DEFAULTS })

  // ---- /api/memoryleak/* 路由 ----
  const routes = makeMemoryleakRoutes({ ctx, scope, registry })
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'memoryleak: /api/memoryleak routes')

  // ---- /ml 命令（单一注册点；子命令文法见 core/command.js）----
  // 注册描述保持短并导向 /ml help —— 命令菜单/补全里的一行说明不可能
  // 装下全部子命令，汇总说明统一由 /ml help 提供。
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'ml',
        description: 'MemoryLeak 记事本 · 输入 /ml help 查看全部命令',
        input: { hint: '<文本> / todo 子命令 / note / view / help' },
        handler: wrappedHandler,
      }),
    'memoryleak: /ml command',
  )

  /**
   * 命令处理器：vault 门控 + 分发。
   *
   * 严格门控：Vault 未设置时，除 help / init 外的一切命令直接报错，
   * 提示先执行 /ml init——init 是唯一的目录设置入口（也可在 GUI 设置里
   * 填写/清除），不自动弹引导。设置后所有读写都以 vault 为根。
   *
   * @param {{ agent: { session?: { header?: { cwd?: string } } }, rawInput: string, signal: AbortSignal }} invocation
   * @returns {Promise<{ kind: 'success', text: string } | { kind: 'error', text: string }>}
   */
  async function mlCommandHandler({ commandId, agent, rawInput, signal }) {
    const parsed = parseMlArgs(rawInput)
    if (parsed.family === 'help') {
      return { kind: 'success', text: renderMlHelp() }
    }
    if (parsed.family === 'init') {
      return initVaultCommand(agent, signal)
    }
    const globalSettings = resolveMemoryleakSettings(scope.get())
    if (globalSettings.vault === '') {
      return { kind: 'error', text: '尚未设置 Vault 目录——先执行 /ml init 指定（或在 GUI 设置 → MemoryLeak 填写）。' }
    }
    const settings = await resolveEffectiveSettings(globalSettings)
    return dispatchMlCommand({ agent, rawInput, signal, parsed, cwd: globalSettings.vault, settings, commandId })
  }

  /** vault 就绪后的实际分发（原命令处理器主体，cwd 即 vault）。 */
  async function dispatchMlCommand({ agent, rawInput, signal, parsed, cwd, settings, commandId }) {
    if (parsed.family === 'journal') {
      const record = await recordJournalNote({ cwd, settings, text: parsed.text })
      const where = record.mode === 'weekly' ? `## MemoryLeak · ${record.date}` : '## MemoryLeak'
      const suffix = record.created ? '（新建文件）' : ''
      return { kind: 'success', text: `已记录 → ${record.file} ${where}${suffix}\n- ${record.note}` }
    }
    if (parsed.family === 'note') {
      return runNoteCommand(ctx, agent, { commandId, signal }, cwd, settings)
    }
    if (parsed.family === 'view') {
      if (parsed.text === null) {
        const journal = await readJournalFile({ cwd, settings })
        if (!journal.exists) {
          return { kind: 'success', text: `尚未创建：${journal.file}\n（首次 /ml 记录或 /ml todo add 时按模板自动创建）` }
        }
        const modeLabel = journal.mode === 'weekly' ? '周志' : '日志'
        return { kind: 'success', text: `${journal.file}（${modeLabel}）\n${'─'.repeat(44)}\n${journal.content.replace(/\n$/, '')}` }
      }
      // 带参数：在扫描范围内的文件名中做模糊解析（VSCode Ctrl+P 风格）
      const files = await listWorkspaceFiles({ cwd, settings })
      const target = resolveViewTarget(parsed.text, files.map((file) => file.name))
      if (target.kind === 'none') {
        return { kind: 'error', text: `没有匹配「${parsed.text}」的文件。可先 /ml view 查看当前日志，或检查设置中的扫描范围。` }
      }
      if (target.kind === 'ambiguous') {
        const list = target.names.map((name, index) => `  ${index + 1}. ${name}`).join('\n')
        return { kind: 'error', text: `「${parsed.text}」匹配到多个文件，请用更长的片段或完整文件名：\n${list}` }
      }
      const content = await readWorkspaceFile(cwd, target.name)
      return { kind: 'success', text: `${target.name}\n${'─'.repeat(44)}\n${content.replace(/\n$/, '')}` }
    }
    if (parsed.action === 'add') {
      return addTodoFlow(agent, cwd, settings, parsed.text, signal)
    }
    if (parsed.action === 'toggle') {
      return toggleTodoByNumber(agent, cwd, parsed.n)
    }
    if (parsed.action === 'cancel') {
      return cancelTodoByNumber(agent, cwd, parsed.n)
    }
    if (parsed.action === 'postpone') {
      return postponeTodoByNumber(agent, cwd, parsed.n, parsed.days)
    }
    if (parsed.action === 'undo') {
      return undoLastOperation(agent, cwd)
    }
    const today = formatDate(new Date())
    const query = createTodoQuery({
      status: parsed.status ?? settings.defaultStatus,
      text: parsed.text,
      limit: null,
      today,
    })
    const scanner = createTodoScanner({ registry, fileSource, limits: createScanLimits(settings) })
    let report = await scanner.scan(cwd, settings, signal)

    // 唤醒遍历：到日、未完成、未取消的 sleep 落盘转写为 active，再以转写后的 meta 呈现
    const { woken, failures } = await wakeupSleepingTodos(cwd, report.items, today)
    if (woken > 0 || failures.length > 0) {
      report = Object.freeze({
        ...report,
        wokenCount: woken,
        items: Object.freeze(
          report.items.map((item) =>
            item.meta !== null && item.meta.type === 'sleep' && item.done !== true && item.cancelled !== true &&
            typeof item.meta.date === 'string' && item.meta.date <= today && item.raw !== null
              ? Object.freeze({ ...item, meta: Object.freeze({ type: 'active', date: null, prio: item.meta.prio }) })
              : item,
          ),
        ),
      })
    }

    // 记录本次 list 的展示顺序（/ml todo d <n> 的寻址表），与渲染序号一致
    lastListByAgent.set(agentIdOf(agent), applyTodoQuery(query, report.items).items)
    return { kind: 'success', text: renderTodoText(report, query) }
  }

  /** 寻址最近一次 list 的第 n 条（序号合法性 + 行原始内容）。 */
  function itemAt(agent, n) {
    const list = lastListByAgent.get(agentIdOf(agent))
    if (list === undefined || list.length === 0) {
      return { error: '还没有可寻址的待办列表 —— 请先执行 /ml todo list。' }
    }
    if (n > list.length) {
      return { error: `序号超出范围：最近一次列表共 ${list.length} 条（收到 ${n}）。请重新 /ml todo list。` }
    }
    return { item: list[n - 1] }
  }

  /** 操作入撤销栈（d/c/p 共用：preRaw = 操作那一刻文件里的行，postRaw = 操作后的行）。 */
  function pushUndo(agent, item, n, action, preRaw, postRaw) {
    if (typeof preRaw !== 'string' || typeof postRaw !== 'string') return
    const key = agentIdOf(agent)
    if (!undoStackByAgent.has(key)) undoStackByAgent.set(key, [])
    undoStackByAgent.get(key).push({ file: item.file, line: item.line, preRaw, postRaw, n, text: item.text, action })
  }

  /** 操作成功后回写寻址表：更新该条目的 raw（与从新行推断的完成/取消态），
   *  使后续 d/c/p/u 不必重新 list 也能继续寻址（relocate 的 expectedRaw 用）。 */
  function refreshListItem(agent, n, raw) {
    if (typeof raw !== 'string') return
    const key = agentIdOf(agent)
    const list = lastListByAgent.get(key)
    if (list === undefined || n < 1 || n > list.length) return
    const done = /^[ \t]*(?:[-*+])[ \t]+\[[xX]\]/.test(raw)
    const cancelled = /^[ \t]*(?:[-*+])[ \t]+\[-\]/.test(raw)
    // applyTodoQuery 返回的是冻结数组——重建一份再存
    lastListByAgent.set(key, list.map((item, index) => (index === n - 1 ? Object.freeze({ ...item, done, cancelled, raw }) : item)))
  }

  /** /ml todo d <n>：按最近一次 list 的序号切换完成态。 */
  async function toggleTodoByNumber(agent, cwd, n) {
    const located = itemAt(agent, n)
    if (located.error !== undefined) return { kind: 'error', text: located.error }
    const item = located.item
    const today = formatDate(new Date())
    let result
    try {
      result = await toggleTodoAt(cwd, item.file, item.line, today, typeof item.raw === 'string' ? item.raw : undefined)
    } catch (error) {
      if (error instanceof TodoError) return { kind: 'error', text: `切换失败：${error.message}` }
      throw error
    }
    pushUndo(agent, item, n, 'done', result.preRaw, result.raw)
    refreshListItem(agent, n, result.raw)
    const state = result.done ? `已完成 ☑（完成于 ${today}）` : '未完成 ☐'
    return { kind: 'success', text: `#${n} → ${state} ${item.text}\n（${item.file}:${item.line}）` }
  }

  /** /ml todo c <n>：取消/恢复该待办（[-] + cancelled:日期；再执行一次恢复）。 */
  async function cancelTodoByNumber(agent, cwd, n) {
    const located = itemAt(agent, n)
    if (located.error !== undefined) return { kind: 'error', text: located.error }
    const item = located.item
    if (item.done === true) {
      return { kind: 'error', text: `#${n} 已完成，不能取消——需要先 /ml todo d ${n} 切回未完成。\n${item.text}` }
    }
    const today = formatDate(new Date())
    let result
    try {
      result = await cancelTodoAt(cwd, item.file, item.line, today, typeof item.raw === 'string' ? item.raw : undefined)
    } catch (error) {
      if (error instanceof TodoError) return { kind: 'error', text: `取消失败：${error.message}` }
      throw error
    }
    pushUndo(agent, item, n, 'cancel', result.preRaw, result.raw)
    refreshListItem(agent, n, result.raw)
    const state = result.cancelled ? `已取消 ☒（取消于 ${today}，从默认列表隐藏；/ml todo l cancelled 可单看）` : '已恢复 ☐'
    return { kind: 'success', text: `#${n} → ${state} ${item.text}\n（${item.file}:${item.line}）` }
  }

  /** /ml todo p <n> [days]：延期 deadline 待办（截止日 +days 天）。 */
  async function postponeTodoByNumber(agent, cwd, n, days) {
    const located = itemAt(agent, n)
    if (located.error !== undefined) return { kind: 'error', text: located.error }
    const item = located.item
    if (item.done === true) {
      return { kind: 'error', text: `#${n} 已完成，延期无意义——先 /ml todo d ${n} 切回未完成。\n${item.text}` }
    }
    if (item.cancelled === true) {
      return { kind: 'error', text: `#${n} 已取消，延期无意义——先 /ml todo c ${n} 恢复。\n${item.text}` }
    }
    if (item.meta === null || item.meta.type !== 'deadline') {
      const kindLabel = item.meta === null ? '普通待办（无类型标记）' : `${item.meta.type} 型`
      return { kind: 'error', text: `#${n} 是 ${kindLabel}，不能延期——只有 deadline 型有截止日可延。\n${item.text}` }
    }
    let result
    try {
      result = await postponeTodoAt(cwd, item.file, item.line, days, typeof item.raw === 'string' ? item.raw : undefined)
    } catch (error) {
      if (error instanceof TodoError) return { kind: 'error', text: `延期失败：${error.message}` }
      throw error
    }
    pushUndo(agent, item, n, 'postpone', result.preRaw, result.raw)
    refreshListItem(agent, n, result.raw)
    return {
      kind: 'success',
      text: `#${n} 截止日 ${result.previousDate} → ${result.date}（延 ${days} 天）${item.text}\n（${item.file}:${item.line}）`,
    }
  }

  /** /ml todo u：撤销最近一次 d/c/p（LIFO，可连续）。 */
  async function undoLastOperation(agent, cwd) {
    const stack = undoStackByAgent.get(agentIdOf(agent))
    if (stack === undefined || stack.length === 0) {
      return { kind: 'error', text: '没有可撤销的操作 —— 请先 /ml todo d / c / p <序号>。' }
    }
    const entry = stack[stack.length - 1]
    if (typeof entry.preRaw !== 'string' || typeof entry.postRaw !== 'string') {
      stack.pop()
      return { kind: 'error', text: '该操作的原始行未留存，无法撤销（不影响后续撤销）。' }
    }
    try {
      await restoreTodoAt(cwd, entry.file, entry.line, entry.postRaw, entry.preRaw)
    } catch (error) {
      if (error instanceof TodoError) return { kind: 'error', text: `撤销失败：${error.message}` }
      throw error
    }
    stack.pop()
    refreshListItem(agent, entry.n, entry.preRaw)
    const actionLabel = { done: '完成', cancel: '取消', postpone: '延期' }[entry.action] ?? '操作'
    return { kind: 'success', text: `已撤销${actionLabel} → 恢复原样：${entry.text}\n（${entry.file}:${entry.line}）` }
  }

  /** agent → 稳定键（无 id 的调用降级为共享桶）。 */
  function agentIdOf(agent) {
    const id = agent !== null && typeof agent === 'object' && typeof agent.id === 'string' ? agent.id : '_anonymous'
    return id
  }

  /**
   * /ml init：指定/更换 Vault 目录。弹出目录选择卡（web 端由客户端半
   * 接管渲染：路径输入 + Tab 补全 + 系统对话框；其余环境自由输入）→
   * 准备目录（缺失则创建）→ 存进全局设置（~/.dsh/settings.yaml）→
   * 把当时生效的设置复制为 vault 内的 .memoryleak.yaml（已存在则保留，
   * 它优先级更高）。已设置过时同样可执行 = 换目录。
   *
   * @returns {Promise<{ kind: 'success', text: string } | { kind: 'error', text: string }>}
   */
  async function initVaultCommand(agent, signal) {
    const userQuestions = ctx.get('userQuestions')
    if (userQuestions === undefined) {
      return { kind: 'error', text: '当前环境没有可用的交互提问界面，无法执行 /ml init。请在 GUI 设置 → MemoryLeak 中填写「Vault 目录」。' }
    }
    const previous = resolveMemoryleakSettings(scope.get()).vault
    const sessionCwd = agent !== null && typeof agent === 'object' && typeof agent.session?.header?.cwd === 'string' ? agent.session.header.cwd : ''
    const answer = await userQuestions.ask({
      agent,
      signal,
      questions: [
        {
          id: ML_VAULT_QUESTION_ID,
          header: 'MemoryLeak Vault',
          question: previous === '' ? '选择 Vault 目录（日志与待办的存放位置）' : `更换 Vault 目录（当前：${previous}）`,
          options: sessionCwd === '' ? [] : [{ label: sessionCwd, description: '当前会话的工作区' }],
        },
      ],
    })
    const entry = answer?.answers?.find((item) => item.id === ML_VAULT_QUESTION_ID)
    const picked = Array.isArray(entry?.selected) ? entry.selected[0] : undefined
    const custom = typeof entry?.custom === 'string' ? entry.custom.trim() : ''
    const raw = custom !== '' ? custom : typeof picked === 'string' ? picked : ''
    if (raw === '') {
      return { kind: 'error', text: '没有收到有效的目录路径，Vault 未变更。' }
    }
    let vaultDir
    try {
      vaultDir = await prepareVaultDir(raw)
    } catch (error) {
      return { kind: 'error', text: `Vault 目录不可用：${error instanceof Error ? error.message : String(error)}` }
    }
    try {
      await ctx.settings.update(MEMORYLEAK_SETTINGS_NAMESPACE, { vault: vaultDir })
    } catch (error) {
      return { kind: 'error', text: `保存 Vault 设置失败：${error instanceof Error ? error.message : String(error)}` }
    }
    try {
      // 双写的另一半：与全局同一份同步进 vault（剔除 vault 键；换目录到
      // 已有旧文件的地方也直接刷新为当前生效值）。
      await writeVaultSettingsFile(vaultDir, resolveMemoryleakSettings(scope.get()))
    } catch (error) {
      return { kind: 'error', text: `写入 ${VAULT_SETTINGS_FILENAME} 失败：${error instanceof Error ? error.message : String(error)}` }
    }
    return {
      kind: 'success',
      text: [
        `Vault 已设置 → ${vaultDir}`,
        `设置文件：${VAULT_SETTINGS_FILENAME}（此文件里的键优先级高于全局设置）`,
        '现在可以用 /ml <文本> 记录、/ml todo 管待办、/ml view 查看了。',
      ].join('\n'),
    }
  }

  /**
   * /ml todo add 的交互流：固定格式提问（类型 → 优先级 → 日期），全程无 LLM。
   * ask 请求必须携带命令调用中的 agent：web Provider 依赖 agent.id 把弹窗
   * 路由到正确的会话（缺省会 ASK_MISSING_AGENT 拒绝）。
   */
  async function addTodoFlow(agent, cwd, settings, text, signal) {
    const userQuestions = ctx.get('userQuestions')
    if (userQuestions === undefined) {
      return { kind: 'error', text: '当前环境没有可用的交互提问界面，无法运行 /ml todo add。' }
    }

    // 第一轮：类型 + 优先级（固定选项）。两问同一批发出：web 端客户端半
    // 认领渲染成一张组合卡（选完两项即自动提交），其余环境走通用逐题问答。
    const choice = await userQuestions.ask({
      agent,
      signal,
      questions: [
        {
          id: ML_TYPE_QUESTION_ID,
          header: 'MemoryLeak 待办',
          question: `待办「${text}」的类型？`,
          options: [
            { label: 'deadline', description: '有固定终结日期，到日截止' },
            { label: 'sleep', description: '先收起，到指定日期唤醒（唤醒前不出现在默认列表）' },
            { label: 'anytime', description: '随时搞一下，只记录' },
          ],
        },
        {
          id: ML_PRIO_QUESTION_ID,
          header: 'MemoryLeak 待办',
          question: '重要程度？',
          options: [
            { label: 'urgent', description: '紧急' },
            { label: 'medium', description: '中等' },
            { label: 'low', description: '低优先级' },
          ],
        },
      ],
    })
    const type = pick(choice, ML_TYPE_QUESTION_ID, ['deadline', 'sleep', 'anytime'])
    const prio = pick(choice, ML_PRIO_QUESTION_ID, ['urgent', 'medium', 'low'])
    if (type === null || prio === null) {
      return { kind: 'error', text: '选择无效：请从给出的选项中选取待办类型与重要程度。' }
    }

    // 第二轮：deadline / sleep 需要日期。问题 id 固定为 ML_DATE_QUESTION_ID：
    // web 端本插件的客户端半认领 composer 渲染日期选择器（日历 + 今天/明天/
    // 本周/本月快捷键）；其余环境（TUI/原生）仍是自由输入。答案统一走
    // custom: yyyy-mm-dd，格式裁决留在宿主。
    let date = null
    if (type === 'deadline' || type === 'sleep') {
      const hint = type === 'deadline' ? '截止日期' : '唤醒日期'
      const answer = await userQuestions.ask({
        agent,
        signal,
        questions: [{ id: ML_DATE_QUESTION_ID, header: 'MemoryLeak 待办', question: `${hint}是哪天？（yyyy-mm-dd）` }],
      })
      const raw = (answer?.answers?.find((entry) => entry.id === ML_DATE_QUESTION_ID)?.custom ?? '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return { kind: 'error', text: `日期格式无效（收到 "${raw}"），需要 yyyy-mm-dd。待办未写入。` }
      }
      date = raw
    }

    const todoLine = buildStructuredTodoLine({ type, date, prio, text })
    const record = await recordTodoLine({ cwd, settings, todoLine })
    const label = todoLabelOf(type, date, prio)
    const suffix = record.created ? '（新建文件）' : ''
    return { kind: 'success', text: `已添加 → ${record.file} ## Todo${suffix}\n${todoLine}\n${label}` }
  }

  /** 从 ask 答案中取出一个合法选项值（label 精确匹配，防自定义文本注入）。 */
  function pick(answer, id, allowed) {
    const selected = answer?.answers?.find((entry) => entry.id === id)?.selected ?? []
    const label = Array.isArray(selected) ? selected[0] : undefined
    return typeof label === 'string' && allowed.includes(label) ? label : null
  }

  /** 待办的人类可读摘要。 */
  function todoLabelOf(type, date, prio) {
    const names = { deadline: '截止型', sleep: '睡眠型（到日唤醒）', anytime: '随时型' }
    const prioNames = { urgent: '紧急', medium: '中等', low: '低优先级' }
    const datePart = date === null ? '' : `，日期 ${date}`
    return `（${names[type]}${datePart}，${prioNames[prio]}）`
  }

  /** 包装：可预期故障 → 命令错误结果；未知异常原样上抛（可见崩溃）。 */
  function wrappedHandler(invocation) {
    return mlCommandHandler(invocation).catch((error) => {
      if (error instanceof TodoUsageError) return { kind: 'error', text: error.message }
      if (error instanceof TodoRootError) return { kind: 'error', text: `工作区目录不可用：${error.message}` }
      if (error instanceof TodoScanAbortedError) return { kind: 'error', text: '扫描已取消。' }
      if (error instanceof JournalIoError) return { kind: 'error', text: `日志写入失败：${error.message}` }
      if (error instanceof NoteParseError) return { kind: 'error', text: `模型输出无法解析：${error.message}` }
      if (error instanceof NoteLlmError) return { kind: 'error', text: `压缩调用失败：${error.message}` }
      if (invocation.signal?.aborted) return { kind: 'error', text: '/ml note 已取消。' }
      throw error
    })
  }}
