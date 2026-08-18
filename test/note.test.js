/**
 * /ml note 测试：core 纯逻辑（transcript / 协议解析 / 落盘渲染）+ 宿主胶水
 * （区间定位 / 模型路由 / 压缩调用 / 端到端落盘）。LLM 用伪 stream，文件
 * 系统用临时目录。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildTranscript,
  buildNotePrompt,
  parseNoteJson,
  slugify,
  renderEntryFile,
  mergeIndexDocument,
  mergeStructuredDocument,
  mergeTableDocument,
  mergeSectionsDocument,
  extractTableRows,
  mergeRowsByField,
  lostKeys,
  resolveStructuredTargets,
  rowFromStorage,
  rowToStorage,
  parseSectionsDocument,
  DEFAULT_STRUCTURED_TARGETS,
  assertNoRowLoss,
  insertNoteSection,
  NoteParseError,
  STRUCTURED_SPECS,
  extractStructuredRows,
  parseIndexTitles,
} from '../src/core/note.js'
import { readVaultNoteConfig, writeVaultSettingsFile } from '../src/vault.js'
import {
  collectNoteItems,
  resolveNoteModel,
  streamNoteCompletion,
  persistNoteResult,
  runNoteCommand,
  NoteLlmError,
  MOMENTO_DIR,
} from '../src/note.js'

/* ---------------- 事件工厂（伪 session 日志） ---------------- */

let nextSeq = 1

function event(type, data, surfaceOp = undefined) {
  const entry = { seq: nextSeq++, type, data }
  if (surfaceOp !== undefined) entry.surfaceOp = surfaceOp
  return entry
}

function userMessage(text, extraBlocks = []) {
  return event(
    'user/message',
    {
      id: `u${nextSeq}`,
      role: 'user',
      content: [{ type: 'text', text }, ...extraBlocks],
      source: { kind: 'user' },
    },
    'append',
  )
}

function assistantMessage(text, toolCalls = []) {
  return event(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: {
        id: `a${nextSeq}`,
        role: 'assistant',
        content: [
          ...(text === '' ? [] : [{ type: 'text', text }]),
          ...toolCalls.map((call) => ({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments ?? '{}' })),
        ],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    },
    'append',
  )
}

function toolCall(callId, name) {
  return event('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
}

function toolResult(callId, content) {
  return event(
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: {
        id: `t${nextSeq}`,
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content, isError: false }],
        source: { kind: 'tool', callId },
      },
    },
    'append',
  )
}

function noteRun(commandId, args = 'note') {
  return event('command/run', { commandId, name: 'ml', args, source: { kind: 'user' } })
}

function noteDone(commandId, kind = 'success') {
  return event('command/done', { commandId, kind, text: 'ok' })
}

function sessionOf(events) {
  return {
    events,
    seq: nextSeq - 1,
    id: 'session-test',
    requestHeader: () => ({ config: { provider: 'prov', model: 'model-x' } }),
  }
}

/** 带事件写入的活会话桩：append 收集到 appended（runNoteCommand 流式路径用）。 */
function liveSessionOf(events) {
  const session = sessionOf(events)
  const appended = []
  session.append = (type, data, ...opts) => {
    nextSeq += 1
    const entry = { seq: nextSeq - 1, type, data }
    if (opts[0]?.surfaceOp !== undefined) entry.surfaceOp = opts[0].surfaceOp
    if (Array.isArray(opts[0]?.sourceEventSeqs)) entry.sourceEventSeqs = opts[0].sourceEventSeqs
    appended.push(entry)
    return entry
  }
  return { session, appended }
}

/* ---------------- buildTranscript ---------------- */

describe('buildTranscript（转写与预算裁剪）', () => {
  it('全量收录：角色标签 + 文本', () => {
    const result = buildTranscript([
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '在的' },
      { role: 'tool', name: 'read', text: '文件内容' },
    ])
    expect(result.truncated).toBe(false)
    expect(result.included).toBe(3)
    expect(result.text).toContain('【用户】\n你好')
    expect(result.text).toContain('【助手】\n在的')
    expect(result.text).toContain('【工具结果 · read】\n文件内容')
  })

  it('单条超长截断（工具结果更狠）', () => {
    const long = 'x'.repeat(10_000)
    const result = buildTranscript([
      { role: 'user', text: long },
      { role: 'tool', text: long },
    ])
    expect(result.text).not.toContain('x'.repeat(9_000))
    expect(result.truncated).toBe(false) // 总量仍小：是单条截断不是预算裁剪
  })

  it('超预算：保头保尾，中间省略标记', () => {
    const items = []
    for (let index = 0; index < 100; index += 1) items.push({ role: 'user', text: `消息 ${index} ${'y'.repeat(100)}` })
    const result = buildTranscript(items, { budget: 8_000 })
    expect(result.truncated).toBe(true)
    expect(result.included).toBeLessThan(100)
    expect(result.text).toContain('消息 0')
    expect(result.text).toContain('消息 99')
    expect(result.text).toMatch(/中间省略 \d+ 条消息/)
    expect(result.text.length).toBeLessThan(9_000)
  })
})

/* ---------------- parseNoteJson ---------------- */

describe('parseNoteJson（模型输出协议）', () => {
  const valid = JSON.stringify({
    summary: '搭好了 note 命令',
    note: ['实现 core 纯逻辑', '接入命令分发'],
    momento: {
      entries: [{ title: 'DSH llm.stream 用法', body: 'ctx.llm.stream 接受 messages/maxTokens，消费 chunk 流。', tags: ['dsh', 'llm'] }],
    },
    structured: {
      databases: [{ name: '主库', type: 'postgres', host: 'db.example.com', port: '5432' }],
      servers: [],
      credentials: [{ name: '生产 AK', where: '环境变量 PROD_AK' }],
      glossary: [],
    },
  })

  it('合法输出解析为受信结构', () => {
    const parsed = parseNoteJson(valid)
    expect(parsed.summary).toBe('搭好了 note 命令')
    expect(parsed.notes).toHaveLength(2)
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0].tags).toEqual(['dsh', 'llm'])
    expect(parsed.structured.databases[0]).toMatchObject({ name: '主库', type: 'postgres', host: 'db.example.com', port: '5432', database: '', user: '', notes: '' })
    expect(parsed.structured.credentials[0].where).toBe('环境变量 PROD_AK')
    expect(parsed.warnings).toEqual([])
  })

  it('markdown fence 与前后杂文容错', () => {
    const fenced = `好的，以下是结果：\n\`\`\`json\n${valid}\n\`\`\`\n以上。`
    expect(parseNoteJson(fenced).summary).toBe('搭好了 note 命令')
  })

  it('非法条目丢弃并告警（缺标题 / 缺主键 / 类型错）', () => {
    const parsed = parseNoteJson(
      JSON.stringify({
        note: ['正常条目', 42, ''],
        momento: { entries: [{ title: '', body: '缺标题' }, { title: '好的', body: '' }, { title: '正常', body: '内容' }] },
        structured: { glossary: [{ term: '', definition: '缺主键' }, { term: 'OK', definition: '正常' }] },
      }),
    )
    expect(parsed.notes).toEqual(['正常条目'])
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.structured.glossary).toHaveLength(1)
    expect(parsed.warnings.some((warning) => warning.includes('缺标题'))).toBe(true)
    expect(parsed.warnings.some((warning) => warning.includes('缺主键'))).toBe(true)
  })

  it('表格注入清洗：| 与换行进不了单元格', () => {
    const parsed = parseNoteJson(
      JSON.stringify({
        structured: { servers: [{ name: 'a|b\nc', notes: 'x | y' }] },
      }),
    )
    expect(parsed.structured.servers[0].name).not.toMatch(/[|\n]/)
    expect(parsed.structured.servers[0].notes).not.toContain('|')
  })

  it('条数与长度上限', () => {
    const many = Array.from({ length: 99 }, (_, index) => ({ term: `t${index}`, definition: 'd'.repeat(999) }))
    const parsed = parseNoteJson(JSON.stringify({ structured: { glossary: many }, note: many.map((row) => row.term) }))
    expect(parsed.structured.glossary).toHaveLength(50)
    expect(parsed.structured.glossary[0].definition.length).toBeLessThanOrEqual(201)
    expect(parsed.notes.length).toBeLessThanOrEqual(20)
  })

  it('全空 / 非 JSON / 非对象 → NoteParseError', () => {
    expect(() => parseNoteJson('')).toThrow(NoteParseError)
    expect(() => parseNoteJson('这不是 JSON')).toThrow(NoteParseError)
    expect(() => parseNoteJson('[1,2,3]')).toThrow(NoteParseError)
    expect(() => parseNoteJson('{"summary":"","note":[],"momento":{"entries":[]}}')).toThrow(/全为空/)
  })

  it('无 summary 时兜底（其余非空即可）', () => {
    const parsed = parseNoteJson(JSON.stringify({ note: ['一条'] }))
    expect(parsed.summary).toBe('（无摘要）')
    expect(parsed.notes).toEqual(['一条'])
  })
})

/* ---------------- slugify / renderEntryFile / index ---------------- */

describe('slugify / 知识文件渲染', () => {
  it('slug 规范：小写、分隔符折叠、Windows 非法字符剔除、空兜底', () => {
    expect(slugify('DSH llm.stream 用法')).toBe('dsh-llm-stream-用法')
    expect(slugify('  a / b: c * d?  ')).toBe('a-b-c-d')
    expect(slugify('---')).toBe('untitled')
    expect(slugify('')).toBe('untitled')
    expect(slugify('？？？')).toBe('？？？') // 全角符号是合法文件名，保留
  })

  it('新文件带元信息；同 slug 追加「## 更新」分节', () => {
    const fresh = renderEntryFile({ title: '标题', body: '正文', date: '2026-02-06' })
    expect(fresh.startsWith('# 标题\n')).toBe(true)
    expect(fresh).toContain('> 首次记录 2026-02-06 · 来源 /ml note')
    expect(fresh).toContain('正文')
    const updated = renderEntryFile({ title: '标题', body: '新内容', date: '2026-02-07', existing: fresh })
    expect(updated).toContain('## 更新 2026-02-07')
    expect(updated).toContain('新内容')
    expect(updated.indexOf('正文')).toBeLessThan(updated.indexOf('## 更新'))
    expect(updated.endsWith('\n')).toBe(true)
  })

  it('index：新建与按文件名去重更新（保留最早记录日）', () => {
    const first = mergeIndexDocument(null, [{ slug: 'a', title: 'A', date: '2026-02-06', summary: 's1' }])
    expect(first).toContain('| A | a.md | 2026-02-06 | s1 |')
    const second = mergeIndexDocument(first, [
      { slug: 'a', title: 'A2', date: '2026-02-08', summary: 's2' },
      { slug: 'b', title: 'B', date: '2026-02-08', summary: '' },
    ])
    expect(second).toContain('| A2 | a.md | 2026-02-06 | s2 |')
    expect(second).toContain('| B | b.md | 2026-02-08 |  |')
    expect(second.match(/\| a\.md/g)).toHaveLength(1)
  })
})

/* ---------------- mergeStructuredDocument ---------------- */

describe('mergeStructuredDocument（结构化表格：零丢失合并）', () => {
  it('新建标准表（表头来自 spec；credentials 带警示脚注）', () => {
    const doc = mergeStructuredDocument(null, 'databases', [
      { name: '主库', type: 'postgres', host: 'db.example.com', port: '5432', database: 'app', user: 'app', notes: '' },
    ])
    expect(doc).toContain(`# ${STRUCTURED_SPECS.databases.title}`)
    expect(doc).toContain('| 名称 | 类型 | 主机 | 端口 | 库 | 用户 | 备注 |')
    expect(doc).toContain('| 主库 | postgres | db.example.com | 5432 | app | app |  |')
    const cred = mergeStructuredDocument(null, 'credentials', [{ name: 'AK', kind: 'api-key', where: 'env' }])
    expect(cred).toContain('永不写入明文密码')
  })

  it('按主键合并：新值覆盖、空值保留旧值、新键追加', () => {
    const base = mergeStructuredDocument(null, 'servers', [
      { name: 'web1', host: 'old.example.com', ip: '10.0.0.1', user: 'root', os: 'debian', notes: '边缘' },
    ])
    const merged = mergeStructuredDocument(base, 'servers', [
      { name: 'web1', host: 'new.example.com' }, // 覆盖 host，其余保留
      { name: 'db1', host: 'db1.example.com', notes: '新机器' }, // 追加
    ])
    expect(merged).toContain('| web1 | new.example.com | 10.0.0.1 | root | debian | 边缘 |')
    expect(merged).toContain('| db1 | db1.example.com |  |  |  | 新机器 |')
    expect(merged.match(/^\| /gm)).toHaveLength(4) // 表头 + 分隔线 + 2 数据行
  })

  it('【数据丢失回归】手写/不认识格式的老库文件：原内容一个字符不动，只在末尾追加小节', () => {
    // 2026-02 事故场景：老库是自由格式（手写段落 + 自定义表头），旧实现
    // 解析不出表格 → 当成空表 → 整个文件被重写成只有新行，老库全丢。
    const oldFile = [
      '# 数据库登记',
      '',
      '这是我从 2024 年维护的老库，下面这些一个都不能丢：',
      '',
      '- 生产主库 postgres://10.0.0.5:5432/app（主从）',
      '- 测试库 sqlite',
      '',
      '| 库名 | 地址 |', // 表头与我们 spec 不同（列数列名都不一样）
      '| --- | --- |',
      '| 老库A | 10.1.1.1 |',
      '| 老库B | 10.1.1.2 |',
      '',
      '> 以上是历史资产，请勿删除。',
      '',
    ].join('\n')
    const merged = mergeStructuredDocument(oldFile, 'databases', [{ name: '新库', type: 'mysql' }], '2026-02-07')
    // 原文件的所有内容逐字保留
    for (const fragment of ['这是我从 2024 年维护的老库', '- 生产主库 postgres://10.1.1.1 不对', '| 老库A | 10.1.1.1 |', '| 老库B | 10.1.1.2 |', '以上是历史资产，请勿删除。']) {
      if (fragment.includes('不对')) continue
      expect(merged).toContain(fragment)
    }
    expect(merged).toContain('- 生产主库 postgres://10.0.0.5:5432/app（主从）')
    expect(merged).toContain('| 老库A | 10.1.1.1 |')
    expect(merged).toContain('| 老库B | 10.1.1.2 |')
    // 新内容以独立小节追加在末尾，带日期戳
    expect(merged).toContain('## Databases（2026-02-07 追加）')
    expect(merged).toContain('| 新库 | mysql |')
    // 原有内容的顺序与位置不变（追加在原内容之后）
    expect(merged.indexOf('| 老库B | 10.1.1.2 |')).toBeLessThan(merged.indexOf('## Databases'))
  })

  it('【数据丢失回归】表头匹配的表格：只重写表格块，表格外的段落与说明原样保留', () => {
    const file = [
      '# Databases',
      '',
      '> 生产资产登记，更新请谨慎。',
      '',
      '| 名称 | 类型 | 主机 | 端口 | 库 | 用户 | 备注 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      '| 主库 | postgres | 10.0.0.5 | 5432 | app | app | 主从 |',
      '',
      '其他说明文字（表格之后）。',
    ].join('\n')
    const merged = mergeStructuredDocument(file, 'databases', [{ name: '新库', type: 'mysql' }])
    expect(merged).toContain('> 生产资产登记，更新请谨慎。')
    expect(merged).toContain('| 主库 | postgres | 10.0.0.5 | 5432 | app | app | 主从 |') // 老行保留
    expect(merged).toContain('| 新库 | mysql |') // 新行追加
    expect(merged).toContain('其他说明文字（表格之后）。')
    expect(merged.indexOf('其他说明文字')).toBeGreaterThan(merged.indexOf('| 新库 |'))
  })

  it('手改坏的数据行（列数不齐）：能解析的行仍参与合并，截断部分补空不丢行', () => {
    const handEdited = '# Servers\n\n| 名称 | 主机 | IP | 登录用户 | 系统 | 备注 |\n| --- | --- | --- | --- | --- | --- |\n| web1 | h |  |  |  |\n'
    const merged = mergeStructuredDocument(handEdited, 'servers', [{ name: 'web2', host: 'h2' }])
    expect(merged).toContain('| web1 |')
    expect(merged).toContain('| web2 | h2 |')
  })

  it('多个匹配表格（历史追加小节）：全部收编进第一个表格，行不重复不丢失', () => {
    const file = [
      '# Servers',
      '',
      '| 名称 | 主机 | IP | 登录用户 | 系统 | 备注 |',
      '| --- | --- | --- | --- | --- | --- |',
      '| web1 | h1 |  |  |  |  |',
      '',
      '## Servers（2026-02-01 追加）',
      '',
      '| 名称 | 主机 | IP | 登录用户 | 系统 | 备注 |',
      '| --- | --- | --- | --- | --- | --- |',
      '| web2 | h2 |  |  |  |  |',
    ].join('\n')
    const merged = mergeStructuredDocument(file, 'servers', [{ name: 'web3', host: 'h3' }])
    expect(merged.match(/^\| web/gm)).toHaveLength(3) // 三行都在，各一次
    expect(merged.match(/^\| 名称 \| 主机/gm)).toHaveLength(1) // 只剩一个表（旧的被收编）
    // 文本行（追加小节标题）按「文本永不删」原则保留
    expect(merged).toContain('## Servers（2026-02-01 追加）')
  })
})

/* ---------------- assertNoRowLoss（防丢失守卫） ---------------- */

describe('assertNoRowLoss（写入前守卫：宁可失败也不丢行）', () => {
  it('合并前后的主键集合守恒：新增/更新放行', () => {
    const before = mergeStructuredDocument(null, 'servers', [{ name: 'web1', host: 'h1' }, { name: 'web2', host: 'h2' }])
    const after = mergeStructuredDocument(before, 'servers', [{ name: 'web1', host: 'new' }, { name: 'web3', host: 'h3' }])
    expect(() => assertNoRowLoss(before, 'servers', after)).not.toThrow()
  })

  it('主键减少 → 拒绝写入（NoteParseError）', () => {
    const before = mergeStructuredDocument(null, 'servers', [{ name: 'web1', host: 'h1' }, { name: 'web2', host: 'h2' }])
    const evil = mergeStructuredDocument(null, 'servers', [{ name: 'only', host: 'x' }])
    expect(() => assertNoRowLoss(before, 'servers', evil)).toThrow(/丢失 2 个已有主键/)
  })

  it('空文件/无已知行 → 放行', () => {
    expect(() => assertNoRowLoss(null, 'servers', '# x\n')).not.toThrow()
    expect(() => assertNoRowLoss('手写内容没有表格', 'servers', '手写内容没有表格\n追加\n')).not.toThrow()
  })
})

/* ---------------- insertNoteSection ---------------- */

describe('insertNoteSection（日志 ## NOTE：### 小节纯追加）', () => {
  it('daily：新建模块插在 ## MemoryLeak 之后，小节带时间与摘要', () => {
    const content = 'start: 2026-02-06\n\n## MemoryLeak\n\n- 上午的记录\n\n## Todo\n\n- [ ] x\n'
    const next = insertNoteSection(content, { mode: 'daily', date: '2026-02-06', time: '14:30', summary: '完成 note 命令', items: ['写核心逻辑', '写测试'] })
    const noteIndex = next.indexOf('## NOTE')
    const mlIndex = next.indexOf('## MemoryLeak')
    const todoIndex = next.indexOf('## Todo')
    expect(noteIndex).toBeGreaterThan(mlIndex)
    expect(noteIndex).toBeLessThan(todoIndex)
    expect(next).toContain('### 14:30 · 完成 note 命令')
    expect(next).toContain('- 写核心逻辑')
    expect(next).toContain('- 写测试')
  })

  it('已有模块：新小节追加到模块尾部，已有小节一行不动', () => {
    const content = '## NOTE\n\n### 09:00 · 早些的整理\n\n- 旧条目\n\n## Todo\n\n- [ ] x\n'
    const next = insertNoteSection(content, { mode: 'daily', date: '2026-02-06', time: '15:00', summary: '新一次', items: ['新条目'] })
    expect(next.indexOf('### 09:00')).toBeLessThan(next.indexOf('### 15:00'))
    expect(next.indexOf('### 15:00')).toBeLessThan(next.indexOf('## Todo'))
    expect(next).toContain('- 旧条目')
    // NOTE 模块内是纯追加：原有小节原样在前，新小节紧随其后
    expect(next).toContain('### 09:00 · 早些的整理\n\n- 旧条目\n\n### 15:00 · 新一次')
    expect(next).toContain('## Todo\n\n- [ ] x') // 模块之外的内容不动
  })

  it('weekly：小节标题带日期，追加到模块尾', () => {
    const content = '## NOTE\n\n### 2026-02-05 10:00 · 周三的\n\n- a\n'
    const next = insertNoteSection(content, { mode: 'weekly', date: '2026-02-06', time: '16:00', summary: '今天的', items: ['b'] })
    expect(next).toContain('### 2026-02-06 16:00 · 今天的')
    expect(next).toContain('- a')
    expect(next.indexOf('### 2026-02-05')).toBeLessThan(next.indexOf('### 2026-02-06'))
  })

  it('全空文件：头部锚点直接建模块', () => {
    const next = insertNoteSection('', { mode: 'daily', date: '2026-02-06', time: '18:00', summary: 's', items: [] })
    expect(next.trim()).toBe('## NOTE\n\n### 18:00 · s')
  })

  it('条目单行化（模型输出的换行不破结构）', () => {
    const next = insertNoteSection('## NOTE\n', { mode: 'daily', date: '2026-02-06', time: '18:00', summary: 's', items: ['第一行\n第二行'] })
    expect(next).toContain('- 第一行 第二行')
  })
})

/* ---------------- collectNoteItems ---------------- */

describe('collectNoteItems（区间定位与投影）', () => {
  it('没有上一个 note：整个会话（到当前 note 的 run 之前）', () => {
    nextSeq = 1
    const events = [
      userMessage('第一个问题'),
      assistantMessage('第一个回答', [{ id: 'c1', name: 'read', arguments: '{"file_path":"a.js"}' }]),
      toolCall('c1', 'read'),
      toolResult('c1', '文件内容'),
      noteRun('cmd-cur'),
    ]
    const { items, hasBoundary } = collectNoteItems(sessionOf(events), 'cmd-cur')
    expect(hasBoundary).toBe(false)
    expect(items).toHaveLength(3) // tool/call 是 log-only，不进转写
    expect(items[0]).toMatchObject({ role: 'user', text: '第一个问题' })
    expect(items[1].text).toContain('第一个回答')
    expect(items[1].text).toContain('[调用工具 read {"file_path":"a.js"}]')
    expect(items[2]).toMatchObject({ role: 'tool', name: 'read', text: '文件内容' })
  })

  it('有上一个 note：只收其 command/done 之后的内容', () => {
    nextSeq = 1
    const events = [
      userMessage('旧消息（上一段）'),
      noteRun('cmd-1'),
      noteDone('cmd-1'),
      userMessage('新消息（这一段）'),
      assistantMessage('新回答'),
      noteRun('cmd-cur'),
    ]
    const { items, hasBoundary } = collectNoteItems(sessionOf(events), 'cmd-cur')
    expect(hasBoundary).toBe(true)
    expect(items).toHaveLength(2)
    expect(items[0].text).toBe('新消息（这一段）')
  })

  it('上一个 note 没有 done（执行中断）：边界回退到 run 本身', () => {
    nextSeq = 1
    const events = [userMessage('旧'), noteRun('cmd-1'), userMessage('新'), noteRun('cmd-cur')]
    const { items, hasBoundary } = collectNoteItems(sessionOf(events), 'cmd-cur')
    expect(hasBoundary).toBe(true)
    expect(items).toHaveLength(1)
    expect(items[0].text).toBe('新')
  })

  it('其他命令不构成边界；非 note 的 /ml 用法不算（args 前缀）', () => {
    nextSeq = 1
    const events = [
      userMessage('消息'),
      event('command/run', { commandId: 'cmd-9', name: 'ml', args: '随手记一笔', source: { kind: 'user' } }),
      event('command/done', { commandId: 'cmd-9', kind: 'success', text: 'ok' }),
      noteRun('cmd-cur'),
    ]
    const { items, hasBoundary } = collectNoteItems(sessionOf(events), 'cmd-cur')
    expect(hasBoundary).toBe(false)
    expect(items).toHaveLength(1)
  })

  it('过滤 <system-reminder> 注入块；replace 型（compaction checkpoint）不入区间', () => {
    nextSeq = 1
    const events = [
      userMessage('真实消息', [{ type: 'text', text: '<system-reminder>\n运行时注入\n</system-reminder>' }]),
      event(
        'user/message',
        { id: 'chk', role: 'user', content: [{ type: 'text', text: 'checkpoint 摘要' }], source: { kind: 'plugin', plugin: 'dsh-compaction-basic' } },
        { op: 'replace', start: 1, end: 2 },
      ),
      noteRun('cmd-cur'),
    ]
    const { items } = collectNoteItems(sessionOf(events), 'cmd-cur')
    expect(items).toHaveLength(1)
    expect(items[0].text).toBe('真实消息')
  })

  it('找不到当前 commandId（异常调用）：按日志末尾处理，日志内最后一个 note 仍是边界', () => {
    nextSeq = 1
    // 防御分支：dsh-commands 保证 handler 调用前 run 已入日志，这里模拟
    // 理论上不可能的失配 —— 语义与正常路径一致：最后一个 note run 即边界。
    const withNote = [userMessage('旧'), noteRun('cmd-1'), userMessage('新')]
    expect(collectNoteItems(sessionOf(withNote), 'cmd-unknown')).toMatchObject({ hasBoundary: true, items: [{ role: 'user', text: '新' }] })
    nextSeq = 1
    const noNote = [userMessage('消息')]
    expect(collectNoteItems(sessionOf(noNote), 'cmd-unknown')).toMatchObject({ hasBoundary: false, items: [{ role: 'user', text: '消息' }] })
  })
})

/* ---------------- resolveNoteModel / streamNoteCompletion ---------------- */

describe('resolveNoteModel（当前模型路由）', () => {
  it('requestHeader 的 config 优先', () => {
    const agent = {
      options: { provider: 'fallback', model: 'fb-model' },
      session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'chat' } }) },
    }
    expect(resolveNoteModel(agent)).toEqual({ provider: 'deepseek', model: 'chat' })
  })

  it('无 header 时回退 agent.options；两者皆缺 → null', () => {
    expect(resolveNoteModel({ options: { provider: 'x', model: 'y' }, session: { requestHeader: () => undefined } })).toEqual({ provider: 'x', model: 'y' })
    expect(resolveNoteModel({ options: {}, session: {} })).toBe(null)
    expect(resolveNoteModel({})).toBe(null)
  })
})

/** 伪 llm 服务：同步吐 chunks。 */
function fakeLlm(chunks, captured = []) {
  return {
    async *stream(options) {
      captured.push(options)
      for (const chunk of chunks) yield chunk
    },
  }
}

describe('streamNoteCompletion（压缩调用）', () => {
  const base = { provider: 'p', model: 'm', prompt: '压缩它' }

  it('累积 text-delta 并返回 usage', async () => {
    const captured = []
    const ctx = { llm: fakeLlm([{ type: 'text-delta', index: 0, text: '{"a":' }, { type: 'text-delta', index: 0, text: '1}' }, { type: 'usage', usage: { totalTokens: 42 } }, { type: 'finish', reason: { kind: 'stop' } }], captured) }
    const result = await streamNoteCompletion(ctx, base)
    expect(result.text).toBe('{"a":1}')
    expect(result.usage).toEqual({ totalTokens: 42 })
    const options = captured[0]
    expect(options.provider).toBe('p')
    expect(options.model).toBe('m')
    expect(options.messages).toHaveLength(1)
    expect(options.messages[0].role).toBe('user')
    expect(options.messages[0].source.plugin).toBe('dsh-memoryleak')
    expect(options.messages[0].content[0].text).toBe('压缩它')
    expect(options.maxTokens).toBe(4096)
  })

  it('error / max-tokens finish → NoteLlmError', async () => {
    const bad = { llm: fakeLlm([{ type: 'text-delta', index: 0, text: 'x' }, { type: 'finish', reason: { kind: 'error', failure: { message: '炸了' } } }]) }
    await expect(streamNoteCompletion(bad, base)).rejects.toThrow(NoteLlmError)
    const truncated = { llm: fakeLlm([{ type: 'finish', reason: { kind: 'max-tokens' } }]) }
    await expect(streamNoteCompletion(truncated, base)).rejects.toThrow(/截断/)
  })
})

/* ---------------- 端到端（临时 Vault） ---------------- */

let vault

beforeAll(async () => {
  vault = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-note-'))
})

afterAll(async () => {
  await rm(vault, { recursive: true, force: true })
})

const SETTINGS = { journalMode: 'daily', dailyTemplate: '', weeklyTemplate: '' }

/** 一次典型的模型 JSON 输出（含 fence，检验容错）。 */
const MODEL_OUTPUT = [
  '```json',
  JSON.stringify({
    summary: '把 /ml note 命令从零做到能跑',
    note: ['core 纯逻辑：转写裁剪、协议解析、渲染', '宿主胶水：区间定位、llm 调用、落盘'],
    momento: {
      entries: [
        { title: 'DSH llm.stream 用法', body: '一次性调用：messages + maxTokens，text-delta 累积文本，finish 判错。', tags: ['dsh'] },
        { title: 'command/run 边界', body: 'command/run 在 handler 前入日志，可作 /ml note 的区间边界。', tags: ['dsh', '笔记'] },
      ],
    },
    structured: {
      databases: [{ name: '测试库', type: 'sqlite', host: '', port: '', database: 'test.db', user: '', notes: '' }],
      servers: [],
      credentials: [{ name: 'GitHub Token', kind: 'token', account: '', where: '环境变量 GH_TOKEN', notes: '' }],
      glossary: [{ term: 'MOMENTO', definition: '知识库目录', notes: '' }],
    },
  }),
  '```',
].join('\n')

describe('persistNoteResult / runNoteCommand（端到端落盘）', () => {
  it('persistNoteResult：MOMENTO 文件 + index + 日志 NOTE 全部落盘', async () => {
    const parsed = parseNoteJson(MODEL_OUTPUT)
    const now = () => new Date(2026, 1, 6, 14, 30)
    const result = await persistNoteResult({ vaultDir: vault, settings: SETTINGS, now, parsed })
    expect(result.momentoFiles).toContain(`${MOMENTO_DIR}/dsh-llm-stream-用法.md`)
    expect(result.momentoFiles).toContain(`${MOMENTO_DIR}/databases.md`)
    expect(result.momentoFiles).toContain(`${MOMENTO_DIR}/credentials.md`)
    expect(result.momentoFiles).toContain(`${MOMENTO_DIR}/glossary.md`)
    expect(result.momentoFiles).not.toContain(`${MOMENTO_DIR}/servers.md`) // 空
    expect(result.indexFile).toBe(`${MOMENTO_DIR}/index.md`)
    expect(result.noteFile).toBe('2026-02-06.md')

    const journal = await readFile(join(vault, '2026-02-06.md'), 'utf8')
    expect(journal).toContain('## NOTE')
    expect(journal).toContain('### 14:30 · 把 /ml note 命令从零做到能跑')
    expect(journal).toContain('- core 纯逻辑：转写裁剪、协议解析、渲染')

    const db = await readFile(join(vault, MOMENTO_DIR, 'databases.md'), 'utf8')
    expect(db).toContain('| 测试库 | sqlite |  |  | test.db |  |  |')
    const index = await readFile(join(vault, MOMENTO_DIR, 'index.md'), 'utf8')
    expect(index.match(/^\| /gm)).toHaveLength(4) // 表头 + 分隔线 + 2 entries

    // 同日再次执行：表格按主键合并、日志追加、知识文件追加更新分节
    const parsed2 = parseNoteJson(
      JSON.stringify({
        summary: '第二轮整理',
        note: ['补了一轮测试'],
        momento: { entries: [{ title: 'DSH llm.stream 用法', body: '补充：purpose 留空即可。', tags: [] }] },
        structured: { databases: [{ name: '测试库', notes: '加了备注' }] },
      }),
    )
    await persistNoteResult({ vaultDir: vault, settings: SETTINGS, now: () => new Date(2026, 1, 6, 16, 0), parsed: parsed2 })
    const db2 = await readFile(join(vault, MOMENTO_DIR, 'databases.md'), 'utf8')
    expect(db2.match(/^\| /gm)).toHaveLength(3) // 不重复
    expect(db2).toContain('| 测试库 | sqlite |  |  | test.db |  | 加了备注 |')
    const journal2 = await readFile(join(vault, '2026-02-06.md'), 'utf8')
    expect(journal2).toContain('### 14:30')
    expect(journal2).toContain('### 16:00')
    const entry2 = await readFile(join(vault, MOMENTO_DIR, 'dsh-llm-stream-用法.md'), 'utf8')
    expect(entry2).toContain('## 更新 2026-02-06')
    expect(entry2).toContain('purpose 留空即可')
    // 默认不备份（git 兜底）：无裸露 .bak，.backup/ 目录也未创建
    expect(existsSync(join(vault, MOMENTO_DIR, 'databases.md.bak'))).toBe(false)
    expect(existsSync(join(vault, '.backup'))).toBe(false)
  })

  it('备份开关：backup: true 时改前备份进 .backup/（新建不备份，修改才备份；时间戳不覆盖）', async () => {
    // 独立目标文件（glossary），避免与其他用例共写 databases.md 的顺序耦合
    const targets = resolveStructuredTargets({
      glossary: { file: 'momento-backup/glossary.md', format: 'table' },
    }).targets
    // 第一次：目标不存在（新建）→ 无备份
    const parsed1 = parseNoteJson(JSON.stringify({ summary: '一', note: ['a'], structured: { glossary: [{ term: '术语1', definition: 'd1' }] } }))
    await persistNoteResult({ vaultDir: vault, settings: SETTINGS, now: () => new Date(2026, 1, 10, 9, 0, 1), parsed: parsed1, targets, backup: true })
    // 第二、三次：修改已有 → 各留一份备份（时间戳不同不互相覆盖）
    const parsed2 = parseNoteJson(JSON.stringify({ summary: '二', note: ['b'], structured: { glossary: [{ term: '术语2', definition: 'd2' }] } }))
    await persistNoteResult({ vaultDir: vault, settings: SETTINGS, now: () => new Date(2026, 1, 10, 9, 5, 2), parsed: parsed2, targets, backup: true })
    const parsed3 = parseNoteJson(JSON.stringify({ summary: '三', note: ['c'], structured: { glossary: [{ term: '术语3', definition: 'd3' }] } }))
    await persistNoteResult({ vaultDir: vault, settings: SETTINGS, now: () => new Date(2026, 1, 10, 9, 10, 3), parsed: parsed3, targets, backup: true })
    const { readdir } = await import('node:fs/promises')
    const backupFiles = await readdir(join(vault, '.backup', 'momento-backup'), 'utf8').catch(() => [])
    const baks = backupFiles.filter((name) => name.startsWith('glossary.md.') && name.endsWith('.bak'))
    expect(baks.length).toBe(2) // 新建不备份；两次修改两份备份
    expect(baks[0]).toMatch(/^glossary\.md\.2026-02-10T09-/)
    // 较早的备份内容 = 只有术语1（第一次修改前的状态）
    const first = await readFile(join(vault, '.backup', 'momento-backup', baks.find((name) => name.includes('09-05')) ?? baks[0]), 'utf8')
    expect(first).toContain('| 术语1 |')
    expect(first).not.toContain('术语2')
    // 原目录无裸露 .bak
    expect(existsSync(join(vault, 'momento-backup', 'glossary.md.bak'))).toBe(false)
  })

  it('runNoteCommand：区间为空 → 明确报错（不调模型）', async () => {
    nextSeq = 1
    const events = [userMessage('旧'), noteRun('cmd-1'), noteDone('cmd-1'), noteRun('cmd-2')]
    let called = 0
    const ctx = { llm: { async *stream() { called += 1 } } }
    const result = await runNoteCommand(ctx, { session: sessionOf(events) }, { commandId: 'cmd-2', signal: new AbortController().signal }, vault, SETTINGS)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('没有新的对话内容')
    expect(called).toBe(0)
  })

  it('【端到端数据丢失回归】Vault 里已有手写老库文件：整理后老内容逐字保留', async () => {
    await mkdir(join(vault, MOMENTO_DIR), { recursive: true })
    const oldDb = [
      '# 数据库（手写老库）',
      '',
      '* 生产主库 10.0.0.5，千万不能丢',
      '',
      '| 自定义表头 | 不是我们的格式 |',
      '| --- | --- |',
      '| 老库A | 10.1.1.1 |',
      '',
    ].join('\n')
    await writeFile(join(vault, MOMENTO_DIR, 'databases.md'), oldDb, 'utf8')
    const parsed = parseNoteJson(
      JSON.stringify({
        summary: '登记了新库',
        note: ['查了新库'],
        structured: { databases: [{ name: '新库', type: 'mysql', host: '10.9.9.9' }] },
      }),
    )
    await persistNoteResult({ vaultDir: vault, settings: SETTINGS, now: () => new Date(2026, 1, 7, 10, 0), parsed, backup: true })
    const after = await readFile(join(vault, MOMENTO_DIR, 'databases.md'), 'utf8')
    expect(after).toContain('* 生产主库 10.0.0.5，千万不能丢')
    expect(after).toContain('| 老库A | 10.1.1.1 |')
    expect(after).toContain('| 自定义表头 | 不是我们的格式 |')
    expect(after).toContain('| 新库 | mysql | 10.9.9.9 |')
    expect(after).toContain('## Databases（2026-02-07 追加）')
    // 开备份时：修改前的完整老内容在 .backup/ 里（保留相对路径），原目录无裸露 .bak
    const { readdir } = await import('node:fs/promises')
    const backupNames = await readdir(join(vault, '.backup', MOMENTO_DIR))
    const bakName = backupNames.find((name) => name.startsWith('databases.md.') && name.endsWith('.bak'))
    expect(bakName).toBeDefined()
    const backup = await readFile(join(vault, '.backup', MOMENTO_DIR, bakName), 'utf8')
    expect(backup).toBe(oldDb)
    expect(existsSync(join(vault, MOMENTO_DIR, 'databases.md.bak'))).toBe(false)
  })

  it('runNoteCommand：无当前模型 → 报错并提示先发消息', async () => {
    nextSeq = 1
    const events = [userMessage('消息'), noteRun('cmd-x')]
    const session = { events, seq: nextSeq - 1, id: 's', requestHeader: () => undefined }
    const ctx = { llm: { async *stream() {} } }
    const result = await runNoteCommand(ctx, { session, options: {} }, { commandId: 'cmd-x', signal: new AbortController().signal }, vault, SETTINGS)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('当前模型')
  })

  it('runNoteCommand：成功路径返回汇总（模型 / 文件 / 摘要）', async () => {
    nextSeq = 1
    const events = [userMessage('做了 llm 调研'), assistantMessage('结论如下'), noteRun('cmd-ok')]
    const captured = []
    const ctx = { llm: fakeLlm([...MODEL_OUTPUT.match(/.*/g)].length ? [
      { type: 'text-delta', index: 0, text: MODEL_OUTPUT },
      { type: 'usage', usage: { totalTokens: 1234 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] : [], captured) }
    const result = await runNoteCommand(
      ctx,
      { session: sessionOf(events) },
      { commandId: 'cmd-ok', signal: new AbortController().signal },
      vault,
      SETTINGS,
    )
    expect(result.kind).toBe('success')
    expect(result.text).toContain('会话开始 → 本次')
    expect(result.text).toContain('2/2 条消息')
    expect(result.text).toContain('prov/model-x · 1234 tokens')
    expect(result.text).toContain('## NOTE')
    // prompt 里带了转写与协议
    const prompt = captured[0].messages[0].content[0].text
    expect(prompt).toContain('【用户】\n做了 llm 调研')
    expect(prompt).toContain('只输出一个 JSON 对象')
  })

  it('runNoteCommand：模型输出不合法 → NoteParseError 变错误结果', async () => {
    nextSeq = 1
    const events = [userMessage('消息'), noteRun('cmd-bad')]
    const ctx = { llm: fakeLlm([{ type: 'text-delta', index: 0, text: '我无法输出 JSON' }, { type: 'finish', reason: { kind: 'stop' } }]) }
    const result = await runNoteCommand(ctx, { session: sessionOf(events) }, { commandId: 'cmd-bad', signal: new AbortController().signal }, vault, SETTINGS)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('无法解析')
  })
})

/* ---------------- 流式过程显示（合成会话事件） ---------------- */

describe('runNoteCommand 流式过程（assistant-step 合成事件）', () => {
  it('成功路径：开始信号 → 模型 deltas → settle 为结果消息（append surface）', async () => {
    nextSeq = 1
    const base = [userMessage('做了 llm 调研'), assistantMessage('结论如下'), noteRun('cmd-live')]
    const { session, appended } = liveSessionOf(base)
    const ctx = {
      llm: fakeLlm([
        { type: 'text-delta', index: 0, text: MODEL_OUTPUT },
        { type: 'usage', usage: { totalTokens: 99 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]),
    }
    const result = await runNoteCommand(ctx, { session }, { commandId: 'cmd-live', signal: new AbortController().signal }, vault, SETTINGS)
    expect(result.kind).toBe('success')

    const chunks = appended.filter((entry) => entry.type === 'assistant/chunk')
    const messages = appended.filter((entry) => entry.type === 'assistant/message')
    expect(messages).toHaveLength(1)

    // step/start 先于一切 chunk（UI 的 assistant-step 投影靠它建立节点）
    const starts = appended.filter((entry) => entry.type === 'step/start')
    expect(starts).toHaveLength(1)
    const synthSteps = appended.filter((entry) => entry.data?.turn === 0).map((entry) => entry.data.step)
    expect(starts[0].data).toEqual({ turn: 0, step: synthSteps[0] })
    const firstChunk = appended.find((entry) => entry.type === 'assistant/chunk')
    expect(starts[0].seq).toBeLessThan(firstChunk.seq)

    // 开始信号是第一条 delta，立即可见（不等模型首 token）
    const firstDelta = chunks.find((entry) => entry.data.chunk.type === 'text-delta')
    expect(firstDelta.data.chunk.text).toContain('📌 /ml note 开始整理')
    expect(firstDelta.data.chunk.text).toContain('2/2 条消息')
    expect(firstDelta.data.chunk.text).toContain('prov/model-x')

    // 模型输出逐 delta 转发；usage 也转发（log-only）
    expect(chunks.some((entry) => entry.data.chunk.text === MODEL_OUTPUT)).toBe(true)
    expect(chunks.some((entry) => entry.data.chunk.type === 'usage')).toBe(true)

    // 全部合成事件在 turn 0、step 为非负整数（UI 校验 turn/step ≥ 0）
    for (const entry of appended.filter((item) => item.data?.turn === 0)) {
      expect(entry.data.turn).toBe(0)
      expect(Number.isSafeInteger(entry.data.step)).toBe(true)
      expect(entry.data.step).toBeGreaterThanOrEqual(0)
    }

    // settle：append 型 assistant/message，内容以标记开头、带 model source 与 usage；
    // 随后 step/end 闭合（与真实 loop 的 message → step/end 同构）
    const settle = messages[0]
    expect(settle.surfaceOp).toBe('append')
    expect(settle.data.message.role).toBe('assistant')
    expect(settle.data.message.source).toEqual({ kind: 'model', provider: 'prov', model: 'model-x' })
    expect(settle.data.message.content[0].text).toMatch(/^📌 \/ml note 已整理/)
    expect(settle.data.usage).toEqual({ totalTokens: 99 })
    // 溯源：引用了流式 chunk 的 seq
    expect(Array.isArray(settle.sourceEventSeqs)).toBe(true)
    const closeEnd = appended.filter((entry) => entry.type === 'step/end')
    expect(closeEnd).toHaveLength(1)
    expect(closeEnd[0].seq).toBeGreaterThan(settle.seq)
    expect(closeEnd[0].data).toEqual({ turn: 0, step: settle.data.step })
  })

  it('失败路径：模型输出不合法 → step/end 收尾（interrupt），无 assistant/message', async () => {
    nextSeq = 1
    const base = [userMessage('消息'), noteRun('cmd-bad2')]
    const { session, appended } = liveSessionOf(base)
    const ctx = { llm: fakeLlm([{ type: 'text-delta', index: 0, text: '不是 JSON' }, { type: 'finish', reason: { kind: 'stop' } }]) }
    const result = await runNoteCommand(ctx, { session }, { commandId: 'cmd-bad2', signal: new AbortController().signal }, vault, SETTINGS)
    expect(result.kind).toBe('error')
    expect(appended.filter((entry) => entry.type === 'assistant/message')).toEqual([])
    const starts = appended.filter((entry) => entry.type === 'step/start')
    const steps = appended.filter((entry) => entry.type === 'step/end')
    expect(starts).toHaveLength(1)
    expect(steps).toHaveLength(1)
    expect(starts[0].seq).toBeLessThan(steps[0].seq)
    expect(steps[0].data.turn).toBe(0)
    expect(steps[0].data.step).toBeGreaterThanOrEqual(0)
    expect(appended.some((entry) => entry.type === 'assistant/chunk' && entry.data.chunk.text.includes('开始整理'))).toBe(true)
  })

  it('压缩调用抛错（LLM 故障）→ 同样 step/end 收尾', async () => {
    nextSeq = 1
    const base = [userMessage('消息'), noteRun('cmd-err')]
    const { session, appended } = liveSessionOf(base)
    const ctx = { llm: fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { message: '网络炸了' } } }]) }
    const result = await runNoteCommand(ctx, { session }, { commandId: 'cmd-err', signal: new AbortController().signal }, vault, SETTINGS)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('网络炸了')
    expect(appended.filter((entry) => entry.type === 'step/end')).toHaveLength(1)
  })

  it('多次执行互不串台：step 编号按 run seq 唯一', async () => {
    nextSeq = 1
    const base = [userMessage('第一段'), noteRun('cmd-a')]
    const { session, appended } = liveSessionOf(base)
    const chunks = [
      { type: 'text-delta', index: 0, text: JSON.stringify({ summary: '一', note: ['x'] }) },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const ctx = { llm: fakeLlm(chunks) }
    await runNoteCommand(ctx, { session }, { commandId: 'cmd-a', signal: new AbortController().signal }, vault, SETTINGS)
    const firstSteps = new Set(appended.filter((entry) => entry.data?.turn === 0).map((entry) => entry.data.step))
    // 模拟第二次执行：新的对话内容 + 新的 run（seq 更大）
    session.events.push(userMessage('第二段'), noteRun('cmd-b'))
    await runNoteCommand(ctx, { session }, { commandId: 'cmd-b', signal: new AbortController().signal }, vault, SETTINGS)
    const allSteps = new Set(appended.filter((entry) => entry.data?.turn === 0).map((entry) => entry.data.step))
    expect(allSteps.size).toBe(2)
    expect(firstSteps.size).toBe(1)
  })

  it('上一次的结果消息不会进入下一次的压缩区间（NOTE_MARK 排除）', async () => {
    nextSeq = 1
    // 上一次 note 的 settle 消息在 surface 上（append）
    const settled = event(
      'assistant/message',
      {
        turn: 0,
        step: 3,
        message: {
          id: 'settled-1',
          role: 'assistant',
          content: [{ type: 'text', text: '📌 /ml note 已整理（上次）\n摘要：旧内容' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
      'append',
    )
    const base = [
      userMessage('旧消息'),
      event('command/run', { commandId: 'cmd-prev', name: 'ml', args: 'note', source: { kind: 'user' } }),
      event('command/done', { commandId: 'cmd-prev', kind: 'success', text: 'ok' }),
      settled,
      userMessage('新消息'),
      noteRun('cmd-next'),
    ]
    const { items } = collectNoteItems(sessionOf(base), 'cmd-next')
    expect(items).toHaveLength(1)
    expect(items[0].text).toBe('新消息')
  })
})

/* ---------------- buildNotePrompt 冒烟 ---------------- */

describe('buildNotePrompt', () => {
  it('包含转写边界与协议字段说明', () => {
    const prompt = buildNotePrompt({ transcript: '【用户】\n hi', date: '2026-02-06', hasBoundary: true })
    expect(prompt).toContain('上次 /ml note 之后到现在的对话')
    expect(prompt).toContain('【用户】\n hi')
    expect(prompt).toContain('structured')
    expect(prompt).toContain('严禁记录明文密码')
    expect(prompt).toContain('host 只写主机名或 IP，不带协议、不带端口')
  })

  it('有已知信息时注入存量并要求增量修改（不重建）', () => {
    const prompt = buildNotePrompt({
      transcript: '【用户】\n hi',
      date: '2026-02-06',
      hasBoundary: true,
      known: {
        structured: { servers: [{ name: 'web1', host: 'h1' }] },
        titles: ['DSH llm.stream 用法'],
      },
    })
    expect(prompt).toContain('已有知识状态')
    expect(prompt).toContain('servers 已有 1 行') // 存量行进了 prompt
    expect(prompt).toContain('「DSH llm.stream 用法」')
    expect(prompt).toContain('不要重复输出')
    expect(prompt).toContain('留空 = 保留原值')
  })
})

/* ---------------- 已知信息读取（extractStructuredRows / parseIndexTitles） ---------------- */

describe('readKnown 基础（extractStructuredRows / parseIndexTitles）', () => {
  it('从标准文件提取已知行；index 提取标题', () => {
    const doc = mergeStructuredDocument(null, 'servers', [
      { name: 'web1', host: 'h1' },
      { name: 'web2', host: 'h2' },
    ])
    const rows = extractStructuredRows(doc, 'servers')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ name: 'web1', host: 'h1' })
    const index = mergeIndexDocument(null, [{ slug: 'a', title: '知识A', date: '2026-02-06' }])
    expect(parseIndexTitles(index)).toEqual([{ title: '知识A', file: 'a.md' }])
  })

  it('手写格式提取不到（返回空），不报错', () => {
    expect(extractStructuredRows('# 手写\n| a | b |\n| --- | --- |\n| x | y |', 'servers')).toEqual([])
    expect(parseIndexTitles('# 没有 index 表')).toEqual([])
  })
})

/* ---------------- normalizeStructuredRow（模型输出清洗） ---------------- */

describe('parseNoteJson 结构化清洗（host:port / 协议前缀）', () => {
  it('databases：host 带端口拆到 port；协议前缀剥离；port 非数字清空', () => {
    const parsed = parseNoteJson(
      JSON.stringify({
        structured: {
          databases: [
            { name: '主库', host: 'db.example.com:5432', port: '' },
            { name: '二号', host: 'postgres://pg.internal/x', port: '' },
            { name: '三号', host: 'ok.host', port: '端口 3306' },
          ],
        },
      }),
    )
    const [a, b, c] = parsed.structured.databases
    expect(a).toMatchObject({ host: 'db.example.com', port: '5432' })
    expect(b).toMatchObject({ host: 'pg.internal/x' })
    expect(c).toMatchObject({ host: 'ok.host', port: '' })
  })
})

/* ---------------- vault 限定格式适配（noteStructured / noteSkill） ---------------- */

describe('resolveStructuredTargets（配置校验）', () => {
  it('空配置 → 全部内置默认（MOMENTO/ 下的标准表格）', () => {
    const { targets, errors } = resolveStructuredTargets(undefined)
    expect(errors).toEqual([])
    expect(targets.databases).toEqual(DEFAULT_STRUCTURED_TARGETS.databases)
    expect(targets.servers.format).toBe('table')
  })

  it('合法配置：自定义表头表格 + YAML 目标 + 字段子集与自定义主键', () => {
    const { targets, errors } = resolveStructuredTargets({
      databases: {
        file: 'infra/databases.md',
        format: 'table',
        header: ['库名', '类型', '地址', '端口', '库', '用户', '备注'],
      },
      servers: {
        file: 'infra/servers.yaml',
        format: 'yaml',
        fields: ['name', 'host', 'ip'],
        key: 'host',
      },
    })
    expect(errors).toEqual([])
    expect(targets.databases.file).toBe('infra/databases.md')
    expect(targets.databases.labels).toEqual(['库名', '类型', '地址', '端口', '库', '用户', '备注'])
    expect(targets.databases.fields).toEqual(DEFAULT_STRUCTURED_TARGETS.databases.fields)
    expect(targets.servers.format).toBe('yaml')
    expect(targets.servers.fields).toEqual(['name', 'host', 'ip'])
    expect(targets.servers.keyField).toBe('host')
    // 未配置的类别保持默认
    expect(targets.credentials).toEqual(DEFAULT_STRUCTURED_TARGETS.credentials)
  })

  it('header 数与 fields 数不一致（配置了 fields 时）报错', () => {
    const { errors } = resolveStructuredTargets({
      databases: { file: 'x.md', header: ['库名', '地址'], fields: ['name', 'type', 'host'] },
    })
    expect(errors[0]).toMatch(/一一对应/)
  })

  it.each([
    [{ file: '/abs/path', format: 'table' }, /vault 相对路径/],
    [{ file: 'a/../b.md', format: 'table' }, /vault 相对路径/],
    [{ file: 'x.md', format: 'json' }, /table、yaml 或 sections/],
    [{ file: 'x.md', fields: ['not-a-field'] }, /非空子集/],
    [{ file: 'x.md', format: 'yaml', fields: ['name', 'host'], key: 'os' }, /必须在 fields 内/],
    [{ file: 'x.md', header: ['a', 'b'] }, /一一对应/],
  ])('非法配置 %#：%j → 错误 %s', (config, pattern) => {
    const { errors } = resolveStructuredTargets({ servers: config })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toMatch(pattern)
  })

  it('未知类别报错；非对象报错', () => {
    expect(resolveStructuredTargets({ docker: {} }).errors[0]).toMatch(/未知类别 "docker"/)
    expect(resolveStructuredTargets([1, 2]).errors[0]).toMatch(/映射对象/)
  })
})

describe('自定义表头目标（mergeTableDocument / extractTableRows）', () => {
  const target = resolveStructuredTargets({
    databases: { file: 'infra/databases.md', header: ['库名', '类型', '地址', '端口'], fields: ['name', 'type', 'host', 'port'] },
  }).targets.databases

  it('老库自定义表头：按它合并（新行更新已有行），表格外内容保留', () => {
    const oldFile = [
      '# 基础设施库',
      '',
      '| 库名 | 类型 | 地址 | 端口 |',
      '| --- | --- | --- | --- |',
      '| 主库 | postgres | 10.0.0.5 | 5432 |',
      '| 老库B | mysql | 10.1.1.2 | 3306 |',
      '',
      '> 历史资产说明。',
    ].join('\n')
    const merged = mergeTableDocument(oldFile, target, [
      { name: '主库', host: '10.0.0.6' }, // 更新
      { name: '新库', type: 'redis' }, // 追加
    ], '2026-02-08')
    expect(merged).toContain('| 主库 | postgres | 10.0.0.6 | 5432 |')
    expect(merged).toContain('| 老库B | mysql | 10.1.1.2 | 3306 |') // 未提及的行原样
    expect(merged).toContain('| 新库 | redis |  |  |')
    expect(merged).toContain('# 基础设施库')
    expect(merged).toContain('> 历史资产说明。')
    expect(merged.match(/^\| 库名/gm)).toHaveLength(1)
    // 已知行读取也用同一表头
    const known = extractTableRows(merged, target)
    expect(known).toHaveLength(3)
    expect(known[0]).toMatchObject({ name: '主库', type: 'postgres', host: '10.0.0.6', port: '5432' })
  })

  it('老库表头对不上配置（配置改过）：仍然只追加小节，不动原文', () => {
    const oldFile = '# 库\n\n| 完全不同的 | 表头 |\n| --- | --- |\n| x | y |\n'
    const merged = mergeTableDocument(oldFile, target, [{ name: '新库' }], '2026-02-08')
    expect(merged).toContain('| x | y |')
    expect(merged).toContain('## Databases（2026-02-08 追加）')
  })
})

/* ---------------- sections 格式（markdown 小节 + 内嵌 YAML 块，用户老库形状） ---------------- */

/** 用户的 databases.md 老库形状（节选，含连接串示例块与警示行）。 */
const OLD_DATABASES = [
  '# 数据库凭证',
  '',
  '按类型分章，每台服务器一个三级标题（IP:port）。跨文件链接用锚点。',
  '',
  'YAML 字段说明（所有条目都遵守这套 schema）：',
  '',
  '| 字段 | 含义 |',
  '| --- | --- |',
  '| host / port | 主机 IP、端口 |',
  '| database | 连哪个库 |',
  '',
  '## MySQL',
  '',
  '### 10.1.1.183:3306',
  '',
  '```yaml',
  'host: 10.1.1.183',
  'port: 3306',
  'database: DigitalDB（库名未记录）',
  'user: root',
  'password: Swsmu@2022!',
  'environment: test',
  'purposes:',
  '  - DigitalDB UAT（申小顾/Digital 平台测试库，与自研 KAP UAT、OFS 测试同机）',
  'note: 管理员石海奇。同机 6379 还有 Redis UAT，见本文 Redis 章。',
  '```',
  '',
  '### 172.16.8.120:3106',
  '',
  '```yaml',
  'host: 172.16.8.120',
  'port: 3106',
  'database: kapdb',
  'user: kapuser',
  'password: kap@Swsmu2023!',
  'environment: production',
  'purposes:',
  '  - 自研 KAP 生产库（Digital 平台组合表、基金业绩看板、月报）',
  'bridges:',
  '  - 10.1.1.193:1527（应用网段经此转发访问）',
  'note: 管理员石海奇。密码含 @，连接串写 kap%40Swsmu2023!。',
  '```',
  '',
  '```',
  'mysql+pymysql://kapuser:kap%40Swsmu2023!@172.16.8.120:3106/kapdb',
  '```',
  '',
  '> ⚠️ 生产库，写任何 DELETE / UPDATE / DROP / 其他非select语句 之前停下，不要继续。',
  '',
  '## Oracle',
  '',
  '### 10.1.1.193:1527',
  '',
  '```yaml',
  'host: 10.1.1.193',
  'port: 1527',
  'database: ORAKAP',
  'user: kap',
  'password: oracle@123',
  'environment: production',
  'purposes:',
  '  - KAP 生产 Oracle 网桥',
  'note: 网桥机。',
  '```',
  '',
].join('\n')

/** 用户的 servers.md 老库形状（节选）。 */
const OLD_SERVERS = [
  '# 服务器凭证',
  '',
  '按系统类型分章（##），同一类型下每台服务器一个三级标题（###，IP）。',
  '',
  '## Linux',
  '',
  '### 10.1.1.91',
  '',
  '```yaml',
  'hostname: JQ-touyanzhushou-01',
  'ip: 10.1.1.91',
  'os: CentOS',
  'admin: 我',
  'environment: production',
  'purposes:',
  '  - 投研小助手（PHP版）生产：nginx 9000 + php-fpm，代码 /var/www/iassistant',
  'accounts:',
  '  - root / （问管理员）',
  'deploy_paths:',
  '  - /etc/nginx/conf.d/iassistant.conf',
  'note: 坑——升级/安装 PHP-FPM 会在 /etc/php-fpm.d/ 下生成 www.conf，注意改名。',
  '```',
  '',
  '### 10.1.1.183',
  '',
  '```yaml',
  'hostname: EBS-test-srv-01',
  'ip: 10.1.1.183',
  'os: CentOS',
  'admin: 石海奇',
  'environment: test',
  'purposes:',
  '  - UAT 测试环境集中部署',
  'accounts: []',
  'note: 组合表/月报的 UAT 验证在此进行。',
  '```',
  '',
].join('\n')

/** 用户的实际 noteStructured 配置形状（databases + servers）。 */
const USER_TARGETS = resolveStructuredTargets({
  databases: {
    file: 'momento/databases.md',
    format: 'sections',
    heading: '{host}:{port}',
    key: ['host', 'database'],
    fields: ['host', 'port', 'database', 'user', 'notes'],
    aliases: { notes: 'note' },
    extraFields: [
      { key: 'environment', desc: 'production 或 test' },
      { key: 'purposes', desc: '这台库上跑的功能' },
      { key: 'schemas' },
      { key: 'bridges' },
      { key: 'extra_accounts' },
    ],
  },
  servers: {
    file: 'momento/servers.md',
    format: 'sections',
    heading: '{ip}',
    key: ['ip'],
    fields: ['name', 'ip', 'os', 'user', 'notes'],
    aliases: { name: 'hostname', user: 'admin', notes: 'note' },
    extraFields: [
      { key: 'environment', desc: 'production 或 test' },
      { key: 'purposes', desc: '功能' },
      { key: 'accounts' },
      { key: 'deploy_paths' },
    ],
  },
}).targets

describe('sections 格式（老库 md 小节 + 内嵌 yaml 块）', () => {
  it('配置解析：aliases / extras / 复合 key / heading 全部就位', () => {
    expect(USER_TARGETS.databases).toMatchObject({
      format: 'sections',
      heading: '{host}:{port}',
      keyFields: ['host', 'database'],
      aliases: { notes: 'note' },
    })
    expect(USER_TARGETS.databases.extras.map((extra) => extra.key)).toEqual(['environment', 'purposes', 'schemas', 'bridges', 'extra_accounts'])
    expect(USER_TARGETS.servers.aliases).toEqual({ name: 'hostname', user: 'admin', notes: 'note' })
    expect(USER_TARGETS.servers.keyFields).toEqual(['ip'])
  })

  it('【核心】更新已有条目：只重写命中的 yaml 块，password 等未声明字段保留，其余一字不动', () => {
    const result = mergeSectionsDocument(
      OLD_DATABASES,
      USER_TARGETS.databases,
      [{ host: '10.1.1.183', port: '3306', database: 'DigitalDB（库名未记录）', user: '', notes: '管理员石海奇。Redis UAT 已迁移到 6380。', purposes: ['新增了备份任务（每日凌晨）'] }],
      '2026-02-08',
    )
    expect(result.warnings).toEqual([])
    expect(result.updated).toBe(1)
    const next = result.content
    // 命中块的 note 更新（经别名 notes→note），purposes 追加去重，user/password 原样
    expect(next).toContain('note: 管理员石海奇。Redis UAT 已迁移到 6380。')
    expect(next).toContain('password: Swsmu@2022!') // 未声明字段永不触碰
    expect(next).toContain('user: root')
    expect(next).toContain('- 新增了备份任务（每日凌晨）')
    expect(next).toContain('- DigitalDB UAT（申小顾/Digital 平台测试库，与自研 KAP UAT、OFS 测试同机）') // 旧列表项保留
    // 其余条目与结构一字不动
    expect(next).toContain('database: kapdb')
    expect(next).toContain('mysql+pymysql://kapuser:kap%40Swsmu2023!@172.16.8.120:3106/kapdb') // 连接串示例块
    expect(next).toContain('> ⚠️ 生产库，写任何 DELETE / UPDATE / DROP / 其他非select语句 之前停下，不要继续。')
    expect(next.match(/```yaml/g)).toHaveLength(3) // 块数不变
    expect(next.match(/^### /gm)).toHaveLength(3)
    expect(next.indexOf('## Oracle')).toBeGreaterThan(next.indexOf('## MySQL'))
  })

  it('【核心】新增条目：heading 命中已有小节 → 节内追加新块（紧随最后一个块）', () => {
    const result = mergeSectionsDocument(
      OLD_DATABASES,
      USER_TARGETS.databases,
      [{ host: '10.1.1.183', port: '3306', database: 'NewDB', user: 'app', notes: '新加的库', environment: 'test', purposes: ['报表测试'] }],
      '2026-02-08',
    )
    expect(result.updated).toBe(0)
    expect(result.created).toBe(1)
    // 新块追加在 10.1.1.183:3306 小节内（下一个 ### 之前）
    const sectionStart = result.content.indexOf('### 10.1.1.183:3306')
    const nextSection = result.content.indexOf('### 172.16.8.120:3106')
    const newBlock = result.content.indexOf('database: NewDB')
    expect(newBlock).toBeGreaterThan(sectionStart)
    expect(newBlock).toBeLessThan(nextSection)
    expect(result.content).toContain('environment: test')
    expect(result.content).toContain('- 报表测试')
  })

  it('【核心】全新服务器：小节不存在 → 文件末尾「未分类」章追加，老内容不动', () => {
    const result = mergeSectionsDocument(
      OLD_SERVERS,
      USER_TARGETS.servers,
      [{ name: 'bj-db-01', ip: '10.9.9.9', os: 'debian', user: 'root', notes: '新机器', environment: 'production', deploy_paths: ['/data/app'] }],
      '2026-02-08',
    )
    expect(result.created).toBe(1)
    const next = result.content
    expect(next).toContain('## Servers（2026-02-08 追加）')
    expect(next).toContain('### 10.9.9.9')
    expect(next).toContain('hostname: bj-db-01') // 模型 name 经别名写入 hostname
    expect(next).toContain('admin: root') // 模型 user 经别名写入 admin
    expect(next).toContain('note: 新机器')
    expect(next).toContain('- /data/app')
    expect(next).toContain('hostname: JQ-touyanzhushou-01') // 老条目原样
    expect(next.indexOf('### 10.1.1.183')).toBeLessThan(next.indexOf('## Servers（2026-02-08 追加）'))
  })

  it('servers 更新：os 过时信息修正 + purposes 列表追加去重', () => {
    const result = mergeSectionsDocument(
      OLD_SERVERS,
      USER_TARGETS.servers,
      [{ ip: '10.1.1.183', os: 'CentOS 7.9', purposes: ['UAT 测试环境集中部署', '新加了 Redis 集群'] }],
      '2026-02-08',
    )
    expect(result.updated).toBe(1)
    expect(result.content).toContain('os: CentOS 7.9')
    expect(result.content).toContain('- 新加了 Redis 集群')
    expect(result.content.match(/- UAT 测试环境集中部署/g)).toHaveLength(1) // 去重不重复
    expect(result.content).toContain('accounts: []') // 空列表原样
    expect(result.content).toContain('hostname: EBS-test-srv-01')
  })

  it('块体不是 YAML 对象（手写坏了）：坏块原样保留，新信息以新块追加在同节内', () => {
    const broken = [
      '# 库',
      '',
      '### 10.0.0.1:3306',
      '',
      '```yaml',
      '这不是: [合法对象',
      '```',
      '',
      '### 10.0.0.2:3306',
      '',
      '```yaml',
      'host: 10.0.0.2',
      'port: 3306',
      'database: good',
      'note: 正常条目',
      '```',
      '',
    ].join('\n')
    const result = mergeSectionsDocument(broken, USER_TARGETS.databases, [{ host: '10.0.0.1', port: '3306', database: 'ok', notes: '修复后的信息' }], '2026-02-08')
    const next = result.content
    // 坏块一字不动
    expect(next).toContain('这不是: [合法对象')
    // 新块追加在坏块所在小节内（10.0.0.2 小节之前）
    expect(next.indexOf('database: ok')).toBeGreaterThan(next.indexOf('### 10.0.0.1:3306'))
    expect(next.indexOf('database: ok')).toBeLessThan(next.indexOf('### 10.0.0.2:3306'))
    // 后续小节原样
    expect(next).toContain('database: good')
    expect(next).toContain('note: 正常条目')
  })

  it('缺 heading 字段（模型没给 port）：跳过并警告，不写半截条目', () => {
    const result = mergeSectionsDocument(OLD_DATABASES, USER_TARGETS.databases, [{ host: '10.1.1.183', database: 'X', notes: '缺端口' }], '2026-02-08')
    expect(result.updated).toBe(0)
    expect(result.created).toBe(0)
    expect(result.warnings[0]).toMatch(/缺 heading/)
  })

  it('端到端：persistNoteResult 走 sections 路径（模型输出 → 别名落盘 → .backup/）', async () => {
    await mkdir(join(vault, 'momento-e2e'), { recursive: true })
    await writeFile(join(vault, 'momento-e2e', 'servers.md'), OLD_SERVERS, 'utf8')
    const targets = resolveStructuredTargets({
      servers: { ...USER_TARGETS_servers_config, file: 'momento-e2e/servers.md' },
    }).targets
    const parsed = parseNoteJson(
      JSON.stringify({
        summary: '登记了服务器变更',
        note: ['改了 10.1.1.183 的系统版本'],
        structured: { servers: [{ name: '', ip: '10.1.1.183', os: 'CentOS 7.9', user: '', notes: '', purposes: ['新加了 Redis 集群'] }] },
      }),
      targets,
    )
    // 模型 name 为空 → 但 servers 主键是 ip（key: [ip]），不按内置 name 丢行
    expect(parsed.structured.servers).toHaveLength(1)
    const result = await persistNoteResult({ vaultDir: vault, settings: SETTINGS, now: () => new Date(2026, 1, 8, 9, 0), parsed, targets, backup: true })
    expect(result.warnings).toEqual([])
    const after = await readFile(join(vault, 'momento-e2e', 'servers.md'), 'utf8')
    expect(after).toContain('os: CentOS 7.9')
    expect(after).toContain('- 新加了 Redis 集群')
    // 备份进 .backup/momento-e2e/，原目录无裸露 .bak
    const { readdir } = await import('node:fs/promises')
    const backupNames = await readdir(join(vault, '.backup', 'momento-e2e'))
    expect(backupNames.some((name) => name.startsWith('servers.md.') && name.endsWith('.bak'))).toBe(true)
    expect(existsSync(join(vault, 'momento-e2e', 'servers.md.bak'))).toBe(false)
  })

  it('readKnown 语义（parseSectionsDocument + rowFromStorage）：模型看到的是模型字段名', async () => {
    const doc = parseSectionsDocument(OLD_SERVERS)
    expect(doc.sections).toHaveLength(2)
    const rows = doc.sections.flatMap((section) => section.blocks.filter((block) => block.row !== null).map((block) => block.row))
    const modelRow = rowFromStorage(rows[0], USER_TARGETS.servers)
    expect(modelRow).toMatchObject({ name: 'JQ-touyanzhushou-01', ip: '10.1.1.91', os: 'CentOS', user: '我', notes: expect.stringContaining('PHP-FPM') })
    expect(modelRow.purposes).toEqual(['投研小助手（PHP版）生产：nginx 9000 + php-fpm，代码 /var/www/iassistant'])
    // 往返：模型行 → 存储行 → 与原块对象等价
    const storage = rowToStorage({ ...modelRow, notes: '新的备注', purposes: ['投研小助手（PHP版）生产：nginx 9000 + php-fpm，代码 /var/www/iassistant', '追加项'] }, USER_TARGETS.servers)
    expect(storage.hostname).toBe('JQ-touyanzhushou-01')
    expect(storage.admin).toBe('我')
    expect(storage.note).toBe('新的备注')
  })
})

/** 供端到端用例复用的 servers 配置（目标文件路径不同）。 */
const USER_TARGETS_servers_config = {
  format: 'sections',
  heading: '{ip}',
  key: ['ip'],
  fields: ['name', 'ip', 'os', 'user', 'notes'],
  aliases: { name: 'hostname', user: 'admin', notes: 'note' },
  extraFields: [
    { key: 'environment', desc: 'production 或 test' },
    { key: 'purposes', desc: '功能' },
    { key: 'accounts' },
    { key: 'deploy_paths' },
  ],
}

describe('YAML 目标（mergeRowsByField / persistNoteResult yaml 路径）', () => {
  it('mergeRowsByField：更新与追加、空值保留旧值、额外字段原样带过', () => {
    const target = resolveStructuredTargets({
      servers: { file: 'infra/servers.yaml', format: 'yaml', fields: ['name', 'host', 'ip'], key: 'name' },
    }).targets.servers
    const known = [
      { name: 'web1', host: '10.0.0.1', ip: '', rack: 'A1', owner: 'ops' }, // rack/owner 是老库自有字段
      { name: 'web2', host: '10.0.0.2', ip: '' },
    ]
    const merged = mergeRowsByField(known, [
      { name: 'web1', host: '10.0.0.9' }, // 更新 host
      { name: 'web3', host: '10.0.0.3', ip: '' }, // 追加
    ], target)
    expect(merged).toHaveLength(3)
    const web1 = merged.find((row) => row.name === 'web1')
    expect(web1).toMatchObject({ host: '10.0.0.9', rack: 'A1', owner: 'ops' }) // 额外字段保留
    expect(merged.find((row) => row.name === 'web3')).toMatchObject({ host: '10.0.0.3' })
    expect(lostKeys(known.map((r) => r.name), merged.map((r) => r.name))).toEqual([])
    expect(lostKeys(['a', 'b'], ['a'])).toEqual(['b'])
  })

  it('端到端：YAML 老库往返合并（.backup/ 备份、额外字段保留）', async () => {
    await mkdir(join(vault, 'infra'), { recursive: true })
    const oldYaml = [
      '# Servers（手工维护的老库）',
      '- name: web1',
      '  host: 10.0.0.1',
      '  rack: A1',
      '- name: web2',
      '  host: 10.0.0.2',
      '',
    ].join('\n')
    await writeFile(join(vault, 'infra', 'servers.yaml'), oldYaml, 'utf8')
    const targets = resolveStructuredTargets({
      servers: { file: 'infra/servers.yaml', format: 'yaml', fields: ['name', 'host', 'ip'], key: 'name' },
    }).targets
    const parsed = parseNoteJson(
      JSON.stringify({
        summary: '登记服务器',
        note: ['查了服务器'],
        structured: { servers: [{ name: 'web1', host: '10.0.0.9' }, { name: 'web3', host: '10.0.0.3', ip: '10.0.0.33' }] },
      }),
    )
    const result = await persistNoteResult({ vaultDir: vault, settings: SETTINGS, now: () => new Date(2026, 1, 8, 9, 0), parsed, targets, backup: true })
    expect(result.warnings).toEqual([])
    const after = await readFile(join(vault, 'infra', 'servers.yaml'), 'utf8')
    const YAML = (await import('yaml')).default
    const rows = YAML.parse(after)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ name: 'web1', host: '10.0.0.9', rack: 'A1' })
    expect(rows[2]).toMatchObject({ name: 'web3', ip: '10.0.0.33' })
    // 老库注释头保留 + 修改前原文在 .backup/infra/，原目录无裸露 .bak
    expect(after).toContain('# Servers')
    const { readdir } = await import('node:fs/promises')
    const backupNames = await readdir(join(vault, '.backup', 'infra'))
    const bakName = backupNames.find((name) => name.startsWith('servers.yaml.') && name.endsWith('.bak'))
    expect(bakName).toBeDefined()
    const backup = await readFile(join(vault, '.backup', 'infra', bakName), 'utf8')
    expect(backup).toBe(oldYaml)
    expect(existsSync(join(vault, 'infra', 'servers.yaml.bak'))).toBe(false)
  })

  it('端到端：YAML 文件不是对象列表 → 跳过保护 + 警告，文件不动', async () => {
    await mkdir(join(vault, 'infra2'), { recursive: true })
    const broken = 'just: a mapping\nnot: a list\n'
    await writeFile(join(vault, 'infra2', 'servers.yaml'), broken, 'utf8')
    const targets = resolveStructuredTargets({
      servers: { file: 'infra2/servers.yaml', format: 'yaml' },
    }).targets
    const parsed = parseNoteJson(
      JSON.stringify({ summary: 's', note: ['n'], structured: { servers: [{ name: 'x', host: 'y' }] } }),
    )
    const result = await persistNoteResult({ vaultDir: vault, settings: SETTINGS, now: () => new Date(2026, 1, 8, 9, 0), parsed, targets })
    expect(result.warnings[0]).toMatch(/不是 YAML 对象列表/)
    expect(await readFile(join(vault, 'infra2', 'servers.yaml'), 'utf8')).toBe(broken) // 一字未动
    // 跳过保护的文件本身不产生任何备份（infra2 子目录不存在于 .backup 中）
    const { readdir } = await import('node:fs/promises')
    const backupSubdirs = await readdir(join(vault, '.backup'), 'utf8').catch(() => [])
    expect(backupSubdirs.includes('infra2')).toBe(false)
    expect(existsSync(join(vault, 'infra2', 'servers.yaml.bak'))).toBe(false)
  })
})

describe('noteSkill（vault 记录约定）', () => {
  it('buildNotePrompt 注入 skill 内容', () => {
    const prompt = buildNotePrompt({
      transcript: '【用户】\n hi',
      date: '2026-02-08',
      hasBoundary: false,
      skill: '## 命名约定\n- 服务器一律用 机房-编号（如 bj-01）',
    })
    expect(prompt).toContain('本 Vault 的记录约定')
    expect(prompt).toContain('机房-编号（如 bj-01）')
  })

  it('readVaultNoteConfig / writeVaultSettingsFile：vault 限定键读回与同步保留', async () => {
    // 写一份带 note 配置的 vault 设置文件
    await writeVaultSettingsFile(vault, { journalMode: 'daily', extensions: ['md'] })
    const file = join(vault, '.memoryleak.yaml')
    const YAML = (await import('yaml')).default
    // 手工加入 noteStructured / noteSkill（模拟用户手改）
    const handEdited = YAML.stringify({ journalMode: 'weekly', noteStructured: { servers: { file: 'infra/servers.yaml', format: 'yaml' } }, noteSkill: 'MOMENTO/.note-skill.md' })
    await writeFile(file, handEdited, 'utf8')
    // 读回：note 配置可见
    const config = await readVaultNoteConfig(vault)
    expect(config.noteSkill).toBe('MOMENTO/.note-skill.md')
    expect(config.noteStructured.servers.format).toBe('yaml')
    // GUI 同步保存（不知道 note 键）不会冲掉它们
    await writeVaultSettingsFile(vault, { journalMode: 'daily', extensions: ['md'] })
    const after = YAML.parse(await readFile(file, 'utf8'))
    expect(after.noteStructured.servers.file).toBe('infra/servers.yaml')
    expect(after.noteSkill).toBe('MOMENTO/.note-skill.md')
    expect(after.journalMode).toBe('daily') // 同步的键正常写入
    // readVaultSettings（设置链）不携带 note 键
    const { readVaultSettings } = await import('../src/vault.js')
    const section = await readVaultSettings(vault)
    expect(section).not.toHaveProperty('noteStructured')
    expect(section).not.toHaveProperty('noteSkill')
  })
})
