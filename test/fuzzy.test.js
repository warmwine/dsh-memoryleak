import { describe, expect, it } from 'vitest'
import { fuzzyScore, rankFileMatches, resolveViewTarget } from '../src/core/fuzzy.js'

const FILES = [
  '2026-08-16.md',
  '2026-08-15.md',
  '2026W33.md',
  'docs/plan.md',
  'docs/architecture.md',
  'README.md',
]

describe('fuzzyScore（子序列评分）', () => {
  it('子序列命中得分，非子序列为 null', () => {
    expect(fuzzyScore('2026-08-16.md', '26816')).not.toBeNull()
    expect(fuzzyScore('docs/plan.md', 'dplan')).not.toBeNull()
    expect(fuzzyScore('2026-08-16.md', 'xyz')).toBeNull()
    expect(fuzzyScore('abc', 'abcd')).toBeNull() // 查询比候选长
    expect(fuzzyScore('anything', '')).toBe(0)
  })

  it('大小写不敏感', () => {
    expect(fuzzyScore('README.md', 'readme')).not.toBeNull()
    expect(fuzzyScore('README.md', 'RdMe')).not.toBeNull()
  })

  it('边界/连续优于跳跃匹配', () => {
    // 'plan' 连续出现在 docs/plan.md；'p…l…a…n' 跳跃匹配同文件分数更低
    const consecutive = fuzzyScore('docs/plan.md', 'plan')
    const jump = fuzzyScore('docs/p-l-a-n.md', 'plan')
    expect(consecutive).toBeGreaterThan(jump)
    // 边界匹配（段首）优于段中匹配（等长候选，排除长度折扣干扰）
    const atBoundary = fuzzyScore('26-aaaa.md', '26') // 匹配落在串首边界
    const midWord = fuzzyScore('x26aaaa.md', '26') // 同长度，匹配落在段中
    expect(atBoundary).toBeGreaterThan(midWord)
  })
})

describe('rankFileMatches（排序）', () => {
  it('按得分降序，同分按名字升序', () => {
    const ranked = rankFileMatches('08', FILES)
    expect(ranked.length).toBeGreaterThan(0)
    for (let index = 1; index < ranked.length; index += 1) {
      const [left, right] = [ranked[index - 1], ranked[index]]
      const ordered = left.score > right.score || (left.score === right.score && left.name <= right.name)
      expect(ordered).toBe(true)
    }
  })

  it('limit 截断', () => {
    expect(rankFileMatches('2', FILES, { limit: 2 })).toHaveLength(2)
  })
})

describe('resolveViewTarget（解析语义）', () => {
  it('exact：完整文件名 / 去扩展名唯一对应', () => {
    expect(resolveViewTarget('README.md', FILES)).toEqual({ kind: 'exact', name: 'README.md' })
    expect(resolveViewTarget('2026-08-16', FILES)).toEqual({ kind: 'exact', name: '2026-08-16.md' })
  })

  it('unique：明显领先的模糊赢家', () => {
    expect(resolveViewTarget('26816', FILES)).toEqual({ kind: 'unique', name: '2026-08-16.md' })
    expect(resolveViewTarget('w33', FILES)).toEqual({ kind: 'unique', name: '2026W33.md' })
  })

  it('ambiguous：难分难解时交还候选', () => {
    const result = resolveViewTarget('08-1', FILES) // 15/16 两天的日期都强匹配
    expect(result.kind).toBe('ambiguous')
    expect(result.names).toContain('2026-08-15.md')
    expect(result.names).toContain('2026-08-16.md')
  })

  it('none：无匹配 / 空查询', () => {
    expect(resolveViewTarget('zzz', FILES)).toEqual({ kind: 'none' })
    expect(resolveViewTarget('', FILES)).toEqual({ kind: 'none' })
    expect(resolveViewTarget('  ', FILES)).toEqual({ kind: 'none' })
  })
})
