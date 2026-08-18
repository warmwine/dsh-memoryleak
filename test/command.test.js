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
        '/ml init',
        '/ml <文本>',
        '/ml todo add <待办内容>',
        '/ml todo n',
        '/ml todo list [all|open|done|cancelled] [关键词]',
        '/ml todo l',
        '/ml todo d <序号>',
        '/ml todo u',
        '/ml todo c <序号>',
        '/ml todo p <序号> [天数]',
        '/ml note',
        '/ml view',
        '/ml v',
        '/ml help',
      ]) {
        expect(help).toContain(fragment)
      }
      // 帮助里不该出现未实现的命令
      expect(help).not.toMatch(/\/ml todo (?!add|list|n|l|d|u|c|p|done|undo|cancel|postpone)\w+/)
    })

    it('init：严格无参数（Vault 设置的唯一入口）', () => {
      expect(parseMlArgs('init')).toEqual({ family: 'init' })
      expect(parseMlArgs('  init  ')).toEqual({ family: 'init' })
      expect(() => parseMlArgs('init E:/x')).toThrow(TodoUsageError)
      expect(() => parseMlArgs('init x')).toThrow(/不带参数/)
      // 复数不保留：initiates 是记录文本
      expect(parseMlArgs('initiates something')).toEqual({ family: 'journal', text: 'initiates something' })
    })

    it('view / v：无参数看当前日志，带参数为模糊查询', () => {
      expect(parseMlArgs('view')).toEqual({ family: 'view', text: null })
      expect(parseMlArgs('v')).toEqual({ family: 'view', text: null })
      expect(parseMlArgs('  view  ')).toEqual({ family: 'view', text: null })
      expect(parseMlArgs('view 2026-08-01')).toEqual({ family: 'view', text: '2026-08-01' })
      expect(parseMlArgs('v feb no')).toEqual({ family: 'view', text: 'feb no' })
      expect(parseMlArgs('v docs/plan')).toEqual({ family: 'view', text: 'docs/plan' })
    })

    it('note：严格无参数（误带反馈文本时明确告知没有发出）', () => {
      expect(parseMlArgs('note')).toEqual({ family: 'note' })
      expect(parseMlArgs('  note  ')).toEqual({ family: 'note' })
      expect(() => parseMlArgs('note new')).toThrow(TodoUsageError)
      expect(() => parseMlArgs('note 会压缩这段话')).toThrow(/没有发给助手/)
      expect(() => parseMlArgs('note 的过程还是不会显示')).toThrow(/想对助手说话/)
      expect(parseMlArgs('notebook 记事本')).toEqual({ family: 'journal', text: 'notebook 记事本' })
    })

    it('todo c / cancel：取消待办（序号寻址，同 d）', () => {
      expect(parseMlArgs('todo c 3')).toEqual({ family: 'todo', action: 'cancel', n: 3 })
      expect(parseMlArgs('todo cancel 12')).toEqual({ family: 'todo', action: 'cancel', n: 12 })
      expect(() => parseMlArgs('todo c')).toThrow(TodoUsageError)
      expect(() => parseMlArgs('todo c x')).toThrow(TodoUsageError)
      expect(() => parseMlArgs('todo c 0')).toThrow(TodoUsageError)
    })

    it('todo p / postpone：延期 deadline（序号 + 可选天数，缺省 1）', () => {
      expect(parseMlArgs('todo p 5')).toEqual({ family: 'todo', action: 'postpone', n: 5, days: 1 })
      expect(parseMlArgs('todo p 5 3')).toEqual({ family: 'todo', action: 'postpone', n: 5, days: 3 })
      expect(parseMlArgs('todo postpone 2 30')).toEqual({ family: 'todo', action: 'postpone', n: 2, days: 30 })
      expect(() => parseMlArgs('todo p')).toThrow(TodoUsageError)
      expect(() => parseMlArgs('todo p x')).toThrow(TodoUsageError)
      expect(() => parseMlArgs('todo p 5 x')).toThrow(/延期天数/)
      expect(() => parseMlArgs('todo p 5 0')).toThrow(/延期天数/)
      expect(() => parseMlArgs('todo p 5 -1')).toThrow(TodoUsageError) // 负号不是数字 token → 序号/天数解析失败
      expect(() => parseMlArgs('todo p 5 3 9')).toThrow(/一个可选天数/)
      expect(() => parseMlArgs('todo p 5 99999')).toThrow(/最多/)
    })
  })

  describe('journal 家族（/ml <文本>）', () => {
    it.each([
      ['修复登录页样式', '修复登录页样式'],
      ['  多余空格  压成单空格  ', '多余空格 压成单空格'],
      ['todos 是复数不算保留字', 'todos 是复数不算保留字'],
      ['list 现在是普通文本', 'list 现在是普通文本'],
      ['notes 是普通文本（复数不保留）', 'notes 是普通文本（复数不保留）'],
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
    for (const fragment of ['/ml <文本>', '/ml todo add', '/ml todo list', '/ml todo d', '/ml todo c', '/ml todo p', '/ml todo u', '/ml note', '/ml view', '/ml help']) {
      expect(ML_USAGE).toContain(fragment)
    }
  })
})
