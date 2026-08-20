/**
 * 表格列宽对齐测试：core/table-align 纯函数（对齐 / 保留 / 跳过边界）+
 * 宿主写回路径集成（journal.js 的 d/c/p/u 与 note.js 落盘在写 .md 时对齐）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { displayWidth, padToWidth, realignMarkdownTables } from '../src/core/table-align.js'
import { toggleTodoAt } from '../src/journal.js'

describe('displayWidth / padToWidth（显示宽度）', () => {
  it('ASCII 计 1、东亚宽字符计 2、组合记号计 0', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('中文')).toBe(4)
    expect(displayWidth('a中')).toBe(3)
    expect(displayWidth('e\u0301')).toBe(1) // 组合记号
    expect(displayWidth('🚀')).toBe(1) // 代理对按 1 个码点迭代不炸
  })

  it('padToWidth 按显示宽度补空格', () => {
    expect(padToWidth('ab', 5)).toBe('ab   ')
    expect(padToWidth('中', 5)).toBe('中   ') // 显示宽 2 + 3 空格
    expect(padToWidth('abcdef', 3)).toBe('abcdef') // 超宽不截断
  })
})

describe('realignMarkdownTables（写时对齐：只补空白，内容逐字保留）', () => {
  const ragged = ['| 名称 | 主机 |', '| --- | --- |', '| bj-01 | 10.0.0.1 |', '| 杭州备份库 | 10.0.0.2 |'].join('\n')
  const aligned = [
    '| 名称       | 主机     |',
    '| ---------- | -------- |',
    '| bj-01      | 10.0.0.1 |',
    '| 杭州备份库 | 10.0.0.2 |',
  ].join('\n')

  it('参差表格 → 按每列最大显示宽度对齐，分隔线随列宽伸展', () => {
    expect(realignMarkdownTables(ragged)).toBe(aligned)
  })

  it('幂等：已对齐的表格字节不变', () => {
    expect(realignMarkdownTables(aligned)).toBe(aligned)
    expect(realignMarkdownTables(realignMarkdownTables(ragged))).toBe(aligned)
  })

  it('内容逐字保留：对齐前后每个单元格 trim 相等（分隔线除外）', () => {
    const cellsOf = (text) =>
      text
        .split('\n')
        .filter((line) => line.trim().startsWith('|'))
        .filter((line) => !/^[\s|:-]+$/.test(line))
        .flatMap((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()))
    expect(cellsOf(realignMarkdownTables(ragged))).toEqual(cellsOf(ragged))
  })

  it('对齐冒号保留并随列宽伸展（:-- / --: / :--:）', () => {
    const input = ['| a | bbb |', '| :-- | --: |', '| ccc | d |'].join('\n')
    expect(realignMarkdownTables(input)).toBe(
      ['| a   | bbb |', '| :--- | ---: |', '| ccc | d   |'].join('\n'),
    )
  })

  it('转义管道：\\| 是单元格内的字面管道，不破表、往返稳定', () => {
    const input = ['| 名称 | 备注 |', '| --- | --- |', '| a \\| b | c |'].join('\n')
    const once = realignMarkdownTables(input)
    expect(once).toBe(['| 名称  | 备注 |', '| ----- | ---- |', '| a \\| b | c    |'].join('\n'))
    expect(realignMarkdownTables(once)).toBe(once)
  })

  it('代码围栏内的表格样文本一律不动；围栏外的表格照常对齐', () => {
    const input = [
      '正文',
      '',
      '```text',
      '| a | b |',
      '| --- | --- |',
      '| xx | yy |',
      '```',
      '',
      '| 名称 | 主机 |',
      '| --- | --- |',
      '| s1 | h1 |',
      '',
    ].join('\n')
    const out = realignMarkdownTables(input)
    expect(out).toContain('| a | b |\n| --- | --- |\n| xx | yy |') // 围栏内原样
    expect(out).toContain('| 名称 | 主机 |\n| ---- | ---- |\n| s1   | h1   |') // 围栏外对齐
  })

  it('列数不齐（手改坏）的块整块不动，绝不猜测', () => {
    const input = ['| a | b |', '| --- | --- | --- |', '| 1 | 2 |'].join('\n')
    expect(realignMarkdownTables(input)).toBe(input)
  })

  it('缩进 ≥4（代码块）或各行缩进不一致 → 不动；统一短缩进保留并对齐', () => {
    const indented = ['    | a | b |', '    | --- | --- |', '    | cc | d |'].join('\n')
    expect(realignMarkdownTables(indented)).toBe(indented)
    const mixed = ['| a | b |', '  | --- | --- |', '| cc | d |'].join('\n')
    expect(realignMarkdownTables(mixed)).toBe(mixed)
    const uniform = ['  | a | b |', '  | --- | --- |', '  | cc | d |'].join('\n')
    expect(realignMarkdownTables(uniform)).toBe(
      ['  | a   | b   |', '  | --- | --- |', '  | cc  | d   |'].join('\n'),
    )
  })

  it('表格之外的一切文本与行结构不动；无表格时字节不变', () => {
    const input = ['# 标题', '', '- 待办', '', '段落 | 里有管道 | 但不是表格', ''].join('\n')
    expect(realignMarkdownTables(input)).toBe(input)
  })
})

describe('写回路径集成（d/c/p/u 与落盘写 .md 时全文件对齐）', () => {
  let dir = ''

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ml-table-align-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('toggleTodoAt 写回的 .md：待办行正常切换，文件内手写表格同时被对齐', async () => {
    const file = '2026-01-01.md'
    const content = [
      '## Todo',
      '- [ ] (ml:anytime low) 事项A',
      '',
      '| 名称 | 主机 |',
      '| --- | --- |',
      '| bj-01 | 10.0.0.1 |',
      '',
      '收尾文字。',
      '',
    ].join('\n')
    await writeFile(join(dir, file), content, 'utf8')
    const result = await toggleTodoAt(dir, file, 2, '2026-01-01', '- [ ] (ml:anytime low) 事项A')
    expect(result.done).toBe(true)
    const after = await readFile(join(dir, file), 'utf8')
    expect(after).toContain('- [x] (ml:anytime low done:2026-01-01) 事项A')
    expect(after).toContain('| 名称  | 主机     |\n| ----- | -------- |\n| bj-01 | 10.0.0.1 |')
    expect(after).toContain('收尾文字。')
  })

  it('非 .md 文件原样写回（不做对齐）', async () => {
    const file = 'notes.txt'
    const content = ['## Todo', '- [ ] (ml:anytime low) 事项B', '', '| a | b |', '| --- | --- |', '| x | y |', ''].join('\n')
    await writeFile(join(dir, file), content, 'utf8')
    await toggleTodoAt(dir, file, 2, '2026-01-01', '- [ ] (ml:anytime low) 事项B')
    const after = await readFile(join(dir, file), 'utf8')
    expect(after).toContain('| a | b |\n| --- | --- |\n| x | y |') // 未对齐
    expect(after).toContain('- [x] (ml:anytime low done:2026-01-01) 事项B')
  })
})
