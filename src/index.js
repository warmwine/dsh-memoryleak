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
import { parseMlArgs } from './core/command.js'
import { createTodoQuery } from './core/filter.js'
import { renderTodoText } from './core/render.js'
import { TodoRootError, TodoScanAbortedError, TodoUsageError } from './core/errors.js'

/** 稳定的 cordis 插件名（与 cordis.patch.yml 的 insert id 一致）。 */
export const name = 'memoryleak'

/** 硬依赖：webServer（API 路由）、commands（/ml todo）、settings（持久化设置）。 */
export const inject = ['webServer', 'commands', 'settings']

export { createDefaultRegistry, createTodoScanner, createScanLimits }

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // ---- 组装核心（纯域 + 适配器）----
  const registry = createDefaultRegistry()
  const fileSource = createNodeFileSource()

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
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'ml',
        description: 'MemoryLeak · /ml <文本> 记一笔 · /ml todo add 加待办（提问类型/优先级） · /ml todo list 列待办',
        input: { hint: '<文本> / todo add <文本> / todo list [all|open|done] [关键词]' },
        handler: wrappedHandler,
      }),
    'memoryleak: /ml command',
  )

  /**
   * 命令处理器：按文法分发到日志记录 / 待办添加 / 待办列表。
   *
   * @param {{ agent: { session?: { header?: { cwd?: string } } }, rawInput: string, signal: AbortSignal }} invocation
   * @returns {Promise<{ kind: 'success', text: string } | { kind: 'error', text: string }>}
   */
  async function mlCommandHandler({ agent, rawInput, signal }) {
    const cwd = agent !== null && typeof agent === 'object' ? agent.session?.header?.cwd : undefined
    if (typeof cwd !== 'string' || cwd === '') {
      return { kind: 'error', text: '当前会话没有绑定工作区目录。' }
    }
    const parsed = parseMlArgs(rawInput)
    const settings = resolveMemoryleakSettings(scope.get())
    if (parsed.family === 'journal') {
      const record = await recordJournalNote({ cwd, settings, text: parsed.text })
      const where = record.mode === 'weekly' ? `## MemoryLeak · ${record.date}` : '## MemoryLeak'
      const suffix = record.created ? '（新建文件）' : ''
      return { kind: 'success', text: `已记录 → ${record.file} ${where}${suffix}\n- ${record.note}` }
    }
    if (parsed.action === 'add') {
      return addTodoFlow(agent, cwd, settings, parsed.text, signal)
    }
    const today = formatDate(new Date())
    const query = createTodoQuery({
      status: parsed.status ?? settings.defaultStatus,
      text: parsed.text,
      limit: null,
      today,
    })
    const scanner = createTodoScanner({ registry, fileSource, limits: createScanLimits(settings) })
    const report = await scanner.scan(cwd, settings, signal)
    return { kind: 'success', text: renderTodoText(report, query) }
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
