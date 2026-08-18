/**
 * /ml 命令文法（纯函数，独立测试）。
 *
 * V1 文法（六个家族）：
 *   /ml init                            → 指定/更换 Vault 目录（日志与待办的存放根）
 *   /ml <文本>                          → 记一笔：写入 Vault 日志/周志的 ## MemoryLeak
 *   /ml todo n|add <文本>               → 添加结构化待办（提问类型/优先级/日期）到 ## Todo
 *   /ml todo l|list [状态] [关键词]      → 列出 Vault Markdown 待办（默认隐藏未唤醒的 sleep）
 *   /ml todo d|done <n>                 → 切换最近一次 list 结果中第 n 条的完成态
 *   /ml todo u|undo                     → 撤销最近一次 d（可连续撤销，LIFO）
 *   /ml note                            → 用当前模型压缩区间对话进 MOMENTO/ 与 ## NOTE
 *   /ml view|v [文件名片段]              → 显示当前日志/周志，或模糊匹配并显示指定文件
 *   /ml help|h                          → 命令一览（汇总说明）
 *
 * 家族判定：第一个词是 `init` / `todo` / `note` / `view` / `help` 即对应家族
 * （保留字，记录文本以它们开头时请换措辞）；其余一切非空输入都是记录文本。
 * Vault 未设置时，除 help / init 外的所有命令在分发层直接报错——init 是
 * 唯一的设置入口，不自动弹引导。
 * 状态默认值不在这里决定 —— 由设置命名空间的 defaultStatus 注入（查询模型
 * 与文法分离，AI 未来可以绕过文法直接给结构化查询）。
 *
 * @module dsh-memoryleak/core/command
 */
import { TodoUsageError } from './errors.js'
import { TODO_STATUSES } from './filter.js'

export const ML_USAGE = '/ml init · /ml <文本> · /ml todo add <文本> · /ml todo list [all|open|done] [关键词] · /ml todo d <序号> · /ml todo u · /ml note · /ml view [文件名片段] · /ml help'

/**
 * @param {string} rawInput 命令名（/ml）之后的原文（含分隔空白）
 * @returns {{
 *   family: 'init'
 * } | {
 *   family: 'journal', text: string
 * } | {
 *   family: 'help'
 * } | {
 *   family: 'note'
 * } | {
 *   family: 'view', text: string | null
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
  if (family === 'init') {
    if (action !== undefined) throw new TodoUsageError('用法：/ml init（不带参数；目录在选择卡里挑）')
    return { family: 'init' }
  }
  if (family === 'view' || family === 'v') {
    const text = [action, ...rest].filter((token) => token !== undefined && token !== '').join(' ')
    return { family: 'view', text: text === '' ? null : text }
  }
  if (family === 'note') {
    if (action !== undefined) {
      throw new TodoUsageError([
        '/ml note 不带参数——你跟在后面的文字没有发给助手，也不会被记录。',
        '· 想整理对话：只输入 /ml note 回车',
        '· 想记一笔：/ml <文本>',
        '· 想对助手说话：去掉开头的 /ml note，直接发消息',
      ].join('\n'))
    }
    return { family: 'note' }
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
    '/ml init',
    '  指定/更换 Vault 目录（日志与待办的存放根；目录选择卡支持 Tab 补全',
    '  与系统对话框）。Vault 未设置时，其他命令都会提示先执行本命令',
    '/ml <文本>',
    '  记一笔：写入 Vault 日志/周志的 ## MemoryLeak 模块（无则按模板新建）',
    '/ml todo add <待办内容>（简写 /ml todo n）',
    '  新增结构化待办：固定表单选类型 deadline/sleep/anytime 与重要程度',
    '  紧急/中等/低（deadline/sleep 再问日期），写入 ## Todo 模块',
    '/ml todo list [all|open|done] [关键词]（简写 /ml todo l；省略操作同为 list）',
    '  列出待办：默认隐藏未唤醒的 sleep（到日自动唤醒并转写 active）；',
    '  条目带序号，供 d 寻址',
    '/ml todo d <序号>（全称 /ml todo done）',
    '  切换最近一次列表中该条目的完成态（需先 list）',
    '/ml todo u（全称 /ml todo undo）',
    '  撤销最近一次 d，可连续撤销（LIFO）',
    '/ml note',
    '  用当前模型把「上一个 /ml note 之后 → 现在」的对话（没有则整个会话）',
    '  压缩成：工作记录（日志 ## NOTE）+ 知识文件（MOMENTO/）+ 结构化登记',
    '  （MOMENTO/databases.md、servers.md、credentials.md、glossary.md，',
    '  表格格式由代码渲染；凭证只记位置，不记明文）',
    '/ml view [文件名片段]（简写 /ml v；无参数 = 当前日志/周志）',
    '  显示文件内容：片段按 VSCode Ctrl+P 风格模糊匹配工作区文件；',
    '  从命令菜单选择 /ml 则弹出快速打开面板（搜索/↑↓/Enter）',
    '/ml help（简写 /ml h）',
    '  显示本帮助',
    '',
    '日志文件：yyyy-mm-dd.md（日志）或 yyyyWww.md（周志，ISO 周）',
    '设置：GUI 设置面板 → MemoryLeak（扫描范围/上限/日志模式/模板）',
  ].join('\n')
}
