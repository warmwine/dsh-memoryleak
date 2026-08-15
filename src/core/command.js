/**
 * /ml 命令文法（纯函数，独立测试）。
 *
 * V1 文法：/ml todo list [all|open|done] [关键词…]
 *   - 第一个词是家族名，V1 只有 `todo`（未来 note / plan 等在同层扩展）
 *   - 第二个词是操作，V1 只有 `list`；省略时默认 list（/ml todo ≡ /ml todo list）
 *   - 第三个词若是状态词（all|open|done）则吃掉，否则视为关键词的一部分
 *   - 剩余词以空格连接为大小写不敏感的包含过滤
 * 状态默认值不在这里决定 —— 由设置命名空间的 defaultStatus 注入（查询模型
 * 与文法分离，AI 未来可以绕过文法直接给结构化查询）。
 *
 * @module dsh-memoryleak/core/command
 */
import { TodoUsageError } from './errors.js'
import { TODO_STATUSES } from './filter.js'

export const ML_USAGE = '/ml todo list [all|open|done] [关键词]'

/**
 * @param {string} rawInput 命令名（/ml）之后的原文（含分隔空白）
 * @returns {{ family: 'todo', action: 'list', status: import('./filter.js').TodoStatus | null, text: string | null }}
 * @throws {TodoUsageError} 用法错误
 */
export function parseMlArgs(rawInput) {
  const tokens = String(rawInput ?? '')
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '')
  if (tokens.length === 0) {
    throw new TodoUsageError(`用法：${ML_USAGE}`)
  }
  const [family, action, ...rest] = tokens
  if (family !== 'todo') {
    throw new TodoUsageError(`未知子命令 "${family}"。用法：${ML_USAGE}`)
  }
  if (action !== undefined && action !== 'list') {
    throw new TodoUsageError(`未知操作 "${action}"。用法：${ML_USAGE}`)
  }
  let status = null
  if (rest.length > 0 && TODO_STATUSES.includes(rest[0])) {
    status = rest[0]
    rest.shift()
  }
  const text = rest.join(' ')
  return { family: 'todo', action: 'list', status, text: text === '' ? null : text }
}
