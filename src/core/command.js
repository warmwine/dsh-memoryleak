/**
 * /todo 命令文法（纯函数，独立测试）。
 *
 * V1 文法：/todo list [all|open|done] [关键词…]
 *   - 第一个词必须是子命令 `list`
 *   - 第二个词若是状态词则吃掉，否则整体视为关键词（/todo list deploy）
 *   - 剩余词以空格连接为大小写不敏感的包含过滤
 * 状态默认值不在这里决定 —— 由设置命名空间的 defaultStatus 注入（查询模型
 * 与文法分离，AI 未来可以绕过文法直接给结构化查询）。
 *
 * @module dsh-notes/core/command
 */
import { TodoUsageError } from './errors.js'
import { TODO_STATUSES } from './filter.js'

export const TODO_USAGE = '/todo list [all|open|done] [关键词]'

/**
 * @param {string} rawInput 命令名之后的原文（含分隔空白）
 * @returns {{ action: 'list', status: import('./filter.js').TodoStatus | null, text: string | null }}
 * @throws {TodoUsageError} 用法错误
 */
export function parseTodoArgs(rawInput) {
  const tokens = String(rawInput ?? '')
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '')
  if (tokens.length === 0) {
    throw new TodoUsageError(`用法：${TODO_USAGE}`)
  }
  const [action, ...rest] = tokens
  if (action !== 'list') {
    throw new TodoUsageError(`未知子命令 "${action}"。用法：${TODO_USAGE}`)
  }
  let status = null
  if (rest.length > 0 && TODO_STATUSES.includes(rest[0])) {
    status = rest[0]
    rest.shift()
  }
  const text = rest.join(' ')
  return { action: 'list', status, text: text === '' ? null : text }
}
