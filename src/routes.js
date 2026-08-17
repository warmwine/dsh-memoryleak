/**
 * /api/memoryleak/* —— 浏览器半与宿主半之间的同源 JSON 桥（与 dsh-pet / dsh-ui-font
 * 同款的 webServer 模式；RPC 域是平台注册的，插件自服务 API 走 HTTP）。
 *
 *   GET  /api/memoryleak/settings        → { ok, section, revision, defaults }
 *   POST /api/memoryleak/settings        → { section, expectedRevision? } 整段替换
 *                                      校验失败 400；版本冲突 409（乐观并发）
 *                                      保存含非空 vault 时顺带做初始化复制
 *   POST /api/memoryleak/settings/reset  → 清空用户层，回到默认
 *   GET  /api/memoryleak/formats         → { ok, formats: [{ id, title, priority }] }
 *   GET  /api/memoryleak/files?limit=    → { ok, files: [{ name, bytes }] }（快速打开
 *                                         弹窗的候选源；根目录 = 设置的 Vault）
 *   GET  /api/memoryleak/path/complete?prefix=
 *                                       → { ok, base, entries }（Vault 选择卡
 *                                         的目录补全；读失败静默空列表）
 *
 * （系统目录选择对话框不在此处：浏览器半直接调官方 workspaces 服务的
 *   pickDirectory —— dsh-host-directory-picker-auto 负责跨平台。）
 *
 * 失败一律显式返回 { ok: false, error }，绝不静默。
 *
 * @module dsh-memoryleak/routes
 */
import { MEMORYLEAK_SETTINGS_NAMESPACE, MEMORYLEAK_SETTINGS_DEFAULTS, resolveMemoryleakSettings } from './settings-schema.js'
import { listWorkspaceFiles } from './journal.js'
import { dailyFileName, weeklyFileName } from './core/journal.js'
import { ensureVaultSettingsFile, resolveEffectiveSettings, completeVaultPath } from './vault.js'

/** 浏览器侧 API 前缀。 */
export const MEMORYLEAK_API_PREFIX = '/api/memoryleak'

const BODY_LIMIT = 64 * 1024

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(payload)) })
  res.end(payload)
}

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {string} method */
function requireMethod(req, res, method) {
  if (req.method === method) return true
  json(res, 405, { ok: false, error: 'method-not-allowed' })
  return false
}

/** @param {import('node:http').IncomingMessage} req @returns {Promise<unknown>} */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 读出本命名空间当前的修订号（用于乐观并发）。 */
function revisionOf(ctx) {
  const descriptor = ctx.settings.describe().find((entry) => entry.ns === MEMORYLEAK_SETTINGS_NAMESPACE)
  return descriptor !== undefined && Number.isInteger(descriptor.revision) ? descriptor.revision : null
}

/**
 * 构造全部路由（由宿主半注册，随插件停用回收）。
 *
 * @param {object} deps
 * @param {object} deps.ctx 宿主上下文（settings 服务，用于 revision 与整段重置）
 * @param {{ get(): unknown, update(patch: object, expectedRevision?: number): Promise<void> }} deps.scope
 * @param {object} deps.registry TodoFormatRegistry
 */
export function makeMemoryleakRoutes({ ctx, scope, registry }) {
  /** GET /settings：读当前段 + 修订号 + 默认值。 */
  function handleGetSettings(req, res) {
    if (!requireMethod(req, res, 'GET')) return
    try {
      json(res, 200, {
        ok: true,
        section: resolveMemoryleakSettings(scope.get()),
        revision: revisionOf(ctx),
        defaults: MEMORYLEAK_SETTINGS_DEFAULTS,
      })
    } catch (error) {
      json(res, 500, { ok: false, error: errorMessage(error) })
    }
  }

  /** POST /settings { section, expectedRevision? }：整段替换。 */
  function handlePostSettings(req, res) {
    if (!requireMethod(req, res, 'POST')) return
    readJsonBody(req)
      .then((body) => {
        if (body === null || typeof body !== 'object' || body === null) {
          throw Object.assign(new Error('请求体必须是 JSON 对象'), { status: 400 })
        }
        const record = /** @type {Record<string, unknown>} */ (body)
        const section = record.section
        if (section === null || typeof section !== 'object' || Array.isArray(section)) {
          throw Object.assign(new Error('section 必须是对象'), { status: 400 })
        }
        // 整段替换（本 schema 全是标量与数组，替换语义最诚实）。
        const expected = Number.isInteger(record.expectedRevision) ? record.expectedRevision : undefined
        return ctx.settings.replace(MEMORYLEAK_SETTINGS_NAMESPACE, section, expected).then(async () => {
          // 设置页保存了非空 vault → 确保 vault 内有设置文件（初始化复制，
          // 已存在则保留 —— 它优先级更高）。
          const saved = resolveMemoryleakSettings(scope.get())
          if (saved.vault !== '') {
            try {
              await ensureVaultSettingsFile(saved.vault, saved)
            } catch {
              // 目录不可达时不阻塞设置保存本身；命令侧引导会再兜底。
            }
          }
          json(res, 200, { ok: true, section: saved, revision: revisionOf(ctx) })
        })
      })
      .catch((error) => {
        if (error !== null && typeof error === 'object' && error.code === 'SETTINGS_CONFLICT') {
          json(res, 409, { ok: false, error: '设置已被其他窗口修改，请刷新后重试', revision: revisionOf(ctx) })
          return
        }
        json(res, error !== null && typeof error === 'object' && Number.isInteger(error.status) ? error.status : 400, {
          ok: false,
          error: errorMessage(error),
        })
      })
  }

  /**
   * /settings 路由：宿主 webServer 的去重键是 (kind, path) 不含 HTTP 方法，
   * 同路径的 GET/POST 必须共用一个 handler，在此按方法分发。
   */
  const settingsRoute = {
    kind: 'exact',
    path: `${MEMORYLEAK_API_PREFIX}/settings`,
    handler: (req, res) => {
      if (req.method === 'POST') {
        handlePostSettings(req, res)
        return
      }
      handleGetSettings(req, res)
    },
  }

  /** POST /settings/reset */
  const postReset = {
    kind: 'exact',
    path: `${MEMORYLEAK_API_PREFIX}/settings/reset`,
    handler: (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      ctx.settings
        .replace(MEMORYLEAK_SETTINGS_NAMESPACE, {})
        .then(() => {
          json(res, 200, { ok: true, section: resolveMemoryleakSettings(scope.get()), revision: revisionOf(ctx) })
        })
        .catch((error) => json(res, 400, { ok: false, error: errorMessage(error) }))
    },
  }

  /** GET /formats */
  const getFormats = {
    kind: 'exact',
    path: `${MEMORYLEAK_API_PREFIX}/formats`,
    handler: (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      json(res, 200, { ok: true, formats: registry.descriptors })
    },
  }

  /** GET /files?limit=（快速打开候选；根目录 = 设置里的 Vault，不再跟随会话） */
  const getFiles = {
    kind: 'exact',
    path: `${MEMORYLEAK_API_PREFIX}/files`,
    handler: (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      Promise.resolve()
        .then(async () => {
          const url = new URL(req.url, 'http://local')
          const limitParam = Number(url.searchParams.get('limit'))
          const limit = Number.isInteger(limitParam) && limitParam >= 1 && limitParam <= 1000 ? limitParam : 200
          const globalSettings = resolveMemoryleakSettings(scope.get())
          if (globalSettings.vault === '') {
            throw Object.assign(new Error('尚未设置 Vault 目录 —— 执行任意 /ml 命令完成引导，或在设置窗口填写'), { status: 400 })
          }
          const settings = await resolveEffectiveSettings(globalSettings)
          const files = await listWorkspaceFiles({ cwd: globalSettings.vault, settings, limit })
          const now = new Date()
          const current =
            settings.journalMode === 'weekly' ? weeklyFileName(now) : dailyFileName(now)
          json(res, 200, { ok: true, files, current })
        })
        .catch((error) => {
          json(res, error !== null && typeof error === 'object' && Number.isInteger(error.status) ? error.status : 400, {
            ok: false,
            error: errorMessage(error),
          })
        })
    },
  }

  /** GET /path/complete?prefix=：目录补全候选（读失败静默为空，永不 5xx）。 */
  const getPathComplete = {
    kind: 'exact',
    path: `${MEMORYLEAK_API_PREFIX}/path/complete`,
    handler: (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      Promise.resolve()
        .then(async () => {
          const url = new URL(req.url, 'http://local')
          const prefix = url.searchParams.get('prefix') ?? ''
          const { base, entries } = await completeVaultPath(prefix)
          json(res, 200, { ok: true, base, entries })
        })
        .catch((error) => json(res, 500, { ok: false, error: errorMessage(error) }))
    },
  }

  return [settingsRoute, postReset, getFormats, getFiles, getPathComplete]
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
