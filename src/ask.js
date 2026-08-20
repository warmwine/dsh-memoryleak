/**
 * /ml ask 的宿主胶水：/ml note 的反向——note 把对话写进 Vault，ask 把
 * Vault 读出来当资料，用当前模型回答用户的问题（**只读，绝不写 Vault**）。
 *
 * 流程：汇集资料（MOMENTO/index → 结构化登记文件 → 按问题关键词排序的
 * MOMENTO 知识条目 → 近期日志，预算内截断）→ buildAskPrompt →
 * ctx.llm.stream 一次性调用（复用 note 的管线；maxTokens 更长）→ 回答
 * 以 markdown 流式显示在会话气泡里（与普通回复同款渲染），settle 后进入
 * 对话上下文。命令卡片另给一份纯文本回执。
 *
 * @module dsh-memoryleak/ask
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { TodoError } from './core/errors.js'
import { JournalIoError } from './journal.js'
import { readVaultNoteConfig } from './vault.js'
import { resolveStructuredTargets, DEFAULT_STRUCTURED_TARGETS } from './core/note.js'
import {
  ASK_BUDGET_CHARS,
  ASK_ENTRY_CLIP,
  ASK_JOURNAL_CLIP,
  ASK_JOURNAL_COUNT,
  ASK_MAX_TOKENS,
  buildAskPrompt,
  extractAskTerms,
  isJournalFileName,
  scoreAskFile,
} from './core/ask.js'
import {
  NoteLlmError,
  createNoteStreamSink,
  resolveCurrentRunSeq,
  resolveNoteModel,
  streamNoteCompletion,
} from './note.js'

/** 插件版本（回执标注）。 */
const PLUGIN_VERSION = createRequire(import.meta.url)('../package.json').version

/** /ml ask 的会话标记（气泡回执前缀；同步维护于 README / help）。 */
export const ASK_MARK = '❓ /ml ask'

/** 资料汇集故障（环境错误，命令层转用户可见结果）。 */
export class AskIoError extends TodoError {}

/** 安全读取 vault 内文件（ENOENT / 故障 → null，不阻塞问答）。 */
async function readVaultFile(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * 汇集问答资料（预算内按优先级 + 相关度选取）。
 *
 * 优先级：① MOMENTO/index.md（知识索引，永远最先）② 结构化登记目标文件
 * （内置默认 + vault 的 noteStructured 声明，紧凑的表格全量带）③ MOMENTO
 * 知识条目（按问题关键词打分排序，高分在前、同分新的在前，单条截断）
 * ④ 近期日志（文件名降序 = 最近优先，截断）。总体预算 ASK_BUDGET_CHARS，
 * 超出部分从队尾丢弃（最后一条可能被裁短）。读不到的文件静默跳过。
 *
 * @param {string} vaultDir
 * @param {Record<string, import('./core/note.js').StructuredTarget>} targets 已解析的结构化目标
 * @param {string} question 用户问题（关键词排序用）
 * @returns {Promise<{ materials: Array<{ path: string, content: string }>, included: number, total: number }>}
 */
export async function gatherAskMaterials(vaultDir, targets = DEFAULT_STRUCTURED_TARGETS, question = '') {
  const momentoDir = join(vaultDir, 'MOMENTO')
  const terms = extractAskTerms(question)
  /** 已入选的 vault 相对路径（登记目标与 MOMENTO 条目可能同名，全局去重）。 */
  const seen = new Set()
  const candidates = []
  const push = (path, clip) => {
    if (seen.has(path)) return
    seen.add(path)
    candidates.push({ path, clip, read: readVaultFile(join(vaultDir, path)) })
  }

  // ① 索引 ② 结构化登记目标
  push('MOMENTO/index.md', ASK_ENTRY_CLIP)
  for (const target of Object.values(targets)) push(target.file, ASK_ENTRY_CLIP)

  // ③ 知识条目（打分排序；与已入选路径去重——登记目标文件不再当条目收）
  const entries = []
  try {
    for (const name of await readdir(momentoDir)) {
      if (!name.endsWith('.md') || name === 'index.md') continue
      const path = `MOMENTO/${name}`
      if (seen.has(path)) continue
      seen.add(path)
      const content = await readVaultFile(join(momentoDir, name))
      if (content === null || content.trim() === '') continue
      entries.push({ path, content, score: scoreAskFile(path, content, terms) })
    }
  } catch {
    // MOMENTO/ 不存在：没有知识条目，继续
  }
  entries.sort((left, right) => right.score - left.score || (left.path > right.path ? -1 : 1))

  // ④ 近期日志（文件名降序 = 最近优先；同样参与去重）
  const journals = []
  try {
    const names = (await readdir(vaultDir))
      .filter((name) => name.endsWith('.md') && isJournalFileName(name) && !seen.has(name))
    for (const name of names) seen.add(name)
    names.sort()
    journals.push(...names.slice(-ASK_JOURNAL_COUNT).reverse())
  } catch {
    // vault 根不可读：结构化目标与日志缺席，继续
  }

  // 装配：索引 → 结构化登记 → 知识条目（分数序）→ 日志（时间序）
  const ordered = [
    ...candidates.map((candidate) => ({ path: candidate.path, clip: candidate.clip, read: candidate.read })),
    ...entries.map((entry) => ({ path: entry.path, clip: ASK_ENTRY_CLIP, read: Promise.resolve(entry.content) })),
    ...journals.map((name) => ({ path: name, clip: ASK_JOURNAL_CLIP, read: readVaultFile(join(vaultDir, name)) })),
  ]

  const loaded = []
  for (const item of ordered) {
    const content = await item.read
    if (content === null || content.trim() === '') continue
    loaded.push({ path: item.path, content, clip: item.clip })
  }
  const total = loaded.length

  // 预算内截断：队尾丢弃；最后一条裁短（保底 200 字符，塞不下就停）
  const materials = []
  let used = 0
  for (const item of loaded) {
    const room = ASK_BUDGET_CHARS - used
    if (room <= 200) break
    const content = item.content.length > item.clip ? `${item.content.slice(0, item.clip - 1)}…` : item.content
    if (content.length <= room) {
      materials.push({ path: item.path, content })
      used += content.length
    } else {
      materials.push({ path: item.path, content: `${content.slice(0, Math.max(200, room) - 1)}…` })
      used += room
      break
    }
  }
  return { materials, included: materials.length, total }
}

/**
 * /ml ask 的完整流程（命令 handler 调用）。回答本身是 markdown，流式
 * 直接转发（与普通回复同款渲染）；settle 后回答进入对话上下文。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ options?: { provider?: string, model?: string }, session?: { events?: ReadonlyArray<object>, append?: Function, id?: string, requestHeader?: () => object } }} agent
 * @param {{ commandId: string, signal: AbortSignal }} invocation
 * @param {string} vaultDir
 * @param {string} question 用户问题
 * @returns {Promise<{ kind: 'success', text: string } | { kind: 'error', text: string }>}
 */
export async function runAskCommand(ctx, agent, invocation, vaultDir, question) {
  const target = resolveNoteModel(agent)
  if (target === null) {
    return { kind: 'error', text: '当前会话还没有路由过模型请求，无法确定「当前模型」。先发一条消息再执行 /ml ask。' }
  }
  const noteConfig = await readVaultNoteConfig(vaultDir)
  const { targets } = resolveStructuredTargets(noteConfig.noteStructured)
  const { materials, included, total } = await gatherAskMaterials(vaultDir, targets, question)
  if (total === 0) {
    return {
      kind: 'error',
      text: 'Vault 里还没有可引用的内容（MOMENTO/ 知识文件、结构化登记、日志均为空）。\n先 /ml note 整理一段对话，或直接把笔记写进 Vault 再问。',
    }
  }
  const date = new Date()
  const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const prompt = buildAskPrompt({ question, materials, date: today, included, total })

  // 流式过程显示（与 /ml note 同一套合成事件管线）
  const session = agent.session
  const stepKey = Math.abs(resolveCurrentRunSeq(session, invocation.commandId) || 1)
  const sink = typeof session?.append === 'function' ? createNoteStreamSink(session, stepKey) : null
  const fileLine = `引用 ${included}/${total} 个文件`
  if (sink !== null) {
    sink.begin(`${ASK_MARK} 提问（${fileLine}；模型 ${target.provider}/${target.model}；v${PLUGIN_VERSION}）…\n\n`)
  }

  let completion
  try {
    completion = await streamNoteCompletion(ctx, {
      provider: target.provider,
      model: target.model,
      prompt,
      maxTokens: ASK_MAX_TOKENS,
      sessionId: typeof session?.id === 'string' ? session.id : undefined,
      signal: invocation.signal,
      ...(sink === null
        ? {}
        : {
            onChunk: (chunk) => {
              if (chunk.type === 'text-delta') sink.delta(chunk.text)
              else if (chunk.type === 'usage') sink.usage(chunk.usage)
            },
          }),
    })
  } catch (error) {
    if (sink !== null) sink.interrupt()
    if (error instanceof NoteLlmError) return { kind: 'error', text: `回答调用失败：${error.message}` }
    throw error
  }

  const answer = completion.text.trim()
  if (answer === '') {
    if (sink !== null) sink.interrupt()
    return { kind: 'error', text: '模型没有返回内容，请稍后重试。' }
  }
  const usage = completion.usage
  const totalTokens = typeof usage?.totalTokens === 'number' ? usage.totalTokens : undefined
  const modelLine = `模型：${target.provider}/${target.model}${totalTokens !== undefined ? ` · ${totalTokens} tokens` : ''} · dsh-memoryleak v${PLUGIN_VERSION}`
  // 回执：命令卡片（纯文本）；气泡（markdown，settle 后进入对话上下文）
  const receipt = [`已回答（${fileLine}）`, '─'.repeat(44), answer, '', modelLine].join('\n')
  if (sink !== null) sink.settle(`${ASK_MARK} ${answer}`, { kind: 'model', provider: target.provider, model: target.model }, usage)
  return { kind: 'success', text: receipt }
}
