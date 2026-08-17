import { describe, expect, it } from 'vitest'
import {
  memoryleakTodoFormat,
  buildStructuredTodoLine,
  toggleStructuredTodoLine,
  isValidTodoMeta,
  TODO_TYPES,
  TODO_PRIORITIES,
} from '../src/core/formats/memoryleak-todo.js'
import { createDefaultRegistry } from '../src/core/registry.js'

describe('memoryleak-todo 策略（解析）', () => {
  it.each([
    ['- [ ] (ml:deadline 2026-09-01 urgent) 完成设计稿', { done: false, type: 'deadline', date: '2026-09-01', prio: 'urgent', doneAt: null, text: '完成设计稿' }],
    ['- [x] (ml:sleep 2026-12-01 low) 学一遍内部源码', { done: true, type: 'sleep', date: '2026-12-01', prio: 'low', doneAt: null, text: '学一遍内部源码' }],
    ['- [x] (ml:anytime medium done:2026-08-16) 整理收藏夹', { done: true, type: 'anytime', date: null, prio: 'medium', doneAt: '2026-08-16', text: '整理收藏夹' }],
    ['- [x] (ml:deadline 2026-09-01 urgent done:2026-08-15) 完成设计稿', { done: true, type: 'deadline', date: '2026-09-01', prio: 'urgent', doneAt: '2026-08-15', text: '完成设计稿' }],
    ['- [x] (ml:active low done:2026-08-16) 复盘上线', { done: true, type: 'active', date: null, prio: 'low', doneAt: '2026-08-16', text: '复盘上线' }],
    ['- [ ] (ml:anytime medium) 整理收藏夹', { done: false, type: 'anytime', date: null, prio: 'medium', doneAt: null, text: '整理收藏夹' }],
    ['* [ ] (ml:anytime urgent) 星号列表也可以', { done: false, type: 'anytime', date: null, prio: 'urgent', doneAt: null, text: '星号列表也可以' }],
  ])('%s → %j', (line, expected) => {
    const match = memoryleakTodoFormat.parse(line)
    expect(match).not.toBeNull()
    expect(match.done).toBe(expected.done)
    expect(match.text).toBe(expected.text)
    expect(match.meta).toEqual({ type: expected.type, date: expected.date, prio: expected.prio, doneAt: expected.doneAt })
    expect(Object.isFrozen(match.meta)).toBe(true)
  })

  it.each([
    ['- [ ] (ml:deadline urgent) 缺日期', 'deadline 缺日期不匹配'],
    ['- [ ] (ml:anytime 2026-09-01 low) anytime 不该带日期', 'anytime 带日期不匹配'],
    ['- [ ] (ml:todo 2026-09-01 low) 未知类型', '未知类型'],
    ['- [ ] (ml:deadline 2026/09/01 low) 日期格式错', '日期斜杠'],
    ['- [ ] (ml:deadline 2026-09-01 critical) 未知优先级', '未知优先级'],
    ['- [ ] (ml:anytime medium done:2026-08-16) 未完成却带完成日', 'done 只属于 [x] 行'],
    ['- [x] (ml:anytime medium done:2026/08/16) 完成日格式错', '完成日格式'],
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
    // 未完成却带 done: 同样降级（数据不丢，正文可见）
    const degraded = registry.parseLine('- [ ] (ml:anytime low done:2026-08-16) 矛盾行')
    expect(degraded.format).toBe('markdown-checkbox')
    expect(degraded.meta).toBeNull()
  })
})

describe('memoryleak-todo 策略（构造）', () => {
  it('buildStructuredTodoLine 与 parse 往返一致', () => {
    for (const input of [
      { type: 'deadline', date: '2026-09-01', prio: 'urgent', text: '完成设计稿' },
      { type: 'sleep', date: '2026-12-01', prio: 'low', text: '学源码' },
      { type: 'anytime', date: null, prio: 'medium', text: '整理收藏夹' },
      { type: 'deadline', date: '2026-09-01', prio: 'low', text: '多 行 文本 折叠', done: true },
      { type: 'anytime', date: null, prio: 'low', text: '带完成日的已完成项', done: true, doneAt: '2026-08-16' },
    ]) {
      const line = buildStructuredTodoLine(input)
      const match = memoryleakTodoFormat.parse(line)
      expect(match, line).not.toBeNull()
      expect(match.done).toBe(input.done ?? false)
      expect(match.meta.type).toBe(input.type)
      expect(match.meta.date).toBe(input.date)
      expect(match.meta.prio).toBe(input.prio)
      expect(match.meta.doneAt).toBe(input.doneAt ?? null)
      expect(match.done).toBe(input.done ?? false)
    }
  })

  it.each([
    [{ type: 'once', date: null, prio: 'low', text: 'x' }, /类型/],
    [{ type: 'deadline', date: null, prio: 'low', text: 'x' }, /日期/],
    [{ type: 'deadline', date: '2026-9-1', prio: 'low', text: 'x' }, /日期/],
    [{ type: 'anytime', date: '2026-09-01', prio: 'low', text: 'x' }, /不带日期/],
    [{ type: 'anytime', date: null, prio: 'critical', text: 'x' }, /优先级/],
    [{ type: 'anytime', date: null, prio: 'low', text: '  ' }, /不能为空/],
    [{ type: 'anytime', date: null, prio: 'low', text: 'x', doneAt: '2026-08-16' }, /doneAt/], // 未完成不能带完成日
    [{ type: 'anytime', date: null, prio: 'low', text: 'x', done: true, doneAt: 'bad' }, /doneAt/],
  ])('非法构造 %# 抛错', (input, pattern) => {
    expect(() => buildStructuredTodoLine(input)).toThrow(pattern)
  })

  it('toggleStructuredTodoLine：完成写戳、取消清戳、非结构化返回 null', () => {
    const today = '2026-08-16'
    const open = '- [ ] (ml:deadline 2026-09-01 urgent) 完成设计稿'
    const done = toggleStructuredTodoLine(open, today)
    expect(done).toEqual({ line: `- [x] (ml:deadline 2026-09-01 urgent done:${today}) 完成设计稿`, done: true })
    // 再切回 → 戳清除
    const back = toggleStructuredTodoLine(done.line, today)
    expect(back).toEqual({ line: open, done: false })
    // 非结构化行
    expect(toggleStructuredTodoLine('- [ ] 普通待办', today)).toBeNull()
    // 非法 today
    expect(() => toggleStructuredTodoLine(open, '2026/08/16')).toThrow(/today/)
  })

  it('常量与 meta 校验', () => {
    expect(TODO_TYPES).toEqual(['deadline', 'sleep', 'anytime', 'active'])
    expect(TODO_PRIORITIES).toEqual(['urgent', 'medium', 'low'])
    expect(isValidTodoMeta(null)).toBe(true)
    expect(isValidTodoMeta({ type: 'sleep', date: '2026-12-01', prio: 'low' })).toBe(true)
    expect(isValidTodoMeta({ type: 'active', date: null, prio: 'low' })).toBe(true)
    expect(isValidTodoMeta({ type: 'active', date: null, prio: 'low', doneAt: '2026-08-16' })).toBe(true)
    expect(isValidTodoMeta({ type: 'active', date: null, prio: 'low', doneAt: 'bad' })).toBe(false)
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
