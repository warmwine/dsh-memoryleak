import { describe, expect, it } from 'vitest'
import { createTodoItem } from '../src/core/todo-item.js'

describe('TodoItem 值对象', () => {
  const valid = { file: 'docs/a.md', line: 3, text: ' 买牛奶 ', done: false, format: 'markdown-checkbox', raw: '- [ ] 买牛奶' }

  it('构造成功即冻结，text 被 trim', () => {
    const item = createTodoItem(valid)
    expect(item.text).toBe('买牛奶')
    expect(item.done).toBe(false)
    expect(Object.isFrozen(item)).toBe(true)
  })

  it.each([
    ['file 为空串', { ...valid, file: '' }],
    ['line 为 0', { ...valid, line: 0 }],
    ['line 非整数', { ...valid, line: 1.5 }],
    ['text 为空白', { ...valid, text: '   ' }],
    ['done 非布尔', { ...valid, done: 'no' }],
    ['format 缺失', { ...valid, format: undefined }],
    ['整体非对象', null],
  ])('非法输入 %s 在构造期崩溃', (_name, input) => {
    expect(() => createTodoItem(input)).toThrow(/invariant/)
  })

  it('raw 可省略（归一为 null）', () => {
    const item = createTodoItem({ ...valid, raw: undefined })
    expect(item.raw).toBeNull()
  })
})
