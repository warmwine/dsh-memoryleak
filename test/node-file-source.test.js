import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeFileSource } from '../src/adapters/node-file-source.js'
import { assertFileSource, assertListOptions } from '../src/core/file-source.js'
import { TodoRootError } from '../src/core/errors.js'

let root

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-notes-test-'))
  await writeFile(join(root, 'README.md'), '- [ ] alpha\n- [x] beta\n')
  await writeFile(join(root, 'notes.markdown'), '- [ ] gamma\n')
  await writeFile(join(root, 'plain.txt'), '- [ ] ignored\n')
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs', 'deep.md'), '- [ ] delta\n')
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'pkg', 'hidden.md'), '- [ ] hidden\n')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const OPTIONS = { extensions: ['md', 'markdown'], excludeDirs: ['node_modules'], maxFiles: 100 }
const source = createNodeFileSource()

describe('NodeFileSource（真实 fs 适配器）', () => {
  it('契约校验通过', () => {
    expect(assertFileSource(source)).toBe(source)
    expect(() => assertListOptions(OPTIONS)).not.toThrow()
  })

  it('列出匹配扩展名的文件、跳过排除目录、路径用 / 分隔且排序', async () => {
    const listing = await source.list(root, OPTIONS)
    expect(listing.files.map((file) => file.path)).toEqual(['README.md', 'docs/deep.md', 'notes.markdown'])
    expect(listing.files.every((file) => Number.isInteger(file.bytes) && file.bytes > 0)).toBe(true)
    expect(listing.errors).toEqual([])
    expect(listing.truncated).toBe(false)
  })

  it('读取文件内容', async () => {
    const text = await source.read(root, 'README.md')
    expect(text).toContain('- [ ] alpha')
  })

  it('maxFiles 截断', async () => {
    const listing = await source.list(root, { ...OPTIONS, maxFiles: 2 })
    expect(listing.files).toHaveLength(2)
    expect(listing.truncated).toBe(true)
  })

  it('根目录不存在抛 TodoRootError', async () => {
    const missing = join(root, 'definitely-missing')
    await expect(source.list(missing, OPTIONS)).rejects.toThrow(TodoRootError)
    await expect(source.list('', OPTIONS)).rejects.toThrow(TodoRootError)
  })

  it('options 非法立即崩溃（装配期校验）', async () => {
    await expect(source.list(root, { extensions: [], excludeDirs: [], maxFiles: 1 })).rejects.toThrow(/extensions/)
    await expect(source.list(root, { ...OPTIONS, maxFiles: 0 })).rejects.toThrow(/maxFiles/)
  })
})
