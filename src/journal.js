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
  weekLabel,
  weeklyFileName,
} from './core/journal.js'
import { activateSleepLine } from './core/formats/memoryleak-todo.js'

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

/** 定位（必要时按模板新建内容）当前日志文件。 */
async function locateJournal({ cwd, settings, now }) {
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
 * 切换工作区内某文件某行的待办完成态。
 *
 * @param {string} cwd
 * @param {string} file 工作区相对路径
 * @param {number} line 1 起始行号
 * @returns {Promise<{ done: boolean, raw: string }>} 切换后的完成态与该行新内容（撤销校验用）
 */
export async function toggleTodoAt(cwd, file, line) {
  const path = join(cwd, file)
  let content
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    throw new JournalIoError(`读取 ${file} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const result = toggleTodoLine(content, line)
  const raw = result.content.split('\n')[line - 1]
  try {
    await writeFile(path, result.content, 'utf8')
  } catch (error) {
    throw new JournalIoError(`写入 ${file} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  return { done: result.done, raw }
}

/**
 * 撤销一次切换：把指定行翻回 d 之前的状态。以 d 完成时捕获的行内容
 * （postRaw）做严格校验 —— 行在 d 之后被外部修改则拒绝撤销。
 *
 * @param {string} cwd
 * @param {string} file
 * @param {number} line
 * @param {string} postRaw d 之后该行的内容（toggleTodoAt 返回的 raw）
 * @returns {Promise<{ done: boolean }>} 撤销后的完成态
 */
export async function undoTodoAt(cwd, file, line, postRaw) {
  const flipped = toggleTodoLine(postRaw, 1) // 单行内容翻回另一态
  const path = join(cwd, file)
  let content
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    throw new JournalIoError(`读取 ${file} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const next = replaceLine(content, line, postRaw, flipped.content)
  try {
    await writeFile(path, next, 'utf8')
  } catch (error) {
    throw new JournalIoError(`写入 ${file} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  return { done: flipped.done }
}
