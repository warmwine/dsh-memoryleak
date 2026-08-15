/**
 * NodeFileSource —— FileSource 端口在真实文件系统上的适配器（仅宿主半使用）。
 *
 * 遍历策略与 memory 适配器共享 core/walk-policy。故障分级：
 *   - 根不存在 / 不是目录：抛 TodoRootError（环境故障，用户可见）
 *   - 单目录/单文件故障：记入 errors 继续遍历（隔离，不放大）
 *   - 符号链接一律跳过（防环、防逃出工作区；文档化取舍）
 *   - 数量/深度双重上限防失控目录树
 *
 * @module dsh-notes/adapters/node-file-source
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { TodoRootError } from '../core/errors.js'
import { buildExtensionSet, normalizeRelativePath, shouldExcludeDir, shouldIncludeFile } from '../core/walk-policy.js'
import { assertListOptions } from '../core/file-source.js'

const MAX_DEPTH = 16
const MAX_ENTRIES_PER_DIR = 20000

/**
 * @param {object} [overrides] 测试可注入 fs 原语
 * @param {typeof readdir} [overrides.readdir]
 * @param {typeof readFile} [overrides.readFile]
 * @param {typeof stat} [overrides.stat]
 */
export function createNodeFileSource(overrides = {}) {
  const fsReaddir = overrides.readdir ?? readdir
  const fsReadFile = overrides.readFile ?? readFile
  const fsStat = overrides.stat ?? stat

  return Object.freeze({
    name: 'node-fs',

    async list(root, options, signal) {
      assertListOptions(options)
      if (typeof root !== 'string' || root === '') throw new TodoRootError('根目录为空')
      const rootInfo = await fsStat(root).catch(() => null)
      if (rootInfo === null || !rootInfo.isDirectory()) {
        throw new TodoRootError(`根目录不存在或不是目录：${root}`)
      }
      const extensionSet = buildExtensionSet(options.extensions)
      const excludeSet = new Set(options.excludeDirs)
      const files = []
      const errors = []
      let truncated = false
      const queue = [{ dir: root, depth: 0 }]
      while (queue.length > 0) {
        if (signal !== null && signal !== undefined && signal.aborted) break
        const { dir, depth } = queue.shift()
        let entries
        try {
          entries = await fsReaddir(dir, { withFileTypes: true })
        } catch (error) {
          errors.push(recordError(rel(root, dir), error))
          continue
        }
        if (entries.length > MAX_ENTRIES_PER_DIR) truncated = true
        for (const entry of entries.slice(0, MAX_ENTRIES_PER_DIR)) {
          if (entry.name === '.' || entry.name === '..') continue
          if (entry.isSymbolicLink()) continue
          const full = join(dir, entry.name)
          if (entry.isDirectory()) {
            if (shouldExcludeDir(entry.name, excludeSet)) continue
            if (depth + 1 > MAX_DEPTH) continue
            queue.push({ dir: full, depth: depth + 1 })
            continue
          }
          if (!entry.isFile()) continue
          if (!shouldIncludeFile(entry.name, extensionSet)) continue
          if (files.length >= options.maxFiles) {
            truncated = true
            break
          }
          let info
          try {
            info = await fsStat(full)
          } catch (error) {
            errors.push(recordError(rel(root, full), error))
            continue
          }
          files.push({ path: rel(root, full), bytes: info.size })
        }
        if (truncated && files.length >= options.maxFiles) break
      }
      files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      return { files, errors, truncated }
    },

    async read(root, path, signal) {
      const readOptions = signal !== null && signal !== undefined ? { signal } : undefined
      return fsReadFile(join(root, path), readOptions === undefined ? 'utf8' : { encoding: 'utf8', signal })
    },
  })
}

function rel(root, full) {
  let value = String(full).slice(String(root).length)
  return normalizeRelativePath(value)
}

function recordError(path, error) {
  return { path, message: error instanceof Error ? error.message : String(error) }
}
