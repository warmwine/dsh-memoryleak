/**
 * /ml ask 的核心纯逻辑（无 fs、无 LLM，全部可直接测试）：
 *   1. 问题关键词抽取 —— 空白/标点切分出词，中文按 bigram 补全（「主从复制」
 *      →「主从」「从复」「复制」），让子串命中成为可能；
 *   2. 资料文件打分 —— 文件名命中权重高于正文命中，用于挑最相关的
 *      MOMENTO 知识条目；
 *   3. prompt 组装 —— 资料按优先级顺序带文件名分段拼接 + 规则（只依据
 *      资料回答、标注来源、没有就说没有）。
 *
 * @module dsh-memoryleak/core/ask
 */

/** /ml ask 的资料字符预算（约 20k–25k token）。 */
export const ASK_BUDGET_CHARS = 80_000
/** 单个知识条目文件的截断上限（长条目只影响问答上下文，不影响落盘）。 */
export const ASK_ENTRY_CLIP = 4_000
/** 单个日志文件的截断上限。 */
export const ASK_JOURNAL_CLIP = 2_500
/** 日志文件带回的个数（按文件名降序 = 最近的优先）。 */
export const ASK_JOURNAL_COUNT = 3
/** 回答的 maxTokens（问答比压缩长，给足）。 */
export const ASK_MAX_TOKENS = 8_192

/** 日志/周志文件名（yyyy-mm-dd.md 或 yyyyWww.md）。 */
const JOURNAL_FILE_RE = /^\d{4}(?:-\d{2}-\d{2}|W\d{2})\.md$/

/** 一个名字是否是日志/周志文件。 */
export function isJournalFileName(name) {
  return JOURNAL_FILE_RE.test(name)
}

/**
 * 抽取问题关键词：非空白/标点切分；长度 ≥2 的词整体保留，≥3 的纯 CJK 词
 * 再补 bigram（子串命中）。英文统一小写。
 *
 * @param {string} question
 * @returns {string[]}
 */
export function extractAskTerms(question) {
  const terms = new Set()
  const words = String(question ?? '').split(/[^\p{L}\p{N}_]+/u).filter((word) => word.length >= 2)
  for (const word of words) {
    const lower = word.toLowerCase()
    terms.add(lower)
    // 纯 CJK 长词补 bigram（「主从复制」→ 主从/从复/复制）
    if (/^[\u4e00-\u9fff]{3,}$/.test(word)) {
      for (let index = 0; index + 2 <= word.length; index += 1) terms.add(word.slice(index, index + 2))
    }
  }
  return [...terms]
}

/** 文本里出现任一关键词的次数（大小写不敏感；空 terms → 0）。 */
function countTermHits(text, terms) {
  if (terms.length === 0) return 0
  const lower = String(text ?? '').toLowerCase()
  let hits = 0
  for (const term of terms) {
    let from = 0
    for (;;) {
      const at = lower.indexOf(term, from)
      if (at === -1) break
      hits += 1
      from = at + term.length
    }
  }
  return hits
}

/**
 * 资料相关度打分：文件名命中一次计 5，正文命中一次计 1（文件名是人工命
 * 名的主题概括，权重高）。0 分 = 不相关。
 *
 * @param {string} path 文件相对路径（vault 正斜杠）
 * @param {string} content 文件内容
 * @param {ReadonlyArray<string>} terms extractAskTerms 的关键词
 * @returns {number}
 */
export function scoreAskFile(path, content, terms) {
  return countTermHits(path, terms) * 5 + countTermHits(content, terms)
}

/** 尾部截断（带省略号标记；不足上限原样返回）。 */
function clipTail(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/**
 * 组装 /ml ask 的 prompt：规则（只依据资料、标注来源、没有就说没有）+
 * 资料分段（每段带文件名标题）+ 问题。
 *
 * @param {{ question: string, materials: ReadonlyArray<{ path: string, content: string }>, date: string, included: number, total: number }} input
 * @returns {string}
 */
export function buildAskPrompt({ question, materials, date, included, total }) {
  const blocks = materials.map((item) => `### ${item.path}\n${clipTail(item.content, ASK_BUDGET_CHARS)}`)
  return [
    '你是「MemoryLeak」私人笔记库的问答助手。用户就自己的 Vault 笔记提问。',
    '',
    '回答规则：',
    '- 只依据下面的资料回答；资料里没有的信息就直说笔记里没有，不要编造。',
    '- 引用资料里的事实时标注来源文件名（如「MOMENTO/databases.md」）。',
    '- 用中文回答，markdown 结构化（小标题 / 列表），先给结论再给依据。',
    '- 资料里有过时或矛盾之处，如实指出。',
    '',
    `─── 资料开始（${included}/${total} 个文件，按相关度与优先级选取）───`,
    '',
    blocks.join('\n\n'),
    '',
    '─── 资料结束 ───',
    '',
    `今天：${date}`,
    `问题：${question}`,
  ].join('\n')
}
