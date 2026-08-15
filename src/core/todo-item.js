/**
 * TodoItem 值对象：一条待办的不可变快照。
 *
 * 构造即校验、构造即冻结（Value Object 模式）。任何把畸形数据塞进管道的
 * 尝试都在这里崩溃，而不是在渲染层变成一行乱码。
 *
 * @module dsh-notes/core/todo-item
 */
import { invariant, TodoError } from './errors.js'

/**
 * @typedef {object} TodoItem
 * @property {string} file 工作区相对路径（'/' 分隔，无 './' 前缀）
 * @property {number} line 1 起始行号
 * @property {string} text 待办正文（已 trim，非空）
 * @property {boolean} done 是否已完成
 * @property {string} format 识别它的格式 Strategy id
 * @property {string | null} raw 原始行（诊断用），可空
 */

/**
 * 构造一个冻结的 TodoItem。
 *
 * @param {object} fields
 * @param {string} fields.file
 * @param {number} fields.line
 * @param {string} fields.text
 * @param {boolean} fields.done
 * @param {string} fields.format
 * @param {string} [fields.raw]
 * @returns {TodoItem}
 */
export function createTodoItem(fields) {
  invariant(fields !== null && typeof fields === 'object', 'todo item 必须是对象')
  const { file, line, text, done, format, raw } = fields
  invariant(typeof file === 'string' && file !== '', 'todo item.file 必须是非空字符串')
  invariant(Number.isInteger(line) && line >= 1, `todo item.line 必须是 >=1 的整数（收到 ${String(line)}）`)
  invariant(typeof text === 'string' && text.trim() !== '', `todo item.text 必须是非空字符串（文件 ${file}:${line}）`)
  invariant(typeof done === 'boolean', `todo item.done 必须是布尔值（文件 ${file}:${line}）`)
  invariant(typeof format === 'string' && format !== '', `todo item.format 必须是非空字符串（文件 ${file}:${line}）`)
  return Object.freeze({
    file,
    line,
    text: text.trim(),
    done,
    format,
    raw: typeof raw === 'string' ? raw : null,
  })
}

/** 把扫描器的“格式匹配”补充上文件坐标，产出最终值对象。 */
export function materializeTodoItem(match, file, line) {
  return createTodoItem({
    file,
    line,
    text: match.text,
    done: match.done,
    format: match.format,
    raw: match.raw,
  })
}
