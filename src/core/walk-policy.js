/**
 * 目录/文件的纯遍历策略：被 node 与 memory 两个 FileSource 适配器共享，
 * 保证“排除规则”在测试与生产环境语义一致（策略与适配器分离）。
 *
 * @module dsh-notes/core/walk-policy
 */

/** 规范化扩展名：小写、去掉前导点。空串原样返回（调用方用集合语义忽略它）。 */
export function normalizeExtension(extension) {
  const value = String(extension ?? '').trim().toLowerCase()
  if (value.startsWith('.')) return value.slice(1)
  return value
}

/** 建立扩展名集合（去空、去重）。 */
export function buildExtensionSet(extensions) {
  const set = new Set()
  for (const extension of extensions) {
    const normalized = normalizeExtension(extension)
    if (normalized !== '') set.add(normalized)
  }
  return set
}

/** 文件名是否命中扩展名集合。 */
export function shouldIncludeFile(name, extensionSet) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false // 无扩展名，或以 '.' 开头的点文件
  return extensionSet.has(name.slice(dot + 1).toLowerCase())
}

/** 目录名是否被排除（按精确名匹配，如 node_modules、.git）。 */
export function shouldExcludeDir(name, excludeSet) {
  return excludeSet.has(name)
}

/** 规范化工作区相对路径：'\' → '/'，去 './' 前缀，去首尾 '/'。 */
export function normalizeRelativePath(path) {
  let value = String(path ?? '').replace(/\\/g, '/')
  while (value.startsWith('./')) value = value.slice(2)
  while (value.startsWith('/')) value = value.slice(1)
  while (value.endsWith('/')) value = value.slice(0, -1)
  return value
}
