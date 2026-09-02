/**
 * `memoryleak` 设置命名空间：schema、默认值与解析器。
 *
 * 通过宿主 ctx.settings.register 注册，持久化在 ~/.dsh/settings.yaml 的
 * memoryleak: 段（与 pet:、ui-theme: 同一层）。schema 用 schemastery（与
 * dsh-settings 服务同一实现）。非法的用户段落会让注册本身失败 —— 启动期
 * 崩溃（let-it-crash），而不是带病运行。
 *
 * @module dsh-memoryleak/settings-schema
 */
import z from 'schemastery'

/** 设置命名空间（settings.yaml 的段名）。 */
export const MEMORYLEAK_SETTINGS_NAMESPACE = 'memoryleak'

/** 解析后的默认值（同时作为注册的 base 层）。 */
export const MEMORYLEAK_SETTINGS_DEFAULTS = Object.freeze({
  /** Vault 目录（绝对路径；空 = 未初始化，任何命令先引导选择）。 */
  vault: '',
  extensions: ['md', 'markdown'],
  excludeDirs: [
    'node_modules',
    '.git',
    '.dsh',
    '.hg',
    '.svn',
    '.backup',
    'dist',
    'build',
    'out',
    'target',
    'vendor',
    '.next',
    '.cache',
    'coverage',
  ],
  maxFiles: 2000,
  maxFileBytes: 512 * 1024,
  maxItems: 1000,
  defaultStatus: 'open',
  journalMode: 'daily',
  dailyTemplate: '',
  weeklyTemplate: 'start: {start}\nend: {end}\n',
  // —— /ml mail（工作邮件）——只住全局层：vault 内 .memoryleak.yaml 不允许
  // 覆盖这些键（密码等凭证不进 vault、不随目录迁移），双写同步时也会剔除。
  /** 登陆方式：password = 账号+密码/授权码；xoauth2 = OAuth2 access token。 */
  mailAuth: 'password',
  /** IMAP 服务器主机（空 = 未配置，/ml mail 走引导）。 */
  mailHost: '',
  /** IMAP 端口（993 = 隐式 TLS）。 */
  mailPort: 993,
  /** 是否使用隐式 TLS（993 端口常规为 true）。 */
  mailSecure: true,
  /** 邮箱账号（登陆用户名，通常为邮箱地址）。 */
  mailUser: '',
  /** 密码或授权码（mailAuth=password 时使用；明文存于 ~/.dsh/settings.yaml）。 */
  mailPassword: '',
  /** OAuth2 access token（mailAuth=xoauth2 时使用，代替密码）。 */
  mailToken: '',
  /** 读取的邮件目录（IMAP mailbox，默认收件箱）。 */
  mailFolder: 'INBOX',
  /** 单次 /ml mail read 最多下载分析的邮件数（超出保留最新的）。 */
  mailMaxEmails: 50,
  /** 信任的服务器证书（PEM，可多段；setup 引导「信任此证书」自动写入）。 */
  mailCaPem: '',
  /** 跳过证书校验（自建服务器内部证书的兜底；勾选后不再验证服务器身份）。 */
  mailTlsInsecure: false,
})

const EXTENSION_PATTERN = /^[a-z0-9]+$/i
const DIR_NAME_PATTERN = /^[^\\/:*?"<>|\s]+$/

/** 设置 schema（供 ctx.settings.register 使用）。vault 只住全局层（~/.dsh/settings.yaml），不进 vault 内设置文件。 */
export const memoryleakSettingsSchema = z.object({
  vault: z.string().max(1024).default(''),
  extensions: z.array(z.string().pattern(EXTENSION_PATTERN)).min(1).max(16).default(MEMORYLEAK_SETTINGS_DEFAULTS.extensions),
  excludeDirs: z.array(z.string().pattern(DIR_NAME_PATTERN).max(64)).min(1).max(256).default(MEMORYLEAK_SETTINGS_DEFAULTS.excludeDirs),
  maxFiles: z.number().step(1).min(1).max(50000).default(MEMORYLEAK_SETTINGS_DEFAULTS.maxFiles),
  maxFileBytes: z.number().step(1).min(1024).max(10 * 1024 * 1024).default(MEMORYLEAK_SETTINGS_DEFAULTS.maxFileBytes),
  maxItems: z.number().step(1).min(1).max(10000).default(MEMORYLEAK_SETTINGS_DEFAULTS.maxItems),
  defaultStatus: z.string().pattern(/^(all|open|done)$/).default(MEMORYLEAK_SETTINGS_DEFAULTS.defaultStatus),
  journalMode: z.string().pattern(/^(daily|weekly)$/).default(MEMORYLEAK_SETTINGS_DEFAULTS.journalMode),
  dailyTemplate: z.string().max(4096).default(MEMORYLEAK_SETTINGS_DEFAULTS.dailyTemplate),
  weeklyTemplate: z.string().max(4096).default(MEMORYLEAK_SETTINGS_DEFAULTS.weeklyTemplate),
  mailAuth: z.string().pattern(/^(password|xoauth2)$/).default(MEMORYLEAK_SETTINGS_DEFAULTS.mailAuth),
  mailHost: z.string().max(255).default(MEMORYLEAK_SETTINGS_DEFAULTS.mailHost),
  mailPort: z.number().step(1).min(1).max(65535).default(MEMORYLEAK_SETTINGS_DEFAULTS.mailPort),
  mailSecure: z.boolean().default(MEMORYLEAK_SETTINGS_DEFAULTS.mailSecure),
  mailUser: z.string().max(255).default(MEMORYLEAK_SETTINGS_DEFAULTS.mailUser),
  mailPassword: z.string().max(1024).default(MEMORYLEAK_SETTINGS_DEFAULTS.mailPassword),
  mailToken: z.string().max(4096).default(MEMORYLEAK_SETTINGS_DEFAULTS.mailToken),
  mailFolder: z.string().max(255).default(MEMORYLEAK_SETTINGS_DEFAULTS.mailFolder),
  mailMaxEmails: z.number().step(1).min(1).max(200).default(MEMORYLEAK_SETTINGS_DEFAULTS.mailMaxEmails),
  mailCaPem: z.string().max(16384).default(MEMORYLEAK_SETTINGS_DEFAULTS.mailCaPem),
  mailTlsInsecure: z.boolean().default(MEMORYLEAK_SETTINGS_DEFAULTS.mailTlsInsecure),
})

/** /ml mail 的全部全局层设置键（vault 文件不允许覆盖、双写时剔除的名单）。 */
export const MAIL_SETTING_KEYS = Object.freeze([
  'mailAuth',
  'mailHost',
  'mailPort',
  'mailSecure',
  'mailUser',
  'mailPassword',
  'mailToken',
  'mailFolder',
  'mailMaxEmails',
  'mailCaPem',
  'mailTlsInsecure',
])

/**
 * 把任意输入（存储段 / API 载荷 / 空值）解析为深冻结的合法设置。
 * 校验失败抛 schemastery 的错误（调用方转成用户可见信息）。
 *
 * @param {unknown} raw
 * @returns {typeof MEMORYLEAK_SETTINGS_DEFAULTS}
 */
export function resolveMemoryleakSettings(raw) {
  const resolved = memoryleakSettingsSchema(raw === undefined || raw === null ? {} : raw)
  return deepFreeze({ ...resolved })
}

/** 标量与字符串数组的递归冻结（本 schema 只含这两类数据）。 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}
