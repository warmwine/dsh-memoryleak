/**
 * dsh-memoryleak —— 宿主半（Cordis 插件）。
 *
 * 职责（组装根）：
 *   1. 装配核心引擎：Registry（内置 markdown-checkbox Strategy）+ NodeFileSource
 *   2. 注册 `memoryleak` 设置命名空间（持久化到 ~/.dsh/settings.yaml）
 *   3. 暴露 /api/memoryleak/* JSON 路由（设置窗口的读写桥）
 *   4. 注册 /ml 命令（dsh-commands 人类命令面）：记录日志 + 待办列表
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
import { wakeupSleepingTodos, toggleTodoAt, undoTodoAt, readJournalFile, listWorkspaceFiles, readWorkspaceFile } from './journal.js'
import { resolveViewTarget } from './core/fuzzy.js'

/** 稳定的 cordis 插件名（与 cordis.patch.yml 的 insert id 一致）。 */
export const name = 'memoryleak'

/**
 * 硬依赖：webServer（API 路由）、commands（/ml）、settings（持久化设置）、
 * sessions（/api/memoryleak/files 按会话定位工作区 —— ctx.sessions.get）。
 */
export const inject = ['webServer', 'commands', 'settings', 'sessions']

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
        input: { hint: '<文本> / todo 子命令 / view / help' },
        handler: wrappedHandler,
      }),
    'memoryleak: /ml command',
  )

  /**
   * 命令处理器：按文法分发到帮助 / 日志记录 / 待办操作。
   *
   * @param {{ agent: { session?: { header?: { cwd?: string } } }, rawInput: string, signal: AbortSignal }} invocation
   * @returns {Promise<{ kind: 'success', text: string } | { kind: 'error', text: string }>}
   */
  async function mlCommandHandler({ agent, rawInput, signal }) {
    const parsed = parseMlArgs(rawInput)
    if (parsed.family === 'help') {
      return { kind: 'success', text: renderMlHelp() }
    }
    const cwd = agent !== null && typeof agent === 'object' ? agent.session?.header?.cwd : undefined
    if (typeof cwd !== 'string' || cwd === '') {
      return { kind: 'error', text: '当前会话没有绑定工作区目录。' }
    }
    const settings = resolveMemoryleakSettings(scope.get())
    if (parsed.family === 'journal') {
      const record = await recordJournalNote({ cwd, settings, text: parsed.text })
      const where = record.mode === 'weekly' ? `## MemoryLeak · ${record.date}` : '## MemoryLeak'
      const suffix = record.created ? '（新建文件）' : ''
      return { kind: 'success', text: `已记录 → ${record.file} ${where}${suffix}\n- ${record.note}` }
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
    if (parsed.action === 'undo') {
      return undoLastToggle(agent, cwd)
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

    // 唤醒遍历：到日的 sleep 落盘转写为 active，再以转写后的 meta 呈现
    const { woken, failures } = await wakeupSleepingTodos(cwd, report.items, today)
    if (woken > 0 || failures.length > 0) {
      report = Object.freeze({
        ...report,
        wokenCount: woken,
        items: Object.freeze(
          report.items.map((item) =>
            item.meta !== null && item.meta.type === 'sleep' && item.done !== true &&
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

  /** /ml todo d <n>：按最近一次 list 的序号切换完成态（成功后入撤销栈）。 */
  async function toggleTodoByNumber(agent, cwd, n) {
    const list = lastListByAgent.get(agentIdOf(agent))
    if (list === undefined || list.length === 0) {
      return { kind: 'error', text: '还没有可寻址的待办列表 —— 请先执行 /ml todo list。' }
    }
    if (n > list.length) {
      return { kind: 'error', text: `序号超出范围：最近一次列表共 ${list.length} 条（收到 ${n}）。请重新 /ml todo list。` }
    }
    const item = list[n - 1]
    let result
    try {
      result = await toggleTodoAt(cwd, item.file, item.line)
    } catch (error) {
      if (error instanceof TodoError) return { kind: 'error', text: `切换失败：${error.message}` }
      throw error
    }
    const key = agentIdOf(agent)
    if (!undoStackByAgent.has(key)) undoStackByAgent.set(key, [])
    undoStackByAgent.get(key).push({ file: item.file, line: item.line, postRaw: result.raw, n, text: item.text })
    const state = result.done ? '已完成 ☑' : '未完成 ☐'
    return { kind: 'success', text: `#${n} → ${state} ${item.text}\n（${item.file}:${item.line}）` }
  }

  /** /ml todo u：撤销最近一次 d（LIFO，可连续）。 */
  async function undoLastToggle(agent, cwd) {
    const stack = undoStackByAgent.get(agentIdOf(agent))
    if (stack === undefined || stack.length === 0) {
      return { kind: 'error', text: '没有可撤销的操作 —— 请先 /ml todo d <序号>。' }
    }
    const entry = stack.pop()
    let result
    try {
      result = await undoTodoAt(cwd, entry.file, entry.line, entry.postRaw)
    } catch (error) {
      if (error instanceof TodoError) return { kind: 'error', text: `撤销失败：${error.message}` }
      throw error
    }
    const state = result.done ? '已完成 ☑' : '未完成 ☐'
    return { kind: 'success', text: `已撤销 #${entry.n} → ${state} ${entry.text}\n（${entry.file}:${entry.line}）` }
  }

  /** agent → 稳定键（无 id 的调用降级为共享桶）。 */
  function agentIdOf(agent) {
    const id = agent !== null && typeof agent === 'object' && typeof agent.id === 'string' ? agent.id : '_anonymous'
    return id
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

    // 第一轮：类型 + 优先级（固定选项）
    const choice = await userQuestions.ask({
      agent,
      signal,
      questions: [
        {
          id: 'type',
          question: `待办「${text}」的类型？`,
          options: [
            { label: 'deadline', description: '有固定终结日期，到日截止' },
            { label: 'sleep', description: '先收起，到指定日期唤醒（唤醒前不出现在默认列表）' },
            { label: 'anytime', description: '随时搞一下，只记录' },
          ],
        },
        {
          id: 'prio',
          question: '重要程度？',
          options: [
            { label: 'urgent', description: '紧急' },
            { label: 'medium', description: '中等' },
            { label: 'low', description: '低优先级' },
          ],
        },
      ],
    })
    const type = pick(choice, 'type', ['deadline', 'sleep', 'anytime'])
    const prio = pick(choice, 'prio', ['urgent', 'medium', 'low'])
    if (type === null || prio === null) {
      return { kind: 'error', text: '选择无效：请从给出的选项中选取待办类型与重要程度。' }
    }

    // 第二轮：deadline / sleep 需要日期（自由输入）
    let date = null
    if (type === 'deadline' || type === 'sleep') {
      const hint = type === 'deadline' ? '截止日期' : '唤醒日期'
      const answer = await userQuestions.ask({
        agent,
        signal,
        questions: [{ id: 'date', question: `${hint}是哪天？（yyyy-mm-dd）` }],
      })
      const raw = (answer?.answers?.find((entry) => entry.id === 'date')?.custom ?? '').trim()
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
      throw error
    })
  }
}
