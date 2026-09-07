/**
 * /ml ask 的宿主胶水：/ml note 的反向——note 把对话写进 Vault，ask 把
 * Vault 读出来当资料，用当前模型回答用户的问题（**只读，绝不写 Vault**）。
 *
 * 命令做薄：本地空库检查后，把问题作为一条 user 消息交给当前模型的原生
 * 回合（agent.followup）。模型在回合里调 memory_ask_gather 工具拿资料包
 * （预算 / 相关度打分 / 去重都在工具里由代码执行），然后原生思考并输出
 * markdown 回答——全部走 DSH 默认对话的渲染与调用路线。
 *
 * @module dsh-memoryleak/ask
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { TodoError } from './core/errors.js'
import { readVaultNoteConfig } from './vault.js'
import { ASK_MARK, HANDOFF_SOURCE } from './core/command.js'
import { resolveStructuredTargets, DEFAULT_STRUCTURED_TARGETS } from './core/note.js'
import {
  ASK_BUDGET_CHARS,
  ASK_ENTRY_CLIP,
  ASK_JOURNAL_CLIP,
  ASK_JOURNAL_COUNT,
  extractAskTerms,
  isJournalFileName,
  scoreAskFile,
} from './core/ask.js'

export { ASK_MARK }

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
 * /ml ask：空库检查后，把问题交给当前模型的原生回合。模型调
 * memory_ask_gather 拿资料包，然后原生思考并回答（markdown、标来源），
 * 回答自然进入对话上下文，可继续追问。
 *
 * @param {import('@deepseek-ai/cordis').Context} _ctx
 * @param {{ followup?: Function }} agent
 * @param {{ commandId: string, signal: AbortSignal }} _invocation
 * @param {string} vaultDir
 * @param {string} question 用户问题
 * @returns {Promise<{ kind: 'success', text: string } | { kind: 'error', text: string }>}
 */
export async function runAskCommand(_ctx, agent, _invocation, vaultDir, question) {
  // 空库早退：Vault 里什么都没有时白开一轮没有任何意义（资料汇集是纯本地读）
  const noteConfig = await readVaultNoteConfig(vaultDir)
  const { targets } = resolveStructuredTargets(noteConfig.noteStructured)
  const { included, total } = await gatherAskMaterials(vaultDir, targets, question)
  if (total === 0) {
    return {
      kind: 'error',
      text: 'Vault 里还没有可引用的内容（MOMENTO/ 知识文件、结构化登记、日志均为空）。\n先 /ml note 整理一段对话，或直接把笔记写进 Vault 再问。',
    }
  }
  if (typeof agent?.followup !== 'function') {
    return { kind: 'error', text: '当前环境不支持把任务交给模型（缺少 agent.followup 通道），无法执行 /ml ask。' }
  }
  // 交接消息只携带动态事实（问题原文；回答规则在 gather 工具的结果里随资
  // 料带出）。source 用 plugin——UI 渲染成折叠的「注入上下文」行。
  const handoff = [
    `${ASK_MARK} 提问（引用 ${included}/${total} 个文件）`,
    `请回答关于 MemoryLeak 笔记库（Vault：${vaultDir}）的问题：「${question}」。先调 memory_ask_gather（question 传问题原文）拿资料包，只依据资料回答、标注来源文件名，资料里没有的就直说没有；用中文 markdown 结构化（先结论后依据）。`,
  ].join('\n')
  agent.followup({
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: handoff }],
    source: HANDOFF_SOURCE,
  })
  return {
    kind: 'success',
    text: `提问已交给当前模型（引用 ${included}/${total} 个文件）。它会在对话里直接回答，可继续追问。`,
  }
}
