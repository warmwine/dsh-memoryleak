/**
 * /ml mail 的核心纯逻辑（无 fs、无网络、无 LLM，全部可直接测试）：
 *   1. 读信窗口 —— 上次 read 结束时刻（vault 设置里的 mailState.lastReadEnd）
 *      → (start, now]；没有状态则「今天 00:00 → 现在」（默认当天）。
 *   2. 邮件筛选与预算 —— 时间窗过滤、按上限截断（保最新）、正文按预算
 *      自适应截断（纯代码，下载与分析之间零模型参与的裁决都在这里）。
 *   3. prompt 组装 —— 邮件按时间序分段 + 严格 JSON 输出协议。
 *   4. 输出解析 —— 容错剥 fence、字段白名单、条数/长度上限（与 note 同款
 *      的防注入清洗），条目不合规逐条告警而非整体失败。
 *   5. 流式 digest —— 模型边输出边把已完成部分格式化为 markdown 分段
 *      （前缀补全式增量解析，任何输入都不抛错）。
 *
 * @module dsh-memoryleak/core/mail
 */
import { TodoError } from './errors.js'

/** /ml mail read 分析输出的 maxTokens（事件 + 待办 + 待阅，给足）。 */
export const MAIL_MAX_TOKENS = 6_144
/** 单封邮件正文的截断上限（fitMailEmailsToBudget 会按预算自适应调小）。 */
export const MAIL_BODY_CLIP = 4_000
/** 全部邮件正文加起来的字符预算（约 20k token）。 */
export const MAIL_TOTAL_BUDGET_CHARS = 80_000
/** 自适应截断的下限（低于此值不如丢最旧的邮件）。 */
export const MAIL_BODY_CLIP_FLOOR = 300

/** 模型输出条目数 / 长度上限（防注入与跑飞）。 */
export const MAX_MAIL_SUMMARY = 300
export const MAX_MAIL_EVENT = 300
export const MAX_MAIL_EVENTS = 20
export const MAX_MAIL_ITEMS = 30
export const MAX_MAIL_TEXT = 200
export const MAX_MAIL_META = 120

/** 模型输出无法解析（命令层转用户可见结果）。 */
export class MailParseError extends TodoError {}

/* ---------------- 1. 读信窗口 ---------------- */

/**
 * 邮箱是否已配置可用：主机、账号非空，且按登陆方式配有凭证
 * （password → 密码/授权码；xoauth2 → access token）。
 *
 * @param {Record<string, unknown> | null | undefined} section 设置段（或其子集）
 * @returns {boolean}
 */
export function isMailConfigured(section) {
  const host = typeof section?.mailHost === 'string' ? section.mailHost.trim() : ''
  const user = typeof section?.mailUser === 'string' ? section.mailUser.trim() : ''
  const secret =
    section?.mailAuth === 'xoauth2'
      ? typeof section?.mailToken === 'string'
        ? section.mailToken.trim()
        : ''
      : typeof section?.mailPassword === 'string'
        ? section.mailPassword.trim()
        : ''
  return host !== '' && user !== '' && secret !== ''
}

/** 本地时区当天零点。 */
function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/**
 * 解析 vault 里存的 lastReadEnd（ISO 字符串）；非法 / 未来时刻 → null
 * （时钟回拨或手改坏都按「没有状态」处理，回退当天）。
 *
 * @param {string | undefined | null} lastReadEnd
 * @returns {Date | null}
 */
export function parseMailStateEnd(lastReadEnd) {
  if (typeof lastReadEnd !== 'string' || lastReadEnd.trim() === '') return null
  const date = new Date(lastReadEnd.trim())
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * 计算本次 /ml mail read 的时间窗 (start, end]。
 *
 * @param {{ lastReadEnd?: string | null, now?: Date }} input
 * @returns {{ start: Date, end: Date, mode: 'incremental' | 'today' }}
 */
export function resolveMailWindow({ lastReadEnd, now = () => new Date() } = {}) {
  const end = typeof now === 'function' ? now() : now instanceof Date ? now : new Date()
  const previous = parseMailStateEnd(lastReadEnd)
  if (previous !== null && previous.getTime() < end.getTime()) {
    return { start: previous, end, mode: 'incremental' }
  }
  return { start: startOfDay(end), end, mode: 'today' }
}

/** Date → 本地 'yyyy-mm-dd HH:mm'（人类可读的窗口标签用）。 */
export function formatMailMoment(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 时间窗的人类标签。
 *
 * @param {{ start: Date, end: Date, mode: 'incremental' | 'today' }} window
 * @returns {string}
 */
export function mailWindowLabel(window) {
  return window.mode === 'incremental'
    ? `上次读完（${formatMailMoment(window.start)}）→ 现在`
    : `今天 00:00（${formatMailMoment(window.start).slice(0, 10)}）→ 现在`
}

/* ---------------- 2. 邮件筛选与预算 ---------------- */

/**
 * 候选邮件按时间窗过滤并截断：只保留时间 ∈ (start, end] 的邮件，时间升序；
 * 超过 maxEmails 时保留最新的（丢最旧的，截断计数如实报告）。IMAP SEARCH
 * SINCE 只有日期粒度，所以精确到分钟的过滤在这里做（纯代码）。条目用
 * id 标识（宿主侧传 UID），字段名保持通用。
 *
 * @param {ReadonlyArray<{ id: number, date: Date }>} candidates SEARCH 命中的候选（date = internaldate，缺省回退信头日期）
 * @param {{ start: Date, end: Date }} window
 * @param {number} maxEmails
 * @returns {{ kept: Array<{ id: number, date: Date }>, dropped: number }}
 */
export function selectMailEmails(candidates, window, maxEmails) {
  const inWindow = candidates.filter(
    (item) => item.date.getTime() > window.start.getTime() && item.date.getTime() <= window.end.getTime(),
  )
  inWindow.sort((left, right) => left.date.getTime() - right.date.getTime())
  const limit = Math.max(1, Math.floor(maxEmails))
  const dropped = Math.max(0, inWindow.length - limit)
  return { kept: dropped > 0 ? inWindow.slice(-limit) : inWindow, dropped }
}

/**
 * 邮件正文按总预算自适应截断：先整体用 perEmail（MAIL_BODY_CLIP），超预算
 * 则对半下调（下限 MAIL_BODY_CLIP_FLOOR），仍超则丢最旧的邮件直到塞得下。
 *
 * @param {ReadonlyArray<{ text: string }>} emails 时间升序
 * @returns {{ emails: Array<{ text: string }>, dropped: number, perEmail: number }}
 */
export function fitMailEmailsToBudget(emails, budget = MAIL_TOTAL_BUDGET_CHARS, perEmail = MAIL_BODY_CLIP, floor = MAIL_BODY_CLIP_FLOOR) {
  if (emails.length === 0) return { emails: [], dropped: 0, perEmail }
  const totalOf = (list) => list.reduce((sum, item) => sum + Math.min(item.text.length, perEmail), 0)
  const clipItem = (item, clip) => ({
    ...item,
    text: item.text.length <= clip ? item.text : `${item.text.slice(0, clip - 1)}…`,
  })
  while (perEmail >= floor) {
    if (totalOf(emails) <= budget) return { emails: emails.map((item) => clipItem(item, perEmail)), dropped: 0, perEmail }
    perEmail = Math.floor(perEmail / 2)
  }
  perEmail = floor
  let kept = emails
  while (kept.length > 1 && totalOf(kept) > budget) kept = kept.slice(1)
  return { emails: kept.map((item) => clipItem(item, floor)), dropped: emails.length - kept.length, perEmail: floor }
}

/* ---------------- 2.5 信任证书（自建服务器内部/自签证书的产品内闭环） ---------------- */

/** 证书 PEM 块的正则（连续一段 BEGIN/END 为一张证书）。 */
const PEM_BLOCK_RE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g

/** 按证书内容去重合并信任证书（PEM 多段；输入可以是空/杂文本）。 */
export function mergeTrustedCertificates(existing, add) {
  const bodyOf = (block) => block.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
  const seen = new Set()
  const merged = []
  for (const block of [...(String(existing ?? '').match(PEM_BLOCK_RE) ?? []), ...(String(add ?? '').match(PEM_BLOCK_RE) ?? [])]) {
    const trimmed = block.trim()
    const body = bodyOf(trimmed)
    if (body === '' || seen.has(body)) continue
    seen.add(body)
    merged.push(trimmed)
  }
  return merged.join('\n') + (merged.length > 0 ? '\n' : '')
}

/** 已保存的信任证书里是否已包含某张证书（按内容比较；空输入视为已包含）。 */
export function hasTrustedCertificate(existing, pem) {
  const bodyOf = (block) => block.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
  const target = bodyOf(String(pem ?? ''))
  if (target === '') return true
  for (const block of String(existing ?? '').match(PEM_BLOCK_RE) ?? []) {
    if (bodyOf(block) === target) return true
  }
  return false
}

/* ---------------- 2.6 待办清单清洗（memory_mail_commit 提交的寻址清单） ---------------- */

/** 单行清洗：去控制字符、压空白、限长（尾加省略号）。 */
function clipLine(value, max) {
  const flat = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * 清洗 memory_mail_commit 提交的待办清单（供 /ml mail todo <序号> 寻址）：
 * 条数上限、text 必填、期限格式白名单、来源字段限长。不合规逐条告警。
 *
 * @param {unknown} raw 模型提交的 todos 参数
 * @param {number} [max] 条数上限（默认 30）
 * @returns {{ items: Array<{ text: string, due: string, from: string, subject: string }>, warnings: string[] }}
 */
export function sanitizeMailTodoItems(raw, max = 30) {
  if (raw === undefined || raw === null) return { items: [], warnings: [] }
  if (!Array.isArray(raw)) return { items: [], warnings: ['todos 不是数组，已忽略。'] }
  const items = []
  const warnings = []
  for (const row of raw.slice(0, max)) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const text = clipLine(row.text, 200)
    if (text === '') {
      warnings.push('有一条待办缺 text，已丢弃。')
      continue
    }
    const due = typeof row.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.due.trim()) ? row.due.trim() : ''
    items.push({
      text,
      due,
      from: clipLine(row.from, 120),
      subject: clipLine(row.subject, 120),
    })
  }
  if (raw.length > max) warnings.push(`待办超过 ${max} 条上限，只保留前 ${max} 条。`)
  return { items, warnings }
}

/* ---------------- 3. prompt 组装 ---------------- */

/**
 * 组装 /ml mail read 的分析 prompt：规则（只依据邮件、严格 JSON、中文）+
 * 邮件分段（时间序，带序号/时间/发件人/主题/正文）。
 *
 * @param {{ emails: ReadonlyArray<{ index?: number, date: string, from: string, subject: string, text: string }>, windowLabel: string, date: string, dropped?: number, folder?: string }} input
 * @returns {string}
 */
export function buildMailReadPrompt({ emails, windowLabel, date, dropped = 0, folder = 'INBOX' }) {
  const blocks = emails.map((mail, position) => {
    const index = typeof mail.index === 'number' ? mail.index : position + 1
    return [
      `### 邮件 ${index} · ${mail.date}`,
      `发件人：${mail.from}`,
      `主题：${mail.subject}`,
      '正文：',
      mail.text,
    ].join('\n')
  })
  const notes = []
  if (dropped > 0) notes.push(`注意：原窗口内共有 ${emails.length + dropped} 封，因预算只带入了最新的 ${emails.length} 封（丢的是最旧的）。`)
  notes.push('附件未下载，正文为纯文本提取（富文本排版已丢失）。')
  return [
    '你是「MemoryLeak」的邮件阅读助手。用户刚从工作邮箱下载了一批新邮件，请你通读并提取要点。',
    '',
    '输出规则：',
    '- 只依据下面这些邮件的内容，不要编造；邮件里没有可提取的就给空数组。',
    '- 用中文；严格输出一个 JSON 对象（不要 markdown 代码围栏、不要多余文字），结构：',
    '  {"summary": "一句话总评这批邮件（整体重要程度与主题）",',
    '   "events": ["重要事件：一句话一条，按时间序"],',
    '   "todos": [{"text": "需要用户处理的事", "due": "yyyy-mm-dd 或空串", "from": "相关发件人", "subject": "相关邮件主题"}],',
    '   "reads": [{"text": "值得抽空一读的内容", "from": "相关发件人", "subject": "相关邮件主题", "note": "为什么值得读，可空串"}]}',
    '- todos 只收「需要用户动手/跟进」的事；邮件里明说了期限的才填 due。',
    '- reads 收「不用动手但值得知道/一读」的内容（通知、分享、周报等）。',
    '- events 收对用户重要的动态（人事、变更、里程碑、风险），没有就空数组。',
    '- 每个字段都控制在长度上限内：summary ≤ 300 字，单条 event ≤ 300 字，',
    '  单条 todo.text / read.text ≤ 200 字，from / subject / note ≤ 120 字。',
    '',
    `─── 邮件开始（${emails.length} 封，窗口：${windowLabel}；目录 ${folder}）───`,
    '',
    blocks.join('\n\n'),
    '',
    '─── 邮件结束 ───',
    '',
    ...notes,
    '',
    `今天：${date}`,
    '请输出 JSON：',
  ].join('\n')
}

/* ---------------- 4. 输出解析 ---------------- */

/** 单行清洗：去控制字符、压空白、限长（尾加省略号）。 */
function oneLine(value, max) {
  const flat = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** 未知形状 → 字符串数组（非字符串元素丢弃）。 */
function toStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
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

/**
 * 解析模型的 /ml mail read 输出（严格清洗：字段白名单 + 条数/长度上限）。
 * 条目不合规逐条告警而非整体失败；全部为空才算解析失败。
 *
 * @param {string} raw
 * @returns {{ summary: string, events: string[], todos: Array<{ text: string, due: string, from: string, subject: string }>, reads: Array<{ text: string, from: string, subject: string, note: string }>, warnings: string[] }}
 * @throws {MailParseError}
 */
export function parseMailReadJson(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') throw new MailParseError('模型输出为空。')
  const parsed = tryParseJson(text)
  if (parsed === undefined) throw new MailParseError(`模型输出不是合法 JSON：${oneLine(text, 300)}`)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MailParseError('模型输出不是 JSON 对象。')
  }
  const warnings = []
  const summary = typeof parsed.summary === 'string' && parsed.summary.trim() !== '' ? oneLine(parsed.summary, MAX_MAIL_SUMMARY) : ''

  const events = toStringArray(parsed.events)
    .map((item) => oneLine(item, MAX_MAIL_EVENT))
    .filter((item) => item !== '')
    .slice(0, MAX_MAIL_EVENTS)
  if (Array.isArray(parsed.events) && parsed.events.length > MAX_MAIL_EVENTS) {
    warnings.push(`重要事件超出 ${MAX_MAIL_EVENTS} 条上限，只保留前 ${MAX_MAIL_EVENTS} 条。`)
  }

  const itemsOf = (value, label) => {
    const rows = []
    if (!Array.isArray(value)) return rows
    for (const row of value.slice(0, MAX_MAIL_ITEMS)) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
      const text = oneLine(row.text, MAX_MAIL_TEXT)
      if (text === '') {
        warnings.push(`${label}有一条缺 text，已丢弃。`)
        continue
      }
      const due = typeof row.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.due.trim()) ? row.due.trim() : ''
      rows.push({
        text,
        due,
        from: oneLine(row.from, MAX_MAIL_META),
        subject: oneLine(row.subject, MAX_MAIL_META),
        ...(label === '待阅' ? { note: oneLine(row.note, MAX_MAIL_META) } : {}),
      })
    }
    if (value.length > MAX_MAIL_ITEMS) warnings.push(`${label}超出 ${MAX_MAIL_ITEMS} 条上限，只保留前 ${MAX_MAIL_ITEMS} 条。`)
    return rows
  }
  const todos = itemsOf(parsed.todos, '待办')
  const reads = itemsOf(parsed.reads, '待阅')

  if (summary === '' && events.length === 0 && todos.length === 0 && reads.length === 0) {
    throw new MailParseError('模型输出没有可用内容（summary / events / todos / reads 全为空）。')
  }
  return { summary: summary || '（无总评）', events, todos, reads, warnings }
}

/* ---------------- 5. 结果渲染与流式 digest ---------------- */

/**
 * 把解析结果渲染为 markdown（会话气泡 settle 文本与命令卡片共用同一份
 * 结构；纯函数，流式 digest 的「重渲部分对象」也复用它）。
 *
 * @param {{ summary: string, events: string[], todos: Array<{text: string, due: string, from: string, subject: string}>, reads: Array<{text: string, from: string, subject: string, note: string}> }} parsed
 * @returns {string}
 */
export function renderMailReadMarkdown(parsed) {
  const lines = []
  if (parsed.summary !== '') lines.push(`**总评** ${parsed.summary}`)
  if (parsed.events.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('**重要事件**')
    lines.push(...parsed.events.map((item) => `- ${item}`))
  }
  if (parsed.todos.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('**待办（需要处理）**')
    lines.push(...parsed.todos.map((item) => `- ${item.text}${item.due === '' ? '' : `（期限 ${item.due}）`}${item.from === '' && item.subject === '' ? '' : ` —— ${[item.from, item.subject].filter((part) => part !== '').join(' · ')}`}`))
  }
  if (parsed.reads.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('**待阅（值得一看）**')
    lines.push(...parsed.reads.map((item) => `- ${item.text}${item.note === '' ? '' : ` —— ${item.note}`}${item.from === '' && item.subject === '' ? '' : `（${[item.from, item.subject].filter((part) => part !== '').join(' · ')}）`}`))
  }
  return lines.join('\n')
}

/**
 * 模型流式输出的增量 markdown 摘要：每次 push 尝试把「前缀补全成完整
 * JSON」后整份重渲，与已产出部分做后缀差量——部分解析只会让条目单调
 * 增加，重渲天然 append-only。任何输入（截断、fence、杂文字、非法
 * JSON）都不抛错：补全不了就没有增量。
 *
 * @returns {{ push(delta: string): string }}
 */
export function createMailDigestStream() {
  let buffer = ''
  let emitted = ''
  return {
    push(delta) {
      buffer += delta
      const partial = parsePartialJsonObject(buffer)
      if (partial === undefined) return ''
      let markdown = ''
      try {
        markdown = renderMailReadMarkdown({
          summary: typeof partial.summary === 'string' ? partial.summary : '',
          events: Array.isArray(partial.events) ? partial.events.filter((item) => typeof item === 'string') : [],
          todos: Array.isArray(partial.todos) ? partial.todos.filter((item) => item !== null && typeof item === 'object') : [],
          reads: Array.isArray(partial.reads) ? partial.reads.filter((item) => item !== null && typeof item === 'object') : [],
        })
      } catch {
        return ''
      }
      if (markdown.startsWith(emitted)) {
        const piece = markdown.slice(emitted.length)
        emitted = markdown
        return piece
      }
      return ''
    },
  }
}

/**
 * 把截断的 JSON 文本前缀补全成可解析的完整 JSON：字符串感知地数括号、
 * 闭合未闭合的字符串/容器、修剪悬空的逗号与冒号。解析不了返回 undefined。
 *
 * @param {string} raw
 * @returns {object | undefined}
 */
function parsePartialJsonObject(raw) {
  const unfenced = String(raw ?? '')
    .replace(/^```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim()
  const start = unfenced.indexOf('{')
  if (start === -1) return undefined
  const text = unfenced.slice(start)
  const stack = []
  let inString = false
  let escape = false
  for (const char of text) {
    if (inString) {
      if (escape) escape = false
      else if (char === '\\') escape = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[') stack.push(char)
    else if (char === '}' || char === ']') {
      const open = stack.pop()
      if (open === undefined || (char === '}' ? open !== '{' : open !== '[')) return undefined
    }
  }
  let completed = text
  if (escape) completed = completed.slice(0, -1)
  if (inString) completed += '"'
  completed = completed.replace(/,\s*$/, '')
  completed = completed.replace(/:\s*$/, ': null')
  while (stack.length > 0) {
    const open = stack.pop()
    completed += open === '{' ? '}' : ']'
  }
  try {
    const parsed = JSON.parse(completed)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}
