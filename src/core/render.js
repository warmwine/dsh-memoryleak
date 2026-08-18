/**
 * 渲染器：ScanReport + TodoQuery → 展示文本 / 结构化 JSON。
 *
 * 文本版服务于 /ml todo list 的命令卡片。卡片把文本放进等宽字体的代码块
 * （white-space: pre-wrap），折叠态只显示首行（nowrap + ellipsis）—— 因此
 * 排版按 TUI 约定设计：首行 = 完整摘要；正文用 Unicode 制表符与选票符号，
 * 不用 ANSI 颜色（<pre> 会把转义序列显示成乱码）。JSON 版是为 AI 消费预留
 * 的稳定契约（V1 即实现并测试，未来 AI 过滤直接复用）。
 *
 * 排版文法：
 *   待办 N 条（…） · M 个文件                ← 摘要行（折叠卡片可见的开头）
 *   ────────────────────────────             ← 分隔线
 *   ■ docs/plan.md · 2 条                    ← 文件分组头
 *    1. ☐ 未完成事项                          ← 序号. 选票符号 [徽章] 正文
 *    2. ☑ 已完成事项                          （序号供 /ml todo d <n>；不显示文件行号）
 *   ☀ 唤醒块（sleep 到日转写为 active 的计数）
 *   ⚠ 警告块（截断 / 跳过 / 读取失败）
 *
 * @module dsh-memoryleak/core/render
 */
import { invariant } from './errors.js'
import { applyTodoQuery, createTodoQuery } from './filter.js'

const STATUS_LABEL = Object.freeze({ open: '未完成', done: '已完成', cancelled: '已取消', all: '全部' })

/** TUI 排版字符（等宽环境安全；右边界不封口——CJK 宽度无法对齐右框）。 */
const RULE = '─'.repeat(44)
const FILE_BULLET = '■'
const GLYPH_OPEN = '☐'
const GLYPH_DONE = '☑'
const GLYPH_CANCELLED = '☒'
const WARN = '⚠'
const WOKE = '☀'

/** 结构化 meta 的展示徽章：[截止 2026-09-01·紧急] / [睡到 12-01·低] / [随时·中等] / [唤醒·低]。 */
const TYPE_LABEL = Object.freeze({ deadline: '截止', sleep: '睡到', anytime: '随时', active: '唤醒' })
const PRIO_LABEL = Object.freeze({ urgent: '紧急', medium: '中等', low: '低' })

function metaBadge(meta, done = false, cancelled = false) {
  if (meta === null || meta === undefined) return ''
  const type = TYPE_LABEL[meta.type] ?? meta.type
  const prio = PRIO_LABEL[meta.prio] ?? meta.prio
  const date = typeof meta.date === 'string' && meta.date !== '' ? ` ${meta.date}` : ''
  // 完成日期（/ml todo d 写入）：仅已完成行显示
  const doneAt = done === true && typeof meta.doneAt === 'string' && meta.doneAt !== '' ? ` ✓${meta.doneAt}` : ''
  // 取消日期（/ml todo c 写入）：仅已取消行显示
  const cancelledAt = cancelled === true && typeof meta.cancelledAt === 'string' && meta.cancelledAt !== '' ? ` ✗${meta.cancelledAt}` : ''
  return ` [${type}${date}·${prio}${doneAt}${cancelledAt}]`
}

/** 结果是否不完整：查询截断或扫描截断都算。 */
function isTruncated(applied, report) {
  return applied.truncated === true || report.truncated === true
}

/** 首行摘要（单行，供折叠卡片显示）。 */
export function summarizeTodoReport(report, query = createTodoQuery()) {
  const applied = applyTodoQuery(query, report.items)
  const openCount = applied.items.filter((item) => item.done !== true && item.cancelled !== true).length
  const cancelledCount = applied.items.filter((item) => item.cancelled === true).length
  const doneCount = applied.items.length - openCount - cancelledCount
  const head =
    `待办 ${applied.items.length} 条` +
    (query.status === 'all'
      ? `（未完成 ${openCount} / 已完成 ${doneCount}${cancelledCount > 0 ? ` / 已取消 ${cancelledCount}` : ''}）`
      : `（${STATUS_LABEL[query.status]}）`)
  const tail = ` · ${report.files.matched} 个文件`
  return head + tail + (isTruncated(applied, report) ? ' · 已截断' : '')
}

/**
 * 渲染纯文本列表（TUI 排版，见模块头排版文法）。
 *
 * @param {object} report ScanReport
 * @param {import('./filter.js').TodoQuery} [query]
 * @returns {string}
 */
export function renderTodoText(report, query = createTodoQuery()) {
  invariant(report !== null && typeof report === 'object' && Array.isArray(report.items), 'renderTodoText 需要 ScanReport')
  const applied = applyTodoQuery(query, report.items)
  const lines = [summarizeTodoReport(report, query), RULE]
  if (applied.items.length === 0) {
    lines.push(query.status === 'all' ? '（没有匹配的待办）' : '（没有匹配的待办 —— 可试试 /ml todo list all）')
  } else {
    const perFile = new Map()
    for (const item of applied.items) perFile.set(item.file, (perFile.get(item.file) ?? 0) + 1)
    let currentFile = null
    let displayId = 0
    for (const item of applied.items) {
      if (item.file !== currentFile) {
        currentFile = item.file
        lines.push(`${FILE_BULLET} ${item.file} · ${perFile.get(item.file)} 条`)
      }
      displayId += 1
      const glyph = item.done ? GLYPH_DONE : item.cancelled === true ? GLYPH_CANCELLED : GLYPH_OPEN
      const idColumn = `${String(displayId).padStart(3)}.`
      lines.push(`${idColumn} ${glyph}${metaBadge(item.meta, item.done, item.cancelled === true)} ${item.text}`)
    }
  }
  if (report.wokenCount > 0) lines.push(RULE, `${WOKE} 已唤醒 ${report.wokenCount} 条 sleep 待办（转写为 active）`)
  const warnings = []
  if (isTruncated(applied, report)) warnings.push(`${WARN} 已截断：达到条数上限 —— 可在设置「MemoryLeak」中调大「最多条目」`)
  if (report.skipped.length > 0) {
    warnings.push(`${WARN} 跳过 ${report.skipped.length} 个超大文件：${report.skipped.map((entry) => entry.file).join('、')}`)
  }
  if (report.errors.length > 0) {
    warnings.push(`${WARN} 读取失败 ${report.errors.length} 个文件`)
    for (const error of report.errors.slice(0, 8)) warnings.push(`    ${error.file}: ${error.message}`)
    if (report.errors.length > 8) warnings.push(`    …等共 ${report.errors.length} 个`)
  }
  if (warnings.length > 0) lines.push(RULE, ...warnings)
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
      open: applied.items.filter((item) => item.done !== true && item.cancelled !== true).length,
      done: applied.items.filter((item) => item.done === true).length,
      cancelled: applied.items.filter((item) => item.cancelled === true).length,
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
