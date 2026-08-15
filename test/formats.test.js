import { describe, expect, it } from 'vitest'
import { markdownCheckboxFormat } from '../src/core/formats/markdown-checkbox.js'

describe('markdown-checkbox 策略', () => {
  it.each([
    ['- [ ] 买牛奶', false, '买牛奶'],
    ['- [x] 买牛奶', true, '买牛奶'],
    ['- [X] 买牛奶', true, '买牛奶'],
    ['* [ ] 星号列表', false, '星号列表'],
    ['+ [x] 加号列表', true, '加号列表'],
    ['  - [ ] 缩进列表', false, '缩进列表'],
    ['- [ ]   多余空格   ', false, '多余空格'],
  ])('%s → done=%s text=%s', (line, done, text) => {
    const match = markdownCheckboxFormat.parse(line)
    expect(match).not.toBeNull()
    expect(match.done).toBe(done)
    expect(match.text).toBe(text)
    expect(match.raw).toBe(line)
  })

  it.each([
    ['- [ ]', '- [ ]   \t'],            // 空正文：噪音
    ['-[] 缺空格', '- [x]缺空格'],       // 复选框后需要空白
    ['[ ] 不是列表', '1. [ ] 有序列表'],  // v1 只支持无序列表
    ['普通文本', '## 标题'],
    ['- ( ) 圆括号', '- [y] 非法状态'],
  ])('%s 不匹配（以及 %s）', (line, other) => {
    expect(markdownCheckboxFormat.parse(line)).toBeNull()
    expect(markdownCheckboxFormat.parse(other)).toBeNull()
  })

  it('策略自身冻结、契约字段齐全', () => {
    expect(Object.isFrozen(markdownCheckboxFormat)).toBe(true)
    expect(markdownCheckboxFormat.id).toMatch(/^[a-z][a-z0-9-]*$/)
    expect(markdownCheckboxFormat.title.trim()).not.toBe('')
    expect(typeof markdownCheckboxFormat.parse).toBe('function')
  })
})
