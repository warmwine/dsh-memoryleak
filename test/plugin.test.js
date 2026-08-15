/**
 * 宿主插件集成测试：以伪 ctx（settings / webServer / commands）装配真实
 * apply()，验证路由、/ml 命令与设置命名空间的端到端行为 —— 不起浏览器、
 * 不碰真实宿主进程。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name, inject } from '../src/index.js'

/** 伪 settings 服务：实现 register/describe/replace/update 的最小语义。 */
function createFakeSettings() {
  const registrations = new Map()
  let revision = 0
  const resolveOf = (entry) => Object.freeze(entry.schema({ ...entry.base, ...entry.user }))
  return {
    register(ns, schema, options = {}) {
      if (typeof ns !== 'string' || ns === '') throw new Error('bad ns')
      if (registrations.has(ns)) throw new Error(`duplicate namespace ${ns}`)
      const entry = { ns, schema, base: options.base ?? {}, user: {} }
      registrations.set(ns, entry)
      return {
        get: () => resolveOf(entry),
        watch: () => () => {},
        async update(_patch) {
          throw new Error('update not used in tests')
        },
      }
    },
    describe: () => [...registrations.values()].map((entry) => ({ ns: entry.ns, revision })),
    async replace(ns, section) {
      const entry = registrations.get(ns)
      if (entry === undefined) throw new Error(`unknown namespace ${ns}`)
      entry.user = section // 整段替换语义
      revision += 1
    },
  }
}

function createFakeHost() {
  const settings = createFakeSettings()
  const routes = []
  const routeKeys = new Set()
  const commands = []
  const effects = []
  const ctx = {
    settings,
    webServer: {
      // 与真实 dsh-host-webserver 一致：exact/prefix 的去重键是 (kind, path)，
      // 不含 HTTP 方法 —— 同路径多方法必须在单个 handler 内分发。
      register(route) {
        const key = `${route.kind} ${route.path}`
        if (routeKeys.has(key)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
        routeKeys.add(key)
        routes.push(route)
        return () => {
          routeKeys.delete(key)
          const index = routes.indexOf(route)
          if (index !== -1) routes.splice(index, 1)
        }
      },
    },
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {
          const index = commands.indexOf(definition)
          if (index !== -1) commands.splice(index, 1)
        }
      },
    },
    effect(factory, _label) {
      const dispose = factory()
      effects.push(dispose)
      return dispose
    },
  }
  return { ctx, routes, commands, effects, settings }
}

/** 最小 req/res 桩：驱动一条 exact 路由。 */
async function invokeRoute(route, method, payload) {
  const out = { status: 0, headers: {}, body: null }
  const res = {
    writeHead(status, headers) {
      out.status = status
      Object.assign(out.headers, headers ?? {})
    },
    end(data) {
      out.body = data === undefined ? '' : String(data)
    },
  }
  const listeners = {}
  const req = {
    method,
    on(event, callback) {
      ;(listeners[event] ??= []).push(callback)
      return req
    },
    destroy() {},
  }
  const settled = route.handler(req, res)
  if (payload !== undefined) {
    for (const callback of listeners.data ?? []) callback(Buffer.from(JSON.stringify(payload)))
    for (const callback of listeners.end ?? []) callback()
  }
  await settled
  for (let index = 0; index < 50 && out.body === null; index += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  return { status: out.status, body: out.body === '' ? null : out.body === null ? null : JSON.parse(out.body) }
}

let workspace

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-ws-'))
  await writeFile(join(workspace, 'README.md'), '# t\n- [ ] alpha\n- [x] beta\n')
  await mkdir(join(workspace, 'docs'), { recursive: true })
  await writeFile(join(workspace, 'docs', 'plan.md'), '- [ ] gamma deploy\n')
  await mkdir(join(workspace, 'node_modules'), { recursive: true })
  await writeFile(join(workspace, 'node_modules', 'x.md'), '- [ ] hidden\n')
})

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('宿主插件装配（apply）', () => {
  const host = createFakeHost()
  let command

  beforeAll(() => {
    apply(host.ctx)
    command = host.commands.find((definition) => definition.name === 'ml')
  })

  it('声明稳定的插件名与硬依赖', () => {
    expect(name).toBe('memoryleak')
    expect(inject).toEqual(['webServer', 'commands', 'settings'])
  })

  it('注册 3 条 API 路由（GET/POST /settings 合一）与 1 条 /ml 命令', () => {
    expect(host.routes.map((route) => `${route.kind} ${route.path}`).sort()).toEqual([
      'exact /api/memoryleak/formats',
      'exact /api/memoryleak/settings',
      'exact /api/memoryleak/settings/reset',
    ])
    expect(command).toBeDefined()
    expect(command.description).toContain('/ml todo list')
    expect(command.input.hint).toBe('todo list [all|open|done] [关键词]')
  })

  it('GET /settings 返回默认段与修订号', async () => {
    const get = host.routes.find((route) => route.path === '/api/memoryleak/settings')
    const result = await invokeRoute(get, 'GET')
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
    expect(result.body.section.defaultStatus).toBe('open')
    expect(result.body.section.extensions).toEqual(['md', 'markdown'])
    expect(result.body.revision).toBe(0)
    expect(result.body.defaults).toBeDefined()
  })

  it('POST /settings 整段替换并递增修订号', async () => {
    const post = host.routes.find((route) => route.path === '/api/memoryleak/settings')
    const result = await invokeRoute(post, 'POST', {
      section: { extensions: ['md'], excludeDirs: ['node_modules'], maxFiles: 10, maxFileBytes: 65536, maxItems: 5, defaultStatus: 'all' },
    })
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
    expect(result.body.section.defaultStatus).toBe('all')
    expect(result.body.revision).toBe(1)
  })

  it('POST /settings 非法段返回 400 与人话错误', async () => {
    const post = host.routes.find((route) => route.path === '/api/memoryleak/settings')
    const result = await invokeRoute(post, 'POST', { section: { defaultStatus: 'ANY' } })
    expect(result.status).toBe(400)
    expect(result.body.ok).toBe(false)
    expect(result.body.error).toBeTruthy()
  })

  it('POST /settings/reset 清空用户层', async () => {
    const reset = host.routes.find((route) => route.path === '/api/memoryleak/settings/reset')
    const result = await invokeRoute(reset, 'POST', {})
    expect(result.status).toBe(200)
    expect(result.body.section.defaultStatus).toBe('open')
  })

  it('GET /formats 返回已注册策略', async () => {
    const formats = host.routes.find((route) => route.path === '/api/memoryleak/formats')
    const result = await invokeRoute(formats, 'GET')
    expect(result.body.formats).toEqual([{ id: 'markdown-checkbox', title: expect.any(String), priority: 100 }])
  })

  it('405 方法错误', async () => {
    const formats = host.routes.find((route) => route.path === '/api/memoryleak/formats')
    const result = await invokeRoute(formats, 'POST', {})
    expect(result.status).toBe(405)
    expect(result.body.error).toBe('method-not-allowed')

    const settings = host.routes.find((route) => route.path === '/api/memoryleak/settings')
    const settingsResult = await invokeRoute(settings, 'PUT', {})
    expect(settingsResult.status).toBe(405)
    expect(settingsResult.body.error).toBe('method-not-allowed')
  })

  it('/ml todo list all 端到端：扫描真实临时工作区', async () => {
    const result = await command.handler({
      agent: { session: { header: { cwd: workspace } } },
      rawInput: ' todo list all',
      signal: new AbortController().signal,
    })
    expect(result.kind).toBe('success')
    expect(result.text.split('\n')[0]).toBe('待办 3 条（未完成 2 / 已完成 1） · 2 个文件')
    expect(result.text).toContain('[ ] alpha')
    expect(result.text).toContain('[x] beta')
    expect(result.text).toContain('docs/plan.md')
    expect(result.text).not.toContain('hidden')
  })

  it('/ml todo 省略操作默认 list（默认状态来自设置）', async () => {
    const result = await command.handler({
      agent: { session: { header: { cwd: workspace } } },
      rawInput: 'todo',
      signal: new AbortController().signal,
    })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('[ ] alpha')
    expect(result.text).not.toContain('[x] beta')
  })

  it('/ml todo list deploy 关键词过滤生效', async () => {
    const result = await command.handler({
      agent: { session: { header: { cwd: workspace } } },
      rawInput: 'todo list deploy',
      signal: new AbortController().signal,
    })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('gamma deploy')
    expect(result.text).not.toContain('alpha')
  })

  it('用法错误返回 kind:error 而非抛出', async () => {
    const result = await command.handler({
      agent: { session: { header: { cwd: workspace } } },
      rawInput: 'note new',
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ kind: 'error', text: expect.stringContaining('未知子命令') })
  })

  it('未知操作返回 kind:error', async () => {
    const result = await command.handler({
      agent: { session: { header: { cwd: workspace } } },
      rawInput: 'todo create x',
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ kind: 'error', text: expect.stringContaining('未知操作') })
  })

  it('会话无工作区返回明确错误', async () => {
    const result = await command.handler({ agent: { session: { header: {} } }, rawInput: 'todo', signal: new AbortController().signal })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('工作区')
  })

  it('工作区目录消失返回环境错误（不崩溃）', async () => {
    const result = await command.handler({
      agent: { session: { header: { cwd: join(workspace, 'nope') } } },
      rawInput: 'todo',
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ kind: 'error', text: expect.stringContaining('工作区目录不可用') })
  })

  it('所有副作用可通过 effects 逆回收', () => {
    const routesBefore = host.routes.length
    const commandsBefore = host.commands.length
    for (const dispose of host.effects) dispose()
    expect(host.routes).toHaveLength(0)
    expect(host.commands).toHaveLength(0)
    expect(routesBefore).toBe(3)
    expect(commandsBefore).toBe(1)
  })
})
