/**
 * /ml mail 宿主胶水测试：IMAP 下载（伪客户端注入）、纯代码解析、读信编排
 * （伪 llm）、设置引导、vault 读信进度读写 —— 不碰真实网络，临时目录用
 * 真实 fs（验证「用完即删」）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, stat, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { resolveMemoryleakSettings } from '../src/settings-schema.js'
import { readVaultMailStateEnd, readVaultSettings, writeVaultMailStateEnd, writeVaultSettingsFile, VAULT_SETTINGS_FILENAME } from '../src/vault.js'
import { MailImapError, buildTlsOptions, downloadMailWindowToTemp, parseEmailFiles, pemFromCertificate, runMailCommand, verifyMailLogin, MAIL_TRUST_QUESTION_ID } from '../src/mail.js'

/* ---------------- 桩与夹具 ---------------- */

const at = (iso) => new Date(iso)

/** 已配置邮箱的生效设置段。 */
function mailSettings(overrides = {}) {
  return resolveMemoryleakSettings({
    mailAuth: 'password',
    mailHost: 'imap.test.example',
    mailUser: 'a@b.c',
    mailPassword: 'secret',
    mailFolder: 'INBOX',
    ...overrides,
  })
}

/** 伪 IMAP 客户端（imapflow 接口子集）。messages: [{seq, uid, date, from, subject, source}] */
function fakeImap({ messages = [], folders = ['INBOX'], connectError = null } = {}) {
  const state = { mailbox: null, lockReleased: false, loggedOut: false, closed: false, searches: [], fetches: [] }
  const client = {
    async connect() {
      if (connectError !== null) throw connectError
    },
    async logout() {
      state.loggedOut = true
    },
    close() {
      state.closed = true
    },
    async list() {
      return folders.map((path) => ({ path }))
    },
    async getMailboxLock(folder) {
      state.mailbox = folder
      return { release() { state.lockReleased = true } }
    },
    async search(query, options) {
      state.searches.push({ query, options })
      return messages.map((message) => message.uid)
    },
    async *fetch(range, query, options) {
      state.fetches.push({ range, options })
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
  return { client, state }
}

/** 伪 llm 服务：同步吐 chunks，捕获请求。 */
function fakeLlm(chunks, captured = []) {
  return {
    async *stream(options) {
      captured.push(options)
      for (const chunk of chunks) yield chunk
    },
  }
}

/** 收集事件的活会话桩（sink 路径用）。 */
function sessionStub() {
  const appended = []
  return {
    session: {
      id: 's-mail',
      events: [],
      append(type, data, opts) {
        const seq = appended.length + 1
        appended.push({ seq, type, data, opts })
        return { seq }
      },
    },
    appended,
  }
}

const MODEL_JSON = JSON.stringify({
  summary: '两件事：周报与规范',
  events: ['周三服务器迁移'],
  todos: [{ text: '回复周报', due: '2026-08-20', from: 'boss@b.c', subject: '周报' }],
  reads: [{ text: '新规范下周生效', from: 'pm@b.c', subject: '规范', note: '' }],
})

let vault
let tempRoot

beforeAll(async () => {
  vault = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-mail-vault-'))
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-mail-t-'))
})
afterAll(async () => {
  await rm(vault, { recursive: true, force: true })
  await rm(tempRoot, { recursive: true, force: true })
})

/** 一次性临时目录工厂（记录创建的目录供断言「用完即删」）。 */
function trackingTempFactory() {
  const created = []
  return {
    created,
    async makeTempDir() {
      const dir = await mkdtemp(join(tempRoot, 'run-'))
      created.push(dir)
      return dir
    },
  }
}

/** 三封邮件：09:00（窗口前）、11:00、12:00（窗口内）。 */
const MESSAGES = [
  { seq: 1, uid: 101, date: at('2026-08-18T09:00:00'), from: [{ name: '昨晚', address: 'old@b.c' }], subject: '窗口外', source: 'Subject: 窗口外\n\n旧邮件' },
  { seq: 2, uid: 102, date: at('2026-08-18T11:00:00'), from: [{ name: '老板', address: 'boss@b.c' }], subject: '周报', source: 'Subject: 周报\n\n请今天交周报' },
  { seq: 3, uid: 103, date: at('2026-08-18T12:00:00'), from: [{ address: 'pm@b.c' }], subject: '新规范', source: 'Subject: 新规范\n\n规范下周生效' },
]

/** 固定时钟：2026-08-18 15:00（本地）；vault 状态 = 当天 10:00。 */
const NOW = at('2026-08-18T15:00:00')
const LAST_END = at('2026-08-18T10:00:00')

/* ---------------- verifyMailLogin ---------------- */

describe('verifyMailLogin', () => {
  it('成功：返回目录列表且无警告；登出被调用', async () => {
    const imap = fakeImap()
    const result = await verifyMailLogin(mailSettings(), { createClient: async () => imap.client })
    expect(result.folders).toContain('INBOX')
    expect(result.warning).toBe(null)
    expect(imap.state.loggedOut).toBe(true)
  })

  it('配置目录不在服务器列表 → 警告但不失败', async () => {
    const imap = fakeImap({ folders: ['INBOX', 'Sent'] })
    const result = await verifyMailLogin(mailSettings({ mailFolder: 'Junk' }), { createClient: async () => imap.client })
    expect(result.warning).toContain('Junk')
  })

  it('认证失败 → MailImapError，带授权码提示', async () => {
    const imap = fakeImap({ connectError: new Error('Authentication failed: invalid credentials') })
    await expect(verifyMailLogin(mailSettings(), { createClient: async () => imap.client })).rejects.toThrow(MailImapError)
    await expect(verifyMailLogin(mailSettings(), { createClient: async () => fakeImap({ connectError: new Error('Authentication failed') }).client })).rejects.toThrow(/授权码/)
  })

  it('网络故障 → 连接提示；认证路径外仍抛 MailImapError', async () => {
    await expect(
      verifyMailLogin(mailSettings(), { createClient: async () => fakeImap({ connectError: new Error('connect ECONNREFUSED 1.2.3.4:993') }).client }),
    ).rejects.toThrow(/连不上/)
  })

  it('证书校验失败 → 指引「信任此证书」引导与 GUI 兜底（不再误导成端口/TLS 开关问题）', async () => {
    const make = () => verifyMailLogin(mailSettings(), { createClient: async () => fakeImap({ connectError: new Error('unable to verify the first certificate') }).client })
    await expect(make()).rejects.toThrow(MailImapError)
    await expect(make()).rejects.toThrow(/证书校验不过/)
    await expect(make()).rejects.toThrow(/信任并保存/)
    await expect(make()).rejects.toThrow(/跳过证书校验/)
    await expect(make()).rejects.toMatchObject({ kind: 'cert' })
    await expect(make()).rejects.not.toThrow(/993 开、143 关/)
  })
})

describe('buildTlsOptions（TLS 选项三级：默认严格 → 信任证书锚 → 跳过校验兜底）', () => {
  it('默认：严格校验，无附加选项', () => {
    expect(buildTlsOptions({})).toEqual({})
    expect(buildTlsOptions({ mailTlsInsecure: false, mailCaPem: '' })).toEqual({})
  })

  it('配置了信任证书 → 以它为 ca（校验仍开启）', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----'
    expect(buildTlsOptions({ mailCaPem: pem })).toEqual({ ca: pem })
  })

  it('跳过校验开关优先于信任证书', () => {
    expect(buildTlsOptions({ mailTlsInsecure: true, mailCaPem: 'x' })).toEqual({ rejectUnauthorized: false })
  })

  it('非 PEM 杂文本不生效', () => {
    expect(buildTlsOptions({ mailCaPem: '随手写的' })).toEqual({})
  })
})

/* ---------------- downloadMailWindowToTemp ---------------- */

describe('downloadMailWindowToTemp（下载到临时目录，零模型）', () => {
  it('窗口过滤 + 时间升序写 NNNN.eml；SINCE 用窗口起点；锁与登出收尾', async () => {
    const imap = fakeImap({ messages: MESSAGES })
    const window = { start: LAST_END, end: NOW }
    const dir = await mkdtemp(join(tempRoot, 'dl-'))
    const result = await downloadMailWindowToTemp({ settings: mailSettings(), window, dir }, { createClient: async () => imap.client })
    expect(result.emails.map((mail) => mail.subject)).toEqual(['周报', '新规范'])
    expect(result.searched).toBe(3)
    expect(result.dropped).toBe(0)
    // 文件确实写在临时目录里，名字按时间序递增
    const files = result.emails.map((mail) => mail.file)
    expect(files).toEqual(['0001.eml', '0002.eml'])
    const written = await readFile(join(dir, '0001.eml'), 'utf8')
    expect(written).toContain('请今天交周报')
    // SEARCH SINCE 以窗口起点为界（日期粒度，精确过滤在内存里做）；全程 UID 寻址
    expect(imap.state.searches[0].query.since.getTime()).toBe(LAST_END.getTime())
    expect(imap.state.searches[0].options).toEqual({ uid: true })
    expect(imap.state.fetches.length).toBeGreaterThan(0)
    expect(imap.state.fetches[0].options).toEqual({ uid: true })
    expect(imap.state.lockReleased).toBe(true)
    expect(imap.state.loggedOut).toBe(true)
    expect(imap.state.mailbox).toBe('INBOX')
  })

  it('超上限保留最新（丢最旧，dropped 如实）', async () => {
    const many = Array.from({ length: 5 }, (_, index) => ({
      seq: index + 1,
      uid: 200 + index,
      date: at(`2026-08-1${index + 2}T10:00:00`),
      from: [],
      subject: `第${index + 1}封`,
      source: `body ${index}`,
    }))
    const imap = fakeImap({ messages: many })
    const window = { start: at('2026-08-11T00:00:00'), end: at('2026-08-20T00:00:00') }
    const result = await downloadMailWindowToTemp({ settings: mailSettings({ mailMaxEmails: 3 }), window, dir: await mkdtemp(join(tempRoot, 'dl-')) }, { createClient: async () => imap.client })
    expect(result.emails.map((mail) => mail.subject)).toEqual(['第3封', '第4封', '第5封'])
    expect(result.dropped).toBe(2)
  })

  it('连接失败 → MailImapError，不落任何文件', async () => {
    const dir = await mkdtemp(join(tempRoot, 'dl-'))
    await expect(
      downloadMailWindowToTemp({ settings: mailSettings(), window: { start: LAST_END, end: NOW }, dir }, { createClient: async () => fakeImap({ connectError: new Error('connect ETIMEDOUT') }).client }),
    ).rejects.toThrow(MailImapError)
  })
})

/* ---------------- parseEmailFiles（纯代码解析） ---------------- */

describe('parseEmailFiles', () => {
  it('simpleParser 结果直取 text；空白规整', async () => {
    const dir = await mkdtemp(join(tempRoot, 'pe-'))
    await writeFile(join(dir, '0001.eml'), 'raw-source-1')
    const parsed = await parseEmailFiles(dir, [{ file: '0001.eml', date: at('2026-08-18T11:00:00'), from: 'x@b.c', subject: 's' }], {
      parseEml: async (buffer) => ({ text: `第一行\n\n\n\n第二行   \n`, html: '' }),
    })
    expect(parsed).toHaveLength(1)
    expect(parsed[0].text).toBe('第一行\n\n第二行')
    expect(parsed[0].date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('html-only 邮件走粗转换兜底；解析失败降级占位文本', async () => {
    const dir = await mkdtemp(join(tempRoot, 'pe-'))
    await writeFile(join(dir, '0001.eml'), 'a')
    await writeFile(join(dir, '0002.eml'), 'b')
    const parsed = await parseEmailFiles(
      dir,
      [
        { file: '0001.eml', date: at('2026-08-18T11:00:00'), from: '', subject: 'html 邮件' },
        { file: '0002.eml', date: at('2026-08-18T12:00:00'), from: '', subject: '坏邮件' },
      ],
      {
        parseEml: async (buffer) =>
          buffer.toString() === 'a'
            ? { text: '', html: '<p>你好</p><p>世界</p><script>evil()</script>' }
            : Promise.reject(new Error('boom')),
      },
    )
    expect(parsed[0].text).toBe('你好\n世界') // script 剔除、块标签换行
    expect(parsed[1].text).toContain('解析失败')
    expect(parsed[1].text).toContain('坏邮件')
  })
})

/* ---------------- runMailCommand（编排端到端） ---------------- */

/** 组一套 read 用的 deps（伪 IMAP + 跟踪临时目录 + 固定时钟）。 */
function readDeps(messages, extra = {}) {
  const imap = fakeImap({ messages })
  const temps = trackingTempFactory()
  return {
    deps: {
      createClient: async () => imap.client,
      parseEml: async (buffer) => ({ text: buffer.toString('utf8'), html: '' }),
      makeTempDir: temps.makeTempDir,
      sweep: async () => {},
      now: () => NOW,
      ...extra,
    },
    imap,
    temps,
  }
}

/** 会话里带 command/run 事件的 invocation。 */
function invocationOf() {
  return { commandId: 'cmd-mail-1', signal: new AbortController().signal }
}

describe('runMailCommand · read', () => {
  it('未配置 → 进入设置引导（三问），不下载不调模型', async () => {
    const asks = []
    const ctx = {
      get: () => ({
        ask: async (request) => {
          asks.push(request)
          return { answers: (request.questions ?? []).map((question) => ({ id: question.id, selected: [], custom: '' })) }
        },
      }),
      settings: { update: async () => {} },
    }
    const result = await runMailCommand(ctx, { session: sessionStub().session }, invocationOf(), { family: 'mail', action: 'read' }, vault, resolveMemoryleakSettings({}), {})
    expect(asks).toHaveLength(1)
    expect(asks[0].questions.map((question) => question.id)).toEqual(['ml-mail-host', 'ml-mail-user', 'ml-mail-secret'])
    // 空答案 + 无当前配置 → 报配置不完整
    expect(result.kind).toBe('error')
    expect(result.text).toContain('配置不完整')
  })

  /** 伪 agent：收集 followup 消息。 */
  function agentOf(followups) {
    return { followup(message) { followups.push(message) } }
  }

  it('已配置 → 交接给原生回合：消息带 📬 标记 / 窗口 / 两个工具指引；不触 IMAP、不建临时目录、进度不动', async () => {
    await writeVaultMailStateEnd(vault, LAST_END.toISOString())
    let imapTouched = false
    const { deps, temps } = readDeps(MESSAGES, { createClient: async () => { imapTouched = true; throw new Error('不应连网') } })
    const followups = []
    const result = await runMailCommand({}, agentOf(followups), invocationOf(), { action: 'read' }, vault, mailSettings(), deps)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('读信任务已交给当前模型')
    expect(imapTouched).toBe(false)
    expect(temps.created).toHaveLength(0) // 下载交给回合里的 fetch 工具
    expect(await readVaultMailStateEnd(vault)).toBe(LAST_END.toISOString()) // 进度不动
    expect(followups).toHaveLength(1)
    const text = followups[0].content[0].text
    expect(followups[0].role).toBe('user')
    expect(followups[0].source).toEqual({ kind: 'plugin', plugin: 'dsh-memoryleak', form: 'notice' })
    expect(text).toContain('📬 /ml mail 读信任务')
    expect(text).toContain('窗口：')
    expect(text).toContain('memory_mail_fetch')
    expect(text).toContain('memory_mail_commit')
    expect(text).toContain('漏调 = 下次重读同一批')
  })

  it('首次使用（vault 无状态）→ 交接消息的窗口为「今天 00:00」起', async () => {
    await rm(join(vault, VAULT_SETTINGS_FILENAME), { force: true })
    const followups = []
    const { deps } = readDeps(MESSAGES)
    await runMailCommand({}, agentOf(followups), invocationOf(), { action: 'read' }, vault, mailSettings(), deps)
    expect(followups[0].content[0].text).toContain('今天 00:00')
  })
})

describe('runMailCommand · setup / 裸命令', () => {
  function setupCtx(answers, patches = []) {
    return {
      get: () => ({
        ask: async (request) => ({ answers: (request.questions ?? []).map((question) => ({ id: question.id, selected: [], custom: answers[question.id] ?? '' })) }),
      }),
      settings: { update: async (ns, patch) => { patches.push({ ns, patch }) } },
    }
  }

  it('setup：问答 → 试登陆 → 存全局设置（host 小写）', async () => {
    const patches = []
    const ctx = setupCtx({ 'ml-mail-host': 'IMAP.Test.Example', 'ml-mail-user': 'a@b.c', 'ml-mail-secret': 'secret' }, patches)
    const result = await runMailCommand(ctx, { session: sessionStub().session }, invocationOf(), { action: 'setup' }, vault, mailSettings({ mailHost: '', mailUser: '', mailPassword: '' }), { createClient: async () => fakeImap().client })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('试登陆成功')
    expect(patches).toHaveLength(1)
    expect(patches[0].ns).toBe('memoryleak')
    expect(patches[0].patch).toMatchObject({ mailHost: 'imap.test.example', mailUser: 'a@b.c', mailPassword: 'secret' })
  })

  it('setup：留空沿用当前值（换服务器不重输密码）；非法 host 拒绝且不保存', async () => {
    const patches = []
    const ctx = setupCtx({ 'ml-mail-host': 'imap.new.example', 'ml-mail-user': '', 'ml-mail-secret': '' }, patches)
    const result = await runMailCommand(ctx, { session: sessionStub().session }, invocationOf(), { action: 'setup' }, vault, mailSettings(), { createClient: async () => fakeImap().client })
    expect(result.kind).toBe('success')
    // 沿用：账号密码来自当前 settings
    expect(patches[0].patch).toMatchObject({ mailHost: 'imap.new.example', mailUser: 'a@b.c', mailPassword: 'secret' })

    const bad = setupCtx({ 'ml-mail-host': 'imaps://x.com:993', 'ml-mail-user': 'a@b.c', 'ml-mail-secret': 's' }, [])
    const rejected = await runMailCommand(bad, { session: sessionStub().session }, invocationOf(), { action: 'setup' }, vault, mailSettings(), { createClient: async () => fakeImap().client })
    expect(rejected.kind).toBe('error')
    expect(rejected.text).toContain('主机名')
  })

  it('setup：试登陆失败 → 配置不保存', async () => {
    const patches = []
    const ctx = setupCtx({ 'ml-mail-host': 'imap.x.com', 'ml-mail-user': 'a@b.c', 'ml-mail-secret': 'wrong' }, patches)
    const result = await runMailCommand(ctx, { session: sessionStub().session }, invocationOf(), { action: 'setup' }, vault, resolveMemoryleakSettings({}), {
      createClient: async () => fakeImap({ connectError: new Error('Authentication failed') }).client,
    })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('试登陆未通过')
    expect(result.text).toContain('授权码')
    expect(patches).toHaveLength(0)
  })

  it('裸 /ml mail：已配置 → 状态一览（含上次读完）', async () => {
    await writeVaultMailStateEnd(vault, LAST_END.toISOString())
    const result = await runMailCommand({ llm: null }, { session: sessionStub().session }, invocationOf(), { action: null }, vault, mailSettings(), {})
    expect(result.kind).toBe('success')
    expect(result.text).toContain('邮箱已配置')
    expect(result.text).toContain('imap.test.example:993')
    expect(result.text).toContain('上次读完')
    expect(result.text).toContain('/ml mail read')
  })

  it('裸 /ml mail：未配置 → 弹设置引导', async () => {
    const asks = []
    const ctx = {
      get: () => ({ ask: async (request) => { asks.push(request); return { answers: [] } } }),
      settings: { update: async () => {} },
    }
    const result = await runMailCommand(ctx, { session: sessionStub().session }, invocationOf(), { action: null }, vault, resolveMemoryleakSettings({}), {})
    expect(asks).toHaveLength(1)
    expect(asks[0].questions).toHaveLength(3)
    expect(result.kind).toBe('error') // 空答案 → 配置不完整
  })

  it('无交互界面（TUI 等）→ 指向 GUI 设置', async () => {
    const ctx = { get: () => undefined }
    const result = await runMailCommand(ctx, { session: sessionStub().session }, invocationOf(), { action: null }, vault, resolveMemoryleakSettings({}), {})
    expect(result.kind).toBe('error')
    expect(result.text).toContain('GUI 设置')
  })

  /* ---- 证书信任闭环：失败 → 一问 → 取证存盘 → 复验 ---- */

  const TRUSTED_PEM = '-----BEGIN CERTIFICATE-----\nabc123\n-----END CERTIFICATE-----\n'

  /** 证书场景的 setup ctx：三问答案 + 信任一问按 answer 选择。 */
  function certSetupCtx(trustLabel, patches, extra = {}) {
    const askLog = []
    const ctx = {
      get: () => ({
        ask: async (request) => {
          askLog.push(request)
          return {
            answers: (request.questions ?? []).map((question) => {
              if (question.id === MAIL_TRUST_QUESTION_ID) return { id: question.id, selected: trustLabel === null ? [] : [trustLabel] }
              const preset = { 'ml-mail-host': 'mail.corp.example', 'ml-mail-user': 'a@b.c', 'ml-mail-secret': 'secret' }[question.id]
              return { id: question.id, selected: [], custom: preset ?? '' }
            }),
          }
        },
      }),
      settings: { update: async (ns, patch) => { patches.push({ ns, patch }) } },
      ...extra,
    }
    ctx.askLog = askLog
    return ctx
  }

  function certDeps(patches, extra = {}) {
    let calls = 0
    return {
      createClient: async () => {
        calls += 1
        return calls === 1
          ? fakeImap({ connectError: new Error('unable to verify the first certificate') }).client
          : fakeImap().client
      },
      captureCert: async () => ({ pem: TRUSTED_PEM, subject: 'CN=mail.corp', issuer: 'Corp CA', validTo: 'Feb 9 2027' }),
      callCount: () => calls,
      ...extra,
    }
  }

  it('setup 证书关：失败 → 信任一问 → 取证存盘 → 复验成功', async () => {
    const patches = []
    const deps = certDeps(patches)
    const ctx = certSetupCtx('信任并保存', patches)
    const result = await runMailCommand(ctx, { session: sessionStub().session }, invocationOf(), { action: 'setup' }, vault, resolveMemoryleakSettings({}), deps)
    expect(result.kind).toBe('success')
    expect(deps.callCount()).toBe(2) // 首验失败 + 信任后复验
    expect(patches).toHaveLength(1)
    expect(patches[0].patch.mailCaPem).toContain('BEGIN CERTIFICATE')
    expect(result.text).toContain('已信任服务器证书')
  })

  it('setup 证书关：用户拒绝 → 配置不保存（提示 GUI 兜底）', async () => {
    const patches = []
    const deps = certDeps(patches)
    const ctx = certSetupCtx('取消', patches)
    const result = await runMailCommand(ctx, { session: sessionStub().session }, invocationOf(), { action: 'setup' }, vault, resolveMemoryleakSettings({}), deps)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('试登陆未通过')
    expect(result.text).toContain('跳过证书校验')
    expect(patches).toHaveLength(0)
    expect(deps.callCount()).toBe(1) // 不复验
  })

  it('setup 证书关：取证失败不挡路 → 问题降级（无「信任」项），跳过校验可就地保存', async () => {
    const patches = []
    const deps = certDeps(patches, { captureCert: async () => { throw new MailImapError('获取服务器证书失败：超时', {}, 'cert') } })
    const ctx = certSetupCtx('跳过证书校验并保存', patches)
    const result = await runMailCommand(ctx, { session: sessionStub().session }, invocationOf(), { action: 'setup' }, vault, resolveMemoryleakSettings({}), deps)
    expect(result.kind).toBe('success')
    // 问题降级：不展示签发者、没有「信任并保存」项
    expect(ctx.askLog[1].questions[0].question).toContain('取证失败')
    expect(JSON.stringify(ctx.askLog[1].questions[0].options)).not.toContain('信任并保存')
    expect(patches[0].patch.mailTlsInsecure).toBe(true)
    expect(patches[0].patch.mailCaPem).toBeUndefined()
    expect(result.text).toContain('跳过证书校验')
  })

  it('setup 证书关：已信任过这张证书 → 不再重复问', async () => {
    const patches = []
    const deps = certDeps(patches)
    const ctx = certSetupCtx('信任并保存', patches)
    const result = await runMailCommand(ctx, { session: sessionStub().session }, invocationOf(), { action: 'setup' }, vault, mailSettings({ mailCaPem: TRUSTED_PEM }), deps)
    expect(result.kind).toBe('success')
    expect(deps.callCount()).toBe(2)
    expect(ctx.askLog).toHaveLength(1) // 只有三问批次，没有信任一问
    expect(patches[0].patch.mailCaPem).toBe(TRUSTED_PEM)
  })

  it('pemFromCertificate：DER 原文 → PEM 文本', () => {
    const pem = pemFromCertificate({ raw: Buffer.from('test-bytes') })
    expect(pem.startsWith('-----BEGIN CERTIFICATE-----\n')).toBe(true)
    expect(pem.endsWith('-----END CERTIFICATE-----\n')).toBe(true)
    expect(Buffer.from(pem.replace(/-----[A-Z ]+-----|\s/g, ''), 'base64').toString()).toBe('test-bytes')
    expect(() => pemFromCertificate({})).toThrow(MailImapError)
  })

  it('setup 证书关：STARTTLS 模式也能就地跳过校验（取证降级，无「信任」项）', async () => {
    const patches = []
    const deps = certDeps(patches, { captureCert: async () => { throw new Error('不应被调用') } })
    const ctx = certSetupCtx('跳过证书校验并保存', patches)
    const result = await runMailCommand(ctx, { session: sessionStub().session }, invocationOf(), { action: 'setup' }, vault, mailSettings({ mailSecure: false }), deps)
    expect(result.kind).toBe('success')
    expect(ctx.askLog[1].questions[0].question).toContain('取证失败')
    expect(patches[0].patch.mailTlsInsecure).toBe(true)
    expect(result.text).toContain('跳过证书校验')
  })
})

/* ---------------- mail todo <序号>（引用上次 read 报告的待办） ---------------- */

describe('runMailCommand · mail todo <序号>', () => {
  const TODOS = [
    { text: '回复周报', due: '2026-09-05', from: 'boss@b.c', subject: '周报' },
    { text: '看新规范', due: '', from: 'pm@b.c', subject: '规范' },
  ]

  function todoCtx(answers, asks = []) {
    return {
      get: () => ({
        ask: async (request) => {
          asks.push(request)
          return {
            answers: (request.questions ?? []).map((question) => {
              const preset = answers[question.id]
              return preset !== undefined
                ? { id: question.id, selected: [preset] }
                : { id: question.id, selected: [], custom: '' }
            }),
          }
        },
      }),
    }
  }

  it('清单为空 → 报错指引先 read', async () => {
    await rm(join(vault, VAULT_SETTINGS_FILENAME), { force: true })
    const ctx = todoCtx({})
    const result = await runMailCommand(ctx, { session: sessionStub().session }, invocationOf(), { action: 'todo', n: 1 }, vault, mailSettings(), {})
    expect(result.kind).toBe('error')
    expect(result.text).toContain('先执行 /ml mail read')
  })

  it('序号超范围 → 报错并列出总量', async () => {
    await writeVaultMailStateEnd(vault, LAST_END.toISOString(), TODOS)
    const ctx = todoCtx({})
    const result = await runMailCommand(ctx, { session: sessionStub().session }, invocationOf(), { action: 'todo', n: 3 }, vault, mailSettings(), {})
    expect(result.kind).toBe('error')
    expect(result.text).toContain('共 2 条重要事项')
  })

  it('取第 1 条走 todo add 表单：deadline 自动带邮件期限并写入 Vault', async () => {
    await writeVaultMailStateEnd(vault, LAST_END.toISOString(), TODOS)
    const asks = []
    const ctx = todoCtx({ 'ml-type': 'deadline', 'ml-prio': 'urgent' }, asks)
    const result = await runMailCommand(ctx, { session: sessionStub().session }, invocationOf(), { action: 'todo', n: 1 }, vault, mailSettings(), {})
    expect(result.kind).toBe('success')
    expect(result.text).toContain('(ml:deadline 2026-09-05 urgent) 回复周报')
    expect(result.text).toContain('期限取自 mail read')
    // 只问了类型+优先级一轮：邮件期限直接采用，没有日期轮
    expect(asks).toHaveLength(1)
    // 待办真实写入 Vault 日志
    const files = (await readdir(vault)).filter((name) => name.endsWith('.md'))
    const contents = await Promise.all(files.map((name) => readFile(join(vault, name), 'utf8')))
    expect(contents.join('\n')).toContain('(ml:deadline 2026-09-05 urgent) 回复周报')
  })

  it('选 anytime → 不问日期直接写入（第 2 条）', async () => {
    await writeVaultMailStateEnd(vault, LAST_END.toISOString(), TODOS)
    const asks = []
    const ctx = todoCtx({ 'ml-type': 'anytime', 'ml-prio': 'low' }, asks)
    const result = await runMailCommand(ctx, { session: sessionStub().session }, invocationOf(), { action: 'todo', n: 2 }, vault, mailSettings(), {})
    expect(result.kind).toBe('success')
    expect(result.text).toContain('(ml:anytime low) 看新规范')
    expect(asks).toHaveLength(1)
  })
})

/* ---------------- vault 状态与双写 ---------------- */

describe('vault 读信进度（mailState）', () => {
  it('round-trip：写后可读，文件缺失 → null', async () => {
    const dir = await mkdtemp(join(tempRoot, 'vs-'))
    expect(await readVaultMailStateEnd(dir)).toBe(null)
    await writeVaultMailStateEnd(dir, '2026-08-18T07:00:00.000Z')
    expect(await readVaultMailStateEnd(dir)).toBe('2026-08-18T07:00:00.000Z')
    // 文件写坏（非 YAML 对象）→ null
    await writeFile(join(dir, VAULT_SETTINGS_FILENAME), '- a\n- b\n', 'utf8')
    expect(await readVaultMailStateEnd(dir)).toBe(null)
  })

  it('进度写入保留文件里的其他键（note 配置等）', async () => {
    const dir = await mkdtemp(join(tempRoot, 'vs-'))
    await writeFile(join(dir, VAULT_SETTINGS_FILENAME), 'noteSkill: MOMENTO/.note-skill.md\nmaxFiles: 100\n', 'utf8')
    await writeVaultMailStateEnd(dir, '2026-08-18T07:00:00.000Z')
    const parsed = YAML.parse(await readFile(join(dir, VAULT_SETTINGS_FILENAME), 'utf8'))
    expect(parsed.noteSkill).toBe('MOMENTO/.note-skill.md')
    expect(parsed.maxFiles).toBe(100)
    expect(parsed.mailState.lastReadEnd).toBe('2026-08-18T07:00:00.000Z')
  })

  it('GUI 双写：mail 账号键不进 vault 文件；mailState 原样保留', async () => {
    const dir = await mkdtemp(join(tempRoot, 'vs-'))
    await writeVaultMailStateEnd(dir, '2026-08-18T07:00:00.000Z')
    const section = mailSettings() // 含 mailPassword: secret
    await writeVaultSettingsFile(dir, section)
    const raw = await readFile(join(dir, VAULT_SETTINGS_FILENAME), 'utf8')
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain('mailPassword')
    expect(raw).not.toContain('mailHost')
    const parsed = YAML.parse(raw)
    expect(parsed.mailState.lastReadEnd).toBe('2026-08-18T07:00:00.000Z')
  })

  it('vault 文件里的 mail 键不参与设置合并（账号只认全局层）', async () => {
    const dir = await mkdtemp(join(tempRoot, 'vs-'))
    await writeFile(join(dir, VAULT_SETTINGS_FILENAME), 'mailHost: evil.example\nmailPassword: nope\nmailState:\n  lastReadEnd: 2026-08-18T07:00:00.000Z\n', 'utf8')
    const vaultSection = await readVaultSettings(dir)
    expect(vaultSection).toEqual({}) // mail* 与 mailState 都被剥离
    expect(await readVaultMailStateEnd(dir)).toBe('2026-08-18T07:00:00.000Z')
  })
})
