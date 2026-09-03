/**
 * /ml note 的宿主胶水：区间定位（会话事件日志）→ 本地检查 → 把整理任务
 * **交给当前模型的原生回合**（agent.followup）。
 *
 * 交互与普通对话完全同构：真实回合里模型先调 memory_note_context 工具
 * 拿存量登记与记录约定，再调 memory_note_write 工具提交整理结果——写盘
 * 守卫（零丢失合并 / 表格对齐 / 字段白名单 / 备份）全部在工具里由代码执
 * 行。思考、工具卡片、最终 markdown 回复都是原生渲染，不再有任何合成事
 * 件与旁路模型调用。
 *
 * 区间语义：每次 /ml note 只整理「上一次成功整理之后 → 现在」的对话。
 * 边界有两代：
 *   - 原生纪元：最后一次成功的 memory_note_write 工具结果（surface 事件）；
 *   - 旧版纪元（升级前的会话）：成功收尾的 /ml note 命令对（command/run +
 *     command/done）。只要存在原生边界，旧版边界一律不再生效——交接命令
 *     自身的 command/done（success）只表示「任务已下发」，不代表整理完成。
 * 失败的整理（模型没调工具 / 写入被守卫拒绝）不产生成功结果，因而不构成
 * 边界：它身前的对话留给下次重试，不会丢。
 *
 * @module dsh-memoryleak/note
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname, relative } from 'node:path'
import YAML from 'yaml'
import { TodoError } from './core/errors.js'
import { realignMarkdownTables } from './core/table-align.js'
import { locateJournal, JournalIoError } from './journal.js'
import { VAULT_SETTINGS_FILENAME, readVaultNoteConfig } from './vault.js'
import {
  buildTranscript,
  DEFAULT_STRUCTURED_TARGETS,
  extractTableRows,
  findMarkdownTables,
  lostKeys,
  mergeIndexDocument,
  mergeRowsByField,
  mergeSectionsDocument,
  mergeTableDocument,
  parseIndexTitles,
  parseSectionsDocument,
  renderEntryFile,
  resolveStructuredTargets,
  rowFromStorage,
  rowToStorage,
  slugify,
  insertNoteSection,
  NoteParseError,
} from './core/note.js'

/** MOMENTO 知识库目录名（Vault 根下）。 */
export const MOMENTO_DIR = 'MOMENTO'

/**
 * 原生整理写入工具名（注册见 tools.js）。collectNoteItems 据此：
 *   1. 把它的成功 tool/result 当作整理边界（原生纪元）；
 *   2. 把它的 tool/result 排除出下个整理区间——是动作记录，不是对话内容。
 */
export const NOTE_TOOL_NAME = 'memory_note_write'

/** /ml note 交接消息（与旧版合成回执）共用的固定标记。 */
export { NOTE_MARK, ASK_MARK, MAIL_MARK } from './core/command.js'
import { NOTE_MARK, ASK_MARK, MAIL_MARK } from './core/command.js'

/** 命令生成的消息（交接任务 / 旧版回执）前缀集合——都不是对话内容。 */
const ML_COMMAND_MARKS = [NOTE_MARK, ASK_MARK, MAIL_MARK]

/** 消息文本是否以任一 /ml 命令标记开头。 */
function hasMlMark(text) {
  return ML_COMMAND_MARKS.some((mark) => text.startsWith(mark))
}

/* ---------------- 1. 区间定位与投影（本地检查 + 边界） ---------------- */

/** command/run 是不是一次 /ml note 调用（args 为空或以 note 开头）。 */
function isNoteRun(event) {
  if (event.type !== 'command/run') return false
  const data = event.data
  if (data === null || typeof data !== 'object') return false
  if (data.name !== 'ml') return false
  const args = typeof data.args === 'string' ? data.args.trim() : ''
  return args === 'note' || args.startsWith('note ') || args.startsWith('note\u3000')
}

/** 一次 memory_note_write 的成功结果事件 seq（找不到返回 -1）。 */
function lastSuccessfulNoteWriteSeq(events) {
  const calls = new Map() // callId → tool/call seq
  let best = -1
  for (const event of events) {
    if (event.type === 'tool/call') {
      if (event.data?.name === NOTE_TOOL_NAME && typeof event.data?.callId === 'string') {
        calls.set(event.data.callId, event.seq)
      }
      continue
    }
    if (event.type !== 'tool/result') continue
    const message = event.data?.message
    const callId = message?.source?.kind === 'tool' ? message.source.callId : undefined
    if (typeof callId !== 'string' || !calls.has(callId)) continue
    const block = Array.isArray(message?.content) ? message.content[0] : undefined
    if (block?.type === 'tool-result' && block.isError !== true) best = Math.max(best, event.seq)
  }
  return best
}

/**
 * 收集本次要整理的对话区间，投影为 transcript 条目。
 *
 * 边界（原生优先）：
 *   1. 存在原生边界：最后一次成功的 memory_note_write 结果事件；
 *   2. 否则旧版边界：回扫上一个成功收尾的 /ml note 命令对（升级前的会话）。
 * 失败、取消的整理不构成边界——身前对话留给下次重试。
 *
 * @param {{ events: ReadonlyArray<object>, seq?: number }} session 会话（用 events 与 surface 折叠）
 * @param {string | number} currentCommandId 当前 /ml note 的 commandId（其 command/run 已在日志中）
 * @returns {{ items: Array<{ role: 'user'|'assistant'|'tool', name?: string, text: string }>, hasBoundary: boolean, fromSeq: number, toSeq: number }}
 */
export function collectNoteItems(session, currentCommandId) {
  const events = session.events
  const currentIndex = events.findIndex(
    (event) => event.type === 'command/run' && event.data?.commandId === currentCommandId,
  )
  // 正常路径：当前 run 已在日志里（dsh-commands 先 append 再调 handler），区间上界
  // 就是它。防御分支（失配）：上界取日志末尾的下一个 seq，整个日志都是候选区间。
  const currentSeq =
    currentIndex !== -1
      ? events[currentIndex].seq
      : events.length > 0
        ? events[events.length - 1].seq + 1
        : Number.MAX_SAFE_INTEGER

  // 原生边界：最后一次成功的 memory_note_write 结果。
  const nativeBoundarySeq = lastSuccessfulNoteWriteSeq(events)
  if (nativeBoundarySeq !== -1) {
    return projectInterval(events, nativeBoundarySeq, currentSeq, true)
  }

  // 旧版边界：回扫上一个成功收尾的 /ml note 命令对（升级前的会话才走这里）。
  let boundarySeq = -1
  for (let index = (currentIndex === -1 ? events.length : currentIndex) - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!isNoteRun(event)) continue
    const done = events.find(
      (candidate) =>
        candidate.seq > event.seq &&
        candidate.seq <= currentSeq &&
        candidate.type === 'command/done' &&
        candidate.data?.commandId === event.data.commandId,
    )
    // 只有**成功收尾**（command/done 为 success）的 note 才构成边界——
    // 失败/中止的 note 不消化它身前的对话，继续回溯到更早的最后一次成功
    // note（重试不丢内容）。
    if (done === undefined || done.data?.kind !== 'success') continue
    boundarySeq = done.seq
    break
  }

  return projectInterval(events, boundarySeq, currentSeq, boundarySeq !== -1)
}

/** 把 (boundarySeq, currentSeq) 开区间里的事件投影为 transcript 条目。 */
function projectInterval(events, boundarySeq, currentSeq, hasBoundary) {
  // callId → 工具名；memory_note_write 的结果不是对话内容，排除出区间
  const toolNames = new Map()
  const noteWriteCalls = new Set()
  for (const event of events) {
    if (event.type !== 'tool/call' || typeof event.data?.callId !== 'string') continue
    toolNames.set(event.data.callId, event.data.name ?? '')
    if (event.data.name === NOTE_TOOL_NAME) noteWriteCalls.add(event.data.callId)
  }

  const items = []
  for (const event of events) {
    if (event.seq <= boundarySeq || event.seq >= currentSeq) continue
    if (event.surfaceOp !== 'append') continue
    if (event.type === 'user/message') {
      const text = joinUserText(event.data)
      // /ml 命令的交接任务（📌 /ml note …等）是命令生成物，不是对话内容
      if (text !== '' && !hasMlMark(text)) items.push({ role: 'user', text })
    } else if (event.type === 'assistant/message') {
      const text = joinAssistantText(event.data?.message)
      // 旧版命令的合成回执（📌 /ml note 已整理 等）：不是对话内容
      if (text !== '' && !hasMlMark(text)) items.push({ role: 'assistant', text })
    } else if (event.type === 'tool/result') {
      const message = event.data?.message
      const callId = message?.source?.kind === 'tool' ? message.source.callId : undefined
      if (typeof callId === 'string' && noteWriteCalls.has(callId)) continue
      const name = typeof callId === 'string' ? toolNames.get(callId) ?? '' : ''
      const text = joinToolResultText(message)
      if (text !== '') items.push({ role: 'tool', name: name || undefined, text })
    }
  }
  return { items, hasBoundary, fromSeq: boundarySeq + 1, toSeq: currentSeq - 1 }
}

/** user/message 的可见文本：text 块拼接，滤掉 harness 注入的 <system-reminder> 整块。 */
function joinUserText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : []
  const texts = []
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const text = block.text.trim()
    if (text === '') continue
    if (text.startsWith('<system-reminder>') && text.endsWith('</system-reminder>')) continue
    texts.push(block.text)
  }
  return texts.join('\n')
}

/** assistant/message 的可见文本：text 块 + 工具调用摘要行（reasoning 丢弃）。 */
function joinAssistantText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text)
    } else if (block?.type === 'tool-call') {
      const args = typeof block.arguments === 'string' ? block.arguments : ''
      parts.push(`[调用工具 ${block.name ?? ''} ${args.slice(0, 200)}]`)
    }
  }
  return parts.join('\n')
}

/** tool/result 的可见文本：content 是字符串或块数组，取文本部分。 */
function joinToolResultText(message) {
  const block = Array.isArray(message?.content) ? message.content[0] : undefined
  if (block === undefined || block?.type !== 'tool-result') return ''
  const content = block.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part?.type === 'text' && typeof part.text === 'string') return part.text
        if (part?.type === 'image') return '[图片]'
        return part?.type ? `[${part.type}]` : ''
      })
      .filter((text) => text !== '')
      .join('\n')
  }
  return ''
}

/* ---------------- 2. 落盘 ---------------- */

/** 两位补零。 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 安全读写 vault 内文件（读写故障 → JournalIoError，命令层统一渲染）。 */
async function readVaultFile(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new JournalIoError(`读取 ${path} 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function writeVaultFile(path, content) {
  try {
    await writeFile(path, alignOnWrite(path, content), 'utf8')
  } catch (error) {
    throw new JournalIoError(`写入 ${path} 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 备份目录名（vault 根下；在默认扫描排除列表里）。 */
export const BACKUP_DIR = '.backup'

/**
 * 写时 lint：markdown 文件写入前把全文件表格列宽重新对齐（只补空白，
 * 单元格内容逐字保留；见 core/table-align.js）。非 .md 原样写入。
 */
function alignOnWrite(path, content) {
  return path.toLowerCase().endsWith('.md') ? realignMarkdownTables(content) : content
}

/**
 * 修改一个已存在的知识文件前做一次备份：进 vault 的 .backup/ 隐藏目录，
 * 保留原相对路径结构 + 时间戳后缀（多次备份不互相覆盖）。默认**不备份**
 * （vault 常由 git 管理，版本历史就是兜底）；仅当 vault 配置 noteBackup:
 * true 时启用。备份失败不阻塞（尽力而为），成功返回备份路径。
 */
async function backupExistingFile(vaultDir, path, existing, stamp) {
  if (existing === null) return null
  try {
    const rel = relative(vaultDir, path).replace(/\\/g, '/')
    const backupPath = join(vaultDir, BACKUP_DIR, `${rel}.${stamp}.bak`)
    await mkdir(dirname(backupPath), { recursive: true })
    await writeFile(backupPath, existing, 'utf8')
    return backupPath
  } catch {
    return null
  }
}

/** YAML 目标的已知行读取：文件须是「对象列表」，值统一转字符串；否则空。 */
function yamlRowsOf(text) {
  let parsed
  try {
    parsed = YAML.parse(text)
  } catch {
    return null // 解析失败（调用方决定如何报告）
  }
  if (!Array.isArray(parsed)) return null
  const rows = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const row = {}
    for (const [key, value] of Object.entries(item)) {
      row[key] = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
    }
    rows.push(row)
  }
  return rows
}

/** YAML 目标序列化（存储字段在前：fields（经别名）+ extras，其余额外字段在后）。 */
function renderYamlDocument(rows, target) {
  const storageKeys = [...target.fields.map((field) => target.aliases[field] ?? field), ...target.extras.map((extra) => extra.key)]
  const ordered = rows.map((row) => {
    const orderedRow = {}
    for (const key of storageKeys) orderedRow[key] = row[key] ?? ''
    for (const key of Object.keys(row)) {
      if (!(key in orderedRow)) orderedRow[key] = row[key]
    }
    return orderedRow
  })
  return `# ${target.title}（由 /ml note 按 ${target.keyFields.join('/')} 主键合并维护；额外字段原样保留）\n` + YAML.stringify(ordered)
}

/**
 * 把解析后的整理结果写进 Vault（memory_note_write 工具的执行体）。
 *
 * structured 落盘按 targets（vault 配置 or 内置默认）分派：table 走
 * mergeTableDocument，yaml 走 mergeRowsByField + YAML 序列化，sections
 * 走 mergeSectionsDocument；所有路径都有防丢失守卫。备份默认关闭
 * （vault 常由 git 管理）；backup: true 时改前备份进 vault 的 .backup/
 * 目录（保留相对路径 + 时间戳）。yaml 目标文件存在但不是「对象列表」时
 * **跳过并警告**，绝不重写。
 *
 * @param {object} input
 * @param {string} input.vaultDir Vault 绝对路径
 * @param {object} input.settings 生效设置（journalMode / 模板）
 * @param {() => Date} [input.now]
 * @param {{ summary: string, notes: string[], entries: Array<{title: string, body: string, tags: string[]}>, structured: Record<string, Array<Record<string, string>>> }} input.parsed
 * @param {Record<string, import('./core/note.js').StructuredTarget>} [input.targets] 解析后的结构化目标（缺省用内置默认）
 * @returns {Promise<{ momentoFiles: string[], indexFile: string | null, noteFile: string, noteMode: 'daily'|'weekly', created: boolean, summary: string, time: string, date: string, warnings: string[] }>}
 */
export async function persistNoteResult({ vaultDir, settings, now = () => new Date(), parsed, targets = DEFAULT_STRUCTURED_TARGETS, backup = false }) {
  const momentoDir = join(vaultDir, MOMENTO_DIR)
  try {
    await mkdir(momentoDir, { recursive: true })
  } catch (error) {
    throw new JournalIoError(`创建 ${MOMENTO_DIR}/ 失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const at = now()
  const date = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`
  const warnings = []
  // 备份戳（一次执行一个，同批备份可归组；文件名安全字符）
  const backupStamp = `${date}T${time.replace(':', '-')}${String(at.getSeconds()).padStart(2, '0')}`
  /** 按配置备份（默认关闭：git 即兜底）。 */
  const maybeBackup = backup ? (path, existing) => backupExistingFile(vaultDir, path, existing, backupStamp) : async () => null

  // 知识条目：一文件一条，同 slug 追加「## 更新」分节（纯追加）
  const written = []
  const indexRows = []
  for (const entry of parsed.entries) {
    const slug = slugify(entry.title)
    const path = join(momentoDir, `${slug}.md`)
    const existing = await readVaultFile(path)
    await maybeBackup(path, existing)
    await writeVaultFile(path, renderEntryFile({ title: entry.title, body: entry.body, date, existing }))
    written.push(`${MOMENTO_DIR}/${slug}.md`)
    indexRows.push({ slug, title: entry.title, date, summary: parsed.summary })
  }

  // 结构化知识：按 target 分派（table / yaml / sections），代码渲染、按主键合并
  for (const [kind, rows] of Object.entries(parsed.structured)) {
    if (!Array.isArray(rows) || rows.length === 0) continue
    const target = targets[kind]
    if (target === undefined) continue
    const path = join(vaultDir, target.file)
    await mkdir(dirname(path), { recursive: true }) // 自定义目标可能在任意子目录
    const existing = await readVaultFile(path)
    if (target.format === 'yaml') {
      let knownRows = []
      if (existing !== null) {
        const parsedRows = yamlRowsOf(existing)
        if (parsedRows === null) {
          warnings.push(`${target.file} 不是 YAML 对象列表，未写入（跳过保护；请检查文件或 noteStructured 配置）。`)
          continue
        }
        knownRows = parsedRows
      }
      const storageRows = rows.map((row) => rowToStorage(row, target))
      const merged = mergeRowsByField(knownRows, storageRows, target)
      const keyOf = (row) => target.keyFields.map((field) => String(row[field] ?? '').trim()).join(' · ')
      const lost = lostKeys(knownRows.map(keyOf), merged.map(keyOf))
      if (lost.length > 0) {
        throw new NoteParseError(`${kind}（${target.file}）合并将丢失 ${lost.length} 个已有主键（${lost.slice(0, 3).join('、')}${lost.length > 3 ? '…' : ''}），已拒绝写入。`)
      }
      await maybeBackup(path, existing)
      await writeVaultFile(path, renderYamlDocument(merged, target))
      written.push(target.file)
      continue
    }
    if (target.format === 'sections') {
      const result = mergeSectionsDocument(existing, target, rows, date)
      warnings.push(...result.warnings)
      await maybeBackup(path, existing)
      await writeVaultFile(path, result.content)
      written.push(target.file)
      continue
    }
    const next = mergeTableDocument(existing, target, rows, date)
    assertNoRowLossForTarget(existing, target, next, `${kind}（${target.file}）`)
    await maybeBackup(path, existing)
    await writeVaultFile(path, next)
    written.push(target.file)
  }

  // index：知识条目或结构化表有产出时刷新
  let indexFile = null
  if (parsed.entries.length > 0 || Object.values(parsed.structured).some((rows) => rows.length > 0)) {
    const indexPath = join(momentoDir, 'index.md')
    const existing = await readVaultFile(indexPath)
    await maybeBackup(indexPath, existing)
    await writeVaultFile(indexPath, mergeIndexDocument(existing, indexRows))
    indexFile = `${MOMENTO_DIR}/index.md`
  }

  // 日志 ## NOTE
  const located = await locateJournal({ cwd: vaultDir, settings, now })
  const next = insertNoteSection(located.content, {
    mode: located.mode,
    date: located.date,
    time,
    summary: parsed.summary,
    items: parsed.notes,
  })
  await writeVaultFile(located.path, next)

  return {
    momentoFiles: written,
    indexFile,
    noteFile: located.file,
    noteMode: located.mode,
    created: located.created,
    summary: parsed.summary,
    date,
    time,
    warnings,
  }
}

/** table 目标的防丢失守卫（任意 target，内置/自定义表头通用）。 */
function assertNoRowLossForTarget(content, target, next, label) {
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
    throw new NoteParseError(`${label} 合并将丢失 ${lost.length} 个已有主键（${lost.slice(0, 3).join('、')}${lost.length > 3 ? '…' : ''}），已拒绝写入。`)
  }
}

/* ---------------- 3. 已知状态（memory_note_context 工具的数据面） ---------------- */

/**
 * 读取 Vault 里已有的知识状态（喂给模型，引导增量修改而非全量重建）。
 * 按 targets 分派：table 读匹配表格、yaml 读对象列表、sections 读小节内
 * 的 yaml 块。全部转为**模型空间**行（反别名、数组保留形状）供 prompt 展示。
 * 读取失败按空处理——已知信息是增强项，不能阻塞整理。
 *
 * @param {string} vaultDir
 * @param {Record<string, import('./core/note.js').StructuredTarget>} targets
 * @returns {Promise<{ structured: Record<string, Array<Record<string, string | string[]>>>, titles: string[] }>}
 */
export async function readKnownState(vaultDir, targets = DEFAULT_STRUCTURED_TARGETS) {
  const structured = {}
  for (const [kind, target] of Object.entries(targets)) {
    let content = null
    try {
      content = await readVaultFile(join(vaultDir, target.file))
    } catch {
      content = null
    }
    if (content === null || content.trim() === '') {
      structured[kind] = []
      continue
    }
    if (target.format === 'yaml') {
      const rows = yamlRowsOf(content)
      structured[kind] = rows === null ? [] : rows.map((row) => rowFromStorage(row, target))
    } else if (target.format === 'sections') {
      const doc = parseSectionsDocument(content)
      const rows = []
      for (const section of doc.sections) {
        for (const block of section.blocks) {
          if (block.row === null) continue
          rows.push(rowFromStorage(block.row, target))
        }
      }
      structured[kind] = rows
    } else {
      structured[kind] = extractTableRows(content, target)
    }
  }
  let titles = []
  try {
    const index = await readVaultFile(join(vaultDir, MOMENTO_DIR, 'index.md'))
    titles = parseIndexTitles(index).map((entry) => entry.title)
  } catch {
    titles = []
  }
  return { structured, titles }
}

/**
 * 读取 note-skill 文件（vault 限定记录约定，注入整理约束）。
 * 未配置 / 文件不存在 → 空文本；读取失败 → 空文本 + 警告。
 *
 * @param {string} vaultDir
 * @param {string} skillPath vault 相对路径（空 = 未配置）
 * @returns {Promise<{ text: string, warning: string | null }>}
 */
export async function readSkillFile(vaultDir, skillPath) {
  if (skillPath === '') return { text: '', warning: null }
  const normalized = skillPath.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').some((part) => part === '..')) {
    return { text: '', warning: `noteSkill 路径必须是 vault 相对路径（收到 "${skillPath}"），已忽略。` }
  }
  try {
    const content = await readVaultFile(join(vaultDir, normalized))
    if (content === null) return { text: '', warning: null }
    return { text: clipText(content, 2_000), warning: null }
  } catch {
    return { text: '', warning: `noteSkill 文件 "${skillPath}" 读取失败，本次未注入记录约定。` }
  }
}

/** 限长截断（尾加省略号）。 */
function clipText(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/* ---------------- 4. 命令编排（薄：本地检查 → 交接给原生回合） ---------------- */

/**
 * /ml note：本地检查后，把整理任务作为一条 user 消息交给当前模型的原生
 * 回合（agent.followup，与官方 /goal 命令同款通道）。命令本身立即返回；
 * 整理在真实回合里完成——模型调 memory_note_context / memory_note_write
 * 两个工具，思考、工具卡片、回复全部原生渲染。
 *
 * @param {import('@deepseek-ai/cordis').Context} _ctx
 * @param {{ followup?: Function, session?: { events?: ReadonlyArray<object> } }} agent
 * @param {{ commandId: string, signal: AbortSignal }} invocation
 * @param {string} vaultDir
 * @param {object} _settings
 * @returns {Promise<{ kind: 'success', text: string } | { kind: 'error', text: string }>}
 */
export async function runNoteCommand(_ctx, agent, invocation, vaultDir, _settings) {
  const { items, hasBoundary } = collectNoteItems(agent.session, invocation.commandId)
  if (items.length === 0) {
    return {
      kind: 'error',
      text: hasBoundary ? '上一个 /ml note 之后没有新的对话内容，无需整理。' : '会话里还没有可整理的对话内容。',
    }
  }
  const transcript = buildTranscript(items)
  if (transcript.text.trim() === '') {
    return { kind: 'error', text: '区间内的对话内容为空，无需整理。' }
  }
  // vault 限定配置：noteStructured（目标格式声明）+ noteSkill（记录约定）
  const noteConfig = await readVaultNoteConfig(vaultDir)
  const { errors: targetErrors } = resolveStructuredTargets(noteConfig.noteStructured)
  if (targetErrors.length > 0) {
    return { kind: 'error', text: `vault 的 noteStructured 配置有误，未执行整理：\n${targetErrors.map((error) => `- ${error}`).join('\n')}\n（配置在 Vault 的 ${VAULT_SETTINGS_FILENAME}，详见 README）` }
  }

  const scope = hasBoundary ? '上一个 /ml note → 本次' : '会话开始 → 本次'
  const handoff = [
    `${NOTE_MARK} 整理任务（${scope}，${transcript.included}/${transcript.total} 条消息${transcript.truncated ? '，超预算已裁剪' : ''}）`,
    `今天是 ${noteDate()}。请把上面这段对话整理进 MemoryLeak 知识库（Vault：${vaultDir}）：`,
    '',
    '1. 先调用 memory_note_context 工具：获取存量登记（结构化表格行、已有知识标题）、记录约定（noteSkill）与结构化字段说明。',
    '2. 再调用 memory_note_write 工具提交整理结果，参数即整理协议：',
    '   - summary：本段工作的一句话总结（不超过 80 字）',
    '   - note：工作流水条目（3–8 条，一句话一条；没有就给空数组）',
    '   - momento.entries：值得长期保留的知识（title 简短稳定 / body 正文 / tags；没有就给空数组）',
    '   - structured：databases / servers / credentials / glossary，只登记对话中真实出现的信息，字段没提到就留空字符串',
    '   - 严禁记录明文密码或密钥；credentials 只登记「在哪、什么账号」',
    '3. 增量增补：context 里的存量条目只输出新增或有变化的部分，不要重复输出已有内容。',
    '4. 提交成功后，用一两句话向用户确认写了哪些文件即可。',
  ].join('\n')
  if (typeof agent?.followup !== 'function') {
    return { kind: 'error', text: '当前环境不支持把任务交给模型（缺少 agent.followup 通道），无法执行 /ml note。' }
  }
  agent.followup({
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: handoff }],
    source: { kind: 'user' },
  })
  return {
    kind: 'success',
    text: `整理任务已交给当前模型（${scope}，${transcript.included}/${transcript.total} 条消息）。它会在对话里直接整理：思考、工具调用与结果原生显示。`,
  }
}

/** 今天日期（yyyy-mm-dd）。 */
function noteDate() {
  const at = new Date()
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
}
