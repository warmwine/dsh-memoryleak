/**
 * 渲染器：ScanReport + TodoQuery → 展示文本 / 结构化 JSON。
 *
 * 文本版服务于 /ml todo list 的命令卡片（纯文本 <pre>）；JSON 版是为 AI 消费
 * 预留的稳定契约（V1 即实现并测试，未来 AI 过滤直接复用）。
 *
 * @module dsh-memoryleak/core/render
 */
import { invariant } from './errors.js'
import { applyTodoQuery, createTodoQuery } from './filter.js'

const STATUS_LABEL = Object.freeze({ open: '未完成', done: '已完成', all: '全部' })

/** 结果是否不完整：查询截断或扫描截断都算。 */
function isTruncated(applied, report) {
  return applied.truncated === true || report.truncated === true
}

/** 首行摘要（单行，供折叠卡片显示）。 */
export function summarizeTodoReport(report, query = createTodoQuery()) {
  const applied = applyTodoQuery(query, report.items)
  const openCount = applied.items.filter((item) => item.done !== true).length
  const doneCount = applied.items.length - openCount
  const head =
    `待办 ${applied.items.length} 条` +
    (query.status === 'all' ? `（未完成 ${openCount} / 已完成 ${doneCount}）` : `（${STATUS_LABEL[query.status]}）`)
  const tail = ` · ${report.files.matched} 个文件`
  return head + tail + (isTruncated(applied, report) ? ' · 已截断' : '')
}

/**
 * 渲染纯文本列表。
 *
 * @param {object} report ScanReport
 * @param {import('./filter.js').TodoQuery} [query]
 * @returns {string}
 */
export function renderTodoText(report, query = createTodoQuery()) {
  invariant(report !== null && typeof report === 'object' && Array.isArray(report.items), 'renderTodoText 需要 ScanReport')
  const applied = applyTodoQuery(query, report.items)
  const lines = [summarizeTodoReport(report, query), '']
  if (applied.items.length === 0) {
    lines.push('（没有匹配的待办）')
  } else {
    let currentFile = null
    for (const item of applied.items) {
      if (item.file !== currentFile) {
        currentFile = item.file
        lines.push(`${item.file}`)
      }
      const mark = item.done ? '[x]' : '[ ]'
      lines.push(`  ${String(item.line).padStart(4)}  ${mark} ${item.text}`)
    }
  }
  if (isTruncated(applied, report)) lines.push('', '（结果达到条数上限被截断 —— 可在设置中调大「最多条目」）')
  if (report.skipped.length > 0) {
    lines.push('', `跳过 ${report.skipped.length} 个超大文件：${report.skipped.map((entry) => entry.file).join('、')}`)
  }
  if (report.errors.length > 0) {
    lines.push('', `读取失败 ${report.errors.length} 个文件：`)
    for (const error of report.errors.slice(0, 8)) lines.push(`  ${error.file}: ${error.message}`)
    if (report.errors.length > 8) lines.push(`  …等 ${report.errors.length} 个`)
  }
  return lines.join('\n')
}

/**
 * 渲染结构化 JSON（未来 AI 过滤/消费的稳定契约；函数返回可 JSON 化的普通对象）。
 *
 * @param {object} report ScanReport
 * @param {import('./filter.js').TodoQuery} [query]
 */
export function renderTodoJson(report, query = createTodoQuery()) {
  invariant(report !== null && typeof report === 'object' && Array.isArray(report.items), 'renderTodoJson 需要 ScanReport')
  const applied = applyTodoQuery(query, report.items)
  const groups = []
  for (const item of applied.items) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.file === item.file) {
      last.todos.push({ line: item.line, text: item.text, done: item.done, format: item.format })
      continue
    }
    groups.push({ file: item.file, todos: [{ line: item.line, text: item.text, done: item.done, format: item.format }] })
  }
  return {
    summary: {
      total: applied.items.length,
      open: applied.items.filter((item) => item.done !== true).length,
      done: applied.items.filter((item) => item.done === true).length,
      files: report.files.matched,
      truncated: isTruncated(applied, report),
    },
    query: { action: query.action, status: query.status, text: query.text, limit: query.limit },
    formats: report.formats,
    groups,
    skipped: report.skipped,
    errors: report.errors,
  }
}
