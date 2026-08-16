/**
 * 日志（journal）核心：文件名与 ISO 周计算、模板渲染、## MemoryLeak 模块的
 * 纯文本插入算法。无 fs、无全局状态 —— 全部函数可直接测试。
 *
 * 文件布局（当前项目根目录）：
 *   日志模式：yyyy-mm-dd.md
 *   周志模式：yyyyWww.md（ISO 8601 周，周次两位补零，如 2026W03）
 *
 * ## MemoryLeak 模块约定（对外契约，见 DEVELOPMENT.md §7）：
 *   日志模式：模块下是平铺列表，一条记录一行 `- 文本`
 *   周志模式：模块下按日期分组，`- yyyy-mm-dd` 为组，记录是其子项 `  - 文本`
 * 模块不存在时，插到「文档最前面的 ## 位置」——跳过文件头部的 key: value
 * 配置块与可选的一级标题（# 标题）之后、任何既有内容之前。
 *
 * @module dsh-memoryleak/core/journal
 */
import { invariant, TodoError } from './errors.js'

/** 两位补零。 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/** Date（本地时区）→ 'yyyy-mm-dd'。 */
export function formatDate(date) {
  invariant(date instanceof Date && !Number.isNaN(date.getTime()), 'formatDate 需要有效 Date')
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 日志文件名：yyyy-mm-dd.md。 */
export function dailyFileName(date) {
  return `${formatDate(date)}.md`
}

/**
 * ISO 8601 周信息：周一为一周之始、第 1 周含当年第一个周四。
 *
 * @param {Date} date
 * @returns {{ year: number, week: number, start: string, end: string }} isoYear / 周次 / 周一与周日的 yyyy-mm-dd
 */
export function isoWeekOf(date) {
  invariant(date instanceof Date && !Number.isNaN(date.getTime()), 'isoWeekOf 需要有效 Date')
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const weekday = (day.getDay() + 6) % 7 // 周一=0 … 周日=6
  const thursday = new Date(day.getFullYear(), day.getMonth(), day.getDate() - weekday + 3)
  const isoYear = thursday.getFullYear()
  const jan4 = new Date(isoYear, 0, 4)
  const week1Monday = new Date(isoYear, 0, 4 - ((jan4.getDay() + 6) % 7))
  const week = Math.round((thursday - week1Monday) / (7 * 24 * 3600 * 1000)) + 1
  const monday = new Date(week1Monday.getFullYear(), week1Monday.getMonth(), week1Monday.getDate() + (week - 1) * 7)
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
  return { year: isoYear, week, start: formatDate(monday), end: formatDate(sunday) }
}

/** 周标签：yyyyWww（如 2026W33）。 */
export function weekLabel(date) {
  const info = isoWeekOf(date)
  return `${info.year}W${pad2(info.week)}`
}

/** 周日志文件名：yyyyWww.md。 */
export function weeklyFileName(date) {
  return `${weekLabel(date)}.md`
}

/** 模板占位符（未识别的原样保留）。 */
const TEMPLATE_PLACEHOLDERS = Object.freeze(['date', 'week', 'start', 'end'])

/** 渲染创建模板：替换 {date} {week} {start} {end}。 */
export function renderJournalTemplate(template, params) {
  invariant(typeof template === 'string', 'renderJournalTemplate 需要字符串模板')
  invariant(params !== null && typeof params === 'object', 'renderJournalTemplate 需要 params')
  let out = template
  for (const key of TEMPLATE_PLACEHOLDERS) {
    const value = params[key]
    if (typeof value === 'string') out = out.split(`{${key}}`).join(value)
  }
  return out
}

/** 识别 `## MemoryLeak`（兼容 `##MemoryLeak`，容忍行尾空白）。 */
function isSectionHeading(line) {
  return /^##\s*MemoryLeak\s*$/.test(line)
}

/** 头部配置行：`key: value` 形态（周志模板的 start:/end:）。 */
function isConfigLine(line) {
  return /^\s*[A-Za-z][\w-]*:\s\S/.test(line)
}

/**
 * 模块不存在时的插入锚点：跳过头部配置块与可选的一级标题（# 标题），
 * 返回应插入的行下标（文档最前面的 ## 位置）。
 */
function firstSectionAnchor(lines) {
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') {
      let next = index
      while (next < lines.length && lines[next].trim() === '') next += 1
      if (next < lines.length && isConfigLine(lines[next])) {
        index = next + 1
        continue
      }
      break
    }
    if (isConfigLine(line)) {
      index += 1
      continue
    }
    break
  }
  // 可选的一级标题（配置块之后的第一个非空行若是 # 标题，插到它后面）
  let probe = index
  while (probe < lines.length && lines[probe].trim() === '') probe += 1
  if (probe < lines.length && /^#\s/.test(lines[probe])) return probe + 1
  return index
}

/** 把一行文本规范为单行记录（必须是字符串；内部换行折叠为空格）。 */
function normalizeNoteText(text) {
  if (typeof text !== 'string') throw new TodoError('记录文本必须是字符串')
  const note = text.replace(/\s*\r?\n\s*/g, ' ').trim()
  if (note === '') throw new TodoError('记录文本不能为空')
  return note
}

/**
 * 把一条记录插入 ## MemoryLeak 模块（纯函数，返回新内容）。
 *
 * @param {string} content 文件当前内容（不存在时为模板渲染结果）
 * @param {{ mode: 'daily' | 'weekly', date: string, text: string }} input
 * @returns {string} 新内容
 */
export function insertNote(content, { mode, date, text }) {
  invariant(typeof content === 'string', 'insertNote 需要 string 内容')
  invariant(mode === 'daily' || mode === 'weekly', `insertNote mode 必须是 daily/weekly（收到 ${String(mode)}）`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TodoError(`日期必须是 yyyy-mm-dd（收到 ${JSON.stringify(date)}）`)
  const note = normalizeNoteText(text)
  const lines = content.split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()

  const headingIndex = lines.findIndex(isSectionHeading)
  if (headingIndex === -1) {
    const at = firstSectionAnchor(lines)
    const section =
      mode === 'daily'
        ? ['## MemoryLeak', '', `- ${note}`]
        : ['## MemoryLeak', '', `- ${date}`, `  - ${note}`]
    if (at > 0 && lines[at - 1].trim() !== '') section.unshift('')
    lines.splice(at, 0, ...section)
    return withFinalNewline(lines)
  }

  // 模块范围：到下一个一/二级标题或文件末尾
  let sectionEnd = lines.length
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s/.test(lines[index])) {
      sectionEnd = index
      break
    }
  }

  if (mode === 'daily') {
    let lastItem = -1
    for (let index = headingIndex + 1; index < sectionEnd; index += 1) {
      if (/^- /.test(lines[index])) lastItem = index
    }
    if (lastItem !== -1) {
      lines.splice(endOfItemBlock(lines, lastItem, sectionEnd) + 1, 0, `- ${note}`)
    } else {
      insertIsolated(lines, sectionEnd, [`- ${note}`])
    }
    return withFinalNewline(lines)
  }

  // 周志：找当日期组 `- yyyy-mm-dd`
  let dateIndex = -1
  for (let index = headingIndex + 1; index < sectionEnd; index += 1) {
    if (lines[index] === `- ${date}`) {
      dateIndex = index
      break
    }
  }
  if (dateIndex === -1) {
    let lastItem = -1
    for (let index = headingIndex + 1; index < sectionEnd; index += 1) {
      if (/^- /.test(lines[index])) lastItem = index
    }
    const block = [`- ${date}`, `  - ${note}`]
    if (lastItem !== -1) {
      lines.splice(endOfItemBlock(lines, lastItem, sectionEnd) + 1, 0, ...block)
    } else {
      insertIsolated(lines, sectionEnd, block)
    }
    return withFinalNewline(lines)
  }

  // 已有日期组：追加到最后一个子项之后
  let lastSub = -1
  for (let index = dateIndex + 1; index < sectionEnd; index += 1) {
    const line = lines[index]
    if (line.trim() === '') break
    if (/^\s+- /.test(line)) lastSub = index
    if (/^- /.test(line)) break
  }
  lines.splice(lastSub === -1 ? dateIndex + 1 : lastSub + 1, 0, `  - ${note}`)
  return withFinalNewline(lines)
}

/** 输出规范：内容以恰好一个换行结尾（文件级约定，幂等）。 */
function withFinalNewline(lines) {
  return `${lines.join('\n')}\n`
}

/** 一个顶层列表项的块尾（含其连续缩进子项）—— 在它之后插入才不拆散嵌套。 */
function endOfItemBlock(lines, start, limit) {
  let end = start
  while (end + 1 < limit && /^\s+- /.test(lines[end + 1])) end += 1
  return end
}

/** 模块内没有可依附列表项时：在模块末尾空行隔开插入。 */
function insertIsolated(lines, at, block) {
  if (at > 0 && lines[at - 1].trim() !== '') block = ['', ...block]
  if (at < lines.length && lines[at].trim() !== '') block = [...block, '']
  lines.splice(at, 0, ...block)
}
