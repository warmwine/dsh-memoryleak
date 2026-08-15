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

  it('按文件分组、行号右对齐、状态标记正确', async () => {
    const report = await scanner.scan('/ws', { extensions: ['md'], excludeDirs: ['node_modules'] })
    const text = renderTodoText(report, createTodoQuery({ status: 'open' }))
    expect(text).toContain('README.md')
    expect(text).toContain('docs/plan.md')
    expect(text).toContain('[ ] alpha')
    expect(text).toContain('[ ] gamma deploy')
    expect(text).not.toContain('[x]')
  })

  it('空结果显示占位文案', async () => {
    const report = await scanner.scan('/ws', { extensions: ['md'], excludeDirs: ['node_modules'] })
    const text = renderTodoText(report, createTodoQuery({ status: 'done', text: 'alpha' }))
    expect(text).toContain('没有匹配的待办')
  })

  it('截断与跳过信息出现在尾部', async () => {
    const report = {
      root: '/ws',
      items: [],
      files: { considered: 1, scanned: 1, matched: 0 },
      errors: [{ file: 'bad.md', message: 'boom' }],
      skipped: [{ file: 'big.md', reason: '超过单文件上限 1 字节' }],
      truncated: true,
      formats: ['markdown-checkbox'],
    }
    const text = renderTodoText(report, createTodoQuery())
    expect(text).toContain('已截断')
    expect(text).toContain('跳过 1 个超大文件')
    expect(text).toContain('bad.md: boom')
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
    expect(round.formats).toEqual(['markdown-checkbox'])
  })
})

describe('summarizeTodoReport', () => {
  it('状态词反映在摘要里', async () => {
    const report = await scanner.scan('/ws', { extensions: ['md'], excludeDirs: ['node_modules'] })
    expect(summarizeTodoReport(report, createTodoQuery({ status: 'done' }))).toBe('待办 2 条（已完成） · 2 个文件')
  })
})
