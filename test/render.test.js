import { describe, expect, it } from 'vitest'
import { createDefaultRegistry } from '../src/core/registry.js'
import { createMemoryFileSource } from '../src/adapters/memory-file-source.js'
import { createTodoScanner, createScanLimits } from '../src/core/scan.js'
import { createTodoQuery } from '../src/core/filter.js'
import { renderTodoText, renderTodoJson, summarizeTodoReport } from '../src/core/render.js'

const scanner = createTodoScanner({
  registry: createDefaultRegistry(),
  fileSource: createMemoryFileSource({
    'README.md': '- [ ] alpha\n- [x] beta\n',
    'docs/plan.md': '- [ ] gamma deploy\n- [x] delta deploy\n',
  }),
  limits: createScanLimits(),
})

describe('renderTodoText（命令卡片文本）', () => {
  it('首行是单行摘要，含计数与文件数', async () => {
    const report = await scanner.scan('/ws', { extensions: ['md'], excludeDirs: ['node_modules'] })
    const text = renderTodoText(report, createTodoQuery({ status: 'all' }))
    const firstLine = text.split('\n')[0]
    expect(firstLine).toBe('待办 4 条（未完成 2 / 已完成 2） · 2 个文件')
    expect(firstLine).not.toMatch(/\n/)
  })

  it('TUI 排版：分组头 + 序号. 行号栏 + 选票符号', async () => {
    const report = await scanner.scan('/ws', { extensions: ['md'], excludeDirs: ['node_modules'] })
    const text = renderTodoText(report, createTodoQuery({ status: 'open' }))
    const lines = text.split('\n')
    expect(lines[1]).toBe('─'.repeat(44)) // 第二行是分隔线
    expect(lines).toContain('■ README.md · 1 条')
    expect(lines).toContain('■ docs/plan.md · 1 条')
    expect(lines).toContain('  1.    1 │ ☐ alpha')
    expect(lines).toContain('  2.    1 │ ☐ gamma deploy')
    expect(text).not.toContain('☑') // open 过滤下无已完成符号
  })

  it('已完成条目使用 ☑ 符号', async () => {
    const report = await scanner.scan('/ws', { extensions: ['md'], excludeDirs: ['node_modules'] })
    const text = renderTodoText(report, createTodoQuery({ status: 'done' }))
    expect(text).toContain('☑ beta')
    expect(text).not.toContain('☐')
  })

  it('空结果显示占位文案；过滤态附带提示', async () => {
    const report = await scanner.scan('/ws', { extensions: ['md'], excludeDirs: ['node_modules'] })
    const filtered = renderTodoText(report, createTodoQuery({ status: 'done', text: 'alpha' }))
    expect(filtered).toContain('没有匹配的待办')
    expect(filtered).toContain('/ml todo list all')
    const all = renderTodoText(report, createTodoQuery({ status: 'all', text: '不存在的词' }))
    expect(all).toContain('（没有匹配的待办）')
    expect(all).not.toContain('可试试')
  })

  it('截断与跳过信息出现在尾部警告块', async () => {
    const report = {
      root: '/ws',
      items: [],
      files: { considered: 1, scanned: 1, matched: 0 },
      errors: [{ file: 'bad.md', message: 'boom' }],
      skipped: [{ file: 'big.md', reason: '超过单文件上限 1 字节' }],
      truncated: true,
      formats: ['memoryleak-todo', 'markdown-checkbox'],
    }
    const text = renderTodoText(report, createTodoQuery())
    const lines = text.split('\n')
    const placeholder = lines.indexOf('（没有匹配的待办）')
    expect(placeholder).toBeGreaterThan(0)
    expect(lines[placeholder + 1]).toBe('─'.repeat(44)) // 警告块前有第二条分隔线
    expect(lines[placeholder + 2]).toMatch(/^⚠ 已截断/)
    expect(text).toContain('⚠ 跳过 1 个超大文件：big.md')
    expect(text).toContain('bad.md: boom')
  })

  it('wokenCount > 0 时显示唤醒块', () => {
    const report = {
      root: '/ws',
      items: [],
      files: { considered: 1, scanned: 1, matched: 0 },
      errors: [],
      skipped: [],
      truncated: false,
      formats: [],
      wokenCount: 2,
    }
    const text = renderTodoText(report, createTodoQuery())
    expect(text).toContain('☀ 已唤醒 2 条 sleep 待办')
  })
})

describe('renderTodoJson（AI 预留的结构化契约）', () => {
  it('输出 summary/query/groups，可被 JSON.stringify', async () => {
    const report = await scanner.scan('/ws', { extensions: ['md'], excludeDirs: ['node_modules'] })
    const query = createTodoQuery({ status: 'open', text: 'gamma' })
    const payload = renderTodoJson(report, query)
    const round = JSON.parse(JSON.stringify(payload))
    expect(round.summary).toEqual({ total: 1, open: 1, done: 0, files: 2, truncated: false })
    expect(round.query).toEqual({ action: 'list', status: 'open', text: 'gamma', limit: null })
    expect(round.groups).toEqual([
      { file: 'docs/plan.md', todos: [{ line: 1, text: 'gamma deploy', done: false, format: 'markdown-checkbox' }] },
    ])
    expect(round.formats).toEqual(['memoryleak-todo', 'markdown-checkbox'])
  })
})

describe('summarizeTodoReport', () => {
  it('状态词反映在摘要里', async () => {
    const report = await scanner.scan('/ws', { extensions: ['md'], excludeDirs: ['node_modules'] })
    expect(summarizeTodoReport(report, createTodoQuery({ status: 'done' }))).toBe('待办 2 条（已完成） · 2 个文件')
  })
})
