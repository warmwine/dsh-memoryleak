/**
 * dsh-notes —— 宿主半（Cordis 插件）。
 *
 * 职责（组装根）：
 *   1. 装配核心引擎：Registry（内置 markdown-checkbox Strategy）+ NodeFileSource
 *   2. 注册 `notes` 设置命名空间（持久化到 ~/.dsh/settings.yaml）
 *   3. 暴露 /api/notes/* JSON 路由（设置窗口的读写桥）
 *   4. 注册 /todo 命令（dsh-commands 人类命令面）
 *
 * 所有副作用挂在自身 Fiber 上：settings 注册随插件停用自动回收，路由与命令
 * 用 ctx.effect 显式回收。故障分级遵循 docs/DEVELOPMENT.md §2：用法/环境错
 * 误转成命令错误结果；未知异常上抛给 dsh-commands 记为 command/done: error
 * （let it crash 的可见出口）。
 *
 * @module dsh-notes
 */
import { createDefaultRegistry } from './core/registry.js'
import { createScanLimits, createTodoScanner } from './core/scan.js'
import { createNodeFileSource } from './adapters/node-file-source.js'
import { makeNotesRoutes } from './routes.js'
import {
  NOTES_SETTINGS_NAMESPACE,
  NOTES_SETTINGS_DEFAULTS,
  notesSettingsSchema,
  resolveNotesSettings,
} from './settings-schema.js'
import { parseTodoArgs } from './core/command.js'
import { createTodoQuery } from './core/filter.js'
import { renderTodoText } from './core/render.js'
import { TodoRootError, TodoScanAbortedError, TodoUsageError } from './core/errors.js'

/** 稳定的 cordis 插件名（与 cordis.patch.yml 的 insert id 一致）。 */
export const name = 'notes'

/** 硬依赖：webServer（API 路由）、commands（/todo）、settings（持久化设置）。 */
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
  const scope = ctx.settings.register(NOTES_SETTINGS_NAMESPACE, notesSettingsSchema, { base: NOTES_SETTINGS_DEFAULTS })

  // ---- /api/notes/* 路由 ----
  const routes = makeNotesRoutes({ ctx, scope, registry })
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'notes: /api/notes routes')

  // ---- /todo 命令（单一注册点）----
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'todo',
        description: '记事本：列出当前工作区 Markdown 里的待办（/todo list [all|open|done] [关键词]）',
        input: { hint: 'list [all|open|done] [关键词]' },
        handler: wrappedHandler,
      }),
    'notes: /todo command',
  )

  /**
   * 命令处理器：组装查询 → 扫描 → 渲染。
   *
   * @param {{ agent: { session?: { header?: { cwd?: string } } }, rawInput: string, signal: AbortSignal }} invocation
   * @returns {Promise<{ kind: 'success', text: string } | { kind: 'error', text: string }>}
   */
  async function todoCommandHandler({ agent, rawInput, signal }) {
    const cwd = agent !== null && typeof agent === 'object' ? agent.session?.header?.cwd : undefined
    if (typeof cwd !== 'string' || cwd === '') {
      return { kind: 'error', text: '当前会话没有绑定工作区目录，无法扫描待办。' }
    }
    const parsed = parseTodoArgs(rawInput)
    const settings = resolveNotesSettings(scope.get())
    const query = createTodoQuery({ status: parsed.status ?? settings.defaultStatus, text: parsed.text, limit: null })
    const scanner = createTodoScanner({ registry, fileSource, limits: createScanLimits(settings) })
    const report = await scanner.scan(cwd, settings, signal)
    return { kind: 'success', text: renderTodoText(report, query) }
  }

  /** 包装：可预期故障 → 命令错误结果；未知异常原样上抛（可见崩溃）。 */
  function wrappedHandler(invocation) {
    return todoCommandHandler(invocation).catch((error) => {
      if (error instanceof TodoUsageError) return { kind: 'error', text: error.message }
      if (error instanceof TodoRootError) return { kind: 'error', text: `工作区目录不可用：${error.message}` }
      if (error instanceof TodoScanAbortedError) return { kind: 'error', text: '扫描已取消。' }
      throw error
    })
  }
}
