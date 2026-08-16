import { describe, expect, it } from 'vitest'
import {
  dailyFileName,
  formatDate,
  insertNote,
  insertTodoLine,
  isoWeekOf,
  renderJournalTemplate,
  weekLabel,
  weeklyFileName,
} from '../src/core/journal.js'
import { TodoError } from '../src/core/errors.js'

const D = (s) => new Date(`${s}T12:00:00`)
/** 期望输出统一以单个换行结尾（文件级约定）。 */
const J = (lines) => `${lines.join('\n')}\n`

describe('日期与 ISO 周', () => {
  it('formatDate / dailyFileName', () => {
    expect(formatDate(D('2026-08-16'))).toBe('2026-08-16')
    expect(dailyFileName(D('2026-01-05'))).toBe('2026-01-05.md')
  })

  it.each([
    ['2026-08-16', 2026, 33, '2026-08-10', '2026-08-16'], // 周日收尾
    ['2026-08-10', 2026, 33, '2026-08-10', '2026-08-16'], // 周一开头
    ['2026-01-01', 2026, 1, '2025-12-29', '2026-01-04'], // 第 1 周：跨到上一年
    ['2027-01-01', 2026, 53, '2026-12-28', '2027-01-03'], // 2026 有 53 周
    ['2025-12-29', 2026, 1, '2025-12-29', '2026-01-04'], // 属于 2026 第 1 周
  ])('%s → %sW%02d（%s..%s）', (date, year, week, start, end) => {
    const info = isoWeekOf(D(date))
    expect(info).toEqual({ year, week, start, end })
    expect(weekLabel(D(date))).toBe(`${year}W${String(week).padStart(2, '0')}`)
    expect(weeklyFileName(D(date))).toBe(`${year}W${String(week).padStart(2, '0')}.md`)
  })

  it('renderJournalTemplate 替换占位符，未识别的原样保留', () => {
    expect(renderJournalTemplate('start: {start}\nend: {end}\n', { start: 'a', end: 'b' })).toBe('start: a\nend: b\n')
    expect(renderJournalTemplate('{date} {week} {other}', { date: 'd', week: 'w' })).toBe('d w {other}')
    expect(renderJournalTemplate('', { date: 'd' })).toBe('')
  })
})

describe('insertNote · 日志模式（daily）', () => {
  it('空内容 → 创建模块与首条记录', () => {
    expect(insertNote('', { mode: 'daily', date: '2026-08-16', text: '修 bug' })).toBe(
      J(['## MemoryLeak', '', '- 修 bug']),
    )
  })

  it('已有模块 → 追加到列表末尾（保留后续章节）', () => {
    const content = ['# 标题', '', '## MemoryLeak', '', '- a', '', '## 其他', '', 'x'].join('\n')
    expect(insertNote(content, { mode: 'daily', date: '2026-08-16', text: 'b' })).toBe(
      J(['# 标题', '', '## MemoryLeak', '', '- a', '- b', '', '## 其他', '', 'x']),
    )
  })

  it('模块不存在但有其他 ## 节 → 插到最前（标题之后）', () => {
    const content = ['# 日志', '', '## 工作', '', '内容'].join('\n')
    expect(insertNote(content, { mode: 'daily', date: '2026-08-16', text: 'n' })).toBe(
      J(['# 日志', '', '## MemoryLeak', '', '- n', '', '## 工作', '', '内容']),
    )
  })

  it('识别 ##MemoryLeak（无空格）写法', () => {
    const content = ['##MemoryLeak', '', '- a', ''].join('\n')
    expect(insertNote(content, { mode: 'daily', date: '2026-08-16', text: 'b' })).toBe(
      J(['##MemoryLeak', '', '- a', '- b']),
    )
  })

  it('模块内无列表项 → 空行隔开追加', () => {
    const content = ['## MemoryLeak', '', '一些散文', '', '## 下节'].join('\n')
    expect(insertNote(content, { mode: 'daily', date: '2026-08-16', text: 'n' })).toBe(
      J(['## MemoryLeak', '', '一些散文', '', '- n', '', '## 下节']),
    )
  })

  it('记录文本折叢单行（多行输入）', () => {
    expect(insertNote('', { mode: 'daily', date: '2026-08-16', text: 'a\nb' })).toContain('- a b')
  })
})

describe('insertNote · 周志模式（weekly）', () => {
  it('模板配置块保留，模块建在配置之后', () => {
    const content = 'start: 2026-08-10\nend: 2026-08-16\n'
    expect(insertNote(content, { mode: 'weekly', date: '2026-08-12', text: 'n1' })).toBe(
      J(['start: 2026-08-10', 'end: 2026-08-16', '', '## MemoryLeak', '', '- 2026-08-12', '  - n1']),
    )
  })

  it('已有日期组 → 追加子项到最后一个子项后', () => {
    const content = ['## MemoryLeak', '', '- 2026-08-11', '  - a', '  - b', '- 2026-08-12', '  - c', ''].join('\n')
    expect(insertNote(content, { mode: 'weekly', date: '2026-08-12', text: 'd' })).toBe(
      J(['## MemoryLeak', '', '- 2026-08-11', '  - a', '  - b', '- 2026-08-12', '  - c', '  - d']),
    )
  })

  it('日期组无子项 → 紧跟其后插入', () => {
    const content = ['## MemoryLeak', '', '- 2026-08-12', ''].join('\n')
    expect(insertNote(content, { mode: 'weekly', date: '2026-08-12', text: 'x' })).toBe(
      J(['## MemoryLeak', '', '- 2026-08-12', '  - x']),
    )
  })

  it('新日期 → 追加到既有日期组之后（不打乱嵌套）', () => {
    const content = ['## MemoryLeak', '', '- 2026-08-11', '  - a', ''].join('\n')
    expect(insertNote(content, { mode: 'weekly', date: '2026-08-13', text: 'b' })).toBe(
      J(['## MemoryLeak', '', '- 2026-08-11', '  - a', '- 2026-08-13', '  - b']),
    )
  })

  it('配置块 + 一级标题同时存在 → 模块插在标题之后', () => {
    const content = ['start: 2026-08-10', 'end: 2026-08-16', '', '# 周志', '', '## 其他', ''].join('\n')
    expect(insertNote(content, { mode: 'weekly', date: '2026-08-12', text: 'n' })).toBe(
      J(['start: 2026-08-10', 'end: 2026-08-16', '', '# 周志', '', '## MemoryLeak', '', '- 2026-08-12', '  - n', '', '## 其他']),
    )
  })
})

describe('insertNote · 参数校验', () => {
  it.each([
    [{ mode: 'yearly', date: '2026-08-16', text: 'x' }, /mode/],
    [{ mode: 'daily', date: '2026/08/16', text: 'x' }, /日期/],
    [{ mode: 'daily', date: '2026-08-16', text: '   ' }, /不能为空/],
    [{ mode: 'daily', date: '2026-08-16', text: 42 }, /字符串/],
  ])('非法参数 %# 抛 TodoError', (input, pattern) => {
    expect(() => insertNote('', input)).toThrow(pattern)
  })

  it('非字符串文本抛 TodoError', () => {
    expect(() => insertNote('', { mode: 'daily', date: '2026-08-16', text: null })).toThrow(TodoError)
  })
})

describe('insertTodoLine · ## Todo 模块', () => {
  const T1 = '- [ ] (ml:deadline 2026-09-01 urgent) 完成设计稿'
  const T2 = '- [ ] (ml:sleep 2026-12-01 low) 学源码'

  it('空文件 → 先建 MemoryLeak 再建 Todo（Todo 在后）', () => {
    expect(insertTodoLine('', T1)).toBe(
      J(['## MemoryLeak', '', '## Todo', '', T1]),
    )
  })

  it('已有 MemoryLeak 模块（有内容）→ Todo 建在模块之后', () => {
    const content = J(['## MemoryLeak', '', '- 已有记录'])
    expect(insertTodoLine(content, T1)).toBe(
      J(['## MemoryLeak', '', '- 已有记录', '', '## Todo', '', T1]),
    )
  })

  it('已有 Todo 模块 → 追加到列表末尾', () => {
    const content = J(['## MemoryLeak', '', '- a', '', '## Todo', '', T1, '', '## 其他'])
    expect(insertTodoLine(content, T2)).toBe(
      J(['## MemoryLeak', '', '- a', '', '## Todo', '', T1, T2, '', '## 其他']),
    )
  })

  it('识别 ##TODO 大小写变体', () => {
    const content = J(['##TODO', '', T1])
    expect(insertTodoLine(content, T2)).toBe(
      J(['##TODO', '', T1, T2]),
    )
  })

  it('Todo 模块内无列表项 → 空行隔开追加', () => {
    const content = J(['## MemoryLeak', '', '## Todo', '', '散文一行', '', '## 下一节'])
    expect(insertTodoLine(content, T1)).toBe(
      J(['## MemoryLeak', '', '## Todo', '', '散文一行', '', T1, '', '## 下一节']),
    )
  })

  it('周志模板（配置块）→ 两个模块建在配置之后', () => {
    const content = 'start: 2026-08-10\nend: 2026-08-16\n'
    expect(insertTodoLine(content, T1)).toBe(
      J(['start: 2026-08-10', 'end: 2026-08-16', '', '## MemoryLeak', '', '## Todo', '', T1]),
    )
  })

  it('非法参数抛错', () => {
    expect(() => insertTodoLine('', '  ')).toThrow(/非空/)
    expect(() => insertTodoLine(null, T1)).toThrow(/string/)
  })
})
