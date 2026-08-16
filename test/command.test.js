import { describe, expect, it } from 'vitest'
import { parseMlArgs, ML_USAGE } from '../src/core/command.js'
import { TodoUsageError } from '../src/core/errors.js'

describe('parseMlArgs（/ml 文法）', () => {
  describe('todo 家族', () => {
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

    it('未知操作抛用法错误', () => {
      expect(() => parseMlArgs('todo create something')).toThrow(TodoUsageError)
      expect(() => parseMlArgs('todo create something')).toThrow(/未知操作/)
    })

    it('u / undo：撤销最近一次 d', () => {
      expect(parseMlArgs('todo u')).toEqual({ family: 'todo', action: 'undo' })
      expect(parseMlArgs('todo undo')).toEqual({ family: 'todo', action: 'undo' })
      expect(() => parseMlArgs('todo u 1')).toThrow(TodoUsageError)
      expect(() => parseMlArgs('todo u 1')).toThrow(/不带参数/)
    })
  })

  describe('journal 家族（/ml <文本>）', () => {
    it.each([
      ['修复登录页样式', '修复登录页样式'],
      ['  多余空格  压成单空格  ', '多余空格 压成单空格'],
      ['todos 是复数不算保留字', 'todos 是复数不算保留字'],
      ['list 现在是普通文本', 'list 现在是普通文本'],
      ['note new', 'note new'],
    ])('%j → 记录 %j', (input, text) => {
      expect(parseMlArgs(input)).toEqual({ family: 'journal', text })
    })
  })

  it('空输入抛用法错误', () => {
    expect(() => parseMlArgs('')).toThrow(TodoUsageError)
    expect(() => parseMlArgs('   ')).toThrow(TodoUsageError)
    expect(() => parseMlArgs('')).toThrow(/用法/)
  })

  it('用法文案包含两种家族', () => {
    expect(ML_USAGE).toContain('/ml <文本>')
    expect(ML_USAGE).toContain('/ml todo list')
  })
})
