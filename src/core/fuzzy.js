/**
 * 文件名模糊匹配（VSCode Ctrl+P 风格）：有序子序列评分 + 解析语义。
 *
 * 评分规则（越高越好，全小写比较）：
 *   - query 必须是 candidate 的子序列，否则不匹配
 *   - 边界加成 +3：匹配落在串首或 `-` `_` `.` `/` 之后（日期与扩展名的分隔处）
 *   - 连续加成 +4：与上一个匹配的查询字符在候选中相邻（连续运行强于散点）
 *   - 跳过惩罚 -0.1：候选中每跳过一个未匹配字符
 *   - 短候选加成：最终得分 ×10 后按候选长度轻微折扣
 *
 * 解析语义（resolveViewTarget）：
 *   exact     —— 查询就是完整文件名（或去扩展名后唯一对应）
 *   unique    —— 模糊赢家得分领先第二名 ≥ 20（约 2 个加分点），自动选中
 *   ambiguous —— 多个候选难分难解 → 调用方列出候选让用户挑
 *   none      —— 无匹配
 *
 * @module dsh-memoryleak/core/fuzzy
 */

/** 字符位置是否为边界（串首或分隔符之后）。 */
function isBoundary(name, index) {
  if (index === 0) return true
  const prev = name.charAt(index - 1)
  return prev === '-' || prev === '_' || prev === '.' || prev === '/'
}

const SKIP_PENALTY = -0.1
const BOUNDARY_BONUS = 3
// 连续加成必须大于边界加成：整段连续命中（docs/plan.md 对 "plan"）应强于
// 每个字符各自落在分隔符之后的散点命中（docs/p-l-a-n.md）。
const CONSECUTIVE_BONUS = 4

/**
 * 计算子序列对齐得分。
 *
 * @param {string} candidate 候选文件名
 * @param {string} query 查询片段
 * @returns {number | null} 得分（已含短候选折扣）；不匹配返回 null
 */
export function fuzzyScore(candidate, query) {
  const name = String(candidate ?? '').toLowerCase()
  const q = String(query ?? '').trim().toLowerCase()
  if (q === '') return 0
  if (q.length > name.length) return null
  const cols = q.length
  // previousS / previousM：上一候选字符行的「最优分」与「以匹配收尾的最优分」
  let previousS = new Array(cols + 1).fill(-Infinity)
  let previousM = new Array(cols + 1).fill(-Infinity)
  previousS[0] = 0
  for (let i = 1; i <= name.length; i += 1) {
    const currentS = new Array(cols + 1).fill(-Infinity)
    const currentM = new Array(cols + 1).fill(-Infinity)
    currentS[0] = 0
    const char = name.charAt(i - 1)
    for (let j = 1; j <= cols; j += 1) {
      // 跳过候选字符（保持已匹配的查询前缀）
      let best = previousS[j] === -Infinity ? -Infinity : previousS[j] + SKIP_PENALTY
      // 候选字符匹配第 j 个查询字符
      if (char === q.charAt(j - 1)) {
        const base = previousS[j - 1]
        if (base !== -Infinity) {
          let score = base + 1
          if (isBoundary(name, i - 1)) score += BOUNDARY_BONUS
          // 连续：上一个查询字符恰在相邻候选位置匹配过
          if (previousM[j - 1] !== -Infinity) score += CONSECUTIVE_BONUS
          if (score > best) best = score
        }
      }
      currentS[j] = best
      currentM[j] = char === q.charAt(j - 1) && previousS[j - 1] !== -Infinity
        ? (previousS[j - 1] + 1 + (isBoundary(name, i - 1) ? BOUNDARY_BONUS : 0) + (previousM[j - 1] !== -Infinity ? CONSECUTIVE_BONUS : 0))
        : -Infinity
    }
    previousS = currentS
    previousM = currentM
  }
  const score = previousS[cols]
  if (score === -Infinity) return null
  return score * 10 - name.length
}

/**
 * 对候选文件名排序（得分降序，同分按名字升序）。
 *
 * @param {string} query 查询片段
 * @param {ReadonlyArray<string>} names 候选文件名
 * @param {{ limit?: number }} [options]
 * @returns {Array<{ name: string, score: number }>}
 */
export function rankFileMatches(query, names, options = {}) {
  const limit = options.limit ?? names.length
  const scored = []
  for (const name of names) {
    const score = fuzzyScore(name, query)
    if (score !== null) scored.push({ name, score })
  }
  scored.sort((left, right) => (right.score - left.score) || (left.name < right.name ? -1 : 1))
  return scored.slice(0, Math.max(0, limit))
}

/**
 * 解析 /ml view 的查询目标。
 *
 * @param {string} query 查询片段
 * @param {ReadonlyArray<string>} names 候选文件名（含扩展名）
 * @returns {{
 *   kind: 'exact', name: string
 * } | {
 *   kind: 'unique', name: string
 * } | {
 *   kind: 'ambiguous', names: string[]
 * } | {
 *   kind: 'none'
 * }}
 */
export function resolveViewTarget(query, names) {
  const q = String(query ?? '').trim()
  if (q === '') return { kind: 'none' }
  // 精确：完整文件名一致，或去扩展名后唯一对应
  const exact = names.find((name) => name === q)
  if (exact !== undefined) return { kind: 'exact', name: exact }
  const stemMatches = names.filter((name) => name.replace(/\.[^.]+$/, '') === q)
  if (stemMatches.length === 1) return { kind: 'exact', name: stemMatches[0] }
  if (stemMatches.length > 1) return { kind: 'ambiguous', names: stemMatches }
  // 模糊：唯一明显赢家（最终得分领先 ≥ 20，约 2 个原始加分点）才自动选
  const ranked = rankFileMatches(q, names, { limit: 8 })
  if (ranked.length === 0) return { kind: 'none' }
  if (ranked.length === 1) return { kind: 'unique', name: ranked[0].name }
  if (ranked[0].score - ranked[1].score >= 20) return { kind: 'unique', name: ranked[0].name }
  return { kind: 'ambiguous', names: ranked.slice(0, 5).map((entry) => entry.name) }
}
