/**
 * /ml 命令文法（纯函数，独立测试）。
 *
 * V1 文法（三个家族）：
 *   /ml <文本>                          → 记一笔：写入工作区日志/周志的 ## MemoryLeak
 *   /ml todo n|add <文本>               → 添加结构化待办（提问类型/优先级/日期）到 ## Todo
 *   /ml todo l|list [状态] [关键词]      → 列出工作区 Markdown 待办（默认隐藏未唤醒的 sleep）
 *   /ml todo d|done <n>                 → 切换最近一次 list 结果中第 n 条的完成态
 *   /ml todo u|undo                     → 撤销最近一次 d（可连续撤销，LIFO）
 *   /ml help                            → 命令一览（汇总说明）
 *
 * 家族判定：第一个词是 `todo` / `help` 即对应家族（两者是保留字，记录文本以
 * 它们开头时请换措辞）；其余一切非空输入都是记录文本。
 * 状态默认值不在这里决定 —— 由设置命名空间的 defaultStatus 注入（查询模型
 * 与文法分离，AI 未来可以绕过文法直接给结构化查询）。
 *
 * @module dsh-memoryleak/core/command
 */
import { TodoUsageError } from './errors.js'
import { TODO_STATUSES } from './filter.js'

export const ML_USAGE = '/ml <文本> · /ml todo n <文本> · /ml todo l [all|open|done] [关键词] · /ml todo d <序号> · /ml todo u · /ml help'

/**
 * @param {string} rawInput 命令名（/ml）之后的原文（含分隔空白）
 * @returns {{
 *   family: 'journal', text: string
 * } | {
 *   family: 'help'
 * } | {
 *   family: 'todo', action: 'add', text: string
 * } | {
 *   family: 'todo', action: 'list', status: import('./filter.js').TodoStatus | null, text: string | null
 * } | {
 *   family: 'todo', action: 'toggle', n: number
 * } | {
 *   family: 'todo', action: 'undo'
 * }}
 * @throws {TodoUsageError} 用法错误
 */
export function parseMlArgs(rawInput) {
  const tokens = String(rawInput ?? '')
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '')
  if (tokens.length === 0) {
    throw new TodoUsageError(`用法：${ML_USAGE}（或输入 /ml help 查看全部命令）`)
  }
  const [family, action, ...rest] = tokens
  if (family === 'help' || family === 'h') {
    return { family: 'help' }
  }
  if (family !== 'todo') {
    return { family: 'journal', text: tokens.join(' ') }
  }
  if (action === 'add' || action === 'n') {
    const text = rest.join(' ')
    if (text === '') throw new TodoUsageError('用法：/ml todo n <待办内容>（add 同义）')
    return { family: 'todo', action: 'add', text }
  }
  if (action === 'd' || action === 'done') {
    const token = rest[0]
    const n = token !== undefined && /^\d+$/.test(token) ? Number(token) : NaN
    if (!Number.isInteger(n) || n < 1) {
      throw new TodoUsageError('用法：/ml todo d <序号>（序号来自最近一次 /ml todo l 的输出）')
    }
    return { family: 'todo', action: 'toggle', n }
  }
  if (action === 'u' || action === 'undo') {
    if (rest.length > 0) throw new TodoUsageError('用法：/ml todo u（撤销最近一次 d，不带参数）')
    return { family: 'todo', action: 'undo' }
  }
  if (action !== undefined && action !== 'list' && action !== 'l') {
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

/**
 * /ml help 的汇总说明（纯函数；新增命令时在此登记，保持与文法同步）。
 *
 * @returns {string}
 */
export function renderMlHelp() {
  return [
    'MemoryLeak · /ml 命令一览',
    '',
    '/ml <文本>',
    '  记一笔：写入工作区日志/周志的 ## MemoryLeak 模块（无则按模板新建）',
    '/ml todo n <待办内容>（add 同义）',
    '  新增结构化待办：固定表单选类型 deadline/sleep/anytime 与重要程度',
    '  紧急/中等/低（deadline/sleep 再问日期），写入 ## Todo 模块',
    '/ml todo l [all|open|done] [关键词]（list 同义；省略操作同为 list）',
    '  列出待办：默认隐藏未唤醒的 sleep（到日自动唤醒并转写 active）；',
    '  条目带序号，供 d 寻址',
    '/ml todo d <序号>（done 同义）',
    '  切换最近一次列表中该条目的完成态（需先 l）',
    '/ml todo u（undo 同义）',
    '  撤销最近一次 d，可连续撤销（LIFO）',
    '/ml help（h 同义）',
    '  显示本帮助',
    '',
    '日志文件：yyyy-mm-dd.md（日志）或 yyyyWww.md（周志，ISO 周）',
    '设置：GUI 设置面板 → MemoryLeak（扫描范围/上限/日志模式/模板）',
  ].join('\n')
}
