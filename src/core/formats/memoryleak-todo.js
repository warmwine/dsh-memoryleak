/**
 * MemoryLeak 结构化待办格式 —— 第二个 TodoFormat Strategy。
 *
 * 行文法（机器友好、人类可读、仍保持 markdown 复选框形态）：
 *   - [ ] (ml:deadline 2026-09-01 urgent) 完成设计稿
 *   - [x] (ml:sleep 2026-12-01 low done:2026-08-16) 学一遍内部源码
 *   - [ ] (ml:anytime medium) 整理收藏夹
 *
 * 规则：
 *   - `(ml:<type>[ <yyyy-mm-dd>] <prio>[ done:<yyyy-mm-dd>])` 属性块紧跟复选框
 *   - type ∈ deadline（固定截止日）/ sleep（到日唤醒）/ anytime（随时）
 *   -   / active（sleep 唤醒后的形态，无日期）
 *   - deadline、sleep 必须带日期；anytime、active 不带
 *   - prio ∈ urgent / medium / low
 *   - done:<date> 只在 [x] 行出现（/ml todo d 完成时写入，u 撤销时清除）
 *   - 属性块不完整（如 deadline 缺日期）不匹配 → 降级为普通 markdown-checkbox
 *     待办（仍然可见，不丢数据）
 *
 * 注册优先级高于 markdown-checkbox（priority 50 < 100）：结构化行优先按本
 * 策略解析，携带 meta 进入查询管线（sleep 过滤、类型/优先级徽章）。
 *
 * @module dsh-memoryleak/core/formats/memoryleak-todo
 */

/** 结构化待办类型（active = sleep 到日唤醒后的形态，无日期）。 */
export const TODO_TYPES = Object.freeze(['deadline', 'sleep', 'anytime', 'active'])

/** 优先级。 */
export const TODO_PRIORITIES = Object.freeze(['urgent', 'medium', 'low'])

const STRUCTURED_PATTERN = /^[ \t]*(?:[-*+])[ \t]+\[([ xX])][ \t]+\(ml:(deadline|sleep|anytime|active)(?:[ \t]+(\d{4}-\d{2}-\d{2}))?[ \t]+(urgent|medium|low)(?:[ \t]+done:(\d{4}-\d{2}-\d{2}))?\)[ \t]+(\S.*)$/

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 校验 meta 形状（registry / 值对象边界复用）。 */
export function isValidTodoMeta(meta) {
  if (meta === null || meta === undefined) return true
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return false
  if (!TODO_TYPES.includes(meta.type)) return false
  if (!TODO_PRIORITIES.includes(meta.prio)) return false
  if (meta.date !== null && meta.date !== undefined && !DATE_PATTERN.test(meta.date)) return false
  if (meta.doneAt !== null && meta.doneAt !== undefined && !DATE_PATTERN.test(meta.doneAt)) return false
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
    const [, mark, type, date, prio, doneAt, body] = match
    // deadline/sleep 缺日期、anytime/active 带日期 → 格式损坏，交给后续策略兜底
    if ((type === 'deadline' || type === 'sleep') && date === undefined) return null
    if ((type === 'anytime' || type === 'active') && date !== undefined) return null
    // done: 只属于已完成行；未完成却带完成日 → 格式损坏，降级兜底
    if (mark === ' ' && doneAt !== undefined) return null
    return Object.freeze({
      done: mark !== ' ',
      text: body.trim(),
      raw: line,
      meta: Object.freeze({ type, date: date ?? null, prio, doneAt: doneAt ?? null }),
    })
  },
})

/**
 * 构造一行结构化待办（写入侧与解析侧共用本文法）。
 *
 * @param {{ done?: boolean, type: string, date?: string | null, prio: string, text: string, doneAt?: string | null }} input
 */
export function buildStructuredTodoLine({ done = false, type, date = null, prio, text, doneAt = null }) {
  if (!TODO_TYPES.includes(type)) throw new Error(`未知待办类型：${String(type)}`)
  if (!TODO_PRIORITIES.includes(prio)) throw new Error(`未知优先级：${String(prio)}`)
  if (typeof text !== 'string' || text.trim() === '') throw new Error('待办文本不能为空')
  const needsDate = type === 'deadline' || type === 'sleep'
  if (needsDate && (typeof date !== 'string' || !DATE_PATTERN.test(date))) {
    throw new Error(`${type} 型待办需要 yyyy-mm-dd 日期`)
  }
  if (!needsDate && date != null) throw new Error(`${type} 型待办不带日期`)
  if (doneAt !== null && (!done || typeof doneAt !== 'string' || !DATE_PATTERN.test(doneAt))) {
    throw new Error('完成日期 doneAt 只能是 [x] 行的 yyyy-mm-dd')
  }
  const mark = done ? 'x' : ' '
  const datePart = needsDate ? ` ${date}` : ''
  const donePart = doneAt !== null ? ` done:${doneAt}` : ''
  const body = text.replace(/\s*\r?\n\s*/g, ' ').trim()
  return `- [${mark}] (ml:${type}${datePart} ${prio}${donePart}) ${body}`
}

/**
 * 切换一行结构化待办的完成态（纯函数）：完成 → 写入 done:<today>；
 * 取消完成 → 清除完成日期。非结构化行返回 null（调用方走普通翻转）。
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
  return buildStructuredTodoLine({ done: match.done, type: 'active', prio: match.meta.prio, text: match.text })
}
