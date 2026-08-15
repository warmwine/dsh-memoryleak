/**
 * `memoryleak` 设置命名空间：schema、默认值与解析器。
 *
 * 通过宿主 ctx.settings.register 注册，持久化在 ~/.dsh/settings.yaml 的
 * memoryleak: 段（与 pet:、ui-theme: 同一层）。schema 用 schemastery（与
 * dsh-settings 服务同一实现）。非法的用户段落会让注册本身失败 —— 启动期
 * 崩溃（let-it-crash），而不是带病运行。
 *
 * @module dsh-memoryleak/settings-schema
 */
import z from 'schemastery'

/** 设置命名空间（settings.yaml 的段名）。 */
export const MEMORYLEAK_SETTINGS_NAMESPACE = 'memoryleak'

/** 解析后的默认值（同时作为注册的 base 层）。 */
export const MEMORYLEAK_SETTINGS_DEFAULTS = Object.freeze({
  extensions: ['md', 'markdown'],
  excludeDirs: [
    'node_modules',
    '.git',
    '.dsh',
    '.hg',
    '.svn',
    'dist',
    'build',
    'out',
    'target',
    'vendor',
    '.next',
    '.cache',
    'coverage',
  ],
  maxFiles: 2000,
  maxFileBytes: 512 * 1024,
  maxItems: 1000,
  defaultStatus: 'open',
})

const EXTENSION_PATTERN = /^[a-z0-9]+$/i
const DIR_NAME_PATTERN = /^[^\\/:*?"<>|\s]+$/

/** 设置 schema（供 ctx.settings.register 使用）。 */
export const memoryleakSettingsSchema = z.object({
  extensions: z.array(z.string().pattern(EXTENSION_PATTERN)).min(1).max(16).default(MEMORYLEAK_SETTINGS_DEFAULTS.extensions),
  excludeDirs: z.array(z.string().pattern(DIR_NAME_PATTERN).max(64)).min(1).max(256).default(MEMORYLEAK_SETTINGS_DEFAULTS.excludeDirs),
  maxFiles: z.number().step(1).min(1).max(50000).default(MEMORYLEAK_SETTINGS_DEFAULTS.maxFiles),
  maxFileBytes: z.number().step(1).min(1024).max(10 * 1024 * 1024).default(MEMORYLEAK_SETTINGS_DEFAULTS.maxFileBytes),
  maxItems: z.number().step(1).min(1).max(10000).default(MEMORYLEAK_SETTINGS_DEFAULTS.maxItems),
  defaultStatus: z.string().pattern(/^(all|open|done)$/).default(MEMORYLEAK_SETTINGS_DEFAULTS.defaultStatus),
})

/**
 * 把任意输入（存储段 / API 载荷 / 空值）解析为深冻结的合法设置。
 * 校验失败抛 schemastery 的错误（调用方转成用户可见信息）。
 *
 * @param {unknown} raw
 * @returns {typeof MEMORYLEAK_SETTINGS_DEFAULTS}
 */
export function resolveMemoryleakSettings(raw) {
  const resolved = memoryleakSettingsSchema(raw === undefined || raw === null ? {} : raw)
  return deepFreeze({ ...resolved })
}

/** 标量与字符串数组的递归冻结（本 schema 只含这两类数据）。 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}
