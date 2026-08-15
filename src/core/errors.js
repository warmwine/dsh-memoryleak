/**
 * Typed errors and the fail-fast invariant helper for the notes core.
 *
 * let-it-crash 分界线（见 docs/DEVELOPMENT.md §2）：
 * - 程序员错误 / 不可能状态：通过 {@link invariant} 在最早的边界抛出，
 *   启动期崩溃优于深夜静默错误（TodoFormatContractError 等）。
 * - 人类用法错误（TodoUsageError）：不崩溃，携带可渲染的文案上抛。
 * - 环境故障（TodoRootError 等）：结构化上抛，由命令层转成用户可见结果，
 *   绝不静默吞掉。
 *
 * @module dsh-notes/core/errors
 */

/** Base class for every error this package raises (name-stable, cause-safe). */
export class TodoError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = new.target.name
  }
}

/** 注册期契约违约（重复 id、畸形 Strategy…）：必须在启动时崩溃。 */
export class TodoFormatContractError extends TodoError {}

/** 用法错误：属于人类的输入问题，渲染为错误结果而非崩溃。 */
export class TodoUsageError extends TodoError {}

/** 扫描根目录不可用（不存在 / 不是目录）：环境故障，向用户明示。 */
export class TodoRootError extends TodoError {}

/** 协作式取消：扫描在文件之间观察到中止信号。 */
export class TodoScanAbortedError extends TodoError {}

/**
 * Fail-fast invariant。条件不为 `true` 立即抛出 —— 用于所有“绝不该发生”的
 * 内部状态；不要用它校验用户输入。
 *
 * @param {boolean} condition
 * @param {string} message 断言失败时拼进错误的信息
 * @param {new (message: string, options?: { cause?: unknown }) => Error} [ErrorClass]
 * @returns {void}
 */
export function invariant(condition, message, ErrorClass = TodoError) {
  if (condition !== true) {
    throw new ErrorClass(`[dsh-notes] invariant violated: ${message}`)
  }
}
