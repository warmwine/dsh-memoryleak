import { describe, expect, it } from 'vitest'
import { parseMlArgs, renderMlHelp, ML_USAGE } from '../src/core/command.js'
import { TodoUsageError } from '../src/core/errors.js'

describe('parseMlArgs（/ml 文法）', () => {
  describe('todo 家族', () => {
    it.each([
      ['todo', { family: 'todo', action: 'list', status: null, text: null }],
      ['  todo  ', { family: 'todo', action: 'list', status: null, text: null }],
      ['todo list', { family: 'todo', action: 'list', status: null, text: null }],
      ['todo l', { family: 'todo', action: 'list', status: null, text: null }],
      ['todo l open', { family: 'todo', action: 'list', status: 'open', text: null }],
      ['todo l done', { family: 'todo', action: 'list', status: 'done', text: null }],
      ['todo l all', { family: 'todo', action: 'list', status: 'all', text: null }],
      ['todo l deploy', { family: 'todo', action: 'list', status: null, text: 'deploy' }],
      ['todo l all deploy api', { family: 'todo', action: 'list', status: 'all', text: 'deploy api' }],
      ['todo list deploy open', { family: 'todo', action: 'list', status: null, text: 'deploy open' }],
      ['todo l ALL', { family: 'todo', action: 'list', status: null, text: 'ALL' }],
    ])('%j → %j', (input, expected) => {
      expect(parseMlArgs(input)).toEqual(expected)
    })

    it('n / add 别名：新增待办', () => {
      expect(parseMlArgs('todo n 修 bug')).toEqual({ family: 'todo', action: 'add', text: '修 bug' })
      expect(parseMlArgs('todo add 修 bug')).toEqual({ family: 'todo', action: 'add', text: '修 bug' })
      expect(() => parseMlArgs('todo n')).toThrow(TodoUsageError)
      expect(() => parseMlArgs('todo n')).toThrow(/\/ml todo n/)
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

  describe('help 家族', () => {
    it('help / h 都解析', () => {
      expect(parseMlArgs('help')).toEqual({ family: 'help' })
      expect(parseMlArgs('h')).toEqual({ family: 'help' })
      expect(parseMlArgs('  help  ')).toEqual({ family: 'help' })
    })

    it('renderMlHelp 覆盖全部已注册命令（全称与简写都可搜到）', () => {
      const help = renderMlHelp()
      for (const fragment of [
        '/ml <文本>',
        '/ml todo add <待办内容>',
        '/ml todo n',
        '/ml todo list [all|open|done] [关键词]',
        '/ml todo l',
        '/ml todo d <序号>',
        '/ml todo u',
        '/ml view',
        '/ml v',
        '/ml help',
      ]) {
        expect(help).toContain(fragment)
      }
      // 帮助里不该出现未实现的命令
      expect(help).not.toMatch(/\/ml todo (?!add|list|n|l|d|u|done|undo)\w+/)
    })

    it('view / v：显示当前日志（无参数）', () => {
      expect(parseMlArgs('view')).toEqual({ family: 'view' })
      expect(parseMlArgs('v')).toEqual({ family: 'view' })
      expect(parseMlArgs('  view  ')).toEqual({ family: 'view' })
      expect(() => parseMlArgs('view 2026-08-01')).toThrow(TodoUsageError)
      expect(() => parseMlArgs('view 2026-08-01')).toThrow(/无参数/)
    })
  })

  describe('journal 家族（/ml <文本>）', () => {
    it.each([
      ['修复登录页样式', '修复登录页样式'],
      ['  多余空格  压成单空格  ', '多余空格 压成单空格'],
      ['todos 是复数不算保留字', 'todos 是复数不算保留字'],
      ['list 现在是普通文本', 'list 现在是普通文本'],
      ['note new', 'note new'],
      ['helps 是普通文本（复数不保留）', 'helps 是普通文本（复数不保留）'],
      ['views 是普通文本（复数不保留）', 'views 是普通文本（复数不保留）'],
    ])('%j → 记录 %j', (input, text) => {
      expect(parseMlArgs(input)).toEqual({ family: 'journal', text })
    })
  })

  it('空输入抛用法错误并导向 help', () => {
    expect(() => parseMlArgs('')).toThrow(TodoUsageError)
    expect(() => parseMlArgs('   ')).toThrow(TodoUsageError)
    expect(() => parseMlArgs('')).toThrow(/\/ml help/)
  })

  it('用法文案覆盖全部入口', () => {
    for (const fragment of ['/ml <文本>', '/ml todo add', '/ml todo list', '/ml todo d', '/ml todo u', '/ml view', '/ml help']) {
      expect(ML_USAGE).toContain(fragment)
    }
  })
})
