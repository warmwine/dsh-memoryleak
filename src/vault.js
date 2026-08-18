/**
 * Vault：MemoryLeak 的工作目录（日志 / 待办 / 待办文件的存放位置）。
 *
 * 两层设置来源（优先级从低到高）：
 *   1. 全局层：~/.dsh/settings.yaml 的 memoryleak: 段（ctx.settings，DSH
 *      官方统一位置）。vault 路径本身只住这一层 —— vault 文件不允许
 *      覆盖 vault 键（读取时直接剥离，写入时直接剔除）。
 *   2. vault 层：<vault>/.memoryleak.yaml（YAML，与 DSH 设置文件同格式）。
 *      GUI 保存与 /ml init 都会「双写」：全局与 vault 文件同步为同一份
 *      （见 writeVaultSettingsFile）；vault 文件的价值是随目录迁移，不是
 *      第三处可分叉的编辑入口（手改仍可读，但下次保存会被覆盖）。
 *      文件缺失 / 键缺失 / 解析失败 → 逐键回退到全局层，再回退到默认值。
 *
 * 解析始终以 resolveMemoryleakSettings 收口（schema 校验 + 默认值填充），
 * 所以合并结果是深冻结的合法设置。vault 层读出来不是对象（比如手改成了
 * 一个列表）时按缺失处理 —— 回退而不是崩溃，与「不能覆盖就用通用设置」
 * 的语义一致。
 *
 * @module dsh-memoryleak/vault
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import YAML from 'yaml'
import { resolveMemoryleakSettings } from './settings-schema.js'
import { NOTE_CONFIG_KEYS } from './core/note.js'

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
 * 只取 schema 认识的键，且忽略 vault 键本身（路径只住全局层）；
 * noteStructured / noteSkill 是 vault 限定键，走 readVaultNoteConfig，
 * 不进设置合并链。
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
    if (key === 'vault' || NOTE_CONFIG_KEYS.includes(key)) continue
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
 * 把设置段落写进 vault（YAML；剔除 vault 键 —— 路径只住全局层，vault
 * 文件不允许覆盖它）。每次都覆盖写入：GUI 保存与 /ml init 都是「同步」
 * 语义 —— 全局与 vault 文件保持一致；vault 文件的价值是随目录迁移，
 * 而不是第三处可分叉的编辑入口（手改仍可读，但下次 GUI 保存会被覆盖）。
 *
 * 例外：**vault 限定的 note 配置键**（noteStructured / noteSkill，见
 * core/note.js 的 NOTE_CONFIG_KEYS）只住在 vault 文件里、不进全局设置
 * schema；同步写入时从现有文件**原样保留**，不被覆盖清掉。
 *
 * @param {string} vaultDir vault 绝对路径
 * @param {object} section 要写入的设置段（含 vault 键会被剔除）
 */
export async function writeVaultSettingsFile(vaultDir, section) {
  const target = resolve(vaultDir, VAULT_SETTINGS_FILENAME)
  const { vault: _vault, ...rest } = section
  // vault 限定键：从现有文件带过来（GUI 保存不会冲掉 note 配置）
  try {
    const parsed = YAML.parse(await readFile(target, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of NOTE_CONFIG_KEYS) {
        const value = parsed[key]
        if (value !== null && value !== undefined) rest[key] = value
      }
    }
  } catch {
    // 现有文件缺失/损坏：无键可保留
  }
  const hasNoteKeys = Object.keys(rest).some((key) => NOTE_CONFIG_KEYS.includes(key))
  const hint = hasNoteKeys
    ? '# noteStructured / noteSkill / noteBackup 为 vault 限定配置（仅本文件有效，详见 README）；同步保存会原样保留\n'
    : ''
  const body = '# MemoryLeak vault 设置（与 GUI 保存同步；此文件的键覆盖 ~/.dsh/settings.yaml 的 memoryleak: 段，vault 路径除外）\n' + hint + YAML.stringify(rest)
  await writeFile(target, body, 'utf8')
}

/**
 * 读 vault 限定的 note 配置（noteStructured / noteSkill / noteBackup）。
 *
 * 这三个键**只住在 vault 文件**：不进全局设置 schema，GUI 不展示，
 * 手改即生效。读取失败 / 文件缺失 / 解析失败一律返回空（视为未配置，
 * 用内置默认目标；配置校验在 core/note.js 的 resolveStructuredTargets）。
 *
 * @param {string} vaultDir vault 绝对路径
 * @returns {Promise<{ noteStructured: unknown, noteSkill: string, noteBackup: boolean }>}
 */
export async function readVaultNoteConfig(vaultDir) {
  const empty = { noteStructured: undefined, noteSkill: '', noteBackup: false }
  try {
    const parsed = YAML.parse(await readFile(resolve(vaultDir, VAULT_SETTINGS_FILENAME), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
    return {
      noteStructured: parsed.noteStructured,
      noteSkill: typeof parsed.noteSkill === 'string' ? parsed.noteSkill.trim() : '',
      noteBackup: parsed.noteBackup === true,
    }
  } catch {
    return empty
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/* ---------------- 路径补全（引导卡 / 设置页共用的候选源） ---------------- */

/** 单次补全返回的候选上限。 */
const COMPLETE_LIMIT = 60

/** 当前平台是否 Windows（决定盘符探测分支）。 */
const IS_WIN = process.platform === 'win32'

/**
 * 按输入前缀列出可作为 Vault 候选的子目录。
 *
 * 约定（客户端按此拼接）：base 是候选所在的父目录（path.dirname 的
 * 规范化结果，盘符候选时为空串），entries 是其下名字以输入尾部匹配的
 * 目录名列表。任何读失败（不存在 / 无权限）都返回空列表 —— 补全永远
 * 不抛。
 *
 * 分隔符两种都收（Windows 上 `e:\x` 与 `e:/x` 等价；dirname/basename
 * 用 node:path 的平台实现，正斜杠输入得到的 base 会规范成 `e:/` 形式，
 * readdir 照常工作）；`~` 开头展开用户目录；Windows 单字母/裸盘符
 * （`e` / `e:`）探测盘符根。
 *
 * @param {string} prefix 输入框当前内容
 * @returns {Promise<{ base: string, entries: { name: string }[] }>}
 */
export async function completeVaultPath(prefix) {
  let input = typeof prefix === 'string' ? prefix.trim() : ''
  if (input.startsWith('~')) input = homedir() + input.slice(1)
  if (input === '') return { base: homedir(), entries: await listDirs(homedir()) }
  if (IS_WIN && /^[a-zA-Z]$/.test(input)) {
    const root = input.toUpperCase() + ':\\'
    try {
      await stat(root)
      return { base: '', entries: [{ name: root }] }
    } catch {
      return { base: '', entries: [] }
    }
  }
  if (IS_WIN && /^[a-zA-Z]:$/.test(input)) {
    // 注意：input 自带冒号，不能再拼一个（否则得到 "E::\"）。
    const root = input.toUpperCase() + '\\'
    return { base: root, entries: await listDirs(root) }
  }
  // 以分隔符结尾 = 「列出该目录内容」：base 是它本身（path.dirname 会给出
  // 父目录，不符合此约定）；否则 base = dirname、匹配段 = basename。
  const endsWithSeparator = input.length > 0 && /[\\/]$/.test(input)
  const dir = endsWithSeparator ? input.replace(/[\\/]+$/, '') : dirname(input)
  const match = endsWithSeparator ? '' : basename(input).toLowerCase()
  return { base: dir, entries: await listDirs(dir, match) }
}

/** readdir 只取目录，按名字排序并截断；任何失败按无候选处理。 */
async function listDirs(dir, match = '') {
  try {
    const dirents = await readdir(dir, { withFileTypes: true })
    return dirents
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(match))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .slice(0, COMPLETE_LIMIT)
      .map((entry) => ({ name: entry.name }))
  } catch {
    return []
  }
}
