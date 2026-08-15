import { describe, expect, it } from 'vitest'
import { applyTodoQuery, createTodoQuery, TODO_STATUSES } from '../src/core/filter.js'
import { createTodoItem } from '../src/core/todo-item.js'

const items = [
  createTodoItem({ file: 'a.md', line: 1, text: 'Deploy the API', done: false, format: 'f' }),
  createTodoItem({ file: 'a.md', line: 2, text: 'deploy docs', done: true, format: 'f' }),
  createTodoItem({ file: 'b.md', line: 5, text: '写周报', done: false, format: 'f' }),
]

describe('TodoQuery（Specification）', () => {
  it('默认查询：all、无文本、无上限', () => {
    const query = createTodoQuery()
    expect(query.status).toBe('all')
    expect(query.text).toBeNull()
    expect(query.limit).toBeNull()
    expect(Object.isFrozen(query)).toBe(true)
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
    expect(TODO_STATUSES).toEqual(['open', 'done', 'all'])
  })
})
