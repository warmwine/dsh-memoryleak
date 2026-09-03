/**
 * 真实模型工具测试：memory_note_context / memory_note_write /
 * memory_ask_gather / memory_mail_fetch / memory_mail_commit。
 * 工具定义是普通对象 —— 直接对 execute/render 断言；文件系统用临时目录，
 * IMAP 用伪客户端，不碰真实网络。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryleakToolDefinitions } from '../src/tools.js'
import { resolveMemoryleakSettings } from '../src/settings-schema.js'
import { readVaultMailStateEnd, writeVaultMailStateEnd } from '../src/vault.js'
/* ---------------- 桩与夹具 ---------------- */

const at = (iso) => new Date(iso)
const NOW = at('2026-08-18T12:00:00')
const LAST_END = at('2026-08-18T08:00:00')

/** 伪 settings scope：get() 返回解析后的全局设置段（vault 指向临时目录，邮箱已配置）。 */
function fakeScope(vault) {
  return {
    get: () =>
      resolveMemoryleakSettings({
        vault,
        mailAuth: 'password',
        mailHost: 'imap.test.example',
        mailUser: 'a@b.c',
        mailPassword: 'secret',
        mailFolder: 'INBOX',
      }),
  }
}

/** 伪 IMAP 客户端（imapflow 接口子集；与 mail.test.js 同款）。 */
function fakeImap({ messages = [] } = {}) {
  const client = {
    async connect() {},
    async logout() {},
    close() {},
    async list() {
      return [{ path: 'INBOX' }]
    },
    async getMailboxLock() {
      return { release() {} }
    },
    async search() {
      return messages.map((message) => message.uid)
    },
    async *fetch() {
      for (const message of messages) {
        yield { seq: message.seq, uid: message.uid, internalDate: message.date, envelope: { subject: message.subject, from: message.from, date: message.date } }
      }
    },
    async fetchOne(uid) {
      const message = messages.find((item) => item.uid === uid)
      if (message === undefined) throw new Error(`no message ${uid}`)
      return { uid: message.uid, source: Buffer.from(message.source) }
    },
  }
  return client
}

/** 记录创建目录的临时目录工厂（断言「用完即删」）。 */
function trackingTempFactory(root) {
  const created = []
  const makeTempDir = async () => {
    const dir = await mkdtemp(join(root, 'tool-'))
    created.push(dir)
    return dir
  }
  return { created, makeTempDir }
}

const MESSAGES = [
  { seq: 1, uid: 11, date: at('2026-08-18T09:00:00'), from: [], subject: '周报', source: '请今天交周报' },
  { seq: 2, uid: 12, date: at('2026-08-18T10:00:00'), from: [], subject: '新规范', source: '规范下周生效' },
]

let vault
let tempRoot

beforeAll(async () => {
  vault = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-tools-vault-'))
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-tools-t-'))
})
afterAll(async () => {
  await rm(vault, { recursive: true, force: true })
  await rm(tempRoot, { recursive: true, force: true })
})

/** 构一套按名字索引的工具定义。 */
function toolsOf(deps = {}) {
  const definitions = createMemoryleakToolDefinitions({ scope: fakeScope(vault), deps })
  return Object.fromEntries(definitions.map((definition) => [definition.name, definition]))
}

const exec = { agent: { id: 'agent-t' } }

describe('工具清单与契约', () => {
  it('注册 5 个工具，均有 name/parameters/output.render/execute', () => {
    const definitions = createMemoryleakToolDefinitions({ scope: fakeScope(vault) })
    expect(definitions.map((definition) => definition.name)).toEqual([
      'memory_note_context',
      'memory_note_write',
      'memory_ask_gather',
      'memory_mail_fetch',
      'memory_mail_commit',
    ])
    for (const definition of definitions) {
      expect(definition.parameters.type).toBe('object')
      expect(typeof definition.output.render).toBe('function')
      expect(typeof definition.execute).toBe('function')
    }
  })

  it('Vault 未设置 → 工具返回模型可见的引导错误，不炸', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-tools-scope-'))
    try {
      const definitions = createMemoryleakToolDefinitions({ scope: { get: () => resolveMemoryleakSettings({}) } })
      const byName = Object.fromEntries(definitions.map((definition) => [definition.name, definition]))
      const context = await byName.memory_note_context.execute({}, exec)
      expect(context.known).toContain('尚未设置 Vault')
      const write = await byName.memory_note_write.execute({ summary: 's' }, exec)
      expect(write.written).toContain('尚未设置 Vault')
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe('memory_note_write（守卫写盘）', () => {
  it('整理结果落盘：日志 ## NOTE + 知识条目 + 结构化表；回执含写入清单', async () => {
    const tools = toolsOf({ now: () => NOW })
    const value = await tools.memory_note_write.execute(
      {
        summary: '把整理改成原生工具',
        note: ['写了 tools.js', '补了测试'],
        momento: { entries: [{ title: '工具化整理', body: '协议进工具参数，守卫在工具里。', tags: ['dsh'] }] },
        structured: { glossary: [{ term: 'MOMENTO', definition: '知识库目录' }] },
      },
      exec,
    )
    expect(value.summary).toBe('把整理改成原生工具')
    expect(value.written).toContain('## NOTE')
    expect(value.written).toContain('MOMENTO/工具化整理.md')
    // render 是模型可见文本
    const rendered = tools.memory_note_write.output.render({}, value)
    expect(rendered[0].text).toContain('把整理改成原生工具')
    // 文件真的在盘上
    const journal = await readFile(join(vault, '2026-08-18.md'), 'utf8')
    expect(journal).toContain('## NOTE')
    expect(journal).toContain('把整理改成原生工具')
    const entry = await readFile(join(vault, 'MOMENTO', '工具化整理.md'), 'utf8')
    expect(entry).toContain('协议进工具参数，守卫在工具里。')
    const glossary = await readFile(join(vault, 'MOMENTO', 'glossary.md'), 'utf8')
    expect(glossary).toContain('MOMENTO')
  })

  it('字段清洗与旧路径一致：缺主键的结构化行丢弃并告警，不合规条目不落盘', async () => {
    const tools = toolsOf({ now: () => new Date(2026, 7, 18, 12, 1) })
    const value = await tools.memory_note_write.execute(
      {
        summary: '清洗检查',
        note: ['正常条目'],
        structured: { credentials: [{ name: '', kind: 'token', account: '', where: '', notes: '' }] }, // 缺主键 name
      },
      exec,
    )
    expect(value.warnings).toContain('缺主键')
    expect(value.written).not.toContain('credentials.md')
  })

  it('主键合并语义：第二轮只写新行，已有行原样保留（增补不丢失）', async () => {
    const tools = toolsOf({ now: () => NOW })
    await tools.memory_note_write.execute(
      { summary: '首轮', structured: { databases: [{ name: '老库', type: 'sqlite', host: 'h', port: '', database: '', user: '', notes: '' }] } },
      exec,
    )
    const value = await tools.memory_note_write.execute(
      { summary: '第二轮', structured: { databases: [{ name: '新库', type: 'mysql', host: 'h2', port: '', database: '', user: '', notes: '' }] } },
      exec,
    )
    expect(value.summary).toBe('第二轮')
    const databases = await readFile(join(vault, 'MOMENTO', 'databases.md'), 'utf8')
    expect(databases).toContain('老库')
    expect(databases).toContain('新库')
  })
})

describe('memory_note_context（存量与约定）', () => {
  it('返回存量登记行、知识标题与字段规范；空库时明确说明', async () => {
    const tools = toolsOf()
    const value = await tools.memory_note_context.execute({}, exec)
    expect(value.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(value.known).toContain('glossary 已有')
    expect(value.known).toContain('工具化整理')
    expect(value.known).toContain('增量增补')
    expect(value.fieldRules).toContain('credentials')
    // render 是模型可见文本
    expect(tools.memory_note_context.output.render({}, value)[0].text).toContain('增量增补')
  })

  it('空库 → 明确告知第一次整理（可全量登记）', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-tools-empty-'))
    try {
      const definitions = createMemoryleakToolDefinitions({ scope: fakeScope(empty) })
      const byName = Object.fromEntries(definitions.map((definition) => [definition.name, definition]))
      const value = await byName.memory_note_context.execute({}, exec)
      expect(value.known).toContain('Vault 还是空的')
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe('memory_ask_gather（资料汇集）', () => {
  it('按相关度带出资料，render 即模型可见的资料块', async () => {
    const tools = toolsOf()
    const value = await tools.memory_ask_gather.execute({ question: 'MOMENTO 是什么' }, exec)
    expect(value.total).toBeGreaterThan(0)
    expect(value.included).toBeGreaterThan(0)
    expect(value.materials).toContain('### MOMENTO/')
    expect(value.materials).toContain('资料开始')
    expect(tools.memory_ask_gather.output.render({}, value)[0].text).toBe(value.materials)
  })

  it('空 Vault → 明确报错文本（让模型如实转告）', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-tools-ask-'))
    try {
      const definitions = createMemoryleakToolDefinitions({ scope: fakeScope(empty) })
      const byName = Object.fromEntries(definitions.map((definition) => [definition.name, definition]))
      const value = await byName.memory_ask_gather.execute({ question: 'q' }, exec)
      expect(value.total).toBe(0)
      expect(value.materials).toContain('还没有可引用的内容')
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe('memory_mail_fetch / memory_mail_commit（两段式读信）', () => {
  const mailDeps = (messages, temps) => ({
    createClient: async () => fakeImap({ messages }),
    parseEml: async (buffer) => ({ text: buffer.toString('utf8'), html: '' }),
    makeTempDir: temps.makeTempDir,
    sweep: async () => {},
    now: () => NOW,
  })

  it('commit 先于 fetch → 明确报错', async () => {
    const tools = toolsOf()
    const value = await tools.memory_mail_commit.execute({}, exec)
    expect(value.committedUntil).toContain('先调用 memory_mail_fetch')
  })

  it('fetch：邮件解析进结果、进度不推进、临时目录即删；commit：进度推进到窗口终点', async () => {
    await writeVaultMailStateEnd(vault, LAST_END.toISOString())
    const temps = trackingTempFactory(tempRoot)
    const tools = toolsOf(mailDeps(MESSAGES, temps))
    const fetched = await tools.memory_mail_fetch.execute({}, exec)
    expect(fetched.windowLabel).toContain('窗口')
    expect(fetched.emails).toContain('周报')
    expect(fetched.emails).toContain('新规范')
    expect(fetched.emails).toContain('分析要求')
    expect(fetched.emails).toContain('memory_mail_commit')
    // fetch 不推进进度（分析失败 = 下次重读同一批）
    expect(await readVaultMailStateEnd(vault)).toBe(LAST_END.toISOString())
    // 铁律：临时目录已删
    for (const dir of temps.created) await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' })

    const committed = await tools.memory_mail_commit.execute({}, exec)
    expect(committed.committedUntil).toContain('读信进度已推进')
    expect(await readVaultMailStateEnd(vault)).toBe(NOW.toISOString())
    // 重复 commit → 明确报错
    const again = await tools.memory_mail_commit.execute({}, exec)
    expect(again.committedUntil).toContain('没有待提交')
  })

  it('空窗口 → 直接推进进度并告知模型没有新邮件', async () => {
    await writeVaultMailStateEnd(vault, LAST_END.toISOString())
    const temps = trackingTempFactory(tempRoot)
    const tools = toolsOf(mailDeps([], temps))
    const fetched = await tools.memory_mail_fetch.execute({}, exec)
    expect(fetched.emails).toContain('没有新邮件')
    expect(await readVaultMailStateEnd(vault)).toBe(NOW.toISOString())
  })

  it('fetch 后 render 拼接窗口与邮件文本（模型可见）', async () => {
    await writeVaultMailStateEnd(vault, LAST_END.toISOString())
    const tools = toolsOf(mailDeps(MESSAGES, trackingTempFactory(tempRoot)))
    const fetched = await tools.memory_mail_fetch.execute({}, exec)
    const rendered = tools.memory_mail_fetch.output.render({}, fetched)
    expect(rendered[0].text).toContain('窗口')
    expect(rendered[0].text).toContain('### 邮件 1')
  })
})
