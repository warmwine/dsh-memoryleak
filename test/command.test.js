import { describe, expect, it } from 'vitest'
import { parseMlArgs, ML_USAGE } from '../src/core/command.js'
import { TodoUsageError } from '../src/core/errors.js'

describe('parseMlArgs（/ml 文法）', () => {
  it.each([
    ['todo', { family: 'todo', action: 'list', status: null, text: null }],
    ['  todo  ', { family: 'todo', action: 'list', status: null, text: null }],
    ['todo list', { family: 'todo', action: 'list', status: null, text: null }],
    ['todo list open', { family: 'todo', action: 'list', status: 'open', text: null }],
    ['todo list done', { family: 'todo', action: 'list', status: 'done', text: null }],
    ['todo list all', { family: 'todo', action: 'list', status: 'all', text: null }],
    ['todo list deploy', { family: 'todo', action: 'list', status: null, text: 'deploy' }],
    ['todo list all deploy api', { family: 'todo', action: 'list', status: 'all', text: 'deploy api' }],
    ['todo list deploy open', { family: 'todo', action: 'list', status: null, text: 'deploy open' }],
    ['todo list ALL', { family: 'todo', action: 'list', status: null, text: 'ALL' }],
  ])('%j → %j', (input, expected) => {
    expect(parseMlArgs(input)).toEqual(expected)
  })

  it.each([
    ['', '用法'],
    ['   ', '用法'],
    ['note new', '未知子命令'],
    ['list', '未知子命令'],
    ['todo create something', '未知操作'],
  ])('输入 %j 抛用法错误（%s）', (input, messagePart) => {
    expect(() => parseMlArgs(input)).toThrow(TodoUsageError)
    expect(() => parseMlArgs(input)).toThrow(new RegExp(messagePart))
  })

  it('用法文案包含完整文法', () => {
    expect(ML_USAGE).toBe('/ml todo list [all|open|done] [关键词]')
  })
})
