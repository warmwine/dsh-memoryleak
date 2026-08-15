/**
 * MemoryFileSource —— FileSource 端口的内存适配器。
 *
 * 测试与「未来预览」共用：一棵 { 相对路径: 内容 } 的扁平树就是整个世界。
 * 遍历语义（扩展名、排除目录、数量上限、排序）与 node 适配器一致 —— 同一
 * 套测试可以跑在两个绑定上，保证适配器不偷改语义。
 *
 * @module dsh-notes/adapters/memory-file-source
 */
import { TodoError } from '../core/errors.js'
import { buildExtensionSet, normalizeRelativePath, shouldExcludeDir, shouldIncludeFile } from '../core/walk-policy.js'
import { assertListOptions } from '../core/file-source.js'

const encoder = new TextEncoder()

/**
 * @param {Record<string, string | { content: string, bytes?: number }>} files
 */
export function createMemoryFileSource(files) {
  if (files === null || typeof files !== 'object' || Array.isArray(files)) {
    throw new TodoError('MemoryFileSource 需要一个 { 路径: 内容 } 对象')
  }
  const entries = new Map()
  for (const [rawPath, value] of Object.entries(files)) {
    const path = normalizeRelativePath(rawPath)
    const content = typeof value === 'string' ? value : value.content
    if (typeof content !== 'string') throw new TodoError(`内存文件 "${rawPath}" 的内容必须是字符串`)
    const bytes = typeof value === 'object' && typeof value.bytes === 'number' ? value.bytes : encoder.encode(content).length
    entries.set(path, { content, bytes })
  }

  return Object.freeze({
    name: 'memory',

    async list(root, options) {
      assertListOptions(options)
      if (typeof root !== 'string' || root === '') throw new TodoError('根目录为空')
      const extensionSet = buildExtensionSet(options.extensions)
      const excludeSet = new Set(options.excludeDirs)
      const out = []
      let truncated = false
      const sorted = [...entries.keys()].sort()
      for (const path of sorted) {
        if (path.split('/').some((segment) => shouldExcludeDir(segment, excludeSet))) continue
        const name = path.slice(path.lastIndexOf('/') + 1)
        if (!shouldIncludeFile(name, extensionSet)) continue
        if (out.length >= options.maxFiles) {
          truncated = true
          break
        }
        out.push({ path, bytes: entries.get(path).bytes })
      }
      return { files: out, errors: [], truncated }
    },

    async read(root, path) {
      const entry = entries.get(normalizeRelativePath(path))
      if (entry === undefined) throw new TodoError(`内存文件不存在：${path}`)
      return entry.content
    },
  })
}
