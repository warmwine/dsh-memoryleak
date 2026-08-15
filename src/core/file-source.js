/**
 * FileSource —— 文件来源端口（依赖倒置）。
 *
 * 扫描器只依赖这个契约，不 import 任何 node: 模块：
 *   - 宿主绑定 NodeFileSource（真实 fs）
 *   - 测试/未来预览绑定 MemoryFileSource（内存树）
 * 两侧共享 core/walk-policy 的排除语义，行为一致。
 *
 * 契约（实现方必须满足，assertFileSource 在装配期校验）：
 *   list(root, options, signal?) ->
 *     { files: Array<{ path, bytes }>, errors: Array<{ path, message }>, truncated: boolean }
 *     path 为工作区相对路径（'/' 分隔）；根不可用时抛 TodoRootError；
 *     单目录/单文件的读取故障记入 errors 继续走（隔离故障，不上浮成全局崩溃）。
 *   read(root, path, signal?) -> string（utf-8；文件消失抛 Error）
 *
 * @module dsh-memoryleak/core/file-source
 */
import { invariant } from './errors.js'

/**
 * 装配期校验一个 FileSource 绑定。坏绑定在启动时崩溃（let-it-crash）。
 *
 * @param {object} source
 * @returns {object} 原样返回，便于内联使用
 */
export function assertFileSource(source) {
  invariant(source !== null && typeof source === 'object', 'FileSource 必须是对象')
  invariant(typeof source.name === 'string' && source.name !== '', 'FileSource 需要 name')
  invariant(typeof source.list === 'function', `FileSource "${String(source.name)}" 缺少 list()`)
  invariant(typeof source.read === 'function', `FileSource "${String(source.name)}" 缺少 read()`)
  return source
}

/** 校验 list() 的 options 形参（扫描器转发前保证）。 */
export function assertListOptions(options) {
  invariant(options !== null && typeof options === 'object', 'FileSource.list 需要 options')
  invariant(Array.isArray(options.extensions) && options.extensions.length > 0, 'options.extensions 必须是非空数组')
  invariant(Array.isArray(options.excludeDirs) && options.excludeDirs.length > 0, 'options.excludeDirs 必须是非空数组')
  invariant(Number.isInteger(options.maxFiles) && options.maxFiles >= 1, 'options.maxFiles 必须是正整数')
}
