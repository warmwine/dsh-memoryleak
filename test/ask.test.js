/**
 * /ml ask 测试：core 纯逻辑（关键词 / 打分 / prompt）+ 宿主胶水（资料
 * 汇集的优先级与预算、runAskCommand 端到端的流式事件与回执）。
 * LLM 用伪 stream，文件系统用临时目录。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ASK_BUDGET_CHARS,
  buildAskPrompt,
  extractAskTerms,
  isJournalFileName,
  scoreAskFile,
} from '../src/core/ask.js'
import { gatherAskMaterials, runAskCommand, ASK_MARK } from '../src/ask.js'

/* ---------------- 纯逻辑 ---------------- */

describe('extractAskTerms（关键词抽取）', () => {
  it('切词 + 小写化；单字符与标点丢弃', () => {
    expect(extractAskTerms('Redis 端口?')).toEqual(['redis', '端口'])
    expect(extractAskTerms('a-b c')).toEqual([])
  })

  it('纯 CJK 长词补 bigram（子串命中）', () => {
    expect(extractAskTerms('主从复制')).toEqual(['主从复制', '主从', '从复', '复制'])
  })
})

describe('scoreAskFile（相关度打分）', () => {
  it('文件名命中权重（×5）高于正文命中（×1）', () => {
    const terms = extractAskTerms('主库 端口')
    expect(scoreAskFile('MOMENTO/主库.md', '', terms)).toBe(5)
    expect(scoreAskFile('MOMENTO/other.md', '主库 主库', terms)).toBe(2)
    expect(scoreAskFile('MOMENTO/other.md', '无关内容', terms)).toBe(0)
  })
})

describe('isJournalFileName / buildAskPrompt', () => {
  it('日志与周志文件名识别', () => {
    expect(isJournalFileName('2026-08-16.md')).toBe(true)
    expect(isJournalFileName('2026W33.md')).toBe(true)
    expect(isJournalFileName('databases.md')).toBe(false)
    expect(isJournalFileName('2026-08.md')).toBe(false)
  })

  it('prompt：规则 + 分段资料（带文件名标题）+ 日期与问题', () => {
    const prompt = buildAskPrompt({
      question: '主库端口？',
      materials: [
        { path: 'MOMENTO/index.md', content: '索引' },
        { path: 'MOMENTO/databases.md', content: '| 名称 | 端口 |' },
      ],
      date: '2026-08-16',
      included: 2,
      total: 3,
    })
    expect(prompt).toContain('只依据下面的资料回答')
    expect(prompt).toContain('### MOMENTO/index.md\n索引')
    expect(prompt).toContain('### MOMENTO/databases.md')
    expect(prompt).toContain('2/3 个文件')
    expect(prompt).toContain('今天：2026-08-16')
    expect(prompt.endsWith('问题：主库端口？')).toBe(true)
  })
})

/* ---------------- 宿主：资料汇集 ---------------- */

let vault = ''

beforeAll(async () => {
  vault = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-ask-'))
  await mkdir(join(vault, 'MOMENTO'), { recursive: true })
  await writeFile(join(vault, 'MOMENTO', 'index.md'), '# 索引\n| 标题 | 文件 |\n| --- | --- |\n| llm | llm.md |', 'utf8')
  await writeFile(join(vault, 'MOMENTO', 'databases.md'), '# Databases\n| 名称 | 端口 |\n| --- | --- |\n| 主库 | 5432 |', 'utf8')
  await writeFile(join(vault, 'MOMENTO', 'servers.md'), '# Servers\n| 名称 | 主机 |\n| --- | --- |\n| web1 | h1 |', 'utf8')
  await writeFile(join(vault, 'MOMENTO', 'redis-用法.md'), '## redis\n连接端口 6379，主从复制配置。', 'utf8')
  await writeFile(join(vault, 'MOMENTO', 'llm-stream.md'), '## llm\n一次性调用用法。', 'utf8')
  await writeFile(join(vault, '2026-08-14.md'), '## NOTE\n- 周五做了部署', 'utf8')
  await writeFile(join(vault, '2026-08-16.md'), '## NOTE\n- 今天修了端口告警', 'utf8')
})

afterAll(async () => {
  await rm(vault, { recursive: true, force: true })
})

describe('gatherAskMaterials（优先级 + 相关度 + 预算）', () => {
  it('顺序：索引 → 结构化登记 → 知识条目（相关度序）→ 近期日志（时间序）', async () => {
    const { materials, included, total } = await gatherAskMaterials(vault, undefined, 'redis 主从 端口')
    // index + 2 个存在的登记目标（databases/servers；credentials/glossary 未创建）
    // + 2 知识条目 + 2 日志 = 7；同名文件（登记目标 vs MOMENTO 条目）全局去重
    expect(total).toBe(7)
    const allPaths = materials.map((item) => item.path)
    expect(allPaths.filter((path) => path === 'MOMENTO/databases.md')).toHaveLength(1) // 不重复出现
    expect(allPaths[0]).toBe('MOMENTO/index.md')
    const paths = materials.map((item) => item.path)
    expect(paths[0]).toBe('MOMENTO/index.md')
    // 结构化登记目标在内（MOMENTO/databases.md 等）
    expect(paths).toContain('MOMENTO/databases.md')
    // 相关度：redis-用法（问题全命中）排在 llm-stream 前
    expect(paths.indexOf('MOMENTO/redis-用法.md')).toBeLessThan(paths.indexOf('MOMENTO/llm-stream.md'))
    // 日志取最近 2 份（2026-08-16 在 2026-08-14 前）
    expect(paths.indexOf('2026-08-16.md')).toBeLessThan(paths.indexOf('2026-08-14.md'))
    expect(paths).not.toContain('2026-08-15.md')
    expect(included).toBe(materials.length)
  })

  it('预算内截断：资料总长不超预算，装不下的从队尾丢', async () => {
    const bigVault = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-ask-big-'))
    try {
      await mkdir(join(bigVault, 'MOMENTO'), { recursive: true })
      // 30 个长条目：每个 6k 字符，总 180k ≫ 预算 80k
      for (let index = 0; index < 30; index += 1) {
        await writeFile(join(bigVault, 'MOMENTO', `entry-${String(index).padStart(2, '0')}.md`), `# 条目 ${index}\n${'x'.repeat(6_000)}`, 'utf8')
      }
      const { materials, included, total } = await gatherAskMaterials(bigVault, undefined, '')
      expect(total).toBe(30)
      expect(included).toBeLessThan(total) // 装不下的被丢弃
      const used = materials.reduce((sum, item) => sum + item.content.length, 0)
      expect(used).toBeLessThanOrEqual(ASK_BUDGET_CHARS)
      // 单条也按上限截断（6k 原文 → ≤4k 的条目截断）
      for (const item of materials) {
        if (item.path.startsWith('MOMENTO/entry-')) expect(item.content.length).toBeLessThanOrEqual(4_000)
      }
    } finally {
      await rm(bigVault, { recursive: true, force: true })
    }
  })
})

/* ---------------- 宿主：runAskCommand 端到端 ---------------- */

/** 伪 llm：同步吐 chunks（与 note 测试同款协议）。 */
function fakeLlm(chunks, captured = []) {
  return {
    async *stream(options) {
      captured.push(options)
      for (const chunk of chunks) yield chunk
    },
  }
}

/** 伪活会话：append 收集事件。 */
function liveSession(events = []) {
  const appended = []
  return {
    session: {
      events,
      id: 'session-ask-test',
      requestHeader: () => ({ config: { provider: 'prov', model: 'model-x' } }),
      append(type, data, ...opts) {
        const entry = { seq: appended.length + 1, type, data }
        if (opts[0]?.surfaceOp !== undefined) entry.surfaceOp = opts[0].surfaceOp
        appended.push(entry)
        return entry
      },
    },
    appended,
  }
}

describe('runAskCommand（端到端）', () => {
  const ANSWER = '生产主库端口 **5432**（来源：MOMENTO/databases.md）。'

  it('成功路径：资料带进 prompt、回答流式转发、settle 进上下文、回执纯文本', async () => {
    const captured = []
    const ctx = { llm: fakeLlm([
      { type: 'text-delta', index: 0, text: '生产主库端口 ' },
      { type: 'text-delta', index: 0, text: '**5432**（来源：MOMENTO/databases.md）。' },
      { type: 'usage', usage: { totalTokens: 777 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ], captured) }
    const { session, appended } = liveSession([{ seq: 1, type: 'command/run', data: { commandId: 'cmd-ask', name: 'ml' } }])
    const result = await runAskCommand(ctx, { session }, { commandId: 'cmd-ask', signal: new AbortController().signal }, vault, '主库端口是多少')

    expect(result.kind).toBe('success')
    // prompt：资料与问题都在，maxTokens 加长
    const prompt = captured[0].messages[0].content[0].text
    expect(prompt).toContain('### MOMENTO/databases.md')
    expect(prompt).toContain('问题：主库端口是多少')
    expect(captured[0].maxTokens).toBeGreaterThan(4096)
    // 流式：开始信号 + 回答 markdown 原样转发 + usage
    const deltas = appended.filter((e) => e.type === 'assistant/chunk' && e.data.chunk.type === 'text-delta').map((e) => e.data.chunk.text)
    expect(deltas[0]).toContain(`${ASK_MARK} 提问`)
    expect(deltas[0]).toContain('prov/model-x')
    expect(deltas.slice(1).join('')).toBe(ANSWER)
    expect(appended.some((e) => e.data?.chunk?.type === 'usage')).toBe(true)
    // settle：append 型 assistant/message，带标记前缀与 usage
    const settle = appended.find((e) => e.type === 'assistant/message')
    expect(settle.surfaceOp).toBe('append')
    expect(settle.data.message.content[0].text).toBe(`${ASK_MARK} ${ANSWER}`)
    expect(settle.data.usage).toEqual({ totalTokens: 777 })
    // 命令卡回执：纯文本，含模型行
    expect(result.text).toContain(ANSWER)
    expect(result.text).toContain('已回答（引用')
    expect(result.text).toContain('777 tokens')
  })

  it('思考转发：reasoning-delta 以思考块（块位 0）流式显示，回答正文在块位 1', async () => {
    const ctx = { llm: fakeLlm([
      { type: 'reasoning-delta', index: 0, text: '用户问端口，去 databases.md 找' },
      { type: 'text-delta', index: 0, text: '生产主库端口 ' },
      { type: 'text-delta', index: 0, text: '**5432**。' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]) }
    const { session, appended } = liveSession([{ seq: 1, type: 'command/run', data: { commandId: 'cmd-think', name: 'ml' } }])
    const result = await runAskCommand(ctx, { session }, { commandId: 'cmd-think', signal: new AbortController().signal }, vault, '主库端口是多少')
    expect(result.kind).toBe('success')
    const reasoning = appended.filter((e) => e.type === 'assistant/chunk' && e.data.chunk.type === 'reasoning-delta')
    expect(reasoning).toHaveLength(1)
    expect(reasoning[0].data.chunk.index).toBe(0)
    expect(reasoning[0].data.chunk.text).toContain('去 databases.md 找')
    const texts = appended.filter((e) => e.type === 'assistant/chunk' && e.data.chunk.type === 'text-delta')
    for (const entry of texts) expect(entry.data.chunk.index).toBe(1)
  })

  it('无当前模型 → 报错（不调 LLM）', async () => {
    let called = 0
    const ctx = { llm: { async *stream() { called += 1 } } }
    const result = await runAskCommand(ctx, { session: { events: [], requestHeader: () => undefined, options: {} } }, { commandId: 'c', signal: new AbortController().signal }, vault, 'q')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('当前模型')
    expect(called).toBe(0)
  })

  it('空 Vault → 明确报错（不调 LLM）', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-ask-empty-'))
    try {
      let called = 0
      const ctx = { llm: { async *stream() { called += 1 } } }
      const result = await runAskCommand(ctx, { session: { events: [], requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }, { commandId: 'c', signal: new AbortController().signal }, empty, 'q')
      expect(result.kind).toBe('error')
      expect(result.text).toContain('还没有可引用的内容')
      expect(called).toBe(0)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  it('模型故障 → interrupt 收尾 + 错误结果', async () => {
    const ctx = { llm: fakeLlm([{ type: 'text-delta', index: 0, text: '写到一半' }, { type: 'finish', reason: { kind: 'error', failure: { message: '炸了' } } }]) }
    const { session, appended } = liveSession([{ seq: 1, type: 'command/run', data: { commandId: 'cmd-bad' } }])
    const result = await runAskCommand(ctx, { session }, { commandId: 'cmd-bad', signal: new AbortController().signal }, vault, 'q')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('回答调用失败')
    expect(appended.filter((e) => e.type === 'assistant/message')).toEqual([]) // 无 settle
    expect(appended.filter((e) => e.type === 'step/end')).toHaveLength(1) // interrupt 收尾
  })
})
