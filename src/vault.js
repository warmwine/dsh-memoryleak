/**
 * Vault：MemoryLeak 的工作目录（日志 / 待办 / 待办文件的存放位置）。
 *
 * 两层设置来源（优先级从低到高）：
 *   1. 全局层：~/.dsh/settings.yaml 的 memoryleak: 段（ctx.settings，DSH
 *      官方统一位置）。vault 路径本身只住这一层 —— vault 文件不该反过来
 *      决定自己在哪里。
 *   2. vault 层：<vault>/.memoryleak.yaml（YAML，与 DSH 设置文件同格式，
 *      方便手改）。用户选定 vault 时把当时的生效设置复制过去；之后该
 *      文件里的键覆盖全局层。文件缺失 / 键缺失 / 解析失败 → 逐键回退到
 *      全局层，再回退到 schema 默认值。
 *
 * 解析始终以 resolveMemoryleakSettings 收口（schema 校验 + 默认值填充），
 * 所以合并结果是深冻结的合法设置。vault 层读出来不是对象（比如手改成了
 * 一个列表）时按缺失处理 —— 回退而不是崩溃，与「不能覆盖就用通用设置」
 * 的语义一致。
 *
 * @module dsh-memoryleak/vault
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import YAML from 'yaml'
import { resolveMemoryleakSettings } from './settings-schema.js'

/** vault 内设置文件名（相对 vault 根）。 */
export const VAULT_SETTINGS_FILENAME = '.memoryleak.yaml'

/** vault 目录路径清理后允许的最大长度（与 schema 的 vault 约束一致）。 */
const MAX_VAULT_PATH = 1024

/** 清理用户输入的目录路径：去首尾空白与包裹引号（粘贴路径常见）。 */
export function normalizeVaultPath(input) {
  let text = typeof input === 'string' ? input.trim() : ''
  if (text.length >= 2) {
    const first = text.charAt(0)
    const last = text.charAt(text.length - 1)
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) text = text.slice(1, -1).trim()
  }
  return text
}

/**
 * 准备 vault 目录：不存在则创建（递归）；存在但不是目录则报错。
 * 返回绝对路径。
 *
 * @param {string} input 用户输入（未清理）
 * @returns {Promise<string>} 规范化后的绝对路径
 * @throws {Error} 路径为空 / 过长 / 存在但不是目录 / 无法创建
 */
export async function prepareVaultDir(input) {
  const cleaned = normalizeVaultPath(input)
  if (cleaned === '') throw new Error('目录路径为空')
  if (cleaned.length > MAX_VAULT_PATH) throw new Error('目录路径过长')
  const absolute = resolve(cleaned)
  let info
  try {
    info = await stat(absolute)
  } catch {
    try {
      await mkdir(absolute, { recursive: true })
    } catch (error) {
      throw new Error(`无法创建目录 ${absolute}：${errorMessage(error)}`)
    }
    return absolute
  }
  if (!info.isDirectory()) throw new Error(`${absolute} 不是目录（是个文件）`)
  return absolute
}

/**
 * 读 vault 内设置文件；缺失 / 解析失败 / 不是对象时返回 null（回退全局层）。
 * 只取 schema 认识的键，且忽略 vault 键本身（路径只住全局层）。
 *
 * @param {string} vaultDir vault 绝对路径
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function readVaultSettings(vaultDir) {
  let text
  try {
    text = await readFile(resolve(vaultDir, VAULT_SETTINGS_FILENAME), 'utf8')
  } catch {
    return null
  }
  let parsed
  try {
    parsed = YAML.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const section = {}
  for (const key of Object.keys(parsed)) {
    if (key === 'vault') continue
    if (parsed[key] !== null && parsed[key] !== undefined) section[key] = parsed[key]
  }
  return section
}

/**
 * 合并出最终生效设置：全局层（已解析）+ vault 层 → schema 收口。
 *
 * @param {object} globalSection resolveMemoryleakSettings 的产物（含 vault 键）
 * @param {Record<string, unknown> | null} vaultSection readVaultSettings 的产物
 * @returns {object} 深冻结的生效设置（vault 键保留全局层的值）
 */
export function mergeVaultSettings(globalSection, vaultSection) {
  const merged = vaultSection === null ? { ...globalSection } : { ...globalSection, ...vaultSection, vault: globalSection.vault }
  return resolveMemoryleakSettings(merged)
}

/**
 * 解析最终生效设置（全局层 → 读 vault 文件 → 合并）。
 *
 * @param {object} globalSection resolveMemoryleakSettings 的产物（vault 非空）
 * @returns {Promise<object>}
 */
export async function resolveEffectiveSettings(globalSection) {
  return mergeVaultSettings(globalSection, await readVaultSettings(globalSection.vault))
}

/**
 * 把设置段落写进 vault（YAML；剔除 vault 键）。已存在时不覆盖 —— 已有
 * 的 vault 文件优先级更高，初始化复制不能抹掉用户改过的内容。
 *
 * @param {string} vaultDir vault 绝对路径
 * @param {object} section 要复制的设置段（含 vault 键会被剔除）
 * @returns {Promise<boolean>} 是否实际写入（false = 已存在，保留原文件）
 */
export async function ensureVaultSettingsFile(vaultDir, section) {
  const target = resolve(vaultDir, VAULT_SETTINGS_FILENAME)
  const { vault: _vault, ...rest } = section
  let exists
  try {
    await stat(target)
    exists = true
  } catch {
    exists = false
  }
  if (exists) return false
  const body = '# MemoryLeak vault 设置（复制自全局设置；此文件的键覆盖 ~/.dsh/settings.yaml 的 memoryleak: 段）\n' + YAML.stringify(rest)
  await writeFile(target, body, 'utf8')
  return true
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
