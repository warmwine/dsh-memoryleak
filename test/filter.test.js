import { describe, expect, it } from 'vitest'
import { applyTodoQuery, createTodoQuery, TODO_STATUSES } from '../src/core/filter.js'
import { createTodoItem } from '../src/core/todo-item.js'

const items = [
  createTodoItem({ file: 'a.md', line: 1, text: 'Deploy the API', done: false, format: 'f' }),
  createTodoItem({ file: 'a.md', line: 2, text: 'deploy docs', done: true, format: 'f' }),
  createTodoItem({ file: 'b.md', line: 5, text: '写周报', done: false, format: 'f' }),
]

const TODAY = '2026-08-16'
const withMeta = (over) => createTodoItem({ file: 'c.md', line: 1, text: '任务', done: false, format: 'memoryleak-todo', meta: { date: null, ...over } })
const sleeping = withMeta({ type: 'sleep', date: '2026-12-01', prio: 'low' })
const awake = withMeta({ type: 'sleep', date: '2026-08-01', prio: 'low' })
const awakeToday = withMeta({ type: 'sleep', date: TODAY, prio: 'low' })
const deadline = withMeta({ type: 'deadline', date: '2026-09-01', prio: 'urgent' })
const anytime = withMeta({ type: 'anytime', prio: 'medium' })

describe('TodoQuery（Specification）', () => {
  it('默认查询：all、无文本、无上限', () => {
    const query = createTodoQuery()
    expect(query.status).toBe('all')
    expect(query.text).toBeNull()
    expect(query.limit).toBeNull()
    expect(Object.isFrozen(query)).toBe(true)
  })

  it('sleep 规格默认：open/done 隐藏未唤醒，all 显示全部', () => {
    const pool = [...items, sleeping, awake, deadline, anytime]
    const open = applyTodoQuery(createTodoQuery({ status: 'open', today: TODAY }), pool)
    expect(open.items.map((i) => i.text)).toEqual(['Deploy the API', '写周报', '任务', '任务', '任务']) // sleeping 隐藏，awake/deadline/anytime 可见
    const all = applyTodoQuery(createTodoQuery({ status: 'all', today: TODAY }), pool)
    expect(all.items).toHaveLength(pool.length)
  })

  it('唤醒日当天即视为唤醒（含当天）', () => {
    const pool = [sleeping, awakeToday]
    expect(applyTodoQuery(createTodoQuery({ status: 'open', today: TODAY }), pool).items).toEqual([awakeToday])
  })

  it('today 为 null 时不做 sleep 过滤；显式 includeSleeping 覆盖默认', () => {
    expect(applyTodoQuery(createTodoQuery({ status: 'open' }), [sleeping]).items).toEqual([sleeping])
    expect(applyTodoQuery(createTodoQuery({ status: 'open', today: TODAY, includeSleeping: true }), [sleeping]).items).toEqual([sleeping])
  })

  it('非法 today 拒绝', () => {
    expect(() => createTodoQuery({ today: '2026/08/16' })).toThrow(/today/)
  })

  it.each([
    ['open', 2],
    ['done', 1],
    ['all', 3],
  ])('状态规格 %s 过滤出 %i 条', (status, count) => {
    expect(applyTodoQuery(createTodoQuery({ status }), items).items).toHaveLength(count)
  })

  it('文本规格大小写不敏感、跨字节安全', () => {
    expect(applyTodoQuery(createTodoQuery({ text: 'DEPLOY' }), items).items).toHaveLength(2)
    expect(applyTodoQuery(createTodoQuery({ text: 'deploy' }), items).items).toHaveLength(2)
    expect(applyTodoQuery(createTodoQuery({ text: '周报' }), items).items).toHaveLength(1)
    expect(applyTodoQuery(createTodoQuery({ text: '  ' }), items).items).toHaveLength(3)
  })

  it('规格组合（状态 AND 文本）', () => {
    const applied = applyTodoQuery(createTodoQuery({ status: 'done', text: 'deploy' }), items)
    expect(applied.items).toHaveLength(1)
    expect(applied.items[0].text).toBe('deploy docs')
  })

  it('limit 截断并标记 truncated', () => {
    const applied = applyTodoQuery(createTodoQuery({ limit: 2 }), items)
    expect(applied.items).toHaveLength(2)
    expect(applied.truncated).toBe(true)
    expect(applied.totalScanned).toBe(3)
  })

  it('非法 status / limit 在构造期崩溃', () => {
    expect(() => createTodoQuery({ status: 'ANY' })).toThrow(/status/)
    expect(() => createTodoQuery({ limit: 0 })).toThrow(/limit/)
    expect(() => createTodoQuery({ limit: 1.5 })).toThrow(/limit/)
    expect(TODO_STATUSES).toEqual(['open', 'done', 'cancelled', 'all'])
  })

  it('cancelled 状态：open 隐藏已取消、cancelled 只看已取消', () => {
    const items = [
      createTodoItem({ file: 'a.md', line: 1, text: '未完成', done: false, format: 'markdown-checkbox' }),
      createTodoItem({ file: 'a.md', line: 2, text: '已完成', done: true, format: 'markdown-checkbox' }),
      createTodoItem({ file: 'a.md', line: 3, text: '已取消', done: false, cancelled: true, format: 'markdown-checkbox' }),
    ]
    const open = applyTodoQuery(createTodoQuery({ status: 'open' }), items)
    expect(open.items.map((item) => item.text)).toEqual(['未完成'])
    const cancelled = applyTodoQuery(createTodoQuery({ status: 'cancelled' }), items)
    expect(cancelled.items.map((item) => item.text)).toEqual(['已取消'])
    const all = applyTodoQuery(createTodoQuery({ status: 'all' }), items)
    expect(all.items).toHaveLength(3)
    expect(() => createTodoItem({ file: 'a.md', line: 9, text: '矛盾', done: true, cancelled: true, format: 'x' })).toThrow(/同时完成与取消/)
  })
})
