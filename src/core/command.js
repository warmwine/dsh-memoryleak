/**
 * /ml 命令文法（纯函数，独立测试）。
 *
 * V1 文法（两个家族）：
 *   /ml <文本>                      → 记一笔：写入工作区日志/周志的 ## MemoryLeak
 *   /ml todo add <文本>             → 添加结构化待办（提问类型/优先级/日期）到 ## Todo
 *   /ml todo [list] [状态] [关键词]  → 列出工作区 Markdown 待办（默认隐藏未唤醒的 sleep）
 *   /ml todo d <n> | done <n>       → 切换最近一次 list 结果中第 n 条的完成态
 *
 * 家族判定：第一个词是 `todo` 即待办家族（todo 是保留字，记录文本以 todo
 * 开头时请换措辞）；其余一切非空输入都是记录文本。
 * 状态默认值不在这里决定 —— 由设置命名空间的 defaultStatus 注入（查询模型
 * 与文法分离，AI 未来可以绕过文法直接给结构化查询）。
 *
 * @module dsh-memoryleak/core/command
 */
import { TodoUsageError } from './errors.js'
import { TODO_STATUSES } from './filter.js'

export const ML_USAGE = '/ml <文本> · /ml todo add <文本> · /ml todo list [all|open|done] [关键词] · /ml todo d <序号>'

/**
 * @param {string} rawInput 命令名（/ml）之后的原文（含分隔空白）
 * @returns {{
 *   family: 'journal', text: string
 * } | {
 *   family: 'todo', action: 'add', text: string
 * } | {
 *   family: 'todo', action: 'list', status: import('./filter.js').TodoStatus | null, text: string | null
 * } | {
 *   family: 'todo', action: 'toggle', n: number
 * }}
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
    return { family: 'journal', text: tokens.join(' ') }
  }
  if (action === 'add') {
    const text = rest.join(' ')
    if (text === '') throw new TodoUsageError('用法：/ml todo add <待办内容>')
    return { family: 'todo', action: 'add', text }
  }
  if (action === 'd' || action === 'done') {
    const token = rest[0]
    const n = token !== undefined && /^\d+$/.test(token) ? Number(token) : NaN
    if (!Number.isInteger(n) || n < 1) {
      throw new TodoUsageError('用法：/ml todo d <序号>（序号来自最近一次 /ml todo list 的输出）')
    }
    return { family: 'todo', action: 'toggle', n }
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
