import { describe, expect, it } from 'vitest'
import {
  memoryleakTodoFormat,
  buildStructuredTodoLine,
  isValidTodoMeta,
  TODO_TYPES,
  TODO_PRIORITIES,
} from '../src/core/formats/memoryleak-todo.js'
import { createDefaultRegistry } from '../src/core/registry.js'

describe('memoryleak-todo 策略（解析）', () => {
  it.each([
    ['- [ ] (ml:deadline 2026-09-01 urgent) 完成设计稿', { done: false, type: 'deadline', date: '2026-09-01', prio: 'urgent', text: '完成设计稿' }],
    ['- [x] (ml:sleep 2026-12-01 low) 学一遍内部源码', { done: true, type: 'sleep', date: '2026-12-01', prio: 'low', text: '学一遍内部源码' }],
    ['- [ ] (ml:anytime medium) 整理收藏夹', { done: false, type: 'anytime', date: null, prio: 'medium', text: '整理收藏夹' }],
    ['* [ ] (ml:anytime urgent) 星号列表也可以', { done: false, type: 'anytime', date: null, prio: 'urgent', text: '星号列表也可以' }],
  ])('%s → %j', (line, expected) => {
    const match = memoryleakTodoFormat.parse(line)
    expect(match).not.toBeNull()
    expect(match.done).toBe(expected.done)
    expect(match.text).toBe(expected.text)
    expect(match.meta).toEqual({ type: expected.type, date: expected.date, prio: expected.prio })
    expect(Object.isFrozen(match.meta)).toBe(true)
  })

  it.each([
    ['- [ ] (ml:deadline urgent) 缺日期', 'deadline 缺日期不匹配'],
    ['- [ ] (ml:anytime 2026-09-01 low) anytime 不该带日期', 'anytime 带日期不匹配'],
    ['- [ ] (ml:todo 2026-09-01 low) 未知类型', '未知类型'],
    ['- [ ] (ml:deadline 2026/09/01 low) 日期格式错', '日期斜杠'],
    ['- [ ] (ml:deadline 2026-09-01 critical) 未知优先级', '未知优先级'],
    ['- [ ] ml:deadline 2026-09-01 low 没有括号', '没有属性块括号'],
    ['- [ ] 普通待办', '普通行'],
  ])('%s 不匹配（%s）', (line) => {
    expect(memoryleakTodoFormat.parse(line)).toBeNull()
  })

  it('格式损坏的结构化行降级为普通复选框待办（不丢数据）', () => {
    const registry = createDefaultRegistry()
    const match = registry.parseLine('- [ ] (ml:deadline urgent) 缺日期')
    expect(match.format).toBe('markdown-checkbox')
    expect(match.meta).toBeNull()
    expect(match.text).toBe('(ml:deadline urgent) 缺日期')
  })
})

describe('memoryleak-todo 策略（构造）', () => {
  it('buildStructuredTodoLine 与 parse 往返一致', () => {
    for (const input of [
      { type: 'deadline', date: '2026-09-01', prio: 'urgent', text: '完成设计稿' },
      { type: 'sleep', date: '2026-12-01', prio: 'low', text: '学源码' },
      { type: 'anytime', date: null, prio: 'medium', text: '整理收藏夹' },
      { type: 'deadline', date: '2026-09-01', prio: 'low', text: '多 行 文本 折叠', done: true },
    ]) {
      const line = buildStructuredTodoLine(input)
      const match = memoryleakTodoFormat.parse(line)
      expect(match, line).not.toBeNull()
      expect(match.done).toBe(input.done ?? false)
      expect(match.meta.type).toBe(input.type)
      expect(match.meta.date).toBe(input.date)
      expect(match.meta.prio).toBe(input.prio)
    }
  })

  it.each([
    [{ type: 'once', date: null, prio: 'low', text: 'x' }, /类型/],
    [{ type: 'deadline', date: null, prio: 'low', text: 'x' }, /日期/],
    [{ type: 'deadline', date: '2026-9-1', prio: 'low', text: 'x' }, /日期/],
    [{ type: 'anytime', date: '2026-09-01', prio: 'low', text: 'x' }, /不带日期/],
    [{ type: 'anytime', date: null, prio: 'critical', text: 'x' }, /优先级/],
    [{ type: 'anytime', date: null, prio: 'low', text: '  ' }, /不能为空/],
  ])('非法构造 %# 抛错', (input, pattern) => {
    expect(() => buildStructuredTodoLine(input)).toThrow(pattern)
  })

  it('常量与 meta 校验', () => {
    expect(TODO_TYPES).toEqual(['deadline', 'sleep', 'anytime'])
    expect(TODO_PRIORITIES).toEqual(['urgent', 'medium', 'low'])
    expect(isValidTodoMeta(null)).toBe(true)
    expect(isValidTodoMeta({ type: 'sleep', date: '2026-12-01', prio: 'low' })).toBe(true)
    expect(isValidTodoMeta({ type: 'sleep', date: 'bad', prio: 'low' })).toBe(false)
    expect(isValidTodoMeta({ type: 'nope', date: null, prio: 'low' })).toBe(false)
  })
})

describe('注册表优先级（结构化行优先解析）', () => {
  it('默认注册表：memoryleak-todo 先于 markdown-checkbox', () => {
    const registry = createDefaultRegistry()
    expect(registry.ids).toEqual(['memoryleak-todo', 'markdown-checkbox'])
    const structured = '- [ ] (ml:anytime low) 整理'
    expect(registry.parseLine(structured).format).toBe('memoryleak-todo')
    const plain = '- [ ] 整理'
    expect(registry.parseLine(plain).format).toBe('markdown-checkbox')
  })
})
