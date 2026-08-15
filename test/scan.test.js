import { describe, expect, it } from 'vitest'
import { createDefaultRegistry } from '../src/core/registry.js'
import { extractTodos, createTodoScanner, createScanLimits } from '../src/core/scan.js'
import { createMemoryFileSource } from '../src/adapters/memory-file-source.js'
import { TodoRootError, TodoScanAbortedError } from '../src/core/errors.js'

const registry = createDefaultRegistry()

describe('extractTodos（纯函数）', () => {
  it('提取全部状态的任务行，行号 1 起始', () => {
    const text = '# 标题\n- [ ] a\n- [x] b\n正文\n'
    const items = extractTodos(text, 'a.md', registry)
    expect(items.map((item) => [item.line, item.text, item.done])).toEqual([
      [2, 'a', false],
      [3, 'b', true],
    ])
  })

  it('围栏代码块内的任务行不计数（``` 与 ~~~，含信息串）', () => {
    const text = ['- [ ] a', '```js', '- [ ] hidden1', '```', '- [ ] b', '~~~', '- [ ] hidden2', '~~~', '- [ ] c'].join('\n')
    const items = extractTodos(text, 'a.md', registry)
    expect(items.map((item) => item.text)).toEqual(['a', 'b', 'c'])
  })

  it('更长的关闭围栏也能闭合', () => {
    const text = ['~~~', '- [ ] hidden', '~~~~~', '- [ ] visible'].join('\n')
    expect(extractTodos(text, 'a.md', registry).map((i) => i.text)).toEqual(['visible'])
  })

  it('CRLF 与 CR 换行都可解析', () => {
    const items = extractTodos('- [ ] a\r\n- [x] b\r- [ ] c', 'a.md', registry)
    expect(items.map((i) => i.text)).toEqual(['a', 'b', 'c'])
    expect(items.map((i) => i.line)).toEqual([1, 2, 3])
  })

  it('onStartItem 钩子逐项回调（供截断）', () => {
    const seen = []
    extractTodos('- [ ] a\n- [ ] b', 'a.md', registry, { onStartItem: (item) => seen.push(item.text) })
    expect(seen).toEqual(['a', 'b'])
  })
})

describe('createTodoScanner + MemoryFileSource（端口与适配器）', () => {
  const tree = {
    'README.md': '# r\n- [ ] alpha\n- [x] beta\n',
    'docs/plan.md': '# plan\n  - [ ] gamma\n',
    'docs/notes.markdown': '- [ ] delta\n',
    'src/index.txt': '- [ ] not-markdown\n',
    'node_modules/pkg/a.md': '- [ ] hidden\n',
    '.git/COMMIT_EDITMSG.md': '- [ ] hidden2\n',
  }
  const options = { extensions: ['md', 'markdown'], excludeDirs: ['node_modules', '.git'] }

  it('跨文件提取、遵守扩展名与排除目录、报告冻结', async () => {
    const scanner = createTodoScanner({
      registry,
      fileSource: createMemoryFileSource(tree),
      limits: createScanLimits(),
    })
    const report = await scanner.scan('/ws', options)
    expect(report.items.map((item) => item.file)).toEqual(['README.md', 'README.md', 'docs/notes.markdown', 'docs/plan.md'])
    expect(report.files).toEqual({ considered: 3, scanned: 3, matched: 3 })
    expect(report.truncated).toBe(false)
    expect(report.formats).toEqual(['markdown-checkbox'])
    expect(Object.isFrozen(report)).toBe(true)
  })

  it('maxItems 截断', async () => {
    const scanner = createTodoScanner({ registry, fileSource: createMemoryFileSource(tree), limits: createScanLimits({ maxItems: 2 }) })
    const report = await scanner.scan('/ws', options)
    expect(report.items).toHaveLength(2)
    expect(report.truncated).toBe(true)
  })

  it('超大文件进 skipped，不算错误', async () => {
    const fat = createMemoryFileSource({ 'big.md': { content: '- [ ] a\n', bytes: 10 * 1024 * 1024 } })
    const scanner = createTodoScanner({ registry, fileSource: fat, limits: createScanLimits({ maxFileBytes: 1024 }) })
    const report = await scanner.scan('/ws', { extensions: ['md'], excludeDirs: ['node_modules'] })
    expect(report.items).toHaveLength(0)
    expect(report.skipped).toEqual([{ file: 'big.md', reason: expect.stringContaining('上限') }])
  })

  it('单文件读取失败进 errors，其余文件继续（故障隔离）', async () => {
    const failing = {
      name: 'stub',
      list: async () => ({ files: [{ path: 'bad.md', bytes: 10 }, { path: 'good.md', bytes: 10 }], errors: [], truncated: false }),
      read: async (_root, path) => {
        if (path === 'bad.md') throw new Error('boom')
        return '- [ ] ok\n'
      },
    }
    const scanner = createTodoScanner({ registry, fileSource: failing })
    const report = await scanner.scan('/ws', { extensions: ['md'], excludeDirs: ['node_modules'] })
    expect(report.items.map((i) => i.text)).toEqual(['ok'])
    expect(report.errors).toEqual([{ file: 'bad.md', message: 'boom' }])
  })

  it('list 报告的目录级错误合并进报告', async () => {
    const partial = {
      name: 'stub',
      list: async () => ({ files: [], errors: [{ path: 'locked', message: 'EACCES' }], truncated: false }),
      read: async () => '',
    }
    const scanner = createTodoScanner({ registry, fileSource: partial })
    const report = await scanner.scan('/ws', { extensions: ['md'], excludeDirs: ['node_modules'] })
    expect(report.errors).toEqual([{ path: 'locked', message: 'EACCES' }])
  })

  it('已中止的信号立即抛 TodoScanAbortedError', async () => {
    const scanner = createTodoScanner({ registry, fileSource: createMemoryFileSource(tree) })
    const controller = new AbortController()
    controller.abort()
    await expect(scanner.scan('/ws', options, controller.signal)).rejects.toThrow(TodoScanAbortedError)
  })

  it('遍历上限传导给适配器（maxFiles 截断）', async () => {
    const wide = {}
    for (let index = 0; index < 5; index += 1) wide[`f${index}.md`] = '- [ ] x\n'
    const scanner = createTodoScanner({ registry, fileSource: createMemoryFileSource(wide), limits: createScanLimits({ maxFiles: 3 }) })
    const report = await scanner.scan('/ws', { extensions: ['md'], excludeDirs: ['node_modules'] })
    expect(report.files.considered).toBe(3)
    expect(report.truncated).toBe(true)
  })
})

describe('createScanLimits 校验', () => {
  it.each([
    [{ maxFiles: 0 }, 'maxFiles'],
    [{ maxFileBytes: 1 }, 'maxFileBytes'],
    [{ maxItems: 99999 }, 'maxItems'],
  ])('越限值 %o 在装配期崩溃', (input, field) => {
    expect(() => createScanLimits(input)).toThrow(new RegExp(field))
  })

  it('空参数得到默认上限且冻结', () => {
    const limits = createScanLimits()
    expect(limits).toEqual({ maxFiles: 2000, maxFileBytes: 524288, maxItems: 1000 })
    expect(Object.isFrozen(limits)).toBe(true)
  })
})

describe('MemoryFileSource 契约', () => {
  it('根路径为空抛 TodoRootError', async () => {
    const source = createMemoryFileSource({ 'a.md': '- [ ] x' })
    await expect(source.list('', { extensions: ['md'], excludeDirs: ['node_modules'], maxFiles: 10 })).rejects.toThrow(/根目录/)
  })

  it('读取不存在的文件抛错（错误由扫描器归类）', async () => {
    const source = createMemoryFileSource({ 'a.md': '- [ ] x' })
    await expect(source.read('/ws', 'missing.md')).rejects.toThrow(/不存在/)
  })

  it('构造参数非法立即崩溃', () => {
    expect(() => createMemoryFileSource(null)).toThrow()
    expect(() => createMemoryFileSource({ 'a.md': 42 })).toThrow()
  })
})
