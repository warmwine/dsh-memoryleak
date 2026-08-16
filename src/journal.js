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
  isoWeekOf,
  renderJournalTemplate,
  weekLabel,
  weeklyFileName,
} from './core/journal.js'

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

  const next = insertNote(content, { mode, date, text })
  try {
    await writeFile(path, next, 'utf8')
  } catch (error) {
    throw new JournalIoError(`写入 ${file} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  return { file, mode, date, created, note: text.trim() }
}
