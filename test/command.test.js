import { describe, expect, it } from 'vitest'
import { parseTodoArgs, TODO_USAGE } from '../src/core/command.js'
import { TodoUsageError } from '../src/core/errors.js'

describe('parseTodoArgs（/todo 文法）', () => {
  it.each([
    ['list', { action: 'list', status: null, text: null }],
    ['  list  ', { action: 'list', status: null, text: null }],
    ['list open', { action: 'list', status: 'open', text: null }],
    ['list done', { action: 'list', status: 'done', text: null }],
    ['list all', { action: 'list', status: 'all', text: null }],
    ['list deploy', { action: 'list', status: null, text: 'deploy' }],
    ['list all deploy api', { action: 'list', status: 'all', text: 'deploy api' }],
    ['list deploy open', { action: 'list', status: null, text: 'deploy open' }],
  ])('%j → %j', (input, expected) => {
    expect(parseTodoArgs(input)).toEqual(expected)
  })

  it.each([
    ['', '用法'],
    ['   ', '用法'],
    ['create something', '未知子命令'],
    ['LIST', '未知子命令'],
    ['list ALL', null], // ALL 不是状态词 → 当作关键词（大小写敏感的状态词才被吃掉）
  ])('输入 %j 抛用法错误或退化为关键词', (input, messagePart) => {
    if (messagePart === null) {
      expect(parseTodoArgs(input)).toEqual({ action: 'list', status: null, text: 'ALL' })
      return
    }
    expect(() => parseTodoArgs(input)).toThrow(TodoUsageError)
    expect(() => parseTodoArgs(input)).toThrow(new RegExp(messagePart))
  })

  it('用法文案包含完整文法', () => {
    expect(TODO_USAGE).toBe('/todo list [all|open|done] [关键词]')
  })
})
