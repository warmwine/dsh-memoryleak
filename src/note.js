/**
 * /ml note 的宿主胶水：区间定位（会话事件日志）→ transcript 投影 →
 * 当前模型压缩（ctx.llm.stream 一次性调用）→ 校验解析（core/note）→
 * 落盘（MOMENTO/ 知识文件 + 结构化表格 + index + 日志 ## NOTE）。
 *
 * 过程显示与普通对话同构：模型的 reasoning-delta（思考）与 text-delta
 * （markdown 摘要）以 assistant/chunk 流式进合成 step；每次落盘写入以
 * 「tool/call + tool/result」事件对显示为真实工具卡片——与 agent loop 的
 * 事件形状、先后顺序完全一致（assistant 消息携带 tool-call 块在前，结果
 * 在后），保证合成内容进入模型可见转写后仍是 provider 合法的序列。
 *
 * 区间语义：每次 /ml note 只整理「上一个 /ml note（command/run+command/done
 * 日志对）之后 → 当前 /ml note 之前」的对话；没有上一个 note 就整理整个
 * 会话。命令生命周期事件（command/run|done）是 log-only 的，不产生 surface
 * 消息，因此 /ml note 自身的执行不会进入任何区间——边界天然干净。
 *
 * @module dsh-memoryleak/note
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname, relative } from 'node:path'
import { createRequire } from 'node:module'
import YAML from 'yaml'
import { TodoError } from './core/errors.js'
import { realignMarkdownTables } from './core/table-align.js'
import { locateJournal, JournalIoError } from './journal.js'
import { VAULT_SETTINGS_FILENAME, readVaultNoteConfig } from './vault.js'
import {
  NOTE_MAX_TOKENS,
  DEFAULT_STRUCTURED_TARGETS,
  buildNotePrompt,
  buildTranscript,
  createNoteDigestStream,
  extractTableRows,
  findMarkdownTables,
  lostKeys,
  mergeIndexDocument,
  mergeRowsByField,
  mergeSectionsDocument,
  mergeTableDocument,
  parseIndexTitles,
  parseNoteJson,
  parseSectionsDocument,
  renderEntryFile,
  resolveStructuredTargets,
  rowFromStorage,
  rowToStorage,
  slugify,
  insertNoteSection,
  NoteParseError,
} from './core/note.js'

/** 插件版本（回执标注，一眼识别运行的是哪版代码）。 */
const PLUGIN_VERSION = createRequire(import.meta.url)('../package.json').version

/** 压缩用的 LLM 调用故障（流错误 / 中止 / 截断），命令层转用户可见结果。 */
export class NoteLlmError extends TodoError {}

/** 模型停摆看门狗：首个 chunk 前最多等这么久（无任何输出即中止）。 */
export const NOTE_LLM_FIRST_CHUNK_TIMEOUT_MS = 120_000
/** 模型停摆看门狗：流开始后连续无输出的最长间隔（超时即中止）。 */
export const NOTE_LLM_IDLE_CHUNK_TIMEOUT_MS = 90_000

/** MOMENTO 知识库目录名（Vault 根下）。 */
export const MOMENTO_DIR = 'MOMENTO'

/**
 * 合成事件的 turn 编号。UI 会话装配器校验 turn/step 必须 ≥ 0（负数直接
 * 抛错炸掉整个渲染管线）；真实对话的 turn 从 1 开始（agent loop 首轮 =
 * lastTurn 0 + 1），**turn 0 永远不被真实流量使用**——它是合成的专属
 * 命名空间。不写 turn/start：agent loop 恢复用 findLast(turn/start) 重建
 * 计数，interruptedTurnClosers 只跟踪 turn/start 打开的轮次，均不受影响。
 */
const NOTE_STREAM_TURN = 0

/**
 * 合成 step 内的块位。UI 的 assistant-step 投影按 chunk.index 聚块
 * （blocks[index]），思考与正文必须分开占位——模型的 reasoning 与正文
 * 常常交错到达，挤在同一位会互相覆盖。
 */
const NOTE_REASONING_BLOCK = 0
const NOTE_TEXT_BLOCK = 1

/**
 * 合成写入卡片的工具名。卡片是真实转写内容（tool/result 会进入模型可见
 * 历史），collectNoteItems 据此把上一轮 /ml note 的合成结果排除出下个
 * 整理区间——它们不是对话，是上一轮整理的动作记录。
 */
export const NOTE_TOOL_NAME = 'ml_note_write'

/** 最终消息与流式说明共用的固定标记（collectNoteItems 据此排除合成消息）。 */
export const NOTE_MARK = '📌 /ml note'

/* ---------------- 1. 区间定位与 transcript 投影 ---------------- */

/** command/run 是不是一次 /ml note 调用（args 为空或以 note 开头）。 */
function isNoteRun(event) {
  if (event.type !== 'command/run') return false
  const data = event.data
  if (data === null || typeof data !== 'object') return false
  if (data.name !== 'ml') return false
  const args = typeof data.args === 'string' ? data.args.trim() : ''
  return args === 'note' || args.startsWith('note ') || args.startsWith('note\u3000')
}

/**
 * 收集本次要压缩的对话区间，投影为 transcript 条目。
 *
 * 区间边界：回扫**上一个成功完成的 /ml note**（command/done 为 success）；
 * 失败、取消或停摆未收尾的 note 不构成边界——它身前的对话留给下次重试
 * 整理，不会因为一次失败的 note 被永久跳过。
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

  // 从当前 run 之前回扫上一个 note；只认成功收尾的（见函数头注释）。
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
    // 失败/中止/停摆未收尾的 note 不消化它身前的对话，继续回溯到更早的
    // 最后一次成功 note（重试不丢内容：停摆被取消的那次 note 若算边界，
    // 它身前的对话会被永远跳过）。
    if (done === undefined || done.data?.kind !== 'success') continue
    boundarySeq = done.seq
    break
  }

  // callId → 工具名（assistant 的 tool-call 与 result 的对应）
  const toolNames = new Map()
  // /ml note 自身合成写入卡片的 callId（其 tool/result 是动作记录，不是对话）
  const syntheticCalls = new Set()
  for (const event of events) {
    if (event.type === 'tool/call' && typeof event.data?.callId === 'string') {
      toolNames.set(event.data.callId, event.data.name ?? '')
      if (event.data.name === NOTE_TOOL_NAME) syntheticCalls.add(event.data.callId)
    }
  }

  const items = []
  for (const event of events) {
    if (event.seq <= boundarySeq || event.seq >= currentSeq) continue
    if (event.surfaceOp !== 'append') continue
    if (event.type === 'user/message') {
      const text = joinUserText(event.data)
      if (text !== '') items.push({ role: 'user', text })
    } else if (event.type === 'assistant/message') {
      const text = joinAssistantText(event.data?.message)
      // 跳过 /ml note 自身的合成消息（上一次整理的结果摘要）：它不是对话内容。
      if (text.startsWith(NOTE_MARK)) continue
      if (text !== '') items.push({ role: 'assistant', text })
    } else if (event.type === 'tool/result') {
      const message = event.data?.message
      const callId = message?.source?.kind === 'tool' ? message.source.callId : undefined
      if (typeof callId === 'string' && syntheticCalls.has(callId)) continue
      const name = typeof callId === 'string' ? toolNames.get(callId) ?? '' : ''
      const text = joinToolResultText(message)
      if (text !== '') items.push({ role: 'tool', name: name || undefined, text })
    }
  }
  return { items, hasBoundary: boundarySeq !== -1, fromSeq: boundarySeq + 1, toSeq: currentSeq - 1 }
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

/* ---------------- 2. 模型路由与压缩调用 ---------------- */

/**
 * 解析「当前模型」：优先最近一次路由请求的 config（会话正在用的模型），
 * 回退 agent 选项。两者都缺 → null（命令层报错）。
 *
 * @param {{ options?: { provider?: string, model?: string }, session?: { requestHeader?: () => { config?: { provider?: string, model?: string } } | undefined } }} agent
 * @returns {{ provider: string, model: string } | null}
 */
export function resolveNoteModel(agent) {
  const header = typeof agent?.session?.requestHeader === 'function' ? agent.session.requestHeader() : undefined
  const config = header?.config
  if (typeof config?.provider === 'string' && config.provider !== '' && typeof config?.model === 'string' && config.model !== '') {
    return { provider: config.provider, model: config.model }
  }
  const options = agent?.options
  if (typeof options?.provider === 'string' && options.provider !== '' && typeof options?.model === 'string' && options.model !== '') {
    return { provider: options.provider, model: options.model }
  }
  return null
}

/**
 * 一次性压缩调用：单条 user 消息（转写 + 输出协议），累积 text-delta。
 * 可选 sink 把流式 chunk 原样转发进会话日志（UI 逐字渲染，与普通回复同款）。
 * maxTokens 可选（缺省 NOTE_MAX_TOKENS；/ml ask 等复用方自带更长限额）。
 *
 * 停摆看门狗：服务端/网络停摆（连接无响应也不报错）时，裸的流式调用会
 * 永久挂起——此前用户只能手动取消。现在首个 chunk 前超过
 * firstChunkTimeoutMs（默认 120s）、或流中途连续 idleChunkTimeoutMs
 * （默认 90s）无任何 chunk，即主动中止并抛 NoteLlmError（可通过入参
 * 覆盖，测试用小值）。/ml note、/ml ask、/ml mail read 共用本函数，
 * 一处加固三处受益。用户主动取消仍由命令层的 withAbort 兜底（信号原样
 * 透传给 llm.stream，不经看门狗）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ provider: string, model: string, prompt: string, sessionId?: string, signal?: AbortSignal, maxTokens?: number, onChunk?: (chunk: object) => void, firstChunkTimeoutMs?: number, idleChunkTimeoutMs?: number }} input
 * @returns {Promise<{ text: string, usage: object | undefined }>}
 * @throws {NoteLlmError}
 */
export async function streamNoteCompletion(ctx, { provider, model, prompt, sessionId, signal, maxTokens, onChunk, firstChunkTimeoutMs = NOTE_LLM_FIRST_CHUNK_TIMEOUT_MS, idleChunkTimeoutMs = NOTE_LLM_IDLE_CHUNK_TIMEOUT_MS }) {
  const message = {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: 'dsh-memoryleak' },
  }
  const describeTimeout = (label, budget) => `模型 ${Math.round(budget / 1000)} 秒没有响应（${label}；${provider}/${model}），已中止本次调用——多半是服务端或网络停摆，请稍后重试。`
  const iterator = ctx.llm.stream({
    provider,
    model,
    messages: [message],
    maxTokens: maxTokens ?? NOTE_MAX_TOKENS,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(signal === undefined ? {} : { signal }),
  })[Symbol.asyncIterator]()
  let text = ''
  let usage
  let finish = { kind: 'stop' }
  let sawChunk = false
  try {
    for (;;) {
      const budget = sawChunk ? idleChunkTimeoutMs : firstChunkTimeoutMs
      const TIMEOUT = Symbol('timeout')
      let timer
      const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), budget)
      })
      const nextPromise = iterator.next()
      // race 输家稍后才拒绝时不能变成 unhandled rejection（Node 会崩）
      nextPromise.catch?.(() => {})
      let stepped
      try {
        stepped = await Promise.race([nextPromise, timeoutPromise])
      } finally {
        clearTimeout(timer)
      }
      if (stepped === TIMEOUT) {
        throw new NoteLlmError(describeTimeout(sawChunk ? '流中途' : '首字', budget))
      }
      if (stepped.done) break
      const chunk = stepped.value
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') finish = chunk.reason
      if (onChunk !== undefined) onChunk(chunk)
      sawChunk = true
    }
  } finally {
    // 尽力收尾底层请求（停摆的连接可能挂着——不 await，防二次卡死）
    try {
      iterator.return?.(undefined)?.catch?.(() => {})
    } catch {
      // 收尾失败不影响结果
    }
  }
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new NoteLlmError(`模型调用失败：${finish.failure?.message ?? finish.kind}`)
  }
  if (finish.kind === 'max-tokens') {
    throw new NoteLlmError(`输出被 maxTokens=${maxTokens ?? NOTE_MAX_TOKENS} 截断，内容可能不完整。请稍后重试，或把问题拆小一点。`)
  }
  return { text, usage }
}

/* ---------------- 2.5 会话内的流式过程显示 ---------------- */

/**
 * 建一个合成流 sink：把压缩与落盘过程作为与真实 agent 回合**同构**的会话
 * 事件写进当前会话，UI 用同一套管线渲染出普通对话的全部形态——
 *
 *   思考   → assistant/chunk reasoning-delta（块位 0，可折叠思考块）
 *   正文   → assistant/chunk text-delta（块位 1，markdown 分块流式）
 *   写入   → tool/call 事件（工具卡片即时出现、转圈）
 *   回执   → assistant/message（携带 tool-call 块，气泡定格为结果摘要并
 *            进入对话上下文），随后按序补落 tool/result（surface append，
 *            卡片逐个翻到完成态）→ step/end 闭合。
 *
 * 转写合法性（load-bearing）：tool/result 是 surface 事件，会进入模型可见
 * 历史；provider（OpenAI/DeepSeek 风格）要求 tool 消息必须紧跟在带
 * tool_calls 的 assistant 消息之后。因此事件顺序镜像真实 agent loop：
 * assistant 消息（含全部 tool-call 块）在前、结果在后、一一对应。tool/call
 * 本身 log-only，不进转写。失败路径（压缩/解析/落盘抛错）走 interrupt：
 * 不落 assistant 消息与结果，未完成的卡片由 UI 按 step 收尾显示为中断样式，
 * 转写不残留任何孤儿。
 *
 * @param {object} session 活会话（agent.session）
 * @param {number} stepKey 本次执行的唯一 step 编号（正数）
 */
export function createNoteStreamSink(session, stepKey) {
  const chunkSeqs = []
  /** tool/call 事件登记：callId → { seq, name, argsJson }（settle 的块与结果溯源都用）。 */
  const calls = new Map()
  /** 已完成写入的结果摘要：callId → 文本（settle 落完 assistant 消息后统一补 tool/result）。 */
  const doneSummaries = new Map()
  /** 显示通道是否已经坏过（append 抛错）：坏掉后停发卡片，settle 退回纯文本。 */
  let unhealthy = false
  /** 事件 append 的容错包装（显示通道，坏了不伤业务）。 */
  const safeAppend = (type, data, ...opts) => {
    try {
      return session.append(type, data, ...opts)
    } catch {
      unhealthy = true
      return undefined
    }
  }
  return {
    /**
     * 建立流式节点：UI 的 assistant-step 投影按 step/start 事件建立节点，
     * 之后的 chunk 才有可挂靠的 step 上下文（缺了它气泡不出现）。
     * turn 恒为 0（合成专属命名空间）：agent loop 恢复只看 turn/start，
     * interruptedTurnClosers 在无 turn/start 时直接跳过，均不受影响。
     */
    begin(summaryLine) {
      safeAppend('step/start', { turn: NOTE_STREAM_TURN, step: stepKey })
      this.delta(summaryLine)
    },
    /** 流式一段思考（模型的 reasoning-delta chunk）。 */
    thinking(text) {
      if (text === '' || unhealthy) return
      const event = safeAppend('assistant/chunk', { turn: NOTE_STREAM_TURN, step: stepKey, chunk: { type: 'reasoning-delta', index: NOTE_REASONING_BLOCK, text } })
      if (event !== undefined) chunkSeqs.push(event.seq)
    },
    /** 流式一段正文（一个 text-delta chunk 的 markdown 分段）。 */
    delta(text) {
      if (unhealthy) return
      const event = safeAppend('assistant/chunk', { turn: NOTE_STREAM_TURN, step: stepKey, chunk: { type: 'text-delta', index: NOTE_TEXT_BLOCK, text } })
      if (event !== undefined) chunkSeqs.push(event.seq)
    },
    /** token 用量（log-only；UI 记到气泡的 usage 上）。 */
    usage(usage) {
      safeAppend('assistant/chunk', { turn: NOTE_STREAM_TURN, step: stepKey, chunk: { type: 'usage', usage } })
    },
    /**
     * 开一张写入卡片：立即落 tool/call 事件（卡片出现、转圈），返回 callId。
     * 结果不在此处落——tool/result 必须排在携带 tool-call 块的 assistant
     * 消息**之后**（转写合法性），由 settle 统一补落。
     *
     * @param {string} name 工具名（恒为 NOTE_TOOL_NAME）
     * @param {Record<string, string | number>} args 卡片参数（保持小巧：文件、动作、规模）
     * @returns {string | null} callId；显示通道已坏时 null（不卡片、不落盘阻塞）
     */
    toolCall(name, args) {
      if (unhealthy) return null
      const argsJson = JSON.stringify(args)
      const event = safeAppend('tool/call', { turn: NOTE_STREAM_TURN, step: stepKey, callId: crypto.randomUUID(), name, arguments: argsJson })
      if (event === undefined) return null
      calls.set(event.data.callId, { seq: event.seq, name, argsJson })
      return event.data.callId
    },
    /** 记录一次写入的结果摘要（事件由 settle 在消息之后统一补落）。 */
    toolDone(callId, summary) {
      if (callId === null || !calls.has(callId)) return
      doneSummaries.set(callId, summary)
    },
    /**
     * 成功收尾：流式内容定格为一条真正的 assistant 消息（结果摘要 + 本次
     * 全部写入的 tool-call 块），随后按 call 顺序补落 tool/result（surface
     * append、溯源到各自 tool/call 的 seq），最后 step/end 闭合该 step——
     * 与真实 loop 的 message → tool/call/result → step/end 同构，会话
     * timeline 不留悬挂的 open step。append 型 surface 事件——进入对话
     * 上下文（下轮模型可见；下个整理区间会整条排除本消息与合成结果）。
     */
    settle(text, source, usage) {
      // 块与结果一一对应：只收「已完成且有结果摘要」的调用，绝不让消息带上
      // 没有结果跟随的 tool-call 块（那会让下轮请求变成非法序列）。
      const blocks = [...doneSummaries.keys()].map((callId) => {
        const call = calls.get(callId)
        return { type: 'tool-call', id: callId, name: call.name, arguments: call.argsJson }
      })
      const settled = safeAppend(
        'assistant/message',
        {
          turn: NOTE_STREAM_TURN,
          step: stepKey,
          message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text }, ...blocks], source },
          ...(usage === undefined ? {} : { usage }),
        },
        { surfaceOp: 'append', ...(chunkSeqs.length > 0 ? { sourceEventSeqs: chunkSeqs } : {}) },
      )
      // 消息落成功才补结果（消息没落出去则没有 tool-call 块，结果成了孤儿）。
      if (settled !== undefined) {
        for (const [callId, summary] of doneSummaries) {
          const call = calls.get(callId)
          safeAppend(
            'tool/result',
            {
              turn: NOTE_STREAM_TURN,
              step: stepKey,
              message: {
                id: crypto.randomUUID(),
                role: 'user',
                source: { kind: 'tool', callId },
                content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: summary }], isError: false }],
              },
            },
            { surfaceOp: 'append', sourceEventSeqs: [call.seq] },
          )
        }
      }
      safeAppend('step/end', { turn: NOTE_STREAM_TURN, step: stepKey })
      return settled
    },
    /** 失败/取消收尾：log-only 的 step/end 让 UI 把已流出内容定格为中断样式
     *（未完成的写入卡片显示为中断——如实反映「没写完」）。不落 assistant
     * 消息与 tool/result：转写不残留孤儿 tool_calls 或孤儿结果。 */
    interrupt() {
      unhealthy = true
      safeAppend('step/end', { turn: NOTE_STREAM_TURN, step: stepKey })
    },
  }
}

/* ---------------- 3. 落盘 ---------------- */

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
 * 把解析后的压缩结果写进 Vault。
 *
 * structured 落盘按 targets（vault 配置 or 内置默认）分派：table 走
 * mergeTableDocument，yaml 走 mergeRowsByField + YAML 序列化，sections
 * 走 mergeSectionsDocument；所有路径都有防丢失守卫。备份默认关闭
 * （vault 常由 git 管理）；backup: true 时改前备份进 vault 的 .backup/
 * 目录（保留相对路径 + 时间戳）。yaml 目标文件存在但不是「对象列表」时
 * **跳过并警告**，绝不重写。
 *
 * sink（可选）：传入 createNoteStreamSink 的实例时，每次落盘写入以
 * 「tool/call 即开卡 → 写入 → toolDone 记结果」的形态显示为工具卡片；
 * 结果事件由 sink.settle 在回执消息之后统一补落（转写合法性）。缺省
 * （null）时行为与旧版完全一致：只写盘，无卡片。
 *
 * @param {object} input
 * @param {string} input.vaultDir Vault 绝对路径
 * @param {object} input.settings 生效设置（journalMode / 模板）
 * @param {() => Date} [input.now]
 * @param {{ summary: string, notes: string[], entries: Array<{title: string, body: string, tags: string[]}>, structured: Record<string, Array<Record<string, string>>> }} input.parsed
 * @param {Record<string, import('./core/note.js').StructuredTarget>} [input.targets] 解析后的结构化目标（缺省用内置默认）
 * @param {{ toolCall(name: string, args: object): string | null, toolDone(callId: string, summary: string): void }} [input.sink] 会话显示 sink（可选，createNoteStreamSink 的实例）
 * @returns {Promise<{ momentoFiles: string[], indexFile: string | null, noteFile: string, noteMode: 'daily'|'weekly', created: boolean, summary: string, time: string, date: string, warnings: string[] }>}
 */
export async function persistNoteResult({ vaultDir, settings, now = () => new Date(), parsed, targets = DEFAULT_STRUCTURED_TARGETS, backup = false, sink = null }) {
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
  /** 开一张写入卡片（sink 缺席 / 显示通道已坏时返回 null，后续 toolDone 自动跳过）。 */
  const card = (args) => (sink !== null ? sink.toolCall(NOTE_TOOL_NAME, args) : null)
  /** 记录卡片结果摘要（settle 后统一补落 tool/result）。 */
  const cardDone = (callId, summary) => {
    if (sink !== null) sink.toolDone(callId, summary)
  }

  // 知识条目：一文件一条，同 slug 追加「## 更新」分节（纯追加）
  const written = []
  const indexRows = []
  for (const entry of parsed.entries) {
    const slug = slugify(entry.title)
    const path = join(momentoDir, `${slug}.md`)
    const existing = await readVaultFile(path)
    await maybeBackup(path, existing)
    const callId = card({ file: `${MOMENTO_DIR}/${slug}.md`, op: existing === null ? 'create' : 'update', title: entry.title })
    await writeVaultFile(path, renderEntryFile({ title: entry.title, body: entry.body, date, existing }))
    cardDone(callId, existing === null ? '已创建' : '已更新（追加「## 更新」分节）')
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
      const callId = card({ file: target.file, op: 'merge', format: 'yaml', rows: rows.length })
      await writeVaultFile(path, renderYamlDocument(merged, target))
      cardDone(callId, `已合并（共 ${merged.length} 条）`)
      written.push(target.file)
      continue
    }
    if (target.format === 'sections') {
      const result = mergeSectionsDocument(existing, target, rows, date)
      warnings.push(...result.warnings)
      await maybeBackup(path, existing)
      const callId = card({ file: target.file, op: 'merge', format: 'sections', rows: rows.length })
      await writeVaultFile(path, result.content)
      cardDone(callId, `已合并（共 ${rows.length} 条）`)
      written.push(target.file)
      continue
    }
    const next = mergeTableDocument(existing, target, rows, date)
    assertNoRowLossForTarget(existing, target, next, `${kind}（${target.file}）`)
    await maybeBackup(path, existing)
    const callId = card({ file: target.file, op: 'merge', format: 'table', rows: rows.length })
    await writeVaultFile(path, next)
    cardDone(callId, `已合并（共 ${rows.length} 条）`)
    written.push(target.file)
  }

  // index：知识条目或结构化表有产出时刷新
  let indexFile = null
  if (parsed.entries.length > 0 || Object.values(parsed.structured).some((rows) => rows.length > 0)) {
    const indexPath = join(momentoDir, 'index.md')
    const existing = await readVaultFile(indexPath)
    await maybeBackup(indexPath, existing)
    const callId = card({ file: `${MOMENTO_DIR}/index.md`, op: existing === null ? 'create' : 'update', entries: indexRows.length })
    await writeVaultFile(indexPath, mergeIndexDocument(existing, indexRows))
    cardDone(callId, `已刷新（+${indexRows.length} 条）`)
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
  const journalCallId = card({ file: located.file, op: located.created ? 'create' : 'append', section: '## NOTE' })
  await writeVaultFile(located.path, next)
  cardDone(journalCallId, `已写入 ${parsed.notes.length} 条工作记录`)

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

/* ---------------- 4. 命令编排 ---------------- */

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
async function readKnownState(vaultDir, targets = DEFAULT_STRUCTURED_TARGETS) {
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
 * 读取 note-skill 文件（vault 限定记录约定，注入 prompt 的模型约束）。
 * 未配置 / 文件不存在 → 空文本；读取失败 → 空文本 + 警告。
 *
 * @param {string} vaultDir
 * @param {string} skillPath vault 相对路径（空 = 未配置）
 * @returns {Promise<{ text: string, warning: string | null }>}
 */
async function readSkillFile(vaultDir, skillPath) {
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

/**
 * /ml note 的完整流程（命令 handler 调用）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ events: ReadonlyArray<object>, seq?: number, id?: string, requestHeader?: () => object, options?: object }} agent
 * @param {{ commandId: string, signal: AbortSignal }} invocation
 * @param {string} vaultDir
 * @param {object} settings
 * @returns {Promise<{ kind: 'success', text: string } | { kind: 'error', text: string }>}
 */
export async function runNoteCommand(ctx, agent, invocation, vaultDir, settings) {
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
  const target = resolveNoteModel(agent)
  if (target === null) {
    return { kind: 'error', text: '当前会话还没有路由过模型请求，无法确定「当前模型」。先发一条消息再执行 /ml note。' }
  }
  const date = new Date()
  // vault 限定配置：noteStructured（目标格式声明）+ noteSkill（记录约定）
  const noteConfig = await readVaultNoteConfig(vaultDir)
  const { targets, errors: targetErrors } = resolveStructuredTargets(noteConfig.noteStructured)
  if (targetErrors.length > 0) {
    return { kind: 'error', text: `vault 的 noteStructured 配置有误，未执行整理：\n${targetErrors.map((error) => `- ${error}`).join('\n')}\n（配置在 Vault 的 ${VAULT_SETTINGS_FILENAME}，详见 README）` }
  }
  const skill = await readSkillFile(vaultDir, noteConfig.noteSkill)
  const known = await readKnownState(vaultDir, targets)
  const prompt = buildNotePrompt({
    transcript: transcript.text,
    date: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    hasBoundary,
    known,
    skill: skill.text,
    targets,
  })

  // 流式过程显示：turn 0（合成专属命名空间）+ step 用当前 run 的 seq（正数、
  // 每次执行唯一）；只在会话对象真实可用时启用（测试桩可能没有 append）。
  const session = agent.session
  const stepKey = Math.abs(resolveCurrentRunSeq(session, invocation.commandId) || 1)
  const sink = typeof session?.append === 'function' ? createNoteStreamSink(session, stepKey) : null
  const scope = hasBoundary ? '上一个 /ml note → 本次' : '会话开始 → 本次'
  if (sink !== null) {
    sink.begin(`${NOTE_MARK} 开始整理（${scope}，${transcript.included}/${transcript.total} 条消息${transcript.truncated ? '，超预算已裁剪' : ''}；模型 ${target.provider}/${target.model}；v${PLUGIN_VERSION}）…\n\n`)
  }

  let completion
  let parsed
  // 流式过程显示：模型输出不转发原始 JSON（无 markdown 结构，气泡里糊成一
  // 团），改为增量解析、把已完成的部分格式化为 markdown 分段追加（与普通
  // 对话同款的分块渲染）。思考（reasoning-delta）原样转发——UI 渲染为与
  // 普通回复同款的思考块。解析失败只是少几段显示，不影响正式解析。
  const digest = createNoteDigestStream()
  try {
    completion = await streamNoteCompletion(ctx, {
      provider: target.provider,
      model: target.model,
      prompt,
      sessionId: typeof session?.id === 'string' ? session.id : undefined,
      signal: invocation.signal,
      ...(sink === null
        ? {}
        : {
            onChunk: (chunk) => {
              if (chunk.type === 'text-delta') {
                const piece = digest.push(chunk.text)
                if (piece !== '') sink.delta(piece)
              } else if (chunk.type === 'reasoning-delta') {
                sink.thinking(chunk.text)
              } else if (chunk.type === 'usage') sink.usage(chunk.usage)
            },
          }),
    })
    parsed = parseNoteJson(completion.text, targets)
  } catch (error) {
    if (sink !== null) sink.interrupt()
    if (error instanceof NoteParseError) return { kind: 'error', text: `模型输出无法解析：${error.message}` }
    if (error instanceof NoteLlmError) return { kind: 'error', text: `压缩调用失败：${error.message}` }
    throw error
  }

  let persisted
  try {
    persisted = await persistNoteResult({ vaultDir, settings, parsed, targets, backup: noteConfig.noteBackup === true, sink })
  } catch (error) {
    if (sink !== null) sink.interrupt()
    throw error
  }
  // 回执双版本：命令卡片是 pre-wrap 纯文本（result.text）；会话气泡走
  // markdown 渲染（settle 文本），用分块结构显示（摘要 / 写入 / 注意）。
  const head = `已整理（${scope}，${transcript.included}/${transcript.total} 条消息${transcript.truncated ? '，超预算已裁剪' : ''}）`
  const knownCount = Object.values(known.structured).reduce((sum, rows) => sum + rows.length, 0)
  const structuredCount = Object.values(parsed.structured).reduce((sum, rows) => sum + rows.length, 0)
  const usage = completion.usage
  const totalTokens = typeof usage?.totalTokens === 'number' ? usage.totalTokens : undefined
  const modelLine = `模型：${target.provider}/${target.model}${totalTokens !== undefined ? ` · ${totalTokens} tokens` : ''} · dsh-memoryleak v${PLUGIN_VERSION}`

  const writeItems = [`工作记录 → ${persisted.noteFile} ## NOTE${persisted.created ? '（新建文件）' : ''}`]
  if (knownCount > 0 || known.titles.length > 0) {
    writeItems.push(`在已有知识基础上增补（存量：${knownCount} 条登记 + ${known.titles.length} 个知识条目${noteConfig.noteBackup === true ? `；改前备份进 ${BACKUP_DIR}/` : ''}）`)
  }
  if (skill.text !== '') writeItems.push(`已按 note skill 约定整理（${noteConfig.noteSkill}）`)
  if (persisted.momentoFiles.length > 0) writeItems.push(`知识库 → ${persisted.momentoFiles.join('、')}`)
  if (structuredCount > 0) writeItems.push(`结构化登记 ${structuredCount} 条（按各自主键合并）`)

  const allWarnings = [...parsed.warnings, ...persisted.warnings]
  if (skill.warning !== null) allWarnings.push(skill.warning)

  const lines = [head, `摘要：${persisted.summary}`, '', ...writeItems]
  if (allWarnings.length > 0) lines.push('', '注意：', ...allWarnings.map((warning) => `- ${warning}`))
  lines.push('', modelLine)
  const receipt = lines.join('\n')

  const markdown = [
    `${NOTE_MARK} ${head}`,
    '',
    `**摘要**`,
    persisted.summary,
    '',
    '**写入**',
    ...writeItems.map((item) => `- ${item}`),
  ]
  if (allWarnings.length > 0) markdown.push('', '**注意**', ...allWarnings.map((warning) => `- ${warning}`))
  markdown.push('', modelLine)
  // 成功收尾：会话气泡定格为 markdown 结构化回执（进入对话上下文，下次压缩时被排除）。
  if (sink !== null) sink.settle(markdown.join('\n'), { kind: 'model', provider: target.provider, model: target.model }, completion.usage)
  return { kind: 'success', text: receipt }
}

/** 当前 command/run 事件的 seq（合成 step 编号的唯一性来源；找不到取日志末 seq）。 */
export function resolveCurrentRunSeq(session, commandId) {
  const events = Array.isArray(session?.events) ? session.events : []
  const run = events.find((event) => event.type === 'command/run' && event.data?.commandId === commandId)
  if (run !== undefined && Number.isSafeInteger(run.seq)) return run.seq
  return events.length > 0 && Number.isSafeInteger(events[events.length - 1].seq) ? events[events.length - 1].seq : 0
}

export { NoteParseError }
