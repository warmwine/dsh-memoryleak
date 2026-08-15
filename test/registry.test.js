import { describe, expect, it } from 'vitest'
import { TodoFormatRegistry, createDefaultRegistry, assertTodoFormat } from '../src/core/registry.js'
import { TodoFormatContractError } from '../src/core/errors.js'
import { markdownCheckboxFormat } from '../src/core/formats/markdown-checkbox.js'

/** 测试用第二策略：只认 `!! 紧急：xxx`。 */
const urgentFormat = Object.freeze({
  id: 'urgent',
  title: '紧急标记（!!）',
  parse(line) {
    const match = /^!!\s+(.*)$/.exec(line)
    if (match === null) return null
    return { done: false, text: match[1], raw: line }
  },
})

describe('TodoFormatRegistry（Registry + Strategy）', () => {
  it('内置默认注册表包含 markdown-checkbox', () => {
    expect(createDefaultRegistry().ids).toEqual(['markdown-checkbox'])
    expect(createDefaultRegistry([urgentFormat]).ids).toEqual(['markdown-checkbox', 'urgent'])
  })

  it('重复 id 在注册期崩溃（let-it-crash）', () => {
    const registry = new TodoFormatRegistry()
    registry.register(markdownCheckboxFormat)
    expect(() => registry.register({ ...markdownCheckboxFormat })).toThrow(TodoFormatContractError)
  })

  it.each([
    [{ id: 'Bad', title: 'x', parse: () => null }, 'id 必须小写'],
    [{ id: 'ok', title: ' ', parse: () => null }, 'title 非空'],
    [{ id: 'ok', title: 'x' }, '缺 parse'],
    [null, '必须是对象'],
  ])('畸形策略 %# 在注册期崩溃', (format) => {
    expect(() => assertTodoFormat(format)).toThrow(TodoFormatContractError)
    const registry = new TodoFormatRegistry()
    expect(() => registry.register(format)).toThrow(TodoFormatContractError)
  })

  it('priority 小者优先，同优先级按 id 稳定排序', () => {
    const registry = new TodoFormatRegistry()
    // 两个策略都能匹配 "!! 紧急" 行？urgent 匹配；markdown 不匹配。构造都匹配的场景：
    const anyLine = Object.freeze({
      id: 'aaa-catch-all',
      title: '吃掉一切',
      parse: (line) => (line.trim() === '' ? null : { done: false, text: line.trim(), raw: line }),
    })
    registry.register(anyLine, { priority: 50 })
    registry.register(urgentFormat, { priority: 10 })
    const match = registry.parseLine('!! 紧急')
    expect(match.format).toBe('urgent')
    expect(registry.ids).toEqual(['urgent', 'aaa-catch-all'])
  })

  it('parseLine 在返回 match 上补 format id 并冻结', () => {
    const registry = createDefaultRegistry()
    const match = registry.parseLine('- [x] 完成')
    expect(match).toMatchObject({ done: true, text: '完成', format: 'markdown-checkbox' })
    expect(Object.isFrozen(match)).toBe(true)
  })

  it('坏 match（非布尔 done / 空 text）在边界崩溃', () => {
    const registry = new TodoFormatRegistry()
    registry.register({ id: 'bad', title: '坏策略', parse: () => ({ done: 'yes', text: 'x' }) })
    expect(() => registry.parseLine('anything')).toThrow(/done/)
    const registry2 = new TodoFormatRegistry()
    registry2.register({ id: 'bad2', title: '坏策略', parse: () => ({ done: true, text: '  ' }) })
    expect(() => registry2.parseLine('anything')).toThrow(/text/)
  })

  it('register 返回注销函数，注销后不再参与解析（副作用可逆）', () => {
    const registry = new TodoFormatRegistry()
    const dispose = registry.register(urgentFormat)
    expect(registry.parseLine('!! 跑')).not.toBeNull()
    dispose()
    expect(registry.ids).toEqual([])
    expect(registry.parseLine('!! 跑')).toBeNull()
  })
})
