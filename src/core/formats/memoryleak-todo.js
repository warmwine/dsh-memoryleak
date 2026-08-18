/**
 * MemoryLeak 结构化待办格式 —— 第二个 TodoFormat Strategy。
 *
 * 行文法（机器友好、人类可读、仍保持 markdown 复选框形态）：
 *   - [ ] (ml:deadline 2026-09-01 urgent) 完成设计稿
 *   - [x] (ml:sleep 2026-12-01 low done:2026-08-16) 学一遍内部源码
 *   - [-] (ml:deadline 2026-09-01 urgent cancelled:2026-08-18) 放弃的设计稿
 *   - [ ] (ml:anytime medium) 整理收藏夹
 *
 * 规则：
 *   - `(ml:<type>[ <yyyy-mm-dd>] <prio>[ done:<yyyy-mm-dd>][ cancelled:<yyyy-mm-dd>])` 属性块紧跟复选框
 *   - type ∈ deadline（固定截止日）/ sleep（到日唤醒）/ anytime（随时）
 *   -   / active（sleep 唤醒后的形态，无日期）
 *   - deadline、sleep 必须带日期；anytime、active 不带
 *   - prio ∈ urgent / medium / low
 *   - done:<date> 只在 [x] 行出现（/ml todo d 完成时写入，u 撤销时清除；
 *     手写 [x] 无 done: 也认）
 *   - cancelled:<date> 只在 [-] 行出现（/ml todo c 取消时写入）
 *   - 三种标记互斥：[ ] 不带 done:/cancelled:，[x] 不带 cancelled:，
 *     [-] 不带 done:（带错 → 整行降级为普通 markdown-checkbox 兜底）
 *   - 属性块不完整（如 deadline 缺日期）不匹配 → 降级为普通 markdown-checkbox
 *     待办（仍然可见，不丢数据）
 *
 * 注册优先级高于 markdown-checkbox（priority 50 < 100）：结构化行优先按本
 * 策略解析，携带 meta 进入查询管线（sleep 过滤、类型/优先级徽章）。
 *
 * @module dsh-memoryleak/core/formats/memoryleak-todo
 */
import { TodoError } from '../errors.js'

/** 结构化待办类型（active = sleep 到日唤醒后的形态，无日期）。 */
export const TODO_TYPES = Object.freeze(['deadline', 'sleep', 'anytime', 'active'])

/** 优先级。 */
export const TODO_PRIORITIES = Object.freeze(['urgent', 'medium', 'low'])

/** 延期天数的合理上限（十年；防手滑输入离谱数字把日期推到天边）。 */
export const MAX_POSTPONE_DAYS = 3650

const STRUCTURED_PATTERN =
  /^[ \t]*(?:[-*+])[ \t]+\[([ xX-])][ \t]+\(ml:(deadline|sleep|anytime|active)(?:[ \t]+(\d{4}-\d{2}-\d{2}))?[ \t]+(urgent|medium|low)(?:[ \t]+done:(\d{4}-\d{2}-\d{2}))?(?:[ \t]+cancelled:(\d{4}-\d{2}-\d{2}))?\)[ \t]+(\S.*)$/

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 两位补零。 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * yyyy-mm-dd + N 天 → yyyy-mm-dd（UTC 计算，不受本地时区影响）。
 *
 * @param {string} dateStr 起算日期
 * @param {number} days 天数（正整数）
 * @returns {string} 新日期
 */
export function addDaysToDate(dateStr, days) {
  if (!DATE_PATTERN.test(String(dateStr ?? ''))) {
    throw new TodoError(`addDaysToDate 需要 yyyy-mm-dd（收到 ${String(dateStr)}）`)
  }
  if (!Number.isInteger(days) || days < 1 || days > MAX_POSTPONE_DAYS) {
    throw new TodoError(`延期天数必须是 1..${MAX_POSTPONE_DAYS} 的整数（收到 ${String(days)}）`)
  }
  const [year, month, day] = dateStr.split('-').map(Number)
  const at = new Date(Date.UTC(year, month - 1, day))
  at.setUTCDate(at.getUTCDate() + days)
  return `${at.getUTCFullYear()}-${pad2(at.getUTCMonth() + 1)}-${pad2(at.getUTCDate())}`
}

/** 校验 meta 形状（registry / 值对象边界复用）。 */
export function isValidTodoMeta(meta) {
  if (meta === null || meta === undefined) return true
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return false
  if (!TODO_TYPES.includes(meta.type)) return false
  if (!TODO_PRIORITIES.includes(meta.prio)) return false
  if (meta.date !== null && meta.date !== undefined && !DATE_PATTERN.test(meta.date)) return false
  if (meta.doneAt !== null && meta.doneAt !== undefined && !DATE_PATTERN.test(meta.doneAt)) return false
  if (meta.cancelledAt !== null && meta.cancelledAt !== undefined && !DATE_PATTERN.test(meta.cancelledAt)) return false
  return true
}

/** @satisfies {import('../formats/markdown-checkbox.js').TodoFormat} */
export const memoryleakTodoFormat = Object.freeze({
  id: 'memoryleak-todo',
  title: 'MemoryLeak 结构化待办（ml:deadline/sleep/anytime）',
  /**
   * @param {string} line
   * @returns {import('../formats/markdown-checkbox.js').TodoFormatMatch & { meta: object | null } | null}
   */
  parse(line) {
    const match = STRUCTURED_PATTERN.exec(line)
    if (match === null) return null
    const [, mark, type, date, prio, doneAt, cancelledAt, body] = match
    // deadline/sleep 缺日期、anytime/active 带日期 → 格式损坏，交给后续策略兜底
    if ((type === 'deadline' || type === 'sleep') && date === undefined) return null
    if ((type === 'anytime' || type === 'active') && date !== undefined) return null
    // 三种标记互斥（带错 → 降级兜底）；标记日期允许缺省（手写 [x] 无 done: 等同）
    if (mark === ' ' && (doneAt !== undefined || cancelledAt !== undefined)) return null
    if (mark === 'x' && cancelledAt !== undefined) return null
    if (mark === '-' && doneAt !== undefined) return null
    return Object.freeze({
      done: mark === 'x' || mark === 'X',
      cancelled: mark === '-',
      text: body.trim(),
      raw: line,
      meta: Object.freeze({ type, date: date ?? null, prio, doneAt: doneAt ?? null, cancelledAt: cancelledAt ?? null }),
    })
  },
})

/**
 * 构造一行结构化待办（写入侧与解析侧共用本文法）。
 *
 * @param {{ done?: boolean, cancelled?: boolean, type: string, date?: string | null, prio: string, text: string, doneAt?: string | null, cancelledAt?: string | null }} input
 */
export function buildStructuredTodoLine({ done = false, cancelled = false, type, date = null, prio, text, doneAt = null, cancelledAt = null }) {
  if (!TODO_TYPES.includes(type)) throw new Error(`未知待办类型：${String(type)}`)
  if (!TODO_PRIORITIES.includes(prio)) throw new Error(`未知优先级：${String(prio)}`)
  if (typeof text !== 'string' || text.trim() === '') throw new Error('待办文本不能为空')
  if (done === true && cancelled === true) throw new Error('待办不能同时完成与取消')
  const needsDate = type === 'deadline' || type === 'sleep'
  if (needsDate && (typeof date !== 'string' || !DATE_PATTERN.test(date))) {
    throw new Error(`${type} 型待办需要 yyyy-mm-dd 日期`)
  }
  if (!needsDate && date != null) throw new Error(`${type} 型待办不带日期`)
  if (doneAt !== null && (done !== true || typeof doneAt !== 'string' || !DATE_PATTERN.test(doneAt))) {
    throw new Error('完成日期 doneAt 只能是 [x] 行的 yyyy-mm-dd')
  }
  if (cancelledAt !== null && (cancelled !== true || typeof cancelledAt !== 'string' || !DATE_PATTERN.test(cancelledAt))) {
    throw new Error('取消日期 cancelledAt 只能是 [-] 行的 yyyy-mm-dd')
  }
  const mark = done ? 'x' : cancelled ? '-' : ' '
  const datePart = needsDate ? ` ${date}` : ''
  const donePart = doneAt !== null ? ` done:${doneAt}` : ''
  const cancelledPart = cancelledAt !== null ? ` cancelled:${cancelledAt}` : ''
  const body = text.replace(/\s*\r?\n\s*/g, ' ').trim()
  return `- [${mark}] (ml:${type}${datePart} ${prio}${donePart}${cancelledPart}) ${body}`
}

/**
 * 切换一行结构化待办的完成态（纯函数）：完成 → 写入 done:<today>；
 * 取消完成 → 清除完成日期。非结构化行返回 null（调用方走普通翻转）；
 * 已取消行抛错（先 /ml todo c 恢复）。
 *
 * @param {string} line 原始行
 * @param {string} today yyyy-mm-dd（完成时写入的日期）
 * @returns {{ line: string, done: boolean } | null}
 */
export function toggleStructuredTodoLine(line, today) {
  if (typeof today !== 'string' || !DATE_PATTERN.test(today)) {
    throw new Error(`today 必须是 yyyy-mm-dd（收到 ${String(today)}）`)
  }
  const match = memoryleakTodoFormat.parse(String(line ?? ''))
  if (match === null) return null
  if (match.cancelled === true) {
    throw new TodoError('该待办已取消——先用 /ml todo c 恢复，再标记完成')
  }
  const nextDone = !match.done
  return {
    line: buildStructuredTodoLine({
      done: nextDone,
      type: match.meta.type,
      date: match.meta.date,
      prio: match.meta.prio,
      text: match.text,
      doneAt: nextDone ? today : null,
    }),
    done: nextDone,
  }
}

/**
 * 切换一行结构化待办的取消态（纯函数，/ml todo c）：取消 → 复选框变
 * `[-]` 并写入 cancelled:<today>；再切一次恢复原状。非结构化行返回
 * null（调用方走普通翻转）；已完成行抛错（取消与完成互斥）。
 *
 * @param {string} line 原始行
 * @param {string} today yyyy-mm-dd（取消时写入的日期）
 * @returns {{ line: string, cancelled: boolean } | null}
 */
export function cancelStructuredTodoLine(line, today) {
  if (typeof today !== 'string' || !DATE_PATTERN.test(today)) {
    throw new Error(`today 必须是 yyyy-mm-dd（收到 ${String(today)}）`)
  }
  const match = memoryleakTodoFormat.parse(String(line ?? ''))
  if (match === null) return null
  if (match.done === true) {
    throw new TodoError('该待办已完成，不能取消——需要先 /ml todo d 切回未完成')
  }
  const nextCancelled = !match.cancelled
  return {
    line: buildStructuredTodoLine({
      cancelled: nextCancelled,
      type: match.meta.type,
      date: match.meta.date,
      prio: match.meta.prio,
      text: match.text,
      cancelledAt: nextCancelled ? today : null,
    }),
    cancelled: nextCancelled,
  }
}

/**
 * 延期一行结构化待办（纯函数，/ml todo p）：截止日 + N 天后重写。
 * 只有未完成、未取消的 deadline 型有效——非结构化行返回 null（调用方
 * 对普通行报错），结构化但不合规抛错（调用方转红字提示）。
 *
 * @param {string} line 原始行
 * @param {number} days 延期天数（1..MAX_POSTPONE_DAYS）
 * @returns {{ line: string, date: string, previousDate: string } | null}
 */
export function postponeStructuredTodoLine(line, days) {
  const match = memoryleakTodoFormat.parse(String(line ?? ''))
  if (match === null) return null
  if (match.meta.type !== 'deadline') {
    throw new TodoError(`只有 deadline 型待办能延期（这条是 ${match.meta.type} 型）`)
  }
  if (match.done === true) {
    throw new TodoError('该待办已完成，延期无意义——先 /ml todo d 切回未完成')
  }
  if (match.cancelled === true) {
    throw new TodoError('该待办已取消，延期无意义——先 /ml todo c 恢复')
  }
  const previousDate = match.meta.date
  const date = addDaysToDate(previousDate, days)
  return {
    line: buildStructuredTodoLine({
      type: 'deadline',
      date,
      prio: match.meta.prio,
      text: match.text,
    }),
    date,
    previousDate,
  }
}

/**
 * 唤醒转写：把一行未完成的 sleep 待办改写为 active（保留完成态/优先级/正文，
 * 去掉日期）。非 sleep 行抛错 —— 调用方（唤醒遍历）已按 meta 过滤。
 *
 * @param {string} raw 文件中的原始行
 * @returns {string} active 行
 */
export function activateSleepLine(raw) {
  const match = memoryleakTodoFormat.parse(String(raw ?? ''))
  if (match === null || match.meta.type !== 'sleep') {
    throw new Error('activateSleepLine 只接受 sleep 型待办行')
  }
  if (match.cancelled === true) {
    // 已取消的 sleep 不唤醒（保留 [-] 形态；到日唤醒遍历会跳过取消行）
    return String(raw)
  }
  return buildStructuredTodoLine({ done: match.done, type: 'active', prio: match.meta.prio, text: match.text })
}
