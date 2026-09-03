/**
 * /ml mail 的宿主胶水：设置引导（userQuestions 问答 → 校验 → 试登陆 →
 * 存全局设置）、增量读信（IMAP 下载到系统临时目录 → 纯代码解析 → 当前
 * 模型分析提取待办/待阅 → vault 设置记录结束时刻）。
 *
 * 两条铁律（README 同步声明）：
 *   1. 邮件只落系统临时目录（os.tmpdir() 下一次性目录，用完即删），
 *      绝不写进 Vault 或当前工作目录；崩溃残留由下次执行清扫（>24h）。
 *   2. 下载与清理全程零模型调用——模型只出现在「分析已下载的邮件」
 *      这一步；窗口内没有新邮件时直接返回，连分析也不发生。
 *
 * 依赖注入（deps）是测试 seam：createClient / parseEml / makeTempDir /
 * sweepStaleDirs / now 全部可替换，默认实现走 imapflow + mailparser。
 *
 * @module dsh-memoryleak/mail
 */
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoError } from './core/errors.js'
import {
  hasTrustedCertificate,
  isMailConfigured,
  mailWindowLabel,
  mergeTrustedCertificates,
  resolveMailWindow,
  selectMailEmails,
  formatMailMoment,
} from './core/mail.js'
import { readVaultMailStateEnd, writeVaultMailStateEnd } from './vault.js'
import { MEMORYLEAK_SETTINGS_NAMESPACE } from './settings-schema.js'
import { MAIL_MARK } from './core/command.js'

export { MAIL_MARK }


/** /ml mail 设置引导的问题 id（宿主与客户端的共享协议，两处必须同步改）：
 *  web 端客户端半认领渲染成一张表单卡（三个输入 + 提交），其余环境走
 *  通用问答。答案统一走 custom 文本。 */
const ML_MAIL_HOST_ID = 'ml-mail-host'
const ML_MAIL_USER_ID = 'ml-mail-user'
const ML_MAIL_SECRET_ID = 'ml-mail-secret'

/** 证书信任一问的 id（自建服务器内部/自签证书时弹出的单选项问题）。 */
export const MAIL_TRUST_QUESTION_ID = 'ml-mail-trust'
/** 信任一问的选项（label 精确匹配）。 */
const MAIL_TRUST_ACCEPT_LABEL = '信任并保存'
const MAIL_TRUST_SKIP_LABEL = '跳过证书校验并保存'

/* ---------------- 错误分级 ---------------- */

/** /ml mail 故障基类（命令层统一转用户可见结果）。 */
export class MailError extends TodoError {}
/** 配置缺失 / 不完整（引导或 GUI 补全）。 */
export class MailConfigError extends MailError {}
/** IMAP 连接 / 认证 / 下载故障（含可读提示）。kind：auth / network / cert / tls / imap。 */
export class MailImapError extends MailError {
  constructor(message, options = {}, kind = 'imap') {
    super(message, options)
    this.kind = kind
  }
}
/** vault 读信进度读写故障。 */
export class MailStateIoError extends MailError {}

/* ---------------- 默认依赖实现（imapflow + mailparser） ---------------- */

/**
 * TLS 连接选项：默认严格校验；配置了信任证书（mailCaPem）就以它为锚
 * （校验仍然开启——链要能建到它 + 主机名要匹配）；mailTlsInsecure 是
 * 兜底开关（自建服务器内部证书，勾选后跳过身份验证，连接仍加密）。
 *
 * @param {Record<string, unknown>} settings 生效设置段
 * @returns {Record<string, unknown>} 传给 imapflow 的 tls 选项（可为空对象）
 */
export function buildTlsOptions(settings) {
  if (settings?.mailTlsInsecure === true) return { rejectUnauthorized: false }
  const pem = typeof settings?.mailCaPem === 'string' ? settings.mailCaPem.trim() : ''
  if (pem !== '' && pem.includes('-----BEGIN CERTIFICATE-----')) return { ca: pem }
  return {}
}

/** 建一个 IMAP 客户端（不连接）。惰性动态 import：不用 mail 的会话不加载。 */
async function createImapFlowClient(config) {
  let ImapFlow
  try {
    ;({ ImapFlow } = await import('imapflow'))
  } catch (error) {
    throw new MailImapError(`imapflow 模块加载失败（依赖未安装完整？）：${error instanceof Error ? error.message : String(error)}`)
  }
  const auth = config.mailAuth === 'xoauth2' ? { user: config.mailUser, accessToken: config.mailToken } : { user: config.mailUser, pass: config.mailPassword }
  const tlsOptions = buildTlsOptions(config)
  return new ImapFlow({
    host: config.mailHost,
    port: config.mailPort,
    secure: config.mailSecure,
    auth,
    logger: false,
    ...(Object.keys(tlsOptions).length > 0 ? { tls: tlsOptions } : {}),
  })
}

/** 用 mailparser 的 simpleParser 解析 .eml 原文（纯代码，无模型）。 */
async function parseEmlWithMailparser(buffer) {
  let simpleParser
  try {
    ;({ simpleParser } = await import('mailparser'))
  } catch (error) {
    throw new MailImapError(`mailparser 模块加载失败（依赖未安装完整？）：${error instanceof Error ? error.message : String(error)}`)
  }
  return simpleParser(buffer)
}

/** 系统临时目录下建一次性目录。 */
export async function makeTempDirUnderTmpdir() {
  return mkdtemp(join(tmpdir(), 'dsh-memoryleak-mail-'))
}

/** 清扫崩溃残留的临时目录（>24h 的一次性目录；尽力而为，永不抛错）。 */
export async function sweepStaleTempDirs(now = Date.now()) {
  try {
    const entries = await readdir(tmpdir())
    await Promise.all(
      entries
        .filter((name) => name.startsWith('dsh-memoryleak-mail-'))
        .map(async (name) => {
          try {
            const path = join(tmpdir(), name)
            const info = await stat(path)
            if (info.isDirectory() && now - info.ctimeMs > 24 * 3600 * 1000) await rm(path, { recursive: true, force: true })
          } catch {
            // 单个目录清扫失败忽略
          }
        }),
    )
  } catch {
    // tmpdir 不可读：无事可做
  }
}

/* ---------------- IMAP 交互 ---------------- */

/** envelope 地址列表 → 「名字 <地址>」展示串。 */
function formatAddresses(addresses) {
  if (!Array.isArray(addresses)) return ''
  return addresses
    .map((item) => (typeof item?.name === 'string' && item.name !== '' ? `${item.name} <${item.address ?? ''}>` : String(item?.address ?? '')))
    .filter((value) => value !== '')
    .join(', ')
}

/** 连接故障 → 带排障提示与分级的 MailImapError（认证 / 网络 / 证书 / TLS 分开提示）。 */
function toImapError(action, error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/auth|login|credential|password|invalid credentials/i.test(message)) {
    return new MailImapError(`${action}失败：${message}（认证被拒——QQ/163/126 等邮箱要在网页版开启 IMAP 并使用「授权码」而非登陆密码；也检查账号是否填对）`, { cause: error }, 'auth')
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|timeout/i.test(message)) {
    return new MailImapError(`${action}失败：${message}（连不上——检查服务器地址与端口；993 端口通常需要 TLS）`, { cause: error }, 'network')
  }
  // 证书类失败要放在通用 TLS 提示之前：握手本身是通的，错在信任链——
  // Windows/Outlook 走 Windows 证书库所以能用，Node 不读它（自带 Mozilla
  // CA 库），内部 CA/自签证书必须走产品的「信任此证书」引导或兜底开关。
  if (/certificate|self[- ]?signed|SELF_SIGNED|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|ERR_TLS_CERT/i.test(message)) {
    return new MailImapError(
      `${action}失败：${message}（证书校验不过：内部 CA / 自签 / 证书链不完整——握手与端口都没问题。按引导选择「信任并保存」或「${MAIL_TRUST_SKIP_LABEL}」即可）`,
      { cause: error },
      'cert',
    )
  }
  if (/tls|ssl/i.test(message)) {
    return new MailImapError(`${action}失败：${message}（TLS 握手失败——确认端口与「使用 TLS」开关匹配：993 开、143 关）`, { cause: error }, 'tls')
  }
  return new MailImapError(`${action}失败：${message}`, { cause: error }, 'imap')
}

/** 服务器证书对象 → PEM 文本（Node 的 getPeerCertificate 产物，raw 为 DER）。 */
export function pemFromCertificate(cert) {
  if (cert === null || typeof cert !== 'object' || !Buffer.isBuffer(cert.raw)) {
    throw new MailImapError('拿不到服务器证书内容')
  }
  const b64 = cert.raw.toString('base64')
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`
}

/**
 * 抓取服务器在隐式 TLS 端口上出示的证书（校验放宽——我们的目的就是拿
 * 到不被信任的那张证书；只连接读取，不发任何凭证）。用于「信任此证书」
 * 引导：取证 → 用户确认 → 存 mailCaPem → 之后以它为信任锚正常校验。
 *
 * @param {{ host: string, port: number, timeoutMs?: number }} input
 * @returns {Promise<{ pem: string, subject: string, issuer: string, validTo: string }>}
 * @throws {MailImapError}
 */
export async function captureServerCertificate({ host, port, timeoutMs = 8000 }) {
  const tls = await import('node:tls')
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false })
    const fail = (error) => {
      clearTimeout(timer)
      socket.destroy()
      reject(new MailImapError(`获取服务器证书失败：${error instanceof Error ? error.message : String(error)}`, {}, 'cert'))
    }
    const timer = setTimeout(() => fail(new Error('等待 TLS 握手超时')), timeoutMs)
    socket.once('secureConnect', () => {
      try {
        const cert = socket.getPeerCertificate()
        const pem = pemFromCertificate(cert)
        const result = { pem, subject: String(cert.subject?.CN ?? cert.subject?.O ?? '(未知)'), issuer: String(cert.issuer?.CN ?? cert.issuer?.O ?? '(未知)'), validTo: String(cert.valid_to ?? '') }
        clearTimeout(timer)
        socket.destroy()
        resolve(result)
      } catch (error) {
        fail(error)
      }
    })
    socket.once('error', fail)
  })
}

/**
 * 试登陆：连接 → 列目录 → 登出。成功返回目录名列表（配置目录不在其中
 * 时给 warning 供上层提示）。任何连接/认证故障转 MailImapError。
 *
 * @param {object} config 生效设置段（mail* 键）
 * @param {object} [deps]
 * @returns {Promise<{ folders: string[], warning: string | null }>}
 */
export async function verifyMailLogin(config, deps = {}) {
  const createClient = deps.createClient ?? createImapFlowClient
  let client
  try {
    client = await createClient(config)
  } catch (error) {
    throw error instanceof MailError ? error : toImapError('连接邮箱', error)
  }
  const folders = []
  try {
    await client.connect()
    for (const folder of await client.list()) {
      if (typeof folder === 'string') folders.push(folder)
      else if (folder !== null && typeof folder === 'object' && typeof folder.path === 'string') folders.push(folder.path)
    }
  } catch (error) {
    try {
      client.close()
    } catch {
      // 已断开
    }
    throw toImapError('登陆邮箱', error)
  }
  try {
    await client.logout()
  } catch {
    try {
      client.close()
    } catch {
      // 已断开
    }
  }
  const wanted = config.mailFolder.trim()
  const warning = folders.some((path) => path.toLowerCase() === wanted.toLowerCase()) ? null : `目录「${wanted}」不在服务器目录列表里（已有：${folders.slice(0, 5).join('、')}${folders.length > 5 ? '…' : ''}）——首次 read 可能失败，请到 GUI 设置检查 mailFolder。`
  return { folders, warning }
}

/**
 * 把窗口内的邮件原文下载进临时目录（纯代码，零模型调用）。
 *
 * 流程：连接 → 锁定目录 → SEARCH SINCE（日期粒度）→ 批量拉 envelope +
 * internaldate → 精确过滤 (start, end] 并截断（保最新）→ 逐封拉原文写
 * <dir>/NNNN.eml → 登出。搜索命中数与截断数如实返回。
 *
 * @param {{ settings: object, window: { start: Date, end: Date }, dir: string }} input
 * @param {object} [deps]
 * @returns {Promise<{ emails: Array<{ seq: number, uid: number, date: Date, from: string, subject: string, file: string }>, dropped: number, searched: number }>}
 * @throws {MailImapError}
 */
export async function downloadMailWindowToTemp({ settings, window, dir }, deps = {}) {
  const createClient = deps.createClient ?? createImapFlowClient
  await mkdir(dir, { recursive: true })
  let client
  try {
    client = await createClient(settings)
  } catch (error) {
    throw error instanceof MailError ? error : toImapError('连接邮箱', error)
  }
  let lock
  try {
    await client.connect()
    lock = await client.getMailboxLock(settings.mailFolder)
    // SEARCH 用 UID 模式：SEARCH 到逐封下载之间，别的客户端删信会让序列
    // 号漂移——UID 稳定不变（SINCE 基于 internaldate，日期粒度粗筛）。
    const uids = await client.search({ since: window.start }, { uid: true })
    if (!Array.isArray(uids) || uids.length === 0) return { emails: [], dropped: 0, searched: 0 }

    // 候选信封：internaldate（SINCE 用的就是它）优先，缺省回退信头 Date
    const candidates = []
    for await (const message of client.fetch(uids.join(','), { envelope: true, internalDate: true }, { uid: true })) {
      const date = message.internalDate instanceof Date ? message.internalDate : message.envelope?.date instanceof Date ? message.envelope.date : null
      if (date === null) continue
      candidates.push({
        uid: message.uid,
        date,
        from: formatAddresses(message.envelope?.from),
        subject: String(message.envelope?.subject ?? '').replace(/[\r\n]+/g, ' '),
      })
    }
    const { kept, dropped } = selectMailEmails(candidates.map((item) => ({ id: item.uid, date: item.date })), window, settings.mailMaxEmails)
    const byUid = new Map(candidates.map((item) => [item.uid, item]))

    const emails = []
    let position = 0
    for (const pick of kept) {
      position += 1
      const meta = byUid.get(pick.id)
      const full = await client.fetchOne(pick.id, { uid: true, source: true }, { uid: true })
      const file = `${String(position).padStart(4, '0')}.eml`
      await writeFile(join(dir, file), full.source ?? Buffer.from(''))
      emails.push({ uid: Number.isSafeInteger(full?.uid) ? full.uid : pick.id, date: pick.date, from: meta?.from ?? '', subject: meta?.subject ?? '(无主题)', file })
    }
    return { emails, dropped, searched: uids.length }
  } catch (error) {
    if (error instanceof MailError) throw error
    throw toImapError('下载邮件', error)
  } finally {
    if (lock !== undefined) {
      try {
        lock.release()
      } catch {
        // 连接已断
      }
    }
    try {
      await client.logout()
    } catch {
      try {
        client.close()
      } catch {
        // 已断开
      }
    }
  }
}

/* ---------------- 纯代码解析（无模型） ---------------- */

/** HTML 粗转纯文本（html-only 邮件的兜底；去 script/style、块标签换行、实体解码）。 */
function crudeHtmlToText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(?:p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 空白规整：行尾空白去掉、3+ 空行压 2。 */
function normalizeText(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 解析临时目录里的 .eml（纯代码）：simpleParser → 正文（text 优先，
 * html 兜底粗转换）→ 规整空白。解析失败的单封降级为占位文本，不炸整批。
 *
 * @param {string} dir 临时目录
 * @param {ReadonlyArray<{ file: string, date: Date, from: string, subject: string }>} emails
 * @param {object} [deps]
 * @returns {Promise<Array<{ date: string, from: string, subject: string, text: string }>>}
 */
export async function parseEmailFiles(dir, emails, deps = {}) {
  const parseEml = deps.parseEml ?? parseEmlWithMailparser
  const parsed = []
  for (const mail of emails) {
    let text = ''
    try {
      const buffer = await readFile(join(dir, mail.file))
      const message = await parseEml(buffer)
      text = typeof message.text === 'string' && message.text.trim() !== '' ? message.text : crudeHtmlToText(message.html)
    } catch {
      text = `（这封邮件解析失败，正文不可用；主题：${mail.subject}）`
    }
    parsed.push({
      date: formatMailMoment(mail.date instanceof Date ? mail.date : new Date()),
      from: mail.from,
      subject: mail.subject,
      text: normalizeText(text),
    })
  }
  return parsed
}

/* ---------------- 命令编排 ---------------- */

/**
 * /ml mail 的统一入口（命令 handler 调用；action null = 裸 /ml mail）。
 * 未配置时一律进设置引导（对话框）；已配置时裸命令显示状态。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} agent
 * @param {{ commandId: string, signal: AbortSignal }} invocation
 * @param {{ action: 'read' | 'setup' | null }} parsed
 * @param {string} vaultDir vault 绝对路径（门控已保证非空）
 * @param {object} settings 生效设置段
 * @param {object} [deps] 测试注入（createClient / parseEml / makeTempDir / sweep / now）
 * @returns {Promise<{ kind: 'success', text: string } | { kind: 'error', text: string }>}
 */
export async function runMailCommand(ctx, agent, invocation, parsed, vaultDir, settings, deps = {}) {
  if (parsed.action === 'setup') return runMailSetupFlow(ctx, agent, invocation.signal, settings, deps)
  if (parsed.action === 'read') {
    if (!isMailConfigured(settings)) return runMailSetupFlow(ctx, agent, invocation.signal, settings, deps, '邮箱还没配置——先完成设置，再读邮件。')
    return runMailReadCommand(ctx, agent, invocation, vaultDir, settings, deps)
  }
  if (!isMailConfigured(settings)) return runMailSetupFlow(ctx, agent, invocation.signal, settings, deps)
  return runMailStatusCommand(vaultDir, settings)
}

/** 已配置时的裸 /ml mail：邮箱状态 + 用法。 */
async function runMailStatusCommand(vaultDir, settings) {
  const lastEnd = await readVaultMailStateEnd(vaultDir)
  const authLabel = settings.mailAuth === 'xoauth2' ? 'OAuth2 token' : '密码/授权码'
  const lines = [
    '邮箱已配置：',
    `· 服务器：${settings.mailHost}:${settings.mailPort}${settings.mailSecure ? '（TLS）' : ''}`,
    `· 账号：${settings.mailUser}`,
    `· 登陆方式：${authLabel} · 目录：${settings.mailFolder} · 单次上限：${settings.mailMaxEmails} 封`,
    `· 上次读完：${lastEnd === null ? '还没读过（首次 read 默认当天）' : `${formatMailMoment(new Date(lastEnd))}（下次从这里继续）`}`,
    '',
    '· /ml mail read —— 增量阅读新邮件并提取待办/待阅（花 token）',
    '· /ml mail setup —— 重新配置；完整选项在 GUI 设置 → MemoryLeak',
  ]
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * 设置引导（userQuestions 三问：服务器 / 账号 / 密码或授权码）→ 校验 →
 * 试登陆（真连一次 IMAP）→ 通过才存全局设置。端口 / TLS / 目录等进阶
 * 项沿用现值或默认值，GUI 里可改。
 *
 * 自建服务器的证书关：试登陆遇「证书校验不过」（内部 CA / 自签）时，
 * 弹「信任并保存」一问——确认后自动抓取服务器证书存进 mailCaPem，之后
 * 的连接以它为信任锚**继续严格校验**（链要建到它、主机名要匹配），拒绝
 * 或取证失败时提示 GUI 里的「跳过证书校验」兜底。
 */
async function runMailSetupFlow(ctx, agent, signal, settings, deps = {}, lead = '') {
  const userQuestions = ctx.get('userQuestions')
  if (userQuestions === undefined) {
    return { kind: 'error', text: `当前环境没有可用的交互提问界面，无法引导配置邮箱。请在 GUI 设置 → MemoryLeak 的「邮箱（/ml mail）」分区填写。${lead === '' ? '' : '\n' + lead}` }
  }
  const previousHost = typeof settings.mailHost === 'string' ? settings.mailHost : ''
  const previousUser = typeof settings.mailUser === 'string' ? settings.mailUser : ''
  const answer = await userQuestions.ask({
    agent,
    signal,
    questions: [
      { id: ML_MAIL_HOST_ID, header: 'MemoryLeak 邮箱', question: `IMAP 服务器地址${previousHost === '' ? '' : `（当前：${previousHost}，回车同值）`}`, options: [] },
      { id: ML_MAIL_USER_ID, header: 'MemoryLeak 邮箱', question: `邮箱账号${previousUser === '' ? '' : `（当前：${previousUser}，回车同值）`}`, options: [] },
      { id: ML_MAIL_SECRET_ID, header: 'MemoryLeak 邮箱', question: '密码或授权码（QQ/163/126 等用网页版生成的授权码）', options: [] },
    ],
  })
  const find = (id) => answer?.answers?.find((entry) => entry.id === id)
  const rawHost = String(find(ML_MAIL_HOST_ID)?.custom ?? '').trim()
  const rawUser = String(find(ML_MAIL_USER_ID)?.custom ?? '').trim()
  const rawSecret = String(find(ML_MAIL_SECRET_ID)?.custom ?? '').trim()
  // 「回车同值」：留空且已有配置 → 沿用现值（改服务器时不用重输密码）
  const host = rawHost === '' ? previousHost : rawHost
  const user = rawUser === '' ? previousUser : rawUser
  const secret = rawSecret === '' ? (settings.mailAuth === 'xoauth2' ? settings.mailToken : settings.mailPassword) : rawSecret
  if (host === '' || user === '' || secret === '') {
    return { kind: 'error', text: '配置不完整（服务器 / 账号 / 密码都要有），邮箱未保存。' }
  }
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(host)) {
    return { kind: 'error', text: `服务器地址看起来不对（收到 "${host}"）——只要主机名或 IP，不带 imaps:// 前缀与端口。` }
  }
  if (/\s/.test(user)) {
    return { kind: 'error', text: `账号不能含空白（收到 "${user}"）。` }
  }
  const candidate = { ...settings, mailHost: host.toLowerCase(), mailUser: user, mailPassword: secret, mailToken: settings.mailAuth === 'xoauth2' ? secret : settings.mailToken }
  let verified
  try {
    verified = await verifyMailLogin(candidate, deps)
  } catch (error) {
    if (!(error instanceof MailError)) throw error
    if (error.kind !== 'cert') {
      return { kind: 'error', text: `试登陆未通过，配置未保存：\n${error.message}` }
    }
    // —— 证书关：信任/跳过引导（都弹同一问，用户一次选择就地解决）——
    const trust = await askMailTrust(ctx, agent, signal, candidate, deps)
    if (trust.status === 'skip') {
      candidate.mailTlsInsecure = true
      try {
        verified = await verifyMailLogin(candidate, deps)
      } catch (retryError) {
        if (!(retryError instanceof MailError)) throw retryError
        return { kind: 'error', text: `已跳过证书校验但仍未通过，配置未保存：\n${retryError.message}` }
      }
    } else if (trust.status === 'trusted') {
      candidate.mailCaPem = mergeTrustedCertificates(candidate.mailCaPem, trust.cert.pem)
      try {
        verified = await verifyMailLogin(candidate, deps)
      } catch (retryError) {
        if (!(retryError instanceof MailError)) throw retryError
        return { kind: 'error', text: `已信任证书但仍未通过，配置未保存：\n${retryError.message}\n（可重新执行 /ml mail setup 并选择「${MAIL_TRUST_SKIP_LABEL}」兜底）` }
      }
    } else {
      return { kind: 'error', text: `试登陆未通过，配置未保存：\n${error.message}\n（重新执行 /ml mail setup 可再次选择「信任并保存」或「${MAIL_TRUST_SKIP_LABEL}」）` }
    }
  }
  const patch = { mailHost: candidate.mailHost, mailUser: user, mailPassword: candidate.mailPassword, mailToken: candidate.mailToken }
  if (typeof candidate.mailCaPem === 'string' && candidate.mailCaPem !== '') patch.mailCaPem = candidate.mailCaPem
  if (candidate.mailTlsInsecure === true) patch.mailTlsInsecure = true
  try {
    await ctx.settings.update(MEMORYLEAK_SETTINGS_NAMESPACE, patch)
  } catch (error) {
    return { kind: 'error', text: `保存邮箱设置失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const lines = [
    `邮箱已配置并试登陆成功 → ${candidate.mailHost}:${settings.mailPort}${settings.mailSecure ? '（TLS）' : ''} · ${user}`,
    '密码明文保存在 ~/.dsh/settings.yaml（只在本机；不会写进 Vault）。',
    '现在可以 /ml mail read 阅读新邮件了。',
  ]
  if (typeof candidate.mailCaPem === 'string' && candidate.mailCaPem !== '') lines.splice(1, 0, '已信任服务器证书（存入本机设置，之后连接继续严格校验到它）。')
  if (candidate.mailTlsInsecure === true) lines.splice(1, 0, '已跳过证书校验（不再验证服务器身份；连接仍加密，GUI 设置可随时关闭）。')
  if (verified.warning !== null) lines.push('', `注意：${verified.warning}`)
  const body = lines.join('\n')
  return { kind: 'success', text: lead === '' ? body : `${lead}\n${body}` }
}

/**
 * 证书关的一问：先取证（只读连接，不发凭证；隐式 TLS 才取得到），再让
 * 用户三选一。取证失败不挡路——问题降级为不含签发者信息的版本，「信任」
 * 选项隐藏（没有证书可存）。返回：
 *   { status: 'trusted', cert }  —— 信任并保存（或此前已信任过这张）
 *   { status: 'skip' }           —— 跳过证书校验并保存
 *   { status: 'refused' }        —— 取消
 */
async function askMailTrust(ctx, agent, signal, candidate, deps) {
  let captured = null
  let captureIssue = null
  try {
    captured = typeof deps.captureCert === 'function' ? await deps.captureCert({ host: candidate.mailHost, port: candidate.mailPort }) : await captureServerCertificate({ host: candidate.mailHost, port: candidate.mailPort })
  } catch (error) {
    captureIssue = error instanceof Error ? error.message : String(error)
  }
  if (captured !== null && hasTrustedCertificate(candidate.mailCaPem, captured.pem)) {
    return { status: 'trusted', cert: captured } // 已信任过这张证书：直接复用，不再问
  }
  const question = captured !== null
    ? `服务器出示的证书不被本机信任（签发者：${captured.issuer}），要如何处理？`
    : `服务器证书取证失败（${captureIssue ?? '原因未知'}），无法出示证书细节。要如何处理？`
  const options = []
  if (captured !== null) {
    options.push({ label: MAIL_TRUST_ACCEPT_LABEL, description: '把这张证书存入本机设置，之后连接以它为锚严格校验（自建服务器常态）' })
  }
  options.push({ label: MAIL_TRUST_SKIP_LABEL, description: '存账号并跳过证书校验——不再验证服务器身份，连接仍加密（兜底）' })
  options.push({ label: '取消', description: '不保存配置' })
  const answer = await ctx.get('userQuestions').ask({
    agent,
    signal,
    questions: [{ id: MAIL_TRUST_QUESTION_ID, header: 'MemoryLeak 邮箱', question, options }],
  })
  const picked = answer?.answers?.find((entry) => entry.id === MAIL_TRUST_QUESTION_ID)?.selected?.[0]
  if (picked === MAIL_TRUST_ACCEPT_LABEL && captured !== null) return { status: 'trusted', cert: captured }
  if (picked === MAIL_TRUST_SKIP_LABEL) return { status: 'skip' }
  return { status: 'refused' }
}

/**
 * /ml mail read：把读信任务交给当前模型的原生回合（命令做薄）。
 *
 * 顺序：读信窗口计算（vault 状态 → (start, now]，本地零模型）→ 交接消息
 * （agent.followup）→ 命令立即返回。真实回合里模型调 memory_mail_fetch
 * 工具（下载到临时目录、纯代码解析为纯文本、目录即删——全程零模型调用），
 * 原生思考并输出 markdown 阅读报告，最后调 memory_mail_commit 推进读信
 * 进度（分析失败不推进，下次重读同一批，绝不漏信）。
 *
 * @param {import('@deepseek-ai/cordis').Context} _ctx
 * @param {{ followup?: Function }} agent
 * @param {{ commandId: string, signal: AbortSignal }} _invocation
 * @param {string} vaultDir vault 绝对路径（门控已保证非空）
 * @param {object} settings 生效设置段
 * @param {object} [_deps] 测试注入（createClient / parseEml / makeTempDir / sweep / now）
 * @returns {Promise<{ kind: 'success', text: string } | { kind: 'error', text: string }>}
 */
export async function runMailReadCommand(_ctx, agent, _invocation, vaultDir, settings, _deps = {}) {
  const now = new Date()
  const lastEnd = await readVaultMailStateEnd(vaultDir)
  const window = resolveMailWindow({ lastReadEnd: lastEnd, now: () => now })
  const label = mailWindowLabel(window)
  if (typeof agent?.followup !== 'function') {
    return { kind: 'error', text: '当前环境不支持把任务交给模型（缺少 agent.followup 通道），无法执行 /ml mail read。' }
  }
  const handoff = [
    `${MAIL_MARK} 读信任务（窗口：${label}）`,
    '请阅读工作邮箱的新邮件并向用户输出阅读报告：',
    '',
    '1. 调用 memory_mail_fetch 工具：增量下载并解析「上次读完 → 现在」的新邮件（纯文本、附件不下载；临时目录即用即删，全程零模型调用）。窗口内没有新邮件时工具会直接说明——届时用一句话告知用户即可。',
    '2. 通读拿到的邮件，输出 markdown 阅读报告：**总评**（一句话整体重要程度与主题）、**重要事件**（按时间序列表）、**待办**（需要用户处理的事，明说期限的标注期限与来源）、**待阅**（不用动手但值得知道的内容）。只依据邮件内容，不要编造。',
    '3. 报告输出之后，调用 memory_mail_commit 工具推进读信进度（漏调 = 下次重读同一批邮件）。',
  ].join('\n')
  agent.followup({
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: handoff }],
    source: { kind: 'user' },
  })
  return {
    kind: 'success',
    text: `读信任务已交给当前模型（窗口：${label}）。它会在对话里下载、分析并输出报告；分析完成后才推进读信进度。`,
  }
}

/** 写读信进度（失败转 MailStateIoError——进度写不进就不推进，宁可重复读）。 */
export async function writeMailState(vaultDir, end) {
  try {
    await writeVaultMailStateEnd(vaultDir, end.toISOString())
  } catch (error) {
    throw new MailStateIoError(`记录读信进度失败（下次 read 会重复这个窗口）：${error instanceof Error ? error.message : String(error)}`)
  }
}
