/**
 * MemoryLeak 结构化待办格式 —— 第二个 TodoFormat Strategy。
 *
 * 行文法（机器友好、人类可读、仍保持 markdown 复选框形态）：
 *   - [ ] (ml:deadline 2026-09-01 urgent) 完成设计稿
 *   - [x] (ml:sleep 2026-12-01 low) 学一遍内部源码
 *   - [ ] (ml:anytime medium) 整理收藏夹
 *
 * 规则：
 *   - `(ml:<type>[ <yyyy-mm-dd>] <prio>)` 属性块紧跟复选框，正文在后
 *   - type ∈ deadline（固定截止日）/ sleep（到日唤醒）/ anytime（随时）
 *   - deadline、sleep 必须带日期；anytime 不带
 *   - prio ∈ urgent / medium / low
 *   - 属性块不完整（如 deadline 缺日期）不匹配 → 降级为普通 markdown-checkbox
 *     待办（仍然可见，不丢数据）
 *
 * 注册优先级高于 markdown-checkbox（priority 50 < 100）：结构化行优先按本
 * 策略解析，携带 meta 进入查询管线（sleep 过滤、类型/优先级徽章）。
 *
 * @module dsh-memoryleak/core/formats/memoryleak-todo
 */

/** 结构化待办类型。 */
export const TODO_TYPES = Object.freeze(['deadline', 'sleep', 'anytime'])

/** 优先级。 */
export const TODO_PRIORITIES = Object.freeze(['urgent', 'medium', 'low'])

const STRUCTURED_PATTERN = /^[ \t]*(?:[-*+])[ \t]+\[([ xX])][ \t]+\(ml:(deadline|sleep|anytime)(?:[ \t]+(\d{4}-\d{2}-\d{2}))?[ \t]+(urgent|medium|low)\)[ \t]+(\S.*)$/

/** 校验 meta 形状（registry / 值对象边界复用）。 */
export function isValidTodoMeta(meta) {
  if (meta === null || meta === undefined) return true
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return false
  if (!TODO_TYPES.includes(meta.type)) return false
  if (!TODO_PRIORITIES.includes(meta.prio)) return false
  if (meta.date !== null && meta.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(meta.date)) return false
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
    const [, mark, type, date, prio, body] = match
    // deadline/sleep 缺日期、anytime 带日期 → 视为格式损坏，交给后续策略兜底
    if ((type === 'deadline' || type === 'sleep') && date === undefined) return null
    if (type === 'anytime' && date !== undefined) return null
    return Object.freeze({
      done: mark !== ' ',
      text: body.trim(),
      raw: line,
      meta: Object.freeze({ type, date: date ?? null, prio }),
    })
  },
})

/**
 * 构造一行结构化待办（写入侧与解析侧共用本文法）。
 *
 * @param {{ done?: boolean, type: string, date?: string | null, prio: string, text: string }} input
 */
export function buildStructuredTodoLine({ done = false, type, date = null, prio, text }) {
  if (!TODO_TYPES.includes(type)) throw new Error(`未知待办类型：${String(type)}`)
  if (!TODO_PRIORITIES.includes(prio)) throw new Error(`未知优先级：${String(prio)}`)
  if (typeof text !== 'string' || text.trim() === '') throw new Error('待办文本不能为空')
  const needsDate = type === 'deadline' || type === 'sleep'
  if (needsDate && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
    throw new Error(`${type} 型待办需要 yyyy-mm-dd 日期`)
  }
  if (!needsDate && date != null) throw new Error('anytime 型待办不带日期')
  const mark = done ? 'x' : ' '
  const datePart = needsDate ? ` ${date}` : ''
  const body = text.replace(/\s*\r?\n\s*/g, ' ').trim()
  return `- [${mark}] (ml:${type}${datePart} ${prio}) ${body}`
}
