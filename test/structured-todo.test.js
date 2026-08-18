import { describe, expect, it } from 'vitest'
import {
  memoryleakTodoFormat,
  buildStructuredTodoLine,
  toggleStructuredTodoLine,
  cancelStructuredTodoLine,
  postponeStructuredTodoLine,
  addDaysToDate,
  MAX_POSTPONE_DAYS,
  isValidTodoMeta,
  TODO_TYPES,
  TODO_PRIORITIES,
} from '../src/core/formats/memoryleak-todo.js'
import { createDefaultRegistry } from '../src/core/registry.js'

describe('memoryleak-todo 策略（解析）', () => {
  it.each([
    ['- [ ] (ml:deadline 2026-09-01 urgent) 完成设计稿', { done: false, cancelled: false, type: 'deadline', date: '2026-09-01', prio: 'urgent', doneAt: null, cancelledAt: null, text: '完成设计稿' }],
    ['- [x] (ml:sleep 2026-12-01 low) 学一遍内部源码', { done: true, cancelled: false, type: 'sleep', date: '2026-12-01', prio: 'low', doneAt: null, cancelledAt: null, text: '学一遍内部源码' }],
    ['- [x] (ml:anytime medium done:2026-08-16) 整理收藏夹', { done: true, cancelled: false, type: 'anytime', date: null, prio: 'medium', doneAt: '2026-08-16', cancelledAt: null, text: '整理收藏夹' }],
    ['- [x] (ml:deadline 2026-09-01 urgent done:2026-08-15) 完成设计稿', { done: true, cancelled: false, type: 'deadline', date: '2026-09-01', prio: 'urgent', doneAt: '2026-08-15', cancelledAt: null, text: '完成设计稿' }],
    ['- [x] (ml:active low done:2026-08-16) 复盘上线', { done: true, cancelled: false, type: 'active', date: null, prio: 'low', doneAt: '2026-08-16', cancelledAt: null, text: '复盘上线' }],
    ['- [ ] (ml:anytime medium) 整理收藏夹', { done: false, cancelled: false, type: 'anytime', date: null, prio: 'medium', doneAt: null, cancelledAt: null, text: '整理收藏夹' }],
    ['* [ ] (ml:anytime urgent) 星号列表也可以', { done: false, cancelled: false, type: 'anytime', date: null, prio: 'urgent', doneAt: null, cancelledAt: null, text: '星号列表也可以' }],
    ['- [-] (ml:deadline 2026-09-01 urgent cancelled:2026-08-18) 放弃的稿子', { done: false, cancelled: true, type: 'deadline', date: '2026-09-01', prio: 'urgent', doneAt: null, cancelledAt: '2026-08-18', text: '放弃的稿子' }],
    ['- [-] (ml:anytime low) 手写取消无日期也认', { done: false, cancelled: true, type: 'anytime', date: null, prio: 'low', doneAt: null, cancelledAt: null, text: '手写取消无日期也认' }],
  ])('%s → %j', (line, expected) => {
    const match = memoryleakTodoFormat.parse(line)
    expect(match).not.toBeNull()
    expect(match.done).toBe(expected.done)
    expect(match.cancelled).toBe(expected.cancelled)
    expect(match.text).toBe(expected.text)
    expect(match.meta).toEqual({ type: expected.type, date: expected.date, prio: expected.prio, doneAt: expected.doneAt, cancelledAt: expected.cancelledAt })
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
    ['- [ ] (ml:anytime low cancelled:2026-08-18) 未取消却带取消日', 'cancelled 只属于 [-] 行'],
    ['- [x] (ml:anytime low done:2026-08-16 cancelled:2026-08-17) 完成又取消', 'done 与 cancelled 互斥'],
    ['- [-] (ml:anytime low done:2026-08-16) 取消行带完成日', '[-] 不带 done:'],
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
    // 已取消行不能标记完成
    const cancelled = '- [-] (ml:deadline 2026-09-01 urgent cancelled:2026-08-15) 放弃'
    expect(() => toggleStructuredTodoLine(cancelled, today)).toThrow(/已取消/)
    // 非法 today
    expect(() => toggleStructuredTodoLine(open, '2026/08/16')).toThrow(/today/)
  })

  it('cancelStructuredTodoLine：取消写 [-]+cancelled:戳、恢复清除、互斥校验', () => {
    const today = '2026-08-18'
    const open = '- [ ] (ml:deadline 2026-09-01 urgent) 完成设计稿'
    const cancelled = cancelStructuredTodoLine(open, today)
    expect(cancelled).toEqual({ line: `- [-] (ml:deadline 2026-09-01 urgent cancelled:${today}) 完成设计稿`, cancelled: true })
    // 再切 → 恢复原状
    const back = cancelStructuredTodoLine(cancelled.line, today)
    expect(back).toEqual({ line: open, cancelled: false })
    // 已完成行拒绝
    const done = '- [x] (ml:anytime low done:2026-08-16) 已完成项'
    expect(() => cancelStructuredTodoLine(done, today)).toThrow(/已完成/)
    // 非结构化行返回 null
    expect(cancelStructuredTodoLine('- [ ] 普通待办', today)).toBeNull()
    // 非法 today
    expect(() => cancelStructuredTodoLine(open, 'bad')).toThrow(/today/)
  })

  describe('postponeStructuredTodoLine（/ml todo p）', () => {
    const open = '- [ ] (ml:deadline 2026-09-01 urgent) 完成设计稿'
    it('deadline 延 N 天：重写日期、保留其余', () => {
      const result = postponeStructuredTodoLine(open, 3)
      expect(result).toEqual({ line: '- [ ] (ml:deadline 2026-09-04 urgent) 完成设计稿', date: '2026-09-04', previousDate: '2026-09-01' })
    })
    it('跨月/跨年边界', () => {
      expect(postponeStructuredTodoLine('- [ ] (ml:deadline 2026-01-31 low) 月末', 1).date).toBe('2026-02-01')
      expect(postponeStructuredTodoLine('- [ ] (ml:deadline 2026-02-28 low) 平年二月', 1).date).toBe('2026-03-01')
      expect(postponeStructuredTodoLine('- [ ] (ml:deadline 2024-02-28 low) 闰年二月', 1).date).toBe('2024-02-29')
      expect(postponeStructuredTodoLine('- [ ] (ml:deadline 2026-12-31 low) 年末', 1).date).toBe('2027-01-01')
    })
    it('非 deadline 型抛错（sleep/anytime/active）', () => {
      expect(() => postponeStructuredTodoLine('- [ ] (ml:sleep 2026-12-01 low) 睡', 1)).toThrow(/只有 deadline/)
      expect(() => postponeStructuredTodoLine('- [ ] (ml:anytime low) 随', 1)).toThrow(/只有 deadline/)
    })
    it('已完成/已取消行抛错；非结构化返回 null；天数非法抛错', () => {
      expect(() => postponeStructuredTodoLine('- [x] (ml:deadline 2026-09-01 low done:2026-08-01) 完', 1)).toThrow(/已完成/)
      expect(() => postponeStructuredTodoLine('- [-] (ml:deadline 2026-09-01 low cancelled:2026-08-01) 弃', 1)).toThrow(/已取消/)
      expect(postponeStructuredTodoLine('- [ ] 普通待办', 1)).toBeNull()
      expect(() => postponeStructuredTodoLine(open, 0)).toThrow(/天数/)
      expect(() => postponeStructuredTodoLine(open, -1)).toThrow(/天数/)
      expect(() => postponeStructuredTodoLine(open, MAX_POSTPONE_DAYS + 1)).toThrow(/天数/)
    })
  })

  it('addDaysToDate：UTC 计算（不受本地时区影响）、闰年', () => {
    expect(addDaysToDate('2026-08-18', 1)).toBe('2026-08-19')
    expect(addDaysToDate('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysToDate('2024-02-28', 1)).toBe('2024-02-29')
    expect(() => addDaysToDate('bad', 1)).toThrow(/yyyy-mm-dd/)
    expect(() => addDaysToDate('2026-08-18', 0)).toThrow(/天数/)
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
    expect(isValidTodoMeta({ type: 'deadline', date: '2026-09-01', prio: 'low', cancelledAt: '2026-08-18' })).toBe(true)
    expect(isValidTodoMeta({ type: 'deadline', date: '2026-09-01', prio: 'low', cancelledAt: 'bad' })).toBe(false)
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
