/**
 * TodoFormatRegistry —— Strategy 的注册表（Registry 模式）。
 *
 * - 注册期做完整契约校验：畸形 Strategy、重复 id 在启动时抛
 *   TodoFormatContractError（let-it-crash：宁可启动崩溃，不要运行期半瘫）。
 * - 解析时按 priority 升序（小者优先）尝试，首个命中即返回；同优先级按 id
 *   字典序稳定排序 —— 结果可复现。
 * - register 返回注销函数：副作用可逆，宿主插件停用/更新时逐项回收。
 *
 * @module dsh-memoryleak/core/registry
 */
import { invariant, TodoFormatContractError } from './errors.js'
import { markdownCheckboxFormat } from './formats/markdown-checkbox.js'
import { memoryleakTodoFormat, isValidTodoMeta } from './formats/memoryleak-todo.js'

const FORMAT_ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** 对单个 Strategy 做契约校验（供注册与测试复用）。 */
export function assertTodoFormat(format) {
  invariant(format !== null && typeof format === 'object', 'todo format 必须是对象', TodoFormatContractError)
  invariant(
    typeof format.id === 'string' && FORMAT_ID_PATTERN.test(format.id),
    `todo format id 必须匹配 ${FORMAT_ID_PATTERN.toString()}（收到 ${JSON.stringify(format.id)}）`,
    TodoFormatContractError,
  )
  invariant(
    typeof format.title === 'string' && format.title.trim() !== '',
    `todo format "${String(format.id)}" 缺少非空 title`,
    TodoFormatContractError,
  )
  invariant(
    typeof format.parse === 'function',
    `todo format "${String(format.id)}" 缺少 parse(line) 函数`,
    TodoFormatContractError,
  )
  return format
}

export class TodoFormatRegistry {
  /** @type {ReadonlyArray<{ format: object, priority: number }>} */
  #entries = []

  /**
   * 注册一个格式 Strategy。
   *
   * @param {import('./formats/markdown-checkbox.js').TodoFormat} format
   * @param {{ priority?: number }} [options] 越小越先尝试
   * @returns {() => void} 注销函数（可逆副作用）
   */
  register(format, options = {}) {
    assertTodoFormat(format)
    const priority = options.priority ?? 100
    invariant(Number.isFinite(priority), `todo format "${format.id}" priority 必须是有限数`)
    if (this.#entries.some((entry) => entry.format.id === format.id)) {
      throw new TodoFormatContractError(`todo format "${format.id}" 已注册（重复注册通常意味着插件冲突）`)
    }
    const entry = Object.freeze({ format: Object.freeze({ ...format }), priority })
    const next = [...this.#entries, entry].sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority
      return left.format.id < right.format.id ? -1 : 1
    })
    this.#entries = next
    return () => {
      this.#entries = this.#entries.filter((candidate) => candidate !== entry)
    }
  }

  /** 当前生效的格式 id（按尝试顺序）。 */
  get ids() {
    return this.#entries.map((entry) => entry.format.id)
  }

  /** 设置窗口展示用的描述符列表。 */
  get descriptors() {
    return this.#entries.map((entry) => ({ id: entry.format.id, title: entry.format.title, priority: entry.priority }))
  }

  /**
   * 逐格式尝试解析一行；命中即在返回值上补 `format` id。
   * Strategy 返回的 match 也在此边界校验 —— 坏 Strategy 立即崩溃。
   *
   * @param {string} line
   * @returns {import('./formats/markdown-checkbox.js').TodoFormatMatch & { format: string } | null}
   */
  parseLine(line) {
    invariant(typeof line === 'string', 'parseLine(line) 需要 string')
    for (const { format } of this.#entries) {
      const match = format.parse(line)
      if (match === null || match === undefined) continue
      invariant(match !== null && typeof match === 'object', `todo format "${format.id}" parse() 返回了非对象 match`)
      invariant(typeof match.done === 'boolean', `todo format "${format.id}" parse() 的 match.done 必须是布尔值`)
      invariant(
        typeof match.text === 'string' && match.text.trim() !== '',
        `todo format "${format.id}" parse() 的 match.text 必须是非空字符串`,
      )
      if (match.meta !== null && match.meta !== undefined && !isValidTodoMeta(match.meta)) {
        throw new TodoFormatContractError(`todo format "${format.id}" parse() 的 match.meta 形状非法`)
      }
      return Object.freeze({
        done: match.done,
        cancelled: match.cancelled === true,
        text: match.text.trim(),
        raw: typeof match.raw === 'string' ? match.raw : line,
        meta: match.meta === null || match.meta === undefined ? null : Object.freeze({ ...match.meta }),
        format: format.id,
      })
    }
    return null
  }
}

/**
 * 建立默认注册表（内置 memoryleak-todo + markdown-checkbox）。额外的
 * Strategy 作为参数注入。memoryleak-todo 优先（priority 50）：结构化行
 * 优先携带 meta 解析；未命中再落回普通复选框策略。
 *
 * @param {import('./formats/markdown-checkbox.js').TodoFormat[]} [extraFormats]
 */
export function createDefaultRegistry(extraFormats = []) {
  const registry = new TodoFormatRegistry()
  registry.register(memoryleakTodoFormat, { priority: 50 })
  registry.register(markdownCheckboxFormat, { priority: 100 })
  for (const format of extraFormats) registry.register(format)
  return registry
}
