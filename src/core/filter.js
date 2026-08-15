/**
 * TodoQuery —— 待办查询的规格模型（Specification 模式）。
 *
 * 这是为「AI 生成特定格式 todo + 结构化过滤」预留的核心接缝：查询首先是一
 * 份数据（action/status/text/limit），其次才是由它编译出的谓词。未来 AI 的
 * 结构化输入只要能产出同形数据，就免费获得全部过滤与渲染管线。
 *
 * @module dsh-memoryleak/core/filter
 */
import { invariant, TodoError } from './errors.js'

/** 合法的状态过滤词。 */
export const TODO_STATUSES = Object.freeze(['open', 'done', 'all'])

/** @typedef {'open' | 'done' | 'all'} TodoStatus */

/** @typedef {import('./todo-item.js').TodoItem} TodoItem */

/**
 * @typedef {object} TodoQuery
 * @property {'list'} action V1 只有 list；未来扩展 create/summarize…
 * @property {TodoStatus} status
 * @property {string | null} text 大小写不敏感的包含匹配
 * @property {number | null} limit 最多保留条数；null = 不限
 * @property {(item: TodoItem) => boolean} predicate 编译出的组合谓词（内部）
 */

/** 状态规格。 */
function statusSpec(status) {
  if (status === 'all') return () => true
  if (status === 'open') return (item) => item.done !== true
  return (item) => item.done === true
}

/** 文本规格：大小写不敏感包含。 */
function textSpec(text) {
  const needle = text.trim().toLowerCase()
  if (needle === '') return () => true
  return (item) => item.text.toLowerCase().includes(needle)
}

/** 规格组合（And）。 */
function andSpec(left, right) {
  return (item) => left(item) && right(item)
}

/**
 * 构造（校验并冻结的）TodoQuery。
 *
 * @param {{ status?: TodoStatus, text?: string | null, limit?: number | null }} [input]
 * @returns {TodoQuery}
 */
export function createTodoQuery(input = {}) {
  const { status = 'all', text = null, limit = null } = input
  if (!TODO_STATUSES.includes(status)) {
    throw new TodoError(`todo 查询 status 必须是 ${TODO_STATUSES.join(' / ')} 之一（收到 ${JSON.stringify(status)}）`)
  }
  if (text !== null) invariant(typeof text === 'string', 'todo 查询 text 必须是 string 或 null')
  if (limit !== null) {
    invariant(Number.isInteger(limit) && limit >= 1, `todo 查询 limit 必须是正整数或 null（收到 ${String(limit)}）`)
  }
  const normalizedText = typeof text === 'string' ? text.trim() : ''
  return Object.freeze({
    action: 'list',
    status,
    text: normalizedText === '' ? null : normalizedText,
    limit,
    predicate: andSpec(statusSpec(status), textSpec(normalizedText)),
  })
}

/**
 * 将查询应用到待办序列。
 *
 * @param {TodoQuery} query
 * @param {ReadonlyArray<TodoItem>} items
 * @returns {{ items: TodoItem[], truncated: boolean, totalScanned: number }}
 */
export function applyTodoQuery(query, items) {
  invariant(query !== null && typeof query === 'object' && typeof query.predicate === 'function', 'applyTodoQuery 需要一个 TodoQuery')
  const matched = []
  let truncated = false
  for (const item of items) {
    if (query.predicate(item) !== true) continue
    if (query.limit !== null && matched.length >= query.limit) {
      truncated = true
      break
    }
    matched.push(item)
  }
  return Object.freeze({ items: Object.freeze(matched), truncated, totalScanned: items.length })
}
