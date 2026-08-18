/**
 * /ml note 的核心纯逻辑（无 fs、无 LLM、无全局状态，全部可直接测试）。
 *
 * 职责分三块：
 *   1. transcript 构建 —— 把一段会话消息投影成喂给模型的纯文本转写，
 *      带总预算与单条截断（长对话不爆上下文）。
 *   2. 模型输出协议 —— 指令模板（要求模型输出严格 JSON）+ 解析校验
 *      （字段白名单、类型收窄、长度上限；非法条目丢弃而非整批失败）。
 *   3. 落盘渲染 —— MOMENTO/ 知识文件、结构化表格（databases/servers/
 *      credentials/glossary，代码渲染、模型只供字段值）、索引、日志
 *      ## NOTE 段。所有「格式」都由这里的代码决定：模型输出永远只是
 *      数据，不直接成为文件内容的一部分。
 *
 * @module dsh-memoryleak/core/note
 */
import YAML from 'yaml'
import { TodoError } from './errors.js'

/** 模型输出解析失败（协议不符 / 空输出），命令层转成用户可见错误。 */
export class NoteParseError extends TodoError {}

/* ---------------- 常量（不做设置项：一次压缩的合理默认） ---------------- */

/** transcript 总字符预算（约 40k–50k token）。 */
export const TRANSCRIPT_BUDGET_CHARS = 160_000
/** 单条用户/助手消息的截断上限。 */
export const MESSAGE_TEXT_LIMIT = 8_000
/** 单条工具结果的截断上限（工具输出信息密度低，砍狠一点）。 */
export const TOOL_RESULT_LIMIT = 1_500
/** 压缩调用 maxTokens。 */
export const NOTE_MAX_TOKENS = 4_096
/** 各集合的条数上限。 */
export const MAX_NOTES = 20
export const MAX_ENTRIES = 12
export const MAX_STRUCTURED_ROWS = 50
/** 字段长度上限。 */
export const MAX_SUMMARY = 200
export const MAX_TITLE = 80
export const MAX_BODY = 4_000
export const MAX_TAG = 30
export const MAX_TAGS = 5
export const MAX_CELL = 200

/* ---------------- 结构化知识规格（代码领地的表格契约） ---------------- */

/**
 * 四类结构化知识：文件名、标题、列（key = 模型输出字段名，label = 表头）、
 * 主键列（合并时按它去重）。模型只能提供 key 集合内的字符串字段；表格
 * 由代码渲染，`|` 与换行在入库前被清洗，模型无法破坏表格结构。
 */
export const STRUCTURED_SPECS = Object.freeze({
  databases: Object.freeze({
    file: 'databases.md',
    title: 'Databases',
    keyField: 'name',
    columns: Object.freeze([
      Object.freeze({ key: 'name', label: '名称' }),
      Object.freeze({ key: 'type', label: '类型' }),
      Object.freeze({ key: 'host', label: '主机' }),
      Object.freeze({ key: 'port', label: '端口' }),
      Object.freeze({ key: 'database', label: '库' }),
      Object.freeze({ key: 'user', label: '用户' }),
      Object.freeze({ key: 'notes', label: '备注' }),
    ]),
  }),
  servers: Object.freeze({
    file: 'servers.md',
    title: 'Servers',
    keyField: 'name',
    columns: Object.freeze([
      Object.freeze({ key: 'name', label: '名称' }),
      Object.freeze({ key: 'host', label: '主机' }),
      Object.freeze({ key: 'ip', label: 'IP' }),
      Object.freeze({ key: 'user', label: '登录用户' }),
      Object.freeze({ key: 'os', label: '系统' }),
      Object.freeze({ key: 'notes', label: '备注' }),
    ]),
  }),
  credentials: Object.freeze({
    file: 'credentials.md',
    title: 'Credentials',
    keyField: 'name',
    columns: Object.freeze([
      Object.freeze({ key: 'name', label: '名称' }),
      Object.freeze({ key: 'kind', label: '类型' }),
      Object.freeze({ key: 'account', label: '账号' }),
      Object.freeze({ key: 'where', label: '存放位置' }),
      Object.freeze({ key: 'notes', label: '备注' }),
    ]),
  }),
  glossary: Object.freeze({
    file: 'glossary.md',
    title: 'Glossary',
    keyField: 'term',
    columns: Object.freeze([
      Object.freeze({ key: 'term', label: '术语' }),
      Object.freeze({ key: 'definition', label: '含义' }),
      Object.freeze({ key: 'notes', label: '备注' }),
    ]),
  }),
})

/* ---------------- 小工具 ---------------- */

/** vault 限定配置允许的结构化目标键（写入 .memoryleak.yaml 的顶层键）。 */
export const NOTE_CONFIG_KEYS = Object.freeze(['noteStructured', 'noteSkill', 'noteBackup'])

/**
 * 结构化目标：一类知识写到哪个文件、什么格式、哪些字段。
 * 内置默认（MOMENTO/<kind>.md 表格）与 vault 配置（自定义表头 / YAML 列表 /
 * markdown 小节内嵌 YAML 块）统一成同一种形状，读写路径共用。
 *
 * @typedef {object} StructuredTarget
 * @property {string} kind
 * @property {string} file vault 相对路径（正斜杠分隔，如 MOMENTO/databases.md）
 * @property {'table'|'yaml'|'sections'} format
 * @property {string} title 追加小节标题用
 * @property {string} keyField 主键字段（模型输出字段名；table 与默认 yaml）
 * @property {string[]} fields 模型字段（列顺序）
 * @property {string[]} labels 表头（table 渲染用）
 * @property {Record<string, string>} aliases 模型字段 → 存储字段改名（yaml/sections）
 * @property {Array<{key: string, desc: string}>} extras 库自有字段白名单（yaml/sections）
 * @property {string[]} keyFields 复合主键（存储字段名；yaml/sections）
 * @property {string} heading sections 的 ### 标题模板（存储字段占位符，如 "{host}:{port}"）
 */

/** 单类的内置默认 target。 */
function defaultTarget(kind) {
  const spec = STRUCTURED_SPECS[kind]
  return Object.freeze({
    kind,
    file: `MOMENTO/${spec.file}`,
    format: 'table',
    title: spec.title,
    keyField: spec.keyField,
    fields: Object.freeze(spec.columns.map((column) => column.key)),
    labels: Object.freeze(spec.columns.map((column) => column.label)),
    aliases: Object.freeze({}),
    extras: Object.freeze([]),
    keyFields: Object.freeze([spec.keyField]),
    heading: '',
  })
}

/** 内置默认 targets（deep-frozen）。 */
export const DEFAULT_STRUCTURED_TARGETS = Object.freeze(
  Object.fromEntries(Object.keys(STRUCTURED_SPECS).map((kind) => [kind, defaultTarget(kind)])),
)

/** vault 相对路径安全校验：非空、无 ..、无绝对/盘符、正斜杠化、长度合理。 */
function safeVaultRelative(raw) {
  const text = typeof raw === 'string' ? raw.trim().replace(/\\/g, '/') : ''
  if (text === '' || text.length > 256) return null
  if (text.startsWith('/') || /^[a-zA-Z]:/.test(text)) return null
  if (text.split('/').some((part) => part === '' || part === '.' || part === '..')) return null
  return text
}

/**
 * 解析 vault 限定的 noteStructured 配置为 targets（纯函数）。
 *
 * 配置形状（.memoryleak.yaml 的 noteStructured 段，全部可选，缺一类用内置默认）：
 *
 *   noteStructured:
 *     servers:
 *       file: infra/servers.yaml   # vault 相对路径
 *       format: sections           # table | yaml | sections（md 小节 + 内嵌 yaml 块）
 *       heading: "{ip}"            # sections：### 标题模板（存储字段占位符）
 *       key: [ip]                  # string 或数组（复合主键；模型或存储字段名）
 *       fields: [name, host, ...]  # 模型字段子集（默认内置全集）
 *       aliases: { name: hostname }        # 模型字段 → 存储字段改名（yaml/sections）
 *       extraFields:                       # 库自有字段白名单（yaml/sections）
 *         - key: environment
 *           desc: production 或 test
 *       header: [名称, 主机, ...]  # table 表头（与 fields 等长）
 *
 * 校验失败不抛错——返回 errors 列表（调用方决定整体拒绝；配置坏了不能
 * 静默回退默认，否则会写错文件）。
 *
 * @param {unknown} raw noteStructured 段
 * @returns {{ targets: Record<string, StructuredTarget>, errors: string[] }}
 */
export function resolveStructuredTargets(raw) {
  const targets = { ...DEFAULT_STRUCTURED_TARGETS }
  const errors = []
  if (raw === undefined || raw === null) return { targets, errors }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('noteStructured 必须是「类别 → 配置」的映射对象。')
    return { targets, errors }
  }
  for (const [kind, config] of Object.entries(raw)) {
    const spec = STRUCTURED_SPECS[kind]
    if (spec === undefined) {
      errors.push(`noteStructured 里出现未知类别 "${kind}"（可用：${Object.keys(STRUCTURED_SPECS).join(' / ')}）。`)
      continue
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      errors.push(`noteStructured.${kind} 必须是对象。`)
      continue
    }
    const file = safeVaultRelative(config.file)
    if (file === null) {
      errors.push(`noteStructured.${kind}.file 必须是 vault 相对路径（不能为空、不含 ..、不是绝对路径）。`)
      continue
    }
    const format = config.format === undefined ? 'table' : config.format
    if (format !== 'table' && format !== 'yaml' && format !== 'sections') {
      errors.push(`noteStructured.${kind}.format 只能是 table、yaml 或 sections（收到 ${JSON.stringify(config.format)}）。`)
      continue
    }
    const builtinFields = spec.columns.map((column) => column.key)
    const fields = Array.isArray(config.fields)
      ? config.fields.filter((field) => typeof field === 'string')
      : undefined
    if (fields !== undefined) {
      if (fields.length === 0 || fields.some((field) => !builtinFields.includes(field))) {
        errors.push(`noteStructured.${kind}.fields 必须是内置字段（${builtinFields.join(' / ')}）的非空子集。`)
        continue
      }
    }
    const effectiveFields = Object.freeze([...(fields ?? builtinFields)])
    const keyInput = config.key
    const keyList = keyInput === undefined
      ? [spec.keyField]
      : typeof keyInput === 'string'
        ? [keyInput]
        : Array.isArray(keyInput)
          ? keyInput.filter((part) => typeof part === 'string')
          : null
    if (keyList === null || keyList.length === 0) {
      errors.push(`noteStructured.${kind}.key 必须是非空字符串或字符串数组。`)
      continue
    }

    // aliases（仅 yaml/sections）：模型字段 → 存储字段
    let aliases = {}
    if (config.aliases !== undefined) {
      if (format === 'table') {
        errors.push(`noteStructured.${kind}：aliases 只支持 yaml/sections 格式（table 用 header 定列名）。`)
        continue
      }
      if (config.aliases === null || typeof config.aliases !== 'object' || Array.isArray(config.aliases)) {
        errors.push(`noteStructured.${kind}.aliases 必须是「模型字段: 存储字段」映射。`)
        continue
      }
      let ok = true
      for (const [modelField, storageField] of Object.entries(config.aliases)) {
        if (!builtinFields.includes(modelField)) {
          errors.push(`noteStructured.${kind}.aliases 的键 "${modelField}" 不是内置字段。`)
          ok = false
          continue
        }
        if (typeof storageField !== 'string' || storageField.trim() === '') {
          errors.push(`noteStructured.${kind}.aliases.${modelField} 必须是非空字符串。`)
          ok = false
        }
      }
      if (!ok) continue
      aliases = { ...config.aliases }
    }

    // extras（仅 yaml/sections）：库自有字段白名单
    let extras = []
    if (config.extraFields !== undefined) {
      if (format === 'table') {
        errors.push(`noteStructured.${kind}：extraFields 只支持 yaml/sections 格式。`)
        continue
      }
      const normalized = normalizeExtras(config.extraFields)
      if (normalized === null) {
        errors.push(`noteStructured.${kind}.extraFields 必须是字段名或 {key, desc} 的数组。`)
        continue
      }
      extras = normalized
    }

    // 存储名集合与唯一性：字段存储名（别名或自身）+ extras 键，互相不能撞
    const storageOf = (modelField) => aliases[modelField] ?? modelField
    const storageNames = effectiveFields.map(storageOf)
    const allStorageKeys = [...storageNames, ...extras.map((extra) => extra.key)]
    if (new Set(allStorageKeys).size !== allStorageKeys.length) {
      errors.push(`noteStructured.${kind}：字段存储名与 extraFields 键有重复（别名目标不能与其他字段或 extras 相撞）。`)
      continue
    }
    if (extras.some((extra) => builtinFields.includes(extra.key))) {
      errors.push(`noteStructured.${kind}.extraFields 的键不能与内置字段同名（内置字段请走 fields/aliases）。`)
      continue
    }

    // key 归一：每段解析为存储字段名（模型字段经别名；否则要求是存储名）
    const keyFields = []
    let keyOk = true
    for (const part of keyList) {
      if (builtinFields.includes(part)) {
        if (!effectiveFields.includes(part)) {
          errors.push(`noteStructured.${kind}.key 的 "${part}" 必须在 fields 内。`)
          keyOk = false
          break
        }
        keyFields.push(storageOf(part))
      } else if (allStorageKeys.includes(part)) {
        keyFields.push(part)
      } else {
        errors.push(`noteStructured.${kind}.key 的 "${part}" 不是已知字段（fields、别名目标或 extraFields）。`)
        keyOk = false
        break
      }
    }
    if (!keyOk) continue
    if (format === 'table' && keyFields.length > 1) {
      errors.push(`noteStructured.${kind}：table 格式只支持单字段主键。`)
      continue
    }

    // heading 模板（仅 sections）：占位符 {field} 必须是存储字段
    let heading = ''
    if (format === 'sections') {
      if (typeof config.heading !== 'string' || config.heading.trim() === '') {
        errors.push(`noteStructured.${kind}：sections 格式必须提供 heading（### 标题模板，如 "{host}:{port}"）。`)
        continue
      }
      heading = config.heading.trim()
      const placeholders = [...heading.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1].trim())
      if (placeholders.length === 0 || placeholders.some((name) => !allStorageKeys.includes(name))) {
        errors.push(`noteStructured.${kind}.heading 的占位符必须是已知存储字段（收到 ${JSON.stringify(placeholders)}）。`)
        continue
      }
    } else if (config.heading !== undefined) {
      errors.push(`noteStructured.${kind}：heading 只支持 sections 格式。`)
      continue
    }

    // labels（table）
    const builtinLabels = Object.freeze(spec.columns.map((column) => column.label))
    let labels = builtinLabels
    if (format === 'table' && Array.isArray(config.header)) {
      const header = config.header
      if (header.length !== effectiveFields.length || header.some((cell) => typeof cell !== 'string' || cell.trim() === '')) {
        errors.push(`noteStructured.${kind}.header 必须是 ${effectiveFields.length} 个非空字符串（与 fields 一一对应）。`)
        continue
      }
      labels = Object.freeze(header.map((cell) => clip(cell, MAX_CELL)))
    }
    targets[kind] = Object.freeze({
      kind,
      file,
      format,
      title: spec.title,
      keyField: keyFields[0],
      fields: effectiveFields,
      labels,
      aliases: Object.freeze({ ...aliases }),
      extras: Object.freeze(extras.map((extra) => Object.freeze({ ...extra }))),
      keyFields: Object.freeze(keyFields),
      heading,
    })
  }
  return { targets, errors }
}

/** 解析 extras 声明（字符串数组或 {key, desc} 对象数组）→ 标准化数组；非法返回 null。 */
function normalizeExtras(raw) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null
  const extras = []
  for (const item of raw.slice(0, MAX_EXTRAS)) {
    if (typeof item === 'string') {
      if (item.trim() === '') return null
      extras.push({ key: item.trim(), desc: '' })
    } else if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      if (typeof item.key !== 'string' || item.key.trim() === '') return null
      const desc = typeof item.desc === 'string' ? clip(item.desc, 120) : ''
      extras.push({ key: item.key.trim(), desc })
    } else {
      return null
    }
  }
  return extras
}

/** extraFields 每类最多声明数。 */
const MAX_EXTRAS = 8

/** 限长截断（字符，尾加省略号）。 */
function clip(text, max) {
  const value = String(text)
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

/** 单行化（换行折成空格）+ 限长。 */
function oneLine(text, max) {
  return clip(String(text).replace(/\s*\r?\n\s*/g, ' ').trim(), max)
}

/** 表格单元格清洗：去 `|` 与换行（防破表）+ 限长。 */
function cleanCell(value) {
  return oneLine(String(value ?? '').replace(/[|]+/g, '/'), MAX_CELL)
}

/** 多行文本清洗：规范换行、去致命字符、限长。 */
function cleanBody(text) {
  const value = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .join('\n')
    .trim()
  return clip(value, MAX_BODY)
}

/* ---------------- 1. transcript 构建 ---------------- */

/**
 * 把投影好的消息条目裁剪成预算内的转写文本。
 *
 * 条目原子（单条超长先截断自身）；总长超预算时保头 60% + 保尾 40%，
 * 中间以省略标记衔接——最近的结论与最初的诉求最值得保留。
 *
 * @param {ReadonlyArray<{ role: 'user' | 'assistant' | 'tool', name?: string, text: string }>} items
 * @param {{ budget?: number, messageLimit?: number, toolLimit?: number }} [limits]
 * @returns {{ text: string, included: number, total: number, truncated: boolean }}
 */
export function buildTranscript(items, limits = {}) {
  const budget = limits.budget ?? TRANSCRIPT_BUDGET_CHARS
  const messageLimit = limits.messageLimit ?? MESSAGE_TEXT_LIMIT
  const toolLimit = limits.toolLimit ?? TOOL_RESULT_LIMIT
  const capped = items.map((item) => ({
    role: item.role,
    name: typeof item.name === 'string' ? item.name : undefined,
    text: clip(String(item.text ?? ''), item.role === 'tool' ? toolLimit : messageLimit),
  }))
  const total = capped.length
  const rendered = capped.map(renderTranscriptItem)
  const totalChars = rendered.reduce((sum, text) => sum + text.length + 2, 0)
  if (totalChars <= budget) {
    return { text: rendered.join('\n\n'), included: total, total, truncated: false }
  }
  const headBudget = Math.floor(budget * 0.6)
  const tailBudget = budget - headBudget
  const head = []
  let headChars = 0
  let headIndex = 0
  while (headIndex < total) {
    const next = rendered[headIndex].length + 2
    if (headChars + next > headBudget && head.length > 0) break
    head.push(rendered[headIndex])
    headChars += next
    headIndex += 1
  }
  const tail = []
  let tailChars = 0
  let tailIndex = total - 1
  while (tailIndex >= headIndex) {
    const next = rendered[tailIndex].length + 2
    if (tailChars + next > tailBudget && tail.length > 0) break
    tail.unshift(rendered[tailIndex])
    tailChars += next
    tailIndex -= 1
  }
  const omitted = tailIndex - headIndex + 1
  const marker = omitted > 0 ? `\n…（中间省略 ${omitted} 条消息）…\n` : ''
  return {
    text: `${head.join('\n\n')}${marker}${tail.join('\n\n')}`.trim(),
    included: head.length + tail.length,
    total,
    truncated: true,
  }
}

/** 单条转写渲染：角色标签 + 工具名 + 文本。 */
function renderTranscriptItem(item) {
  const label =
    item.role === 'user' ? '【用户】' : item.role === 'assistant' ? '【助手】' : `【工具结果${item.name ? ` · ${item.name}` : ''}】`
  return `${label}\n${item.text}`
}

/* ---------------- 2. 模型输出协议 ---------------- */

/** 结构化各类的字段规范说明（进 prompt，约束模型的填写习惯）。 */
const STRUCTURED_FIELD_RULES = Object.freeze({
  databases: '- databases：name 是简短稳定标识（如「生产主库」「分析从库」）；host 只写主机名或 IP，不带协议、不带端口；port 纯数字；一个库一行。',
  servers: '- servers：name 是简短稳定标识（如「web-01」「跳板机」）；host 与 ip 分开写，host 不带端口；os 写系统名（如 debian/win2022）。',
  credentials: '- credentials：where 只写凭证存放位置（如 1Password 某条目、环境变量 X、~/.aws/credentials），严禁记录明文密码/密钥/token。',
  glossary: '- glossary：term 是术语本身，definition 一句话说清含义。',
})

/**
 * 组装压缩指令（转写正文 + 已知信息 + vault 约定 + 输出协议）。
 *
 * known 是 Vault 里已有的知识状态（结构化表格行 + 知识条目标题）。
 * 有已知信息时，structured 的语义是**增量修改**：只输出需要新增或修改
 * 的行（修改 = 主键不变、只填有变化的字段，留空 = 保留原值），无变化的
 * 已知行不要重复输出——避免把本段对话当成全部上下文重建文件。
 * skill 是 vault 限定的 note-skill 文件内容（本 vault 的记录约定，模型
 * 约束提示；格式仍由代码强制）。
 *
 * @param {{ transcript: string, date: string, hasBoundary: boolean, known?: { structured?: Record<string, Array<Record<string, string>>>, titles?: string[] }, skill?: string }} input
 * @returns {string} 完整的 user 消息文本
 */
export function buildNotePrompt({ transcript, date, hasBoundary, known = {}, skill = '', targets = DEFAULT_STRUCTURED_TARGETS }) {
  const scope = hasBoundary ? '上次 /ml note 之后到现在的对话' : '本会话开始到现在的完整对话'
  const parts = [
    `下面是「${scope}」的转写记录（${date} 生成）。请把它压缩整理成结构化笔记。`,
    '',
    '─── 转写开始 ───',
    '',
    transcript,
    '',
    '─── 转写结束 ───',
    '',
  ]

  const knownStructured = Object.entries(known.structured ?? {}).filter(([, rows]) => rows.length > 0)
  const knownTitles = known.titles ?? []
  if (knownStructured.length > 0 || knownTitles.length > 0) {
    parts.push('─── 已有知识状态（Vault 里已经登记的内容）───', '')
    for (const [kind, rows] of knownStructured) {
      parts.push(`${kind} 已有 ${rows.length} 行：`, JSON.stringify(rows), '')
    }
    if (knownTitles.length > 0) {
      parts.push(`MOMENTO 已有知识条目标题：${knownTitles.map((title) => `「${title}」`).join('、')}`, '')
    }
    parts.push(
      '在转写中只有出现了与已有登记**相关的新信息**（新条目、属性变化、需要修正的错误）才输出对应内容：',
      '- structured 只输出需要**新增**或**修改**的行；修改已有行时主键（name/term）保持不变、只填有变化的字段（留空 = 保留原值）；信息没有变化的已有行**不要重复输出**。',
      '- momento 只在确有值得长期保留的新知识时输出；对已有条目的补充沿用相同标题（会以「更新」分节追加），全新知识用新标题。',
      '',
    )
  }

  if (typeof skill === 'string' && skill.trim() !== '') {
    parts.push('─── 本 Vault 的记录约定（note skill）───', '', skill.trim(), '')
  }

  // 各类别声明的扩展字段（vault 配置的 extraFields）：字段名 + 说明
  const extrasLines = []
  for (const [kind, target] of Object.entries(targets)) {
    if (target.extras.length === 0) continue
    const fields = target.extras.map((extra) => (extra.desc === '' ? extra.key : `${extra.key}（${extra.desc}）`)).join('、')
    extrasLines.push(`- ${kind}: ${fields}`)
  }
  if (extrasLines.length > 0) {
    parts.push(
      '扩展字段（本 Vault 声明的库自有字段；可加进对应类型的行里，同样「明确出现才填」）：',
      ...extrasLines,
      '- 扩展字段值为列表时给字符串数组；已有序列会**追加去重**，不会覆盖。',
      '',
    )
  }

  parts.push(
    '输出要求：只输出一个 JSON 对象，不要 markdown 代码块，不要任何额外文字。结构如下：',
    '',
    JSON.stringify(
      {
        summary: '本段工作的一句话总结（不超过80字）',
        note: ['工作记录条目：做了什么、结论是什么（每条一句话）'],
        momento: {
          entries: [
            {
              title: '知识点标题（简短稳定，作为文件名；不要日期、不要标点结尾）',
              body: '知识点正文（markdown，可多段；只写值得长期保留的知识，不复述过程）',
              tags: ['标签'],
            },
          ],
        },
        structured: {
          databases: [{ name: '', type: '', host: '', port: '', database: '', user: '', notes: '' }],
          servers: [{ name: '', host: '', ip: '', user: '', os: '', notes: '' }],
          credentials: [{ name: '', kind: '', account: '', where: '凭证存放位置（如 1Password/环境变量 X），严禁记录明文密码或密钥', notes: '' }],
          glossary: [{ term: '', definition: '', notes: '' }],
        },
      },
      null,
      2,
    ),
    '',
    '规则：',
    '- note：本段的工作流水（3–8条）；没有就给空数组。',
    '- momento.entries：值得进知识库的长期知识（方案、坑、命令、结论）；没有给空数组。',
    '- structured：只登记转写中**真实出现**的信息，字段没提到就留空字符串；没有整类给空数组。',
    STRUCTURED_FIELD_RULES.databases,
    STRUCTURED_FIELD_RULES.servers,
    STRUCTURED_FIELD_RULES.credentials,
    STRUCTURED_FIELD_RULES.glossary,
    '- 所有字符串值都用中文（专有名词、命令、路径除外）。',
    '- 只输出 JSON。',
  )
  return parts.join('\n')
}

/**
 * 解析模型输出为受信数据（字段白名单 + 类型收窄 + 长度上限；非法条目
 * 丢弃，解析彻底失败才抛 {@link NoteParseError}）。
 *
 * @param {string} raw 模型原始输出
 * @param {Record<string, StructuredTarget>} [targets] 解析后的结构化目标
 *   （决定各类的主键字段与 extras 白名单；缺省用内置默认）
 * @returns {{
 *   summary: string,
 *   notes: string[],
 *   entries: Array<{ title: string, body: string, tags: string[] }>,
 *   structured: Record<string, Array<Record<string, string | string[]>>>,
 *   warnings: string[],
 * }}
 * @throws {NoteParseError}
 */
export function parseNoteJson(raw, targets = DEFAULT_STRUCTURED_TARGETS) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') throw new NoteParseError('模型输出为空。')
  let parsed = tryParseJson(text)
  if (parsed === undefined) throw new NoteParseError(`模型输出不是合法 JSON：${clip(text, 300)}`)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NoteParseError('模型输出不是 JSON 对象。')
  }
  const warnings = []

  const summary = typeof parsed.summary === 'string' && parsed.summary.trim() !== '' ? oneLine(parsed.summary, MAX_SUMMARY) : ''

  const notes = toStringArray(parsed.note)
    .map((item) => oneLine(item, 300))
    .filter((item) => item !== '')
    .slice(0, MAX_NOTES)

  const rawEntries = Array.isArray(parsed.momento?.entries) ? parsed.momento.entries : []
  const entries = []
  for (const raw of rawEntries.slice(0, MAX_ENTRIES)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const title = oneLine(raw.title ?? '', MAX_TITLE)
    const body = cleanBody(raw.body ?? '')
    if (title === '' || body === '') {
      warnings.push(`知识条目「${title || '(无标题)'}」缺标题或正文，已丢弃。`)
      continue
    }
    const tags = toStringArray(raw.tags)
      .map((tag) => oneLine(tag, MAX_TAG))
      .filter((tag) => tag !== '')
      .slice(0, MAX_TAGS)
    entries.push({ title, body, tags })
  }

  const structured = {}
  for (const [kind, spec] of Object.entries(STRUCTURED_SPECS)) {
    const rows = []
    const rawRows = Array.isArray(parsed.structured?.[kind]) ? parsed.structured[kind] : []
    const target = targets[kind] ?? DEFAULT_STRUCTURED_TARGETS[kind]
    // 模型空间的主键要求：存储 keyFields 经反别名映射（extras 与未别名字段同名）
    const inverseAliases = Object.fromEntries(Object.entries(target.aliases).map(([model, storage]) => [storage, model]))
    const modelKeyFields = target.keyFields.map((field) => inverseAliases[field] ?? field)
    for (const row of rawRows.slice(0, MAX_STRUCTURED_ROWS)) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
      const clean = {}
      for (const column of spec.columns) clean[column.key] = cleanCell(row[column.key] ?? '')
      // 库自有字段（extras）：string 清洗；string[] 逐项清洗保持数组；空数组视为未填
      for (const extra of target.extras) {
        const value = row[extra.key]
        if (Array.isArray(value)) {
          const items = value.filter((item) => typeof item === 'string').map((item) => cleanCell(item)).filter((item) => item !== '')
          if (items.length > 0) clean[extra.key] = items
        } else if (typeof value === 'string' && value.trim() !== '') {
          clean[extra.key] = cleanCell(value)
        }
      }
      normalizeStructuredRow(kind, clean)
      const missingKey = modelKeyFields.find((field) => clean[field] === '' || clean[field] === undefined)
      if (missingKey !== undefined) {
        warnings.push(`${kind} 有一条缺主键字段（${modelKeyFields.join(' / ')}），已丢弃。`)
        continue
      }
      rows.push(clean)
    }
    structured[kind] = rows
  }

  if (summary === '' && notes.length === 0 && entries.length === 0 && Object.values(structured).every((rows) => rows.length === 0)) {
    throw new NoteParseError('模型输出没有可用的压缩内容（note / momento / structured 全为空）。')
  }
  return { summary: summary || '（无摘要）', notes, entries, structured, warnings }
}

/** 容错 JSON 解析：剥 fence、截取首尾大括号；失败返回 undefined。 */
function tryParseJson(text) {
  const candidates = []
  const unfenced = text.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
  candidates.push(unfenced)
  const first = unfenced.indexOf('{')
  const last = unfenced.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(unfenced.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // 尝试下一个候选
    }
  }
  return undefined
}

/** 未知形状 → 字符串数组（非字符串元素丢弃）。 */
function toStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

/**
 * 结构化行的语义清洗（常见模型错误就地修正）：
 *   - port 只留纯数字（「5432 端口」→「5432」；非数字清空）；
 *   - host 剥协议前缀（postgres://db.x → db.x）；host 带 :port 而 port 为空时拆分；
 *   - servers 的 ip 字段同样剥协议与端口。
 */
function normalizeStructuredRow(kind, row) {
  const cleanHostLike = (value) => value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  if (kind === 'databases') {
    row.host = cleanHostLike(row.host)
    const match = /^(.*?):(\d+)$/.exec(row.host)
    if (match !== null && row.port === '') {
      row.host = match[1]
      row.port = match[2]
    }
    row.port = /^\d+$/.test(row.port) ? row.port : ''
  }
  if (kind === 'servers') {
    row.host = cleanHostLike(row.host)
    row.ip = cleanHostLike(row.ip)
  }
}

/* ---------------- 3. 落盘渲染 ---------------- */

/**
 * 标题 → 文件名 slug：小写、非字母数字（含中文）折叠为 '-'、去首尾、
 * 限长；空则 'untitled'。中文保留（Windows/macOS 文件名都合法）。
 *
 * @param {string} title
 * @returns {string}
 */
export function slugify(title) {
  const slug = String(title)
    .trim()
    .toLowerCase()
    .replace(/[\s._/\\:]+/g, '-')
    .replace(/[<>:"|?*#]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return slug === '' ? 'untitled' : slug
}

/**
 * 渲染一个知识条目文件。
 *
 * 新文件：标题 + 元信息 + 正文。已存在（同 slug 再写）：正文之前追加
 * `## 更新 <date>` 分节，旧内容不动——知识文件是追加式的账本，不覆盖。
 *
 * @param {{ title: string, body: string, date: string, existing?: string | null }} input
 * @returns {string} 完整文件内容
 */
export function renderEntryFile({ title, body, date, existing = null }) {
  if (existing !== null && typeof existing === 'string' && existing.trim() !== '') {
    const base = existing.replace(/\n+$/, '')
    return `${base}\n\n## 更新 ${date}\n\n${cleanBody(body)}\n`
  }
  return `# ${oneLine(title, MAX_TITLE)}\n\n> 首次记录 ${date} · 来源 /ml note\n\n${cleanBody(body)}\n`
}

/* ---------------- markdown 表格定位（安全的增量基础） ---------------- */

/** 一行是否是 markdown 表格行。 */
function isTableRow(line) {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2
}

/** 拆表格行为单元格数组。 */
function splitTableRow(line) {
  return line.trim().slice(1, -1).split('|').map((cell) => cell.trim())
}

/** 一行是否是表格分隔线（| --- | --- |）。 */
function isTableSeparator(line) {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell))
}

/**
 * 定位文件里所有「表头与期望列名完全一致」的表格块。
 *
 * 只认自己的格式：表头单元格逐项等于 labels（顺序、文案全等），随后是
 * 分隔线，再后到块尾都是数据行。表头对不上的表格（用户手写的、其他工具
 * 的）一律不认——这是安全边界：不认的格式永远不会被重写。
 *
 * @param {string} content 文件内容
 * @param {ReadonlyArray<string>} labels 期望的表头列名
 * @returns {Array<{ headerLine: number, endLine: number, rows: string[][] }>}
 *   headerLine：表头行号（0 起）；endLine：数据行结束行号（不含）；rows：数据行单元格
 */
export function findMarkdownTables(content, labels) {
  const lines = String(content).split('\n')
  const tables = []
  let index = 0
  while (index < lines.length) {
    if (isTableRow(lines[index])) {
      const cells = splitTableRow(lines[index])
      if (cells.length === labels.length && cells.every((cell, i) => cell === labels[i])) {
        // 表头匹配：吞掉分隔线与连续数据行
        let cursor = index + 1
        if (cursor < lines.length && isTableSeparator(lines[cursor]) && splitTableRow(lines[cursor]).length === cells.length) cursor += 1
        const rows = []
        while (cursor < lines.length && isTableRow(lines[cursor])) {
          const dataCells = splitTableRow(lines[cursor])
          while (dataCells.length < cells.length) dataCells.push('')
          rows.push(dataCells.slice(0, cells.length))
          cursor += 1
        }
        tables.push({ headerLine: index, endLine: cursor, rows })
        index = cursor
        continue
      }
    }
    index += 1
  }
  return tables
}

/** 渲染一张带表头的完整表格。 */
function renderTable(labels, dataRows) {
  return [`| ${labels.join(' | ')} |`, `| ${labels.map(() => '---').join(' | ')} |`, ...dataRows.map((cells) => `| ${cells.map((cell) => cleanCell(cell ?? '')).join(' | ')} |`)]
}

/* ---------------- index.md（安全化：只认自己的表头；不认 → 追加小节） ---------------- */

/** index.md 的表头列名。 */
const INDEX_LABELS = Object.freeze(['标题', '文件', '记录于', '摘要'])

/**
 * 解析 index.md 已有条目（表头匹配的表格数据行 → { title, file } 列表）。
 *
 * @param {string | null} content
 * @returns {Array<{ title: string, file: string }>}
 */
export function parseIndexTitles(content) {
  if (content === null || typeof content !== 'string') return []
  const titles = []
  for (const table of findMarkdownTables(content, [...INDEX_LABELS])) {
    for (const cells of table.rows) {
      if (cells[1] !== '') titles.push({ title: cells[0] ?? '', file: cells[1] ?? '' })
    }
  }
  return titles
}

/**
 * 合并 MOMENTO/index.md。
 *
 * 安全契约：只重写「表头匹配」的第一个表格（合并全部已知行 + 新行），
 * 其余匹配表格收编后移除、非表格内容原样保留；一个匹配表格都没有时
 * 绝不重写文件——在末尾追加新表格小节。
 *
 * @param {string | null} content 现有内容（null = 新建）
 * @param {ReadonlyArray<{ slug: string, title: string, date: string, summary?: string }>} rows
 * @returns {string}
 */
export function mergeIndexDocument(content, rows) {
  if (rows.length === 0) return content ?? ''
  if (content === null || content.trim() === '') {
    const body = rows.map((row) => [oneLine(row.title, MAX_TITLE), `${row.slug}.md`, row.date, oneLine(row.summary ?? '', 120)])
    return `${['# MOMENTO 索引', '', ...renderTable([...INDEX_LABELS], body)].join('\n')}\n`
  }
  const lines = content.replace(/\n+$/, '').split('\n')
  const tables = findMarkdownTables(content, [...INDEX_LABELS])
  const byFile = new Map()
  for (const table of tables) {
    for (const cells of table.rows) byFile.set(cells[1] ?? '', cells)
  }
  for (const row of rows) {
    const file = `${row.slug}.md`
    const previous = byFile.get(file)
    byFile.set(file, [oneLine(row.title, MAX_TITLE), file, previous?.[2] ?? row.date, oneLine(row.summary ?? '', 120)])
  }
  const mergedTable = renderTable([...INDEX_LABELS], [...byFile.values()])
  if (tables.length === 0) {
    // 原文件没有我们的表格（手写/别的格式）：原样保留，末尾追加小节
    return `${[...lines, '', ...mergedTable].join('\n')}\n`
  }
  // 第一个匹配表格替换为合并结果，其余匹配表格移除（行已收编），其他行原样
  const remove = new Set()
  for (const table of tables.slice(1)) for (let i = table.headerLine; i < table.endLine; i += 1) remove.add(i)
  const kept = lines.filter((_, i) => !remove.has(i))
  // 替换第一个表格：以它在新数组的近似位置重定位（移除都发生在首个表格之后，位置不变）
  const first = tables[0]
  const replaced = [...kept.slice(0, first.headerLine), ...mergedTable, ...kept.slice(first.endLine)]
  return `${replaced.join('\n')}\n`
}

/* ---------------- 结构化知识文档（安全合并：零丢失，target 驱动） ---------------- */

/**
 * 读取一个 table 目标的已知行（表头匹配的表格 → 字段对象数组）。
 *
 * @param {string | null} content 文件内容
 * @param {StructuredTarget} target
 * @returns {Array<Record<string, string>>}
 */
export function extractTableRows(content, target) {
  if (content === null || typeof content !== 'string') return []
  const rows = []
  for (const table of findMarkdownTables(content, [...target.labels])) {
    for (const cells of table.rows) {
      const row = {}
      for (const [index, field] of target.fields.entries()) row[field] = cells[index] ?? ''
      rows.push(row)
    }
  }
  return rows
}

/** 内置默认 target（兼容包装用）。 */
function targetOfKind(kind) {
  const spec = STRUCTURED_SPECS[kind]
  return DEFAULT_STRUCTURED_TARGETS[kind] ?? Object.freeze({
    kind,
    file: `MOMENTO/${spec.file}`,
    format: 'table',
    title: spec.title,
    keyField: spec.keyField,
    fields: Object.freeze(spec.columns.map((c) => c.key)),
    labels: Object.freeze(spec.columns.map((c) => c.label)),
  })
}

/**
 * 读取一类结构化文档的已知行（内置默认 target 的便捷包装）。
 *
 * @param {string | null} content 文件内容
 * @param {string} kind STRUCTURED_SPECS 的键
 * @returns {Array<Record<string, string>>}
 */
export function extractStructuredRows(content, kind) {
  return extractTableRows(content, targetOfKind(kind))
}

/**
 * 行级合并（yaml 目标，**存储空间**）：按复合主键合并已知行与新行。
 * 新值非空才覆盖；为空保留旧值。**保留已知行里 target 之外的额外字段**
 * （yaml 老库常有 rack/owner 之类的自有键，模型不输出它们，原样带过）。
 *
 * @param {ReadonlyArray<Record<string, unknown>>} knownRows 存储行
 * @param {ReadonlyArray<Record<string, unknown>>} newRows 存储行（模型行经 rowToStorage）
 * @param {StructuredTarget} target
 * @returns {Array<Record<string, unknown>>}
 */
export function mergeRowsByField(knownRows, newRows, target) {
  const keyOf = (row) => {
    const parts = target.keyFields.map((field) => String(row[field] ?? '').trim())
    return parts.some((part) => part === '') ? null : parts.join(' · ')
  }
  const storageKeys = [...target.fields.map((field) => target.aliases[field] ?? field), ...target.extras.map((extra) => extra.key)]
  const merged = new Map()
  for (const row of knownRows) {
    const key = keyOf(row)
    if (key !== null) merged.set(key, { ...row })
  }
  for (const row of newRows) {
    const key = keyOf(row)
    if (key === null) continue
    const previous = merged.get(key)
    const next = previous !== undefined ? { ...previous } : {}
    for (const storageKey of storageKeys) {
      const value = row[storageKey]
      if (value === '' || value === undefined) {
        if (next[storageKey] === undefined) next[storageKey] = ''
        continue
      }
      next[storageKey] = value
    }
    merged.set(key, next)
  }
  return [...merged.values()]
}

/**
 * 主键集合守卫：合并后的主键必须包含合并前的全部（合并只允许新增与更新）。
 * 违反返回丢失列表（不抛错，调用方决定如何呈现）。
 *
 * @param {Iterable<string>} beforeKeys
 * @param {Iterable<string>} afterKeys
 * @returns {string[]} 丢失的主键（空数组 = 通过）
 */
export function lostKeys(beforeKeys, afterKeys) {
  const after = new Set(afterKeys)
  return [...new Set(beforeKeys)].filter((key) => key !== '' && !after.has(key))
}

/**
 * 防丢失守卫（table 内容级）：合并后的主键集合必须包含合并前的全部。
 * 违反即抛错拒绝写入——宁可这次整理失败，也不能再丢用户的库。
 *
 * @param {string | null} content 合并前文件内容
 * @param {string} kind
 * @param {string} next 合并后文件内容
 */
export function assertNoRowLoss(content, kind, next) {
  const target = targetOfKind(kind)
  const keyIndex = target.fields.indexOf(target.keyField)
  const keysOf = (text) => {
    const keys = new Set()
    for (const table of findMarkdownTables(text ?? '', [...target.labels])) {
      for (const cells of table.rows) {
        const key = (cells[keyIndex] ?? '').trim()
        if (key !== '') keys.add(key)
      }
    }
    return keys
  }
  const before = keysOf(content)
  if (before.size === 0) return
  const lost = lostKeys(before, keysOf(next))
  if (lost.length > 0) {
    throw new NoteParseError(`${kind} 合并将丢失 ${lost.length} 个已有主键（${lost.slice(0, 3).join('、')}${lost.length > 3 ? '…' : ''}），已拒绝写入。`)
  }
}

/**
 * 合并一个 table 目标的文档。
 *
 * 安全契约（2026-02 事故后重写）：
 *   1. 只认「表头与 target.labels 完全一致」的表格；表头对不上的内容永远原样保留。
 *   2. 文件里没有匹配表格（含不存在/为空/手写格式）：
 *      - 空文件 → 新建标准格式；
 *      - 非空文件 → **只在末尾追加**一个新的表格小节，原有内容一个字符不动。
 *   3. 有匹配表格 → 全部已知行（后出现优先）与新行按主键合并（新值非空才覆盖），
 *      合并结果替换第一个匹配表格的块范围；其余匹配表格的行已收编进合并结果，
 *      块本身移除；表格之外的一切内容（标题、说明、手写段落）原样保留。
 *
 * @param {string | null} content 现有内容
 * @param {StructuredTarget} target
 * @param {ReadonlyArray<Record<string, string>>} rows 模型输出的新行（已清洗）
 * @param {string} date yyyy-mm-dd（追加小节标题用）
 * @returns {string}
 */
export function mergeTableDocument(content, target, rows, date = '') {
  const labels = [...target.labels]
  const renderRows = (merged) => merged.map((row) => target.fields.map((field) => row[field] ?? ''))

  // 1. 空/不存在：新建标准格式
  if (content === null || content.trim() === '') {
    const header = [`# ${target.title}`, '', ...renderTable(labels, renderRows(mergeRowsByField([], rows, target)))]
    if (target.kind === 'credentials') header.push('', '> 凭证登记约定：只记录存放位置与账号，永不写入明文密码/密钥/token。')
    return `${header.join('\n')}\n`
  }

  const lines = content.replace(/\n+$/, '').split('\n')
  const tables = findMarkdownTables(content, labels)

  // 2. 没有匹配表格：原有内容原样保留，末尾追加小节（绝不重写）
  if (tables.length === 0) {
    const stamp = date === '' ? '' : `（${date} 追加）`
    const section = [`## ${target.title}${stamp}`, '', ...renderTable(labels, renderRows(mergeRowsByField([], rows, target)))]
    return `${[...lines, '', ...section].join('\n')}\n`
  }

  // 3. 有匹配表格：收编全部已知行 → 合并 → 替换第一个块，移除其余块
  const knownRows = []
  for (const table of tables) {
    for (const cells of table.rows) {
      const row = {}
      for (const [index, field] of target.fields.entries()) row[field] = cells[index] ?? ''
      knownRows.push(row)
    }
  }
  const mergedTable = renderTable(labels, renderRows(mergeRowsByField(knownRows, rows, target)))
  const remove = new Set()
  for (const table of tables.slice(1)) for (let i = table.headerLine; i < table.endLine; i += 1) remove.add(i)
  const kept = lines.filter((_, i) => !remove.has(i))
  const first = tables[0]
  const replaced = [...kept.slice(0, first.headerLine), ...mergedTable, ...kept.slice(first.endLine)]
  return `${replaced.join('\n')}\n`
}

/**
 * 合并一类结构化知识文档（内置默认 target 的便捷包装）。
 *
 * @param {string | null} content 现有内容
 * @param {string} kind STRUCTURED_SPECS 的键
 * @param {ReadonlyArray<Record<string, string>>} rows
 * @param {string} date
 * @returns {string}
 */
export function mergeStructuredDocument(content, kind, rows, date = '') {
  return mergeTableDocument(content, targetOfKind(kind), rows, date)
}

/* ---------------- sections 格式：markdown 小节 + 内嵌 YAML 块 ---------------- */

/**
 * 解析 sections 文档：`### <heading>` 小节（到下一个任意级别标题或文件末尾）
 * 与其中的 ```yaml 围栏块。只做定位与解析，不做任何判断。
 *
 * @param {string} content
 * @returns {{ sections: Array<{ heading: string, headingLine: number, endLine: number, blocks: Array<{ startLine: number, endLine: number, row: Record<string, unknown> | null }> }> }}
 *   行号 0 起、含围栏行；row 为 null 表示块体不是 YAML 对象（保持原样，不参与合并）
 */
export function parseSectionsDocument(content) {
  const lines = String(content).split('\n')
  const sections = []
  let index = 0
  while (index < lines.length) {
    const headingMatch = /^###\s+(.*?)\s*$/.exec(lines[index])
    if (headingMatch === null) {
      index += 1
      continue
    }
    const headingLine = index
    const heading = headingMatch[1]
    // 小节到下一个任意级别标题（#/##/###…）或文件末尾
    let end = index + 1
    while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end += 1
    // 收集节内 yaml 围栏块
    const blocks = []
    let cursor = index + 1
    while (cursor < end) {
      if (/^```ya?ml\s*$/i.test(lines[cursor].trim())) {
        const start = cursor
        let close = cursor + 1
        while (close < end && lines[close].trim() !== '```') close += 1
        if (close >= end) break // 未闭合：不认，停止扫块
        const body = lines.slice(start + 1, close).join('\n')
        let row = null
        try {
          const parsed = YAML.parse(body)
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) row = parsed
        } catch {
          row = null
        }
        blocks.push({ startLine: start, endLine: close, row })
        cursor = close + 1
        continue
      }
      cursor += 1
    }
    sections.push({ heading, headingLine, endLine: end, blocks })
    index = end
  }
  return { sections }
}

/** 渲染 heading 模板（{field} 占位符 → 存储行字段值）；缺字段返回 null。 */
function renderHeading(template, row) {
  let ok = true
  const text = template.replace(/\{([^{}]+)\}/g, (_, name) => {
    const value = row[name.trim()]
    if (value === undefined || value === null || String(value).trim() === '') {
      ok = false
      return ''
    }
    return String(value).trim()
  })
  return ok ? text : null
}

/** 存储行的复合主键（keyFields 全非空才算有效；返回 null 表示无效）。 */
export function storageRowKey(row, target) {
  const parts = target.keyFields.map((field) => String(row[field] ?? '').trim())
  if (parts.some((part) => part === '')) return null
  return parts.join(' · ')
}

/** 模型行 → 存储行（字段经别名；extras 直传；丢掉空值）。 */
export function rowToStorage(modelRow, target) {
  const out = {}
  for (const field of target.fields) {
    const value = modelRow[field]
    if (value === '' || value === undefined || value === null) continue
    out[target.aliases[field] ?? field] = value
  }
  for (const extra of target.extras) {
    const value = modelRow[extra.key]
    if (value === '' || value === undefined || value === null) continue
    out[extra.key] = value
  }
  return out
}

/** 存储行 → 模型行（反别名；数组保留形状供 prompt 展示）。 */
export function rowFromStorage(storageRow, target) {
  const out = {}
  const inverse = Object.fromEntries(Object.entries(target.aliases).map(([model, storage]) => [storage, model]))
  for (const field of target.fields) {
    const storage = target.aliases[field] ?? field
    const value = storageRow[storage]
    out[field] = value === undefined ? '' : Array.isArray(value) ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : String(value)
  }
  for (const extra of target.extras) {
    const value = storageRow[extra.key]
    if (value !== undefined) out[extra.key] = value
  }
  return out
}

/** 值清洗：模型输出（字符串或字符串数组）→ 合并用值。 */
function cleanExtraValue(value) {
  if (Array.isArray(value)) {
    const items = value.filter((item) => typeof item === 'string').map((item) => cleanCell(item)).filter((item) => item !== '')
    return items
  }
  return cleanCell(String(value ?? ''))
}

/**
 * 把一个存储行合并进 YAML 块对象（原地语义，返回新对象）：
 *   - 标量：新值非空才覆盖（旧值为数字、新值纯数字时保型）；
 *   - 列表：新项追加去重（旧列表顺序在前）；
 *   - 未声明的旧字段（password 等库自有键）原样保留；
 *   - 键顺序：旧块的键序在前，新键按 target 顺序追加。
 *
 * @param {Record<string, unknown>} block 旧块对象
 * @param {Record<string, unknown>} patch 新存储行（已清洗，值 string | string[]）
 * @param {StructuredTarget} target
 */
export function mergeBlockObject(block, patch, target) {
  const next = { ...block }
  for (const [key, newValue] of Object.entries(patch)) {
    const oldValue = next[key]
    if (Array.isArray(oldValue)) {
      const oldItems = oldValue.map((item) => (typeof item === 'string' ? item : String(item)))
      const addItems = Array.isArray(newValue) ? newValue : [String(newValue)]
      const seen = new Set(oldItems)
      const merged = [...oldItems]
      for (const item of addItems) {
        if (!seen.has(item)) {
          merged.push(item)
          seen.add(item)
        }
      }
      next[key] = merged
      continue
    }
    if (newValue === '' || newValue === undefined) continue
    if (typeof oldValue === 'number' && typeof newValue === 'string' && /^-?\d+(\.\d+)?$/.test(newValue)) {
      next[key] = Number(newValue)
      continue
    }
    if (Array.isArray(newValue)) {
      next[key] = newValue.length === 1 ? newValue[0] : [...newValue]
      continue
    }
    next[key] = newValue
  }
  // 键顺序：旧序在前，新键按 target（字段→extras）顺序追加
  const order = [...Object.keys(block)]
  const preferredOrder = [...target.fields.map((field) => target.aliases[field] ?? field), ...target.extras.map((extra) => extra.key)]
  for (const key of preferredOrder) {
    if (key in next && !order.includes(key)) order.push(key)
  }
  for (const key of Object.keys(next)) {
    if (!order.includes(key)) order.push(key)
  }
  return Object.fromEntries(order.map((key) => [key, next[key]]))
}

/** 序列化一个 yaml 块（含围栏）。 */
function renderYamlBlock(obj) {
  return ['```yaml', YAML.stringify(obj).replace(/\n$/, ''), '```']
}

/**
 * 合并一个 sections 目标的文档。
 *
 * 写入策略（零丢失）：
 *   1. 行按 heading 模板定位小节；小节内按复合主键匹配 YAML 块；
 *   2. 命中块 → 块内合并（mergeBlockObject），只重写该块的行范围，
 *      块外的一切（章节、说明、连接串示例、手写段落）一个字符不动；
 *   3. 小节存在但无匹配块 → 在小节内最后一个 yaml 块后追加新块；
 *   4. 小节不存在 → 文件末尾「## <title>（<date> 追加）」章下追加新小节
 *      （不猜归属章节，由用户事后归类）；
 *   5. heading 缺字段或主键不全的行 → 跳过并计入 warnings。
 *
 * @param {string | null} content 现有内容
 * @param {StructuredTarget} target
 * @param {ReadonlyArray<Record<string, string | string[]>>} modelRows 模型行（已清洗）
 * @param {string} date yyyy-mm-dd
 * @returns {{ content: string, warnings: string[], updated: number, created: number }}
 */
export function mergeSectionsDocument(content, target, modelRows, date) {
  const warnings = []
  const storageRows = modelRows.map((row) => {
    const storage = rowToStorage(row, target)
    // extras 值清洗（rowToStorage 传原值；此处统一 string|string[]）
    for (const extra of target.extras) {
      if (extra.key in storage) storage[extra.key] = cleanExtraValue(storage[extra.key])
    }
    return storage
  })

  if (content === null || content.trim() === '') {
    // 空文件：直接建标准结构（标题 + 未分类章）
    const created = []
    for (const [index, row] of storageRows.entries()) {
      const heading = renderHeading(target.heading, row)
      if (heading === null || storageRowKey(row, target) === null) {
        warnings.push(`${target.kind} 第 ${index + 1} 条缺 heading 或主键字段，已跳过。`)
        continue
      }
      created.push(row)
    }
    const lines = [`# ${target.title}`, '']
    if (created.length > 0) {
      const stamp = date === '' ? '' : `（${date} 追加）`
      lines.push(`## ${target.title}${stamp}`, '')
      for (const row of created) {
        lines.push(`### ${renderHeading(target.heading, row)}`, '', ...renderYamlBlock(row), '')
      }
    }
    return { content: `${lines.join('\n').replace(/\n+$/, '')}\n`, warnings, updated: 0, created: created.length }
  }

  const doc = parseSectionsDocument(content)
  const lines = String(content).replace(/\n+$/, '').split('\n')
  const beforeKeys = new Set()
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (block.row === null) continue
      const key = storageRowKey(block.row, target)
      if (key !== null) beforeKeys.add(`${section.heading} :: ${key}`)
    }
  }

  // 编辑收集：按行号从底向上应用（replace: [start, end] → newLines；insert: at → lines）
  const replaces = []
  const inserts = []
  const sectionByHeading = new Map(doc.sections.map((section) => [section.heading, section]))

  for (const [index, row] of storageRows.entries()) {
    const heading = renderHeading(target.heading, row)
    const key = storageRowKey(row, target)
    if (heading === null || key === null) {
      warnings.push(`${target.kind} 第 ${index + 1} 条缺 heading（${target.heading}）或主键（${target.keyFields.join('/')}）字段，已跳过。`)
      continue
    }
    const section = sectionByHeading.get(heading)
    if (section === undefined) {
      // 新小节：文件末尾未分类章（统一在 apply 阶段追加）
      inserts.push({ kind: 'section', heading, row })
      continue
    }
    const match = section.blocks.find((block) => block.row !== null && storageRowKey(block.row, target) === key)
    if (match !== undefined && match.row !== null) {
      const merged = mergeBlockObject(match.row, row, target)
      replaces.push({ start: match.startLine, end: match.endLine, lines: renderYamlBlock(merged) })
    } else {
      // 小节内追加新块：插到最后一个 yaml 块之后；没有块则插到小节末尾（下一个标题行之前）
      const at = section.blocks.length > 0 ? section.blocks[section.blocks.length - 1].endLine + 1 : section.endLine
      inserts.push({ kind: 'block', at, heading, row })
    }
  }

  // 从底向上应用 replaces（行号不漂移）
  replaces.sort((left, right) => right.start - left.start)
  for (const edit of replaces) {
    lines.splice(edit.start, edit.end - edit.start + 1, ...edit.lines)
  }
  // 同一位置的 block 追加按原顺序（at 相对原行号；replaces 之后行号已变——
  // 追加点都在对应小节内且 replaces 数量有限，为稳妥按 at 从大到小插入）
  const blockInserts = inserts.filter((item) => item.kind === 'block').sort((left, right) => right.at - left.at)
  for (const item of blockInserts) {
    const block = ['', ...renderYamlBlock(item.row)]
    if (item.at > 0 && item.at < lines.length && lines[item.at].trim() !== '') block.push('')
    lines.splice(item.at, 0, ...block)
  }

  // 新小节统一追加到文件末尾的未分类章
  const sectionInserts = inserts.filter((item) => item.kind === 'section')
  if (sectionInserts.length > 0) {
    const stamp = date === '' ? '' : `（${date} 追加）`
    lines.push('', `## ${target.title}${stamp}`, '')
    for (const item of sectionInserts) {
      lines.push(`### ${item.heading}`, '', ...renderYamlBlock(item.row), '')
    }
  }

  const nextContent = `${lines.join('\n').replace(/\n+$/, '')}\n`
  // 防丢失守卫：所有旧块的 heading::key 必须仍在
  const afterDoc = parseSectionsDocument(nextContent)
  const afterKeys = new Set()
  for (const section of afterDoc.sections) {
    for (const block of section.blocks) {
      if (block.row === null) continue
      const key = storageRowKey(block.row, target)
      if (key !== null) afterKeys.add(`${section.heading} :: ${key}`)
    }
  }
  const lost = [...beforeKeys].filter((key) => !afterKeys.has(key))
  if (lost.length > 0) {
    throw new NoteParseError(`${target.kind}（${target.file}）合并将丢失 ${lost.length} 个已有条目（${lost.slice(0, 2).map((key) => key.split(' :: ')[1]).join('、')}${lost.length > 2 ? '…' : ''}），已拒绝写入。`)
  }
  return {
    content: nextContent,
    warnings,
    updated: replaces.length,
    created: inserts.length,
  }
}

/* ---------------- 日志 ## NOTE 模块（纯追加式小节） ---------------- */

/**
 * 把一次 /ml note 的结果追加进日志文件的 ## NOTE 模块（纯函数）。
 *
 * 每次整理是一个独立的 `###` 小节，**永远追加**，从不修改模块内已有行：
 *
 *   日志模式：  ### HH:mm · 摘要
 *   周志模式：  ### yyyy-mm-dd HH:mm · 摘要
 *   小节体：    - 工作记录逐条
 *
 * 模块不存在时建在 ## MemoryLeak 模块之后（无则文件头部锚点）。
 *
 * @param {string} content 日志文件当前内容
 * @param {{ mode: 'daily' | 'weekly', date: string, time: string, summary: string, items: string[] }} input
 * @returns {string} 新内容
 */
export function insertNoteSection(content, { mode, date, time, summary, items }) {
  const heading = `### ${mode === 'weekly' ? `${date} ` : ''}${time} · ${oneLine(summary, MAX_SUMMARY)}`
  const list = items.map((item) => `- ${oneLine(item, 300)}`).filter((item) => item !== '- ')
  const lines = String(content).split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()

  const appendBlock = () => ['', heading, '', ...list]

  const headingIndex = lines.findIndex((line) => /^##\s*NOTE\s*$/i.test(line))
  if (headingIndex !== -1) {
    // 追加到模块最后一个非空行之后（下一个一/二级标题之前）
    const sectionEnd = sectionEndIndex(lines, headingIndex)
    let insertAt = sectionEnd
    while (insertAt > headingIndex + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1
    lines.splice(insertAt, 0, ...appendBlock())
    return `${lines.join('\n')}\n`
  }

  // 无 ## NOTE：建在 ## MemoryLeak 模块之后
  const mlIndex = lines.findIndex((line) => /^##\s*MemoryLeak\s*$/.test(line))
  const section = ['## NOTE', ...appendBlock()]
  if (mlIndex !== -1) {
    const at = sectionEndIndex(lines, mlIndex)
    if (at > 0 && at < lines.length && lines[at - 1].trim() !== '') section.unshift('')
    else if (at === lines.length && lines[at - 1].trim() !== '') section.unshift('')
    lines.splice(at, 0, ...section)
    return `${lines.join('\n')}\n`
  }

  // 两者皆无：文件头部锚点（配置块 / 一级标题之后）
  let at = 0
  while (at < lines.length && /^\s*[A-Za-z][\w-]*:\s\S/.test(lines[at])) at += 1
  let probe = at
  while (probe < lines.length && lines[probe].trim() === '') probe += 1
  if (probe < lines.length && /^#\s/.test(lines[probe])) at = probe + 1
  if (at > 0 && at < lines.length && lines[at - 1].trim() !== '') section.unshift('')
  lines.splice(at, 0, ...section)
  return `${lines.join('\n')}\n`
}

/** 标题模块的结束行（下一个一/二级标题或文件末尾）。 */
function sectionEndIndex(lines, headingIndex) {
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s/.test(lines[index])) return index
  }
  return lines.length
}
