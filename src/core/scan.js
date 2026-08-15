/**
 * 扫描引擎：把文件树变成 ScanReport。
 *
 * 纯函数 extractTodos 可独立测试；createTodoScanner 组合 Registry +
 * FileSource（依赖倒置），产出冻结的报告。故障分级见 docs/DEVELOPMENT.md §2：
 * 根不可用 → 抛 TodoRootError；单文件故障 → 记入 report.errors/skipped；
 * 中止 → 抛 TodoScanAbortedError；内部不可能状态 → invariant 崩溃。
 *
 * @module dsh-notes/core/scan
 */
import { invariant, TodoScanAbortedError } from './errors.js'
import { materializeTodoItem } from './todo-item.js'
import { assertFileSource } from './file-source.js'

/** CommonMark 围栏：0-3 空格缩进 + 3 个以上 ` 或 ~。 */
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/

/**
 * 计算一行是否开启/关闭围栏。返回 null 表示与围栏状态无关。
 * 关闭条件（CommonMark）：同字符、长度不小于开启、后随仅空白。
 */
function fenceTransition(line, current) {
  const match = FENCE_PATTERN.exec(line)
  if (match === null) return null
  const marker = match[1]
  const char = marker[0]
  const length = marker.length
  const info = match[2].trim()
  if (current !== null) {
    if (char === current.char && length >= current.length && info === '') return { close: current }
    return null
  }
  return { open: { char, length } }
}

/**
 * 从一段文本提取待办（纯函数；跳过围栏代码块内的行）。
 *
 * @param {string} text
 * @param {string} file 相对路径（进 TodoItem）
 * @param {import('./registry.js').TodoFormatRegistry} registry
 * @param {{ onStartItem?: (item: import('./todo-item.js').TodoItem) => void }} [hooks] 每命中一项即回调（供调用方实现截断）
 * @returns {import('./todo-item.js').TodoItem[]}
 */
export function extractTodos(text, file, registry, hooks = {}) {
  invariant(typeof text === 'string', 'extractTodos 需要 string 文本')
  invariant(typeof file === 'string' && file !== '', 'extractTodos 需要非空 file')
  invariant(registry !== null && typeof registry.parseLine === 'function', 'extractTodos 需要注册表')
  invariant(hooks === null || typeof hooks === 'object', 'extractTodos hooks 必须是对象')
  const items = []
  let fence = null
  const lines = text.split(/\r\n|\r|\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const transition = fenceTransition(line, fence)
    if (transition !== null) {
      if (transition.open !== undefined) fence = transition.open
      else fence = null
      continue
    }
    if (fence !== null) continue
    const match = registry.parseLine(line)
    if (match === null) continue
    const item = materializeTodoItem(match, file, index + 1)
    items.push(item)
    if (hooks.onStartItem !== undefined) hooks.onStartItem(item)
  }
  return items
}

/** 校验并冻结扫描限额（超限值在装配期崩溃）。 */
export function createScanLimits(input = {}) {
  const { maxFiles = 2000, maxFileBytes = 512 * 1024, maxItems = 1000 } = input
  invariant(
    Number.isInteger(maxFiles) && maxFiles >= 1 && maxFiles <= 50000,
    `maxFiles 必须是 1..50000 的整数（收到 ${String(maxFiles)}）`,
  )
  invariant(
    Number.isInteger(maxFileBytes) && maxFileBytes >= 1024 && maxFileBytes <= 10 * 1024 * 1024,
    `maxFileBytes 必须是 1KB..10MB 的整数（收到 ${String(maxFileBytes)}）`,
  )
  invariant(
    Number.isInteger(maxItems) && maxItems >= 1 && maxItems <= 10000,
    `maxItems 必须是 1..10000 的整数（收到 ${String(maxItems)}）`,
  )
  return Object.freeze({ maxFiles, maxFileBytes, maxItems })
}

/**
 * 装配扫描器（组合根之一）。
 *
 * @param {object} deps
 * @param {import('./registry.js').TodoFormatRegistry} deps.registry
 * @param {object} deps.fileSource FileSource 绑定（见 core/file-source.js）
 * @param {ReturnType<typeof createScanLimits>} [deps.limits]
 */
export function createTodoScanner({ registry, fileSource, limits = createScanLimits() }) {
  invariant(registry !== null && typeof registry.parseLine === 'function', 'scanner 需要 registry')
  assertFileSource(fileSource)
  createScanLimits(limits) // 复用校验（limits 已冻结则原样通过）

  /**
   * 扫描一个根目录。
   *
   * @param {string} root 绝对路径
   * @param {{ extensions: string[], excludeDirs: string[] }} options
   * @param {AbortSignal | null} [signal]
   */
  async function scan(root, options, signal = null) {
    invariant(typeof root === 'string' && root !== '', 'scan 需要 root 路径')
    checkAborted(signal)
    const listing = await fileSource.list(root, { ...options, maxFiles: limits.maxFiles }, signal)
    const errors = listing.errors.map((error) => Object.freeze({ ...error }))
    const skipped = []
    const items = []
    let scanned = 0
    let matched = 0
    let truncated = listing.truncated === true
    for (const entry of listing.files) {
      checkAborted(signal)
      if (entry.bytes > limits.maxFileBytes) {
        skipped.push(Object.freeze({ file: entry.path, reason: `超过单文件上限 ${limits.maxFileBytes} 字节` }))
        continue
      }
      let text
      try {
        text = await fileSource.read(root, entry.path, signal)
      } catch (error) {
        if (signal !== null && signal.aborted) throw new TodoScanAbortedError('扫描已取消')
        errors.push(Object.freeze({ file: entry.path, message: error instanceof Error ? error.message : String(error) }))
        continue
      }
      scanned += 1
      const found = extractTodos(text, entry.path, registry)
      if (found.length === 0) continue
      matched += 1
      for (const item of found) {
        items.push(item)
        if (items.length >= limits.maxItems) {
          truncated = true
          break
        }
      }
      if (truncated) break
    }
    return Object.freeze({
      root,
      items: Object.freeze(items),
      files: Object.freeze({ considered: listing.files.length, scanned, matched }),
      errors: Object.freeze(errors),
      skipped: Object.freeze(skipped.map((entry) => Object.freeze({ ...entry }))),
      truncated,
      formats: Object.freeze([...registry.ids]),
    })
  }

  return Object.freeze({ scan })
}

/** 观察到中止信号立即抛出（协作式取消的检查点）。 */
function checkAborted(signal) {
  if (signal !== null && signal.aborted) throw new TodoScanAbortedError('扫描已取消')
}
