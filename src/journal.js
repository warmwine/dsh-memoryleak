/**
 * 日志记录的宿主胶水：定位目标文件 → 读已有内容或按设置模板新建（纯字符串
 * 替换，不涉 LLM）→ 核心纯函数插入 → 写回。文件名由日期派生，不含用户输入，
 * 无路径注入面。
 *
 * @module dsh-memoryleak/journal
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TodoError } from './core/errors.js'
import {
  dailyFileName,
  formatDate,
  insertNote,
  insertTodoLine,
  isoWeekOf,
  renderJournalTemplate,
  replaceLine,
  toggleTodoLine,
  cancelTodoLine,
  postponeTodoLine,
  weekLabel,
  weeklyFileName,
} from './core/journal.js'
import { activateSleepLine } from './core/formats/memoryleak-todo.js'
import { createNodeFileSource } from './adapters/node-file-source.js'

/** 日志读写故障（环境错误，命令层转用户可见结果）。 */
export class JournalIoError extends TodoError {}

/**
 * 把一条记录写进工作区的日志/周志文件。
 *
 * @param {object} input
 * @param {string} input.cwd 工作区根目录（绝对路径）
 * @param {{ journalMode: 'daily' | 'weekly', dailyTemplate: string, weeklyTemplate: string }} input.settings
 * @param {string} input.text 记录文本（单行）
 * @param {() => Date} [input.now] 时钟（默认系统时间；测试可注入）
 * @returns {Promise<{ file: string, mode: 'daily' | 'weekly', date: string, created: boolean, note: string }>}
 */
export async function recordJournalNote({ cwd, settings, text, now = () => new Date() }) {
  const located = await locateJournal({ cwd, settings, now })
  const next = insertNote(located.content, { mode: located.mode, date: located.date, text })
  await writeJournal(located, next)
  return { file: located.file, mode: located.mode, date: located.date, created: located.created, note: text.trim() }
}

/**
 * 把一行结构化待办写进工作区日志/周志的 ## Todo 模块（不存在则建在
 * ## MemoryLeak 之后）。
 *
 * @param {object} input
 * @param {string} input.cwd
 * @param {object} input.settings
 * @param {string} input.todoLine 完整待办行（含 `- [ ]` 前缀）
 * @param {() => Date} [input.now]
 * @returns {Promise<{ file: string, mode: 'daily' | 'weekly', date: string, created: boolean }>}
 */
export async function recordTodoLine({ cwd, settings, todoLine, now = () => new Date() }) {
  const located = await locateJournal({ cwd, settings, now })
  const next = insertTodoLine(located.content, todoLine)
  await writeJournal(located, next)
  return { file: located.file, mode: located.mode, date: located.date, created: located.created }
}

/** 定位（必要时按模板新建内容）当前日志文件（/ml note 的 NOTE 落盘也复用）。 */
export async function locateJournal({ cwd, settings, now }) {
  if (typeof cwd !== 'string' || cwd === '') throw new JournalIoError('工作区目录为空')
  const mode = settings.journalMode === 'weekly' ? 'weekly' : 'daily'
  const at = now()
  const date = formatDate(at)
  const week = isoWeekOf(at)
  const file = mode === 'weekly' ? weeklyFileName(at) : dailyFileName(at)
  const path = join(cwd, file)

  let created = false
  let content
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new JournalIoError(`读取 ${file} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    created = true
    const template = mode === 'weekly' ? settings.weeklyTemplate : settings.dailyTemplate
    content = renderJournalTemplate(template, {
      date,
      week: weekLabel(at),
      start: week.start,
      end: week.end,
    })
  }
  return { path, file, mode, date, created, content }
}

/** 写回日志文件。 */
async function writeJournal(located, next) {
  try {
    await writeFile(located.path, next, 'utf8')
  } catch (error) {
    throw new JournalIoError(
      `写入 ${located.file} 失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

/**
 * 列出工作区内符合扫描设置的文件（只看文件名，不读内容；供 /ml view
 * 模糊解析与快速打开弹窗共用）。按名字降序 —— 日期型文件名（日志/周志）
 * 天然新的在前。
 *
 * @param {object} input
 * @param {string} input.cwd
 * @param {object} input.settings（extensions / excludeDirs）
 * @param {number} [input.limit] 默认 200
 * @param {AbortSignal | null} [input.signal]
 * @returns {Promise<Array<{ name: string, bytes: number }>>}
 */
export async function listWorkspaceFiles({ cwd, settings, limit = 200, signal = null }) {
  const source = createNodeFileSource()
  const listing = await source.list(
    cwd,
    { extensions: settings.extensions, excludeDirs: settings.excludeDirs, maxFiles: limit },
    signal,
  )
  const files = listing.files.map((file) => ({ name: file.path, bytes: file.bytes }))
  files.sort((left, right) => (left.name > right.name ? -1 : left.name < right.name ? 1 : 0))
  return files
}

/**
 * 读取工作区内任意（符合扫描设置的）文件的只读内容（/ml view <文件> 用）。
 *
 * @param {string} cwd
 * @param {string} name 工作区相对路径
 * @returns {Promise<string>}
 */
export async function readWorkspaceFile(cwd, name) {
  if (typeof name !== 'string' || name === '' || name.includes('..') || /^[a-zA-Z]:/.test(name) || name.startsWith('/') || name.startsWith('\\')) {
    throw new JournalIoError(`非法文件路径：${String(name)}`)
  }
  try {
    return await readFile(join(cwd, name), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new JournalIoError(`文件不存在：${name}`)
    throw new JournalIoError(`读取 ${name} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

/**
 * 只读定位当前日志/周志文件（/ml view 用）：不存在时不创建，仅报告。
 *
 * @param {object} input
 * @param {string} input.cwd
 * @param {object} input.settings
 * @param {() => Date} [input.now]
 * @returns {Promise<{ file: string, mode: 'daily' | 'weekly', exists: boolean, content: string }>}
 */
export async function readJournalFile({ cwd, settings, now = () => new Date() }) {
  const mode = settings.journalMode === 'weekly' ? 'weekly' : 'daily'
  const at = now()
  const file = mode === 'weekly' ? weeklyFileName(at) : dailyFileName(at)
  const path = join(cwd, file)
  try {
    const content = await readFile(path, 'utf8')
    return { file, mode, exists: true, content }
  } catch (error) {
    if (error.code === 'ENOENT') return { file, mode, exists: false, content: '' }
    throw new JournalIoError(`读取 ${file} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

/**
 * 唤醒转写：把扫描报告中已到唤醒日、未完成的 sleep 待办在源文件里改写为
 * active（按 文件+行号+raw 三重校验，行变化即跳过该条）。单文件故障隔离
 * —— 一个文件写失败不影响其余，计入 failures 返回。
 *
 * @param {string} cwd 工作区根目录
 * @param {ReadonlyArray<{file: string, line: number, raw: string|null, meta: object|null, done: boolean}>} items 扫描报告条目
 * @param {string} today yyyy-mm-dd
 * @returns {Promise<{ woken: number, failures: Array<{file: string, message: string}> }>}
 */
export async function wakeupSleepingTodos(cwd, items, today) {
  const due = items.filter(
    (item) =>
      item.done !== true &&
      item.cancelled !== true &&
      item.meta !== null &&
      item.meta.type === 'sleep' &&
      typeof item.meta.date === 'string' &&
      item.meta.date <= today &&
      typeof item.raw === 'string',
  )
  const byFile = new Map()
  for (const item of due) {
    if (!byFile.has(item.file)) byFile.set(item.file, [])
    byFile.get(item.file).push(item)
  }
  let woken = 0
  const failures = []
  for (const [file, fileItems] of byFile) {
    try {
      const path = join(cwd, file)
      let content = await readFile(path, 'utf8')
      for (const item of fileItems) {
        try {
          content = replaceLine(content, item.line, item.raw, activateSleepLine(item.raw))
          woken += 1
        } catch {
          // 行内容变化 → 跳过该条（下一轮扫描重新决策）
        }
      }
      await writeFile(path, content, 'utf8')
    } catch (error) {
      failures.push({ file, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { woken, failures }
}

/**
 * 行重定位（防错位）：list 到操作之间文件可能被外部改动（插行/删行/改行）。
 * 校验与定位规则：
 *   1. 原行号处内容仍等于 expectedRaw → 行没挪，直接用；
 *   2. 否则在**同一文件**里找内容完全等于 expectedRaw 的行：
 *      恰好一处 → 目标挪到了那里，用新行号；
 *      零处（被改/被删）或多处（内容重复无法分辨）→ 抛错让用户重新 list。
 *
 * @param {string} file 工作区相对路径（错误信息用）
 * @param {string[]} lines 文件按行拆分
 * @param {number} line list 时的行号
 * @param {string} expectedRaw list 时该行的原文（item.raw）
 * @returns {number} 实际行号
 * @throws {TodoError} 行被修改/删除或内容重复
 */
function relocateTodoLine(file, lines, line, expectedRaw) {
  if (line >= 1 && line <= lines.length && lines[line - 1] === expectedRaw) return line
  const matches = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === expectedRaw) matches.push(index + 1)
  }
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) {
    throw new TodoError(`目标待办行已在 ${file} 中被修改或删除——请重新 /ml todo list 后再操作`)
  }
  throw new TodoError(`${file} 里有 ${matches.length} 行内容完全相同，无法确定操作目标——请重新 /ml todo list`)
}

/**
 * 切换工作区内某文件某行的待办完成态（结构化行完成时写入 done:<today>）。
 * expectedRaw（list 时行原文）提供时做错位防护：行号处内容不符则按原文
 * 全文唯一重定位（见 relocateTodoLine）。
 *
 * @param {string} cwd
 * @param {string} file 工作区相对路径
 * @param {number} line 1 起始行号
 * @param {string} today yyyy-mm-dd（完成日期戳）
 * @param {string} [expectedRaw] list 时该行的原文（错位防护；缺省不校验）
 * @returns {Promise<{ done: boolean, preRaw: string, raw: string }>} 切换后的完成态与操作前/后行内容
 */
export async function toggleTodoAt(cwd, file, line, today, expectedRaw) {
  const path = join(cwd, file)
  let content
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    throw new JournalIoError(`读取 ${file} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const lines = content.split('\n')
  const target = typeof expectedRaw === 'string' ? relocateTodoLine(file, lines, line, expectedRaw) : line
  const preRaw = lines[target - 1]
  const result = toggleTodoLine(content, target, today)
  const raw = result.content.split('\n')[target - 1]
  try {
    await writeFile(path, result.content, 'utf8')
  } catch (error) {
    throw new JournalIoError(`写入 ${file} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  return { done: result.done, preRaw, raw }
}

/**
 * 切换工作区内某文件某行的待办取消态（结构化行取消时写入 cancelled:<today>）。
 * expectedRaw 语义同 toggleTodoAt。
 *
 * @param {string} cwd
 * @param {string} file 工作区相对路径
 * @param {number} line 1 起始行号
 * @param {string} today yyyy-mm-dd（取消日期戳）
 * @param {string} [expectedRaw] list 时该行的原文（错位防护；缺省不校验）
 * @returns {Promise<{ cancelled: boolean, preRaw: string, raw: string }>} 切换后的取消态与操作前/后行内容
 */
export async function cancelTodoAt(cwd, file, line, today, expectedRaw) {
  const path = join(cwd, file)
  let content
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    throw new JournalIoError(`读取 ${file} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const lines = content.split('\n')
  const target = typeof expectedRaw === 'string' ? relocateTodoLine(file, lines, line, expectedRaw) : line
  const preRaw = lines[target - 1]
  const result = cancelTodoLine(content, target, today)
  try {
    await writeFile(path, result.content, 'utf8')
  } catch (error) {
    throw new JournalIoError(`写入 ${file} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  return { cancelled: result.cancelled, preRaw, raw: result.raw }
}

/**
 * 延期工作区内某文件某行的 deadline 待办（截止日 + days 天）。
 * expectedRaw 语义同 toggleTodoAt。
 *
 * @param {string} cwd
 * @param {string} file 工作区相对路径
 * @param {number} line 1 起始行号
 * @param {number} days 延期天数（正整数）
 * @param {string} [expectedRaw] list 时该行的原文（错位防护；缺省不校验）
 * @returns {Promise<{ date: string, previousDate: string, preRaw: string, raw: string }>} 新/旧截止日与操作前/后行内容
 */
export async function postponeTodoAt(cwd, file, line, days, expectedRaw) {
  const path = join(cwd, file)
  let content
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    throw new JournalIoError(`读取 ${file} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const lines = content.split('\n')
  const target = typeof expectedRaw === 'string' ? relocateTodoLine(file, lines, line, expectedRaw) : line
  const preRaw = lines[target - 1]
  const result = postponeTodoLine(content, target, days)
  try {
    await writeFile(path, result.content, 'utf8')
  } catch (error) {
    throw new JournalIoError(`写入 ${file} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  return { date: result.date, previousDate: result.previousDate, preRaw, raw: result.raw }
}

/**
 * 通用撤销（d 完成 / c 取消 / p 延期共用）：把指定行恢复为操作前的原文。
 * 以操作完成时捕获的行内容（expectedRaw）做校验，且同样支持错位重定位
 * （操作之后行挪动了也能撤销）；行内容已被外部修改则拒绝（防抹掉别人
 * 的改动）。
 *
 * @param {string} cwd
 * @param {string} file
 * @param {number} line
 * @param {string} expectedRaw 操作后该行的内容（各 *At 返回的 raw）
 * @param {string} restoreRaw 操作前该行的内容（撤销目标）
 * @returns {Promise<{ raw: string }>} 恢复后的行内容
 */
export async function restoreTodoAt(cwd, file, line, expectedRaw, restoreRaw) {
  const path = join(cwd, file)
  let content
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    throw new JournalIoError(`读取 ${file} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const lines = content.split('\n')
  const target = relocateTodoLine(file, lines, line, expectedRaw)
  const next = replaceLine(content, target, expectedRaw, restoreRaw)
  try {
    await writeFile(path, next, 'utf8')
  } catch (error) {
    throw new JournalIoError(`写入 ${file} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  return { raw: restoreRaw }
}
