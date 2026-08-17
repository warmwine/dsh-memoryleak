/**
 * 宿主插件集成测试：以伪 ctx（settings / webServer / commands）装配真实
 * apply()，验证路由、/ml 命令与设置命名空间的端到端行为 —— 不起浏览器、
 * 不碰真实宿主进程。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name, inject } from '../src/index.js'
import { dailyFileName, formatDate, isoWeekOf, weeklyFileName } from '../src/core/journal.js'
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
    async update(ns, patch) {
      const entry = registrations.get(ns)
      if (entry === undefined) throw new Error(`unknown namespace ${ns}`)
      entry.user = { ...entry.user, ...patch }
      revision += 1
    },
    async replace(ns, section) {
      const entry = registrations.get(ns)
      if (entry === undefined) throw new Error(`unknown namespace ${ns}`)
      entry.user = section // 整段替换语义
      revision += 1
    },
  }
}

function createFakeHost(answers = {}) {
  const settings = createFakeSettings()
  const routes = []
  const routeKeys = new Set()
  const commands = []
  const effects = []
  const askLog = []
  const sessions = new Map() // sessionId → { header: { cwd } }（files 路由测试注册）
  const ctx = {
    settings,
    sessions: {
      get(id) {
        return sessions.get(id)
      },
    },
    // 伪 userQuestions：按问题 id 返回预置答案（端到端注入点）
    get(name) {
      if (name !== 'userQuestions') return undefined
      return {
        async ask(request) {
          askLog.push(request)
          return {
            answers: (request.questions ?? []).map((question) => {
              const preset = answers[question.id]
              if (preset === undefined) return { id: question.id, selected: [] }
              if (preset.custom !== undefined) return { id: question.id, selected: [], custom: preset.custom }
              return { id: question.id, selected: [preset] }
            }),
          }
        },
      }
    },
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
  return { ctx, routes, commands, effects, settings, askLog, sessions }
}

/** 最小 req/res 桩：驱动一条 exact 路由。 */
async function invokeRoute(route, method, payload, url) {
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
    url: url ?? route.path,
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

  it('声明稳定的插件名与硬依赖（inject 与代码实际访问的 ctx 服务一致）', async () => {
    expect(name).toBe('memoryleak')
    expect(inject).toEqual(['webServer', 'commands', 'settings'])
    // 回归：宿主源码里访问的每个 ctx.<service>（effect 除外）都必须出现在
    // inject 声明里 —— Guard 在属性访问时拦截，桩 ctx 无 Guard 测不出来。
    const hostSources = (
      await Promise.all(
        ['src/index.js', 'src/routes.js'].map((file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8')),
      )
    ).join('\n')
    const accessed = new Set(hostSources.match(/\bctx\.\w+/g) ?? [])
    for (const access of accessed) {
      const service = access.slice('ctx.'.length)
      if (service === 'effect' || service === 'plugin' || service === 'get') continue
      expect(inject, `宿主代码访问 ctx.${service} 但未声明 inject`).toContain(service)
    }
  })

  it('注册 4 条 API 路由（GET/POST /settings 合一）与 1 条 /ml 命令', () => {
    expect(host.routes.map((route) => `${route.kind} ${route.path}`).sort()).toEqual([
      'exact /api/memoryleak/files',
      'exact /api/memoryleak/formats',
      'exact /api/memoryleak/path/complete',
      'exact /api/memoryleak/settings',
      'exact /api/memoryleak/settings/reset',
    ])
    expect(command).toBeDefined()
    // 注册描述保持短并导向 /ml help（汇总说明统一由 help 提供）
    expect(command.description).toBe('MemoryLeak 记事本 · 输入 /ml help 查看全部命令')
    expect(command.input.hint).toBe('<文本> / todo 子命令 / view / help')
  })

  it('/ml help：返回汇总说明（无需工作区绑定）', async () => {
    const result = await command.handler({
      agent: { id: 'a', session: { header: {} } }, // 无 cwd 也能看帮助
      rawInput: 'help',
      signal: new AbortController().signal,
    })
    expect(result.kind).toBe('success')
    for (const fragment of ['/ml <文本>', '/ml todo add', '/ml todo list', '/ml todo d', '/ml todo u', '/ml view', '/ml help']) {
      expect(result.text).toContain(fragment)
    }
  })

  it('/ml h 别名同样返回帮助', async () => {
    const result = await command.handler({
      agent: { id: 'a', session: { header: {} } },
      rawInput: ' h',
      signal: new AbortController().signal,
    })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('MemoryLeak · /ml 命令一览')
  })

  it('GET /settings 返回默认段与修订号', async () => {
    const get = host.routes.find((route) => route.path === '/api/memoryleak/settings')
    const result = await invokeRoute(get, 'GET')
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
    expect(result.body.section.vault).toBe('')
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
    expect(result.body.formats).toEqual([
      { id: 'memoryleak-todo', title: expect.any(String), priority: 50 },
      { id: 'markdown-checkbox', title: expect.any(String), priority: 100 },
    ])
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
    await host.settings.update('memoryleak', { vault: workspace })
    const result = await command.handler({
      agent: { session: { header: { cwd: workspace } } },
      rawInput: ' todo list all',
      signal: new AbortController().signal,
    })
    expect(result.kind).toBe('success')
    expect(result.text.split('\n')[0]).toBe('待办 3 条（未完成 2 / 已完成 1） · 2 个文件')
    expect(result.text).toContain('☐ alpha')
    expect(result.text).toContain('☑ beta')
    expect(result.text).toContain('■ docs/plan.md · 1 条')
    expect(result.text).not.toContain('hidden')
  })

  it('/ml todo 省略操作默认 list（默认状态来自设置）', async () => {
    const result = await command.handler({
      agent: { session: { header: { cwd: workspace } } },
      rawInput: 'todo',
      signal: new AbortController().signal,
    })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('☐ alpha')
    expect(result.text).not.toContain('☑ beta')
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

  it('未知操作返回 kind:error', async () => {
    const result = await command.handler({
      agent: { session: { header: { cwd: workspace } } },
      rawInput: 'todo create x',
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ kind: 'error', text: expect.stringContaining('未知操作') })
  })

  it('vault 未设置：除 help/init 外的命令直接报错并提示 /ml init（不弹引导）', async () => {
    await host.settings.update('memoryleak', { vault: '' })
    for (const rawInput of ['todo', 'todo list', 'view', '随便记一句']) {
      const result = await command.handler({ agent: { session: { header: {} } }, rawInput, signal: new AbortController().signal })
      expect(result.kind, rawInput).toBe('error')
      expect(result.text, rawInput).toContain('/ml init')
    }
    expect(host.askLog).toHaveLength(0) // 严格门控：没有触发任何提问
    // help 仍可用
    const help = await command.handler({ agent: { session: { header: {} } }, rawInput: 'help', signal: new AbortController().signal })
    expect(help.kind).toBe('success')
  })

  it('vault 指向的目录消失返回环境错误（不崩溃）', async () => {
    await host.settings.update('memoryleak', { vault: join(workspace, 'nope') })
    const result = await command.handler({
      agent: { session: { header: {} } },
      rawInput: 'todo',
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ kind: 'error', text: expect.stringContaining('工作区目录不可用') })
    await host.settings.update('memoryleak', { vault: workspace })
  })

  it('所有副作用可通过 effects 逆回收', () => {
    const routesBefore = host.routes.length
    const commandsBefore = host.commands.length
    for (const dispose of host.effects) dispose()
    expect(host.routes).toHaveLength(0)
    expect(host.commands).toHaveLength(0)
    expect(routesBefore).toBe(5)
    expect(commandsBefore).toBe(1)
  })
})

describe('/ml <文本> 日志记录（端到端）', () => {
  const host = createFakeHost()
  let command
  let journalWs
  let today
  let dailyFile
  let weekFile

  beforeAll(async () => {
    apply(host.ctx)
    command = host.commands.find((definition) => definition.name === 'ml')
    journalWs = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-journal-'))
    await host.settings.update('memoryleak', { vault: journalWs })
    const now = new Date()
    today = formatDate(now)
    dailyFile = dailyFileName(now)
    weekFile = weeklyFileName(now)
  })

  afterAll(async () => {
    await rm(journalWs, { recursive: true, force: true })
  })

  const run = (rawInput) =>
    command.handler({
      agent: { session: { header: { cwd: journalWs } } },
      rawInput,
      signal: new AbortController().signal,
    })

  it('daily 默认：新建文件并记录', async () => {
    const result = await run(' 修复登录页样式')
    expect(result.kind).toBe('success')
    expect(result.text).toContain(`已记录 → ${dailyFile} ## MemoryLeak（新建文件）`)
    expect(result.text).toContain('- 修复登录页样式')
    const content = await readFile(join(journalWs, dailyFile), 'utf8')
    expect(content).toBe(['## MemoryLeak', '', '- 修复登录页样式', ''].join('\n'))
  })

  it('daily 第二条：追加到同一列表', async () => {
    const result = await run('写周报')
    expect(result.kind).toBe('success')
    expect(result.text).not.toContain('新建文件')
    const content = await readFile(join(journalWs, dailyFile), 'utf8')
    expect(content).toBe(['## MemoryLeak', '', '- 修复登录页样式', '- 写周报', ''].join('\n'))
  })

  it('weekly 模式：新建周志（start/end 配置 + 日期分组）', async () => {
    await host.settings.update('memoryleak', { journalMode: 'weekly' })
    const result = await run('调研竞品')
    expect(result.kind).toBe('success')
    expect(result.text).toContain(`已记录 → ${weekFile} ## MemoryLeak · ${today}（新建文件）`)
    const content = await readFile(join(journalWs, weekFile), 'utf8')
    const week = isoWeekOf(new Date())
    const lines = content.split('\n')
    expect(lines[0]).toBe(`start: ${week.start}`)
    expect(lines[1]).toBe(`end: ${week.end}`)
    expect(content).toContain('## MemoryLeak')
    expect(content).toContain(`- ${today}`)
    expect(content).toContain('  - 调研竞品')
  })

  it('weekly 第二条：同日期追加子项', async () => {
    const result = await run('复盘会议')
    expect(result.kind).toBe('success')
    const content = await readFile(join(journalWs, weekFile), 'utf8')
    const block = content.slice(content.indexOf(`- ${today}`))
    expect(block.indexOf('  - 调研竞品')).toBeLessThan(block.indexOf('  - 复盘会议'))
  })

  it('记录不会污染 todo 扫描（journal 行不是复选框）', async () => {
    const result = await run('todo list all')
    // 'todo list all' 属于 todo 家族：扫描 journalWs，两条 daily 记录不应出现
    expect(result.kind).toBe('success')
    expect(result.text).toContain('待办 0 条')
    expect(result.text).not.toContain('修复登录页样式')
  })

  it('空文本仍是用法错误', async () => {
    const result = await run('   ')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('用法')
  })

  it('工作区不可达返回环境错误', async () => {
    await host.settings.update('memoryleak', { vault: join(journalWs, 'gone') })
    const result = await command.handler({
      agent: { session: { header: {} } },
      rawInput: 'x',
      signal: new AbortController().signal,
    })
    expect(result.kind).toBe('error')
    expect(result.text).toMatch(/日志写入失败|工作区/)
  })
})

describe('/ml view（端到端）', () => {
  const host = createFakeHost()
  let command
  let viewWs

  beforeAll(async () => {
    apply(host.ctx)
    command = host.commands.find((definition) => definition.name === 'ml')
    viewWs = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-view-'))
    await host.settings.update('memoryleak', { vault: viewWs })
  })

  afterAll(async () => {
    await rm(viewWs, { recursive: true, force: true })
  })

  const run = (rawInput) =>
    command.handler({
      agent: { id: 'agent-view-test', session: { header: { cwd: viewWs } } },
      rawInput,
      signal: new AbortController().signal,
    })

  it('文件未创建 → 友好提示（不创建文件）', async () => {
    const daily = `${formatDate(new Date())}.md`
    const result = await run('view')
    expect(result.kind).toBe('success')
    expect(result.text).toContain(`尚未创建：${daily}`)
    expect(result.text).toContain('按模板自动创建')
    expect(await readFile(join(viewWs, daily), 'utf8').catch(() => null)).toBeNull()
  })

  it('记录后 → 显示文件名与内容', async () => {
    await run(' 第一条记录')
    const daily = `${formatDate(new Date())}.md`
    const result = await run('view')
    expect(result.kind).toBe('success')
    expect(result.text).toContain(`${daily}（日志）`)
    expect(result.text).toContain('## MemoryLeak')
    expect(result.text).toContain('- 第一条记录')
  })

  it('v 别名等价', async () => {
    const result = await run('v')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('（日志）')
  })

  it('weekly 模式 → 定位周志文件（未创建则提示）', async () => {
    await host.settings.update('memoryleak', { journalMode: 'weekly' })
    const weekFile = weeklyFileName(new Date())
    const result = await run('view')
    expect(result.kind).toBe('success')
    expect(result.text).toContain(`尚未创建：${weekFile}`)
    // daily 文件仍在，但 weekly 模式下 view 只看周志
    expect(result.text).not.toContain('第一条记录')
  })

  it('带参数：exact 文件名直接查看', async () => {
    const daily = `${formatDate(new Date())}.md`
    const result = await run(`view ${daily}`)
    expect(result.kind).toBe('success')
    expect(result.text.startsWith(`${daily}\n`)).toBe(true)
    expect(result.text).toContain('第一条记录')
  })

  it('带参数：去扩展名 stem 唯一对应', async () => {
    const stem = formatDate(new Date())
    const result = await run(`view ${stem}`)
    expect(result.kind).toBe('success')
    expect(result.text).toContain(`${stem}.md`)
  })

  it('带参数：无匹配报错并提示', async () => {
    const result = await run('view zzz不存在')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('没有匹配')
  })
})

describe('/ml view 模糊解析（多文件场景，端到端）', () => {
  const host = createFakeHost()
  let command
  let fuzzyWs

  beforeAll(async () => {
    apply(host.ctx)
    command = host.commands.find((definition) => definition.name === 'ml')
    fuzzyWs = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-fuzzy-'))
    await host.settings.update('memoryleak', { vault: fuzzyWs })
    await writeFile(join(fuzzyWs, '2026-08-15.md'), '# 15 日\n- [ ] a\n')
    await writeFile(join(fuzzyWs, '2026-08-16.md'), '# 16 日\n- [ ] b\n')
    await writeFile(join(fuzzyWs, '2026W33.md'), 'start: 2026-08-10\nend: 2026-08-16\n')
    await mkdir(join(fuzzyWs, 'docs'), { recursive: true })
    await writeFile(join(fuzzyWs, 'docs', 'plan.md'), '# 计划\n')
  })

  afterAll(async () => {
    await rm(fuzzyWs, { recursive: true, force: true })
  })

  const run = (rawInput) =>
    command.handler({
      agent: { id: 'agent-fuzzy-test', session: { header: { cwd: fuzzyWs } } },
      rawInput,
      signal: new AbortController().signal,
    })

  it('unique：明显赢家直接查看（w33 → 2026W33.md）', async () => {
    const result = await run('view w33')
    expect(result.kind).toBe('success')
    expect(result.text.startsWith('2026W33.md\n')).toBe(true)
    expect(result.text).toContain('start: 2026-08-10')
  })

  it('unique：唯一子序列（plan → docs/plan.md）', async () => {
    const result = await run('view plan')
    expect(result.kind).toBe('success')
    expect(result.text.startsWith('docs/plan.md\n')).toBe(true)
  })

  it('ambiguous：多候选列出并要求更具体（08-1 命中 15/16 两天）', async () => {
    const result = await run('view 08-1')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('匹配到多个文件')
    expect(result.text).toContain('2026-08-15.md')
    expect(result.text).toContain('2026-08-16.md')
    // 用更长的片段即可消歧
    const resolved = await run('view 26815')
    expect(resolved.kind).toBe('success')
    expect(resolved.text.startsWith('2026-08-15.md\n')).toBe(true)
  })

  it('GET /files：按 Vault 定位（名字降序）+ 当前日志名；未设置 Vault → 400', async () => {
    const route = host.routes.find((entry) => entry.path === '/api/memoryleak/files')
    const ok = await invokeRoute(route, 'GET', undefined, `${route.path}?limit=10`)
    expect(ok.status).toBe(200)
    expect(ok.body.ok).toBe(true)
    const names = ok.body.files.map((file) => file.name)
    expect(names).toContain('2026-08-16.md')
    expect(names).toContain('docs/plan.md')
    expect(names[0]).toBe('docs/plan.md') // 降序：docs/ > 2026W33 > 2026-08-16
    expect(ok.body.current).toBe(`${formatDate(new Date())}.md`) // daily 模式的当前日志
    // 未设置 Vault → 400
    await host.settings.update('memoryleak', { vault: '' })
    const noVault = await invokeRoute(route, 'GET')
    expect(noVault.status).toBe(400)
    expect(noVault.body.ok).toBe(false)
    expect(noVault.body.error).toContain('Vault')
  })
})

describe('/ml todo add（交互添加 + sleep 过滤，端到端）', () => {
  const answers = { 'ml-type': 'deadline', 'ml-prio': 'urgent', 'ml-date': { custom: '2026-09-01' } }
  const host = createFakeHost(answers)
  let command
  let todoWs

  beforeAll(async () => {
    apply(host.ctx)
    command = host.commands.find((definition) => definition.name === 'ml')
    todoWs = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-todo-'))
    await host.settings.update('memoryleak', { vault: todoWs })
  })

  afterAll(async () => {
    await rm(todoWs, { recursive: true, force: true })
  })

  const run = (rawInput) =>
    command.handler({
      agent: { id: 'agent-todo-test', session: { header: { cwd: todoWs } } },
      rawInput,
      signal: new AbortController().signal,
    })

  it('deadline：两轮提问 → 建文件、双模块、结构化行', async () => {
    const result = await run('todo add 完成设计稿')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已添加 →')
    expect(result.text).toContain('## Todo')
    expect(result.text).toContain('(ml:deadline 2026-09-01 urgent) 完成设计稿')
    expect(result.text).toContain('截止型，日期 2026-09-01，紧急')
    // 提问形态：第一轮两问同批（id 命名空间化 —— web 端客户端半据此渲染
    // 「选完即提交」的组合卡），第二轮日期自由输入（id 固定 ml-date，
    // 客户端渲染日历选择器；答案仍走 custom）
    expect(host.askLog[0].questions.map((q) => q.id)).toEqual(['ml-type', 'ml-prio'])
    expect(host.askLog[0].questions[0].options).toHaveLength(3)
    expect(host.askLog[1].questions.map((q) => q.id)).toEqual(['ml-date'])
    expect(host.askLog[1].questions[0].options).toBeUndefined()
    // web Provider 依赖 agent.id 路由弹窗（ASK_MISSING_AGENT 回归）
    for (const request of host.askLog) {
      expect(request.agent).toBeDefined()
      expect(request.agent.id).toBeTypeOf('string')
    }
    // 文件内容：## MemoryLeak 在前，## Todo 在后
    const daily = `${formatDate(new Date())}.md`
    const content = await readFile(join(todoWs, daily), 'utf8')
    expect(content.indexOf('## MemoryLeak')).toBeLessThan(content.indexOf('## Todo'))
    expect(content).toContain('- [ ] (ml:deadline 2026-09-01 urgent) 完成设计稿')
  })

  it('list 默认显示 deadline 待办（带徽章）；all 同样可见', async () => {
    const open = await run('todo list')
    expect(open.kind).toBe('success')
    expect(open.text).toContain('完成设计稿')
    expect(open.text).toContain('[截止 2026-09-01·紧急]')
    const all = await run('todo list all')
    expect(all.text).toContain('完成设计稿')
  })

  it('sleep：默认隐藏，唤醒日前不可见，all 可见', async () => {
    // 直接写入两条 sleep：一条远期（未唤醒），一条已过唤醒日
    const daily = `${formatDate(new Date())}.md`
    const path = join(todoWs, daily)
    const current = await readFile(path, 'utf8')
    const { insertTodoLine } = await import('../src/core/journal.js')
    const next = insertTodoLine(
      insertTodoLine(current, '- [ ] (ml:sleep 2099-01-01 low) 远期沉睡'),
      '- [ ] (ml:sleep 2000-01-01 low) 早已唤醒',
    )
    await writeFile(path, next, 'utf8')

    const open = await run('todo list')
    expect(open.text).toContain('早已唤醒')
    expect(open.text).not.toContain('远期沉睡')
    const all = await run('todo list all')
    expect(all.text).toContain('远期沉睡')
    expect(all.text).toContain('[睡到 2099-01-01·低]')
  })

  it('anytime：不需要日期问题（只有一轮提问）', async () => {
    const anytimeHost = createFakeHost({ 'ml-type': 'anytime', 'ml-prio': 'medium' })
    apply(anytimeHost.ctx)
    await anytimeHost.settings.update('memoryleak', { vault: todoWs })
    const anytimeCommand = anytimeHost.commands.find((definition) => definition.name === 'ml')
    const result = await anytimeCommand.handler({
      agent: { id: 'agent-todo-test', session: { header: { cwd: todoWs } } },
      rawInput: 'todo add 整理收藏夹',
      signal: new AbortController().signal,
    })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('(ml:anytime medium) 整理收藏夹')
    expect(anytimeHost.askLog).toHaveLength(1) // 只有一轮（类型+优先级），无日期问题
    const listed = await run('todo list')
    expect(listed.text).toContain('整理收藏夹')
    expect(listed.text).toContain('[随时·中等]')
  })

  it('非法选项答案被拒绝（不写入）', async () => {
    const badHost = createFakeHost({ 'ml-type': '不存在的类型', 'ml-prio': 'urgent' })
    apply(badHost.ctx)
    await badHost.settings.update('memoryleak', { vault: todoWs })
    const badCommand = badHost.commands.find((definition) => definition.name === 'ml')
    const result = await badCommand.handler({
      agent: { id: 'agent-todo-test', session: { header: { cwd: todoWs } } },
      rawInput: 'todo add 不该写入',
      signal: new AbortController().signal,
    })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('选择无效')
  })

  it('非法日期被拒绝（不写入）', async () => {
    const badDateHost = createFakeHost({ 'ml-type': 'deadline', 'ml-prio': 'low', 'ml-date': { custom: '明天' } })
    apply(badDateHost.ctx)
    await badDateHost.settings.update('memoryleak', { vault: todoWs })
    const badDateCommand = badDateHost.commands.find((definition) => definition.name === 'ml')
    const result = await badDateCommand.handler({
      agent: { id: 'agent-todo-test', session: { header: { cwd: todoWs } } },
      rawInput: 'todo add 不该写入2',
      signal: new AbortController().signal,
    })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('日期格式无效')
  })

  it('无 userQuestions 服务时给出明确错误', async () => {
    const bareHost = createFakeHost({})
    bareHost.ctx.get = () => undefined
    apply(bareHost.ctx)
    await bareHost.settings.update('memoryleak', { vault: todoWs })
    const bareCommand = bareHost.commands.find((definition) => definition.name === 'ml')
    const result = await bareCommand.handler({
      agent: { id: 'agent-todo-test', session: { header: { cwd: todoWs } } },
      rawInput: 'todo add 无界面',
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ kind: 'error', text: expect.stringContaining('交互提问界面') })
  })

  it('add 缺文本是用法错误', async () => {
    const result = await run('todo add')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('/ml todo n <待办内容>')
  })
})

describe('/ml todo d 与唤醒转写（端到端）', () => {
  const host = createFakeHost()
  let command
  let dWs

  beforeAll(async () => {
    apply(host.ctx)
    command = host.commands.find((definition) => definition.name === 'ml')
    dWs = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-d-'))
    await host.settings.update('memoryleak', { vault: dWs })
    // 手工布置：一条远期 sleep、一条到日 sleep、一条 deadline
    const daily = `${formatDate(new Date())}.md`
    const { insertTodoLine } = await import('../src/core/journal.js')
    let content = insertTodoLine('', '- [ ] (ml:sleep 2099-01-01 low) 远期沉睡')
    content = insertTodoLine(content, '- [ ] (ml:sleep 2000-01-01 medium) 早已唤醒')
    content = insertTodoLine(content, '- [ ] (ml:deadline 2026-09-01 urgent) 完成设计稿')
    await writeFile(join(dWs, daily), content)
  })

  afterAll(async () => {
    await rm(dWs, { recursive: true, force: true })
  })

  const run = (rawInput, agentId = 'agent-d-test') =>
    command.handler({
      agent: { id: agentId, session: { header: { cwd: dWs } } },
      rawInput,
      signal: new AbortController().signal,
    })

  it('未 list 直接 d → 提示先 list', async () => {
    const result = await run('todo d 1')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('请先执行 /ml todo list')
  })

  it('list：到日 sleep 落盘转写为 active（文件内容变化 + 输出唤醒计数）', async () => {
    const result = await run('todo list')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('☀ 已唤醒 1 条 sleep 待办')
    expect(result.text).toContain('早已唤醒')
    expect(result.text).toContain('[唤醒·中等]') // 转写后的徽章
    expect(result.text).not.toContain('远期沉睡') // 未唤醒仍隐藏
    const daily = `${formatDate(new Date())}.md`
    const content = await readFile(join(dWs, daily), 'utf8')
    expect(content).toContain('- [ ] (ml:active medium) 早已唤醒')
    expect(content).toContain('- [ ] (ml:sleep 2099-01-01 low) 远期沉睡') // 远期不动
  })

  it('再次 list：active 不再触发转写（无 ☀ 唤醒行）', async () => {
    const result = await run('todo list')
    expect(result.kind).toBe('success')
    expect(result.text).not.toContain('☀ 已唤醒')
    expect(result.text).toContain('[唤醒·中等]')
  })

  it('d <n>：按序号切换完成态（落盘 + 写入完成日期 + 回显）', async () => {
    const result = await run('todo d 1')
    expect(result.kind).toBe('success')
    const today = formatDate(new Date())
    expect(result.text).toContain(`#1 → 已完成 ☑（完成于 ${today}）`)
    const daily = `${today}.md`
    const content = await readFile(join(dWs, daily), 'utf8')
    expect(content).toContain(`- [x] (ml:active medium done:${today}) 早已唤醒`)
    // list 徽章显示 ✓完成日
    const listed = await run('todo list done')
    expect(listed.kind).toBe('success')
    expect(listed.text).toContain(`[唤醒·中等 ✓${today}]`)
  })

  it('d done 别名 + 再次切换回未完成（完成日期清除）', async () => {
    const result = await run('todo done 1')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('#1 → 未完成 ☐')
    const daily = `${formatDate(new Date())}.md`
    const content = await readFile(join(dWs, daily), 'utf8')
    expect(content).toContain('- [ ] (ml:active medium) 早已唤醒')
    expect(content).not.toContain('done:')
  })

  it('序号超出范围报错', async () => {
    const result = await run('todo d 99')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('序号超出范围')
  })

  it('不同会话的 list 快照互不干扰', async () => {
    const other = await run('todo d 1', 'agent-d-other')
    expect(other.kind).toBe('error')
    expect(other.text).toContain('请先执行 /ml todo list')
  })

  it('d 缺序号/非数字是用法错误', async () => {
    const result = await run('todo d')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('/ml todo d <序号>')
    const bad = await run('todo d abc')
    expect(bad.kind).toBe('error')
  })
})

describe('/ml todo u 撤销（端到端）', () => {
  const host = createFakeHost()
  let command
  let uWs
  let daily

  beforeAll(async () => {
    apply(host.ctx)
    command = host.commands.find((definition) => definition.name === 'ml')
    uWs = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-u-'))
    await host.settings.update('memoryleak', { vault: uWs })
    daily = `${formatDate(new Date())}.md`
    const { insertTodoLine } = await import('../src/core/journal.js')
    const content = insertTodoLine('', '- [ ] (ml:deadline 2026-09-01 urgent) 完成设计稿')
    await writeFile(join(uWs, daily), content)
  })

  afterAll(async () => {
    await rm(uWs, { recursive: true, force: true })
  })

  const run = (rawInput) =>
    command.handler({
      agent: { id: 'agent-u-test', session: { header: { cwd: uWs } } },
      rawInput,
      signal: new AbortController().signal,
    })

  it('未 d 先 u → 提示无可撤销', async () => {
    const result = await run('todo u')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('没有可撤销的操作')
  })

  it('d 1 → u 完整往返：文件回到未完成（完成日期清除），回显已撤销', async () => {
    const toggled = await run('todo list').then(() => run('todo d 1'))
    expect(toggled.kind).toBe('success')
    const today = formatDate(new Date())
    expect((await readFile(join(uWs, daily), 'utf8')).trim()).toContain(`- [x] (ml:deadline 2026-09-01 urgent done:${today}) 完成设计稿`)

    const undone = await run('todo u')
    expect(undone.kind).toBe('success')
    expect(undone.text).toContain('已撤销 #1 → 未完成 ☐')
    expect(undone.text).toContain('完成设计稿')
    const after = (await readFile(join(uWs, daily), 'utf8')).trim()
    expect(after).toContain('- [ ] (ml:deadline 2026-09-01 urgent) 完成设计稿')
    expect(after).not.toContain('done:')
  })

  it('栈空再 u → 报错', async () => {
    const result = await run('todo u')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('没有可撤销的操作')
  })

  it('d 后文件被外部修改 → u 拒绝撤销（行内容校验）', async () => {
    await run('todo d 1') // 切到 [x]
    const content = await readFile(join(uWs, daily), 'utf8')
    await writeFile(join(uWs, daily), content.replace('完成设计稿', '改过的内容'))
    const result = await run('todo u')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('撤销失败')
    expect(result.text).toContain('已变化')
  })

  it('连续 d 多次可连续 u（LIFO）', async () => {
    // 重置文件为未完成
    const content = await readFile(join(uWs, daily), 'utf8')
    await writeFile(join(uWs, daily), content.replace(/- \[x\] \(ml:deadline/, '- [ ] (ml:deadline').replace(/ done:\d{4}-\d{2}-\d{2}/, ''))
    await run('todo list')
    await run('todo d 1') // → done
    await run('todo d 1') // → open
    const undone = await run('todo u') // → done（撤销第二次 d）
    expect(undone.kind).toBe('success')
    expect(undone.text).toContain('已撤销 #1 → 已完成 ☑')
    const today = formatDate(new Date())
    expect((await readFile(join(uWs, daily), 'utf8')).trim()).toContain(`- [x] (ml:deadline 2026-09-01 urgent done:${today}) 改过的内容`)
  })

  it('u 带参数是用法错误', async () => {
    const result = await run('todo u 1')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('不带参数')
  })
})

describe('Vault 与 /ml init（端到端）', () => {
  const signal = () => new AbortController().signal

  it('/ml init：选择目录（引号清理 + 自动创建）→ 保存 + 复制设置文件；init 前其他命令被拦', async () => {
    const vaultWs = await mkdtemp(join(tmpdir(), 'dsh-ml-vault-'))
    try {
      const target = join(vaultWs, 'sub', 'MLeak')
      const vhost = createFakeHost({ 'ml-vault': { custom: `"${target}"` } })
      apply(vhost.ctx)
      const vcommand = vhost.commands.find((definition) => definition.name === 'ml')
      // init 之前：其他命令被严格门控拦下（提示 /ml init），不触发提问
      const blocked = await vcommand.handler({ agent: { id: 'a', session: { header: {} } }, rawInput: ' 记一句', signal: signal() })
      expect(blocked.kind).toBe('error')
      expect(blocked.text).toContain('/ml init')
      expect(vhost.askLog).toHaveLength(0)
      // /ml init：答案带包裹引号 + 指向不存在的子目录 → 清理 + 自动创建
      const result = await vcommand.handler({ agent: { id: 'a', session: { header: {} } }, rawInput: 'init', signal: signal() })
      expect(result.kind).toBe('success')
      expect(result.text).toContain(`Vault 已设置 → ${target}`)
      // 提问形态：无会话 cwd → 无选项，只有路径输入
      expect(vhost.askLog[0].questions.map((q) => q.id)).toEqual(['ml-vault'])
      expect(vhost.askLog[0].questions[0].options).toEqual([])
      // init 之后：原命令可正常执行（写入 vault，而非会话目录）
      const again = await vcommand.handler({ agent: { id: 'a', session: { header: {} } }, rawInput: ' 初始化记录', signal: signal() })
      expect(again.kind).toBe('success')
      expect(again.text).toContain('已记录 →')
      expect(vhost.askLog).toHaveLength(1)
      // 初始化复制：vault 里有 .memoryleak.yaml，且不包含 vault 键本身
      const copied = await readFile(join(target, '.memoryleak.yaml'), 'utf8')
      expect(copied).toContain('extensions:')
      expect(copied).not.toContain('vault:')
      const daily = `${dailyFileName(new Date())}`
      expect(await readFile(join(target, daily), 'utf8')).toContain('初始化记录')
    } finally {
      await rm(vaultWs, { recursive: true, force: true })
    }
  })

  it('/ml init 也可换目录：已设置时提问带「当前」，新答案替换旧值', async () => {
    const vaultWs = await mkdtemp(join(tmpdir(), 'dsh-ml-vault-swap-'))
    try {
      const first = join(vaultWs, 'one')
      const second = join(vaultWs, 'two')
      const vhost = createFakeHost({ 'ml-vault': { custom: second } })
      apply(vhost.ctx)
      await vhost.settings.update('memoryleak', { vault: first })
      await mkdir(first, { recursive: true })
      const vcommand = vhost.commands.find((definition) => definition.name === 'ml')
      const result = await vcommand.handler({ agent: { id: 'a', session: { header: {} } }, rawInput: 'init', signal: signal() })
      expect(result.kind).toBe('success')
      // 提问带「当前」提示（换目录语义），成功输出是新值
      expect(vhost.askLog[0].questions[0].question).toContain(`当前：${first}`)
      expect(result.text).toContain(`Vault 已设置 → ${second}`)
      // 新命令写进新目录
      await vcommand.handler({ agent: { id: 'a', session: { header: {} } }, rawInput: ' 换址记录', signal: signal() })
      expect(await readFile(join(second, `${dailyFileName(new Date())}`), 'utf8')).toContain('换址记录')
    } finally {
      await rm(vaultWs, { recursive: true, force: true })
    }
  })

  it('/ml init 带参数是用法错误', async () => {
    const vhost = createFakeHost({})
    apply(vhost.ctx)
    const vcommand = vhost.commands.find((definition) => definition.name === 'ml')
    const result = await vcommand.handler({ agent: { id: 'a', session: { header: {} } }, rawInput: 'init E:/x', signal: signal() })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('不带参数')
  })

  it('vault 内设置覆盖全局，缺键回退全局/默认', async () => {
    const vaultWs = await mkdtemp(join(tmpdir(), 'dsh-ml-vault2-'))
    try {
      const vhost = createFakeHost({})
      apply(vhost.ctx)
      await vhost.settings.update('memoryleak', { vault: vaultWs, journalMode: 'daily' })
      // vault 文件只覆盖一个键：journalMode=weekly；其余键缺省回退
      await writeFile(join(vaultWs, '.memoryleak.yaml'), 'journalMode: weekly\n')
      const vcommand = vhost.commands.find((definition) => definition.name === 'ml')
      const result = await vcommand.handler({ agent: { id: 'a', session: { header: {} } }, rawInput: ' 周志记录', signal: signal() })
      expect(result.kind).toBe('success')
      expect(result.text).toContain(weeklyFileName(new Date()))
      expect(result.text).toContain('## MemoryLeak · ')
      // vault 文件损坏（非法 YAML 顶层）→ 回退全局，不崩溃
      await writeFile(join(vaultWs, '.memoryleak.yaml'), ':::: not yaml [\n')
      const fallback = await vcommand.handler({ agent: { id: 'a', session: { header: {} } }, rawInput: ' 回退记录', signal: signal() })
      expect(fallback.kind).toBe('success')
      expect(fallback.text).toContain(dailyFileName(new Date()))
    } finally {
      await rm(vaultWs, { recursive: true, force: true })
    }
  })

  it('/ml init 答案指向已存在的文件 → 明确错误，不写入设置', async () => {
    const vaultWs = await mkdtemp(join(tmpdir(), 'dsh-ml-vault3-'))
    try {
      const filePath = join(vaultWs, 'afile.txt')
      await writeFile(filePath, 'x')
      const vhost = createFakeHost({ 'ml-vault': { custom: filePath } })
      apply(vhost.ctx)
      const vcommand = vhost.commands.find((definition) => definition.name === 'ml')
      const result = await vcommand.handler({ agent: { id: 'a', session: { header: {} } }, rawInput: 'init', signal: signal() })
      expect(result.kind).toBe('error')
      expect(result.text).toContain('不是目录')
      // 设置未被保存（仍是默认空 vault），提问只发生一次
      expect(vhost.askLog).toHaveLength(1)
    } finally {
      await rm(vaultWs, { recursive: true, force: true })
    }
  })

  it('无交互界面时：普通命令仍报 /ml init 提示；/ml init 明确报错指向设置页', async () => {
    const vhost = createFakeHost({})
    vhost.ctx.get = () => undefined
    apply(vhost.ctx)
    const vcommand = vhost.commands.find((definition) => definition.name === 'ml')
    const blocked = await vcommand.handler({ agent: { id: 'a', session: { header: {} } }, rawInput: 'todo', signal: signal() })
    expect(blocked.kind).toBe('error')
    expect(blocked.text).toContain('/ml init')
    const init = await vcommand.handler({ agent: { id: 'a', session: { header: {} } }, rawInput: 'init', signal: signal() })
    expect(init.kind).toBe('error')
    expect(init.text).toContain('GUI 设置')
  })

  it('GET /path/complete：列出前缀匹配的子目录（只目录、读失败静默空）', async () => {
    const tree = await mkdtemp(join(tmpdir(), 'dsh-ml-complete-'))
    try {
      await mkdir(join(tree, 'alpha'), { recursive: true })
      await mkdir(join(tree, 'beta-dir'), { recursive: true })
      await writeFile(join(tree, 'gamma.txt'), 'x')
      const vhost = createFakeHost({})
      apply(vhost.ctx)
      const route = vhost.routes.find((entry) => entry.path === '/api/memoryleak/path/complete')
      const call = async (prefix) => invokeRoute(route, 'GET', undefined, `${route.path}?prefix=${encodeURIComponent(prefix)}`)
      // 空匹配：列出全部子目录（文件被排除）
      const all = await call(tree + '/')
      expect(all.status).toBe(200)
      expect(all.body.ok).toBe(true)
      expect(all.body.base).toBe(tree.replace(/[\\/]+$/, ''))
      expect(all.body.entries.map((entry) => entry.name)).toEqual(['alpha', 'beta-dir'])
      // 前缀过滤（大小写不敏感）
      const filtered = await call(tree + '/AL')
      expect(filtered.body.entries.map((entry) => entry.name)).toEqual(['alpha'])
      // 无匹配 → 空（不是 5xx）
      const none = await call(tree + '/zz')
      expect(none.status).toBe(200)
      expect(none.body.entries).toEqual([])
      // 不存在的目录 → 静默空
      const missing = await call(join(tree, 'nope', 'x'))
      expect(missing.status).toBe(200)
      expect(missing.body.entries).toEqual([])
      // Windows 盘符形式规范化：`E:` → base 为 `E:\`（不得双冒号）
      if (process.platform === 'win32') {
        const drive = await call('E:')
        expect(drive.status).toBe(200)
        expect(drive.body.base).toBe('E:\\')
        expect(Array.isArray(drive.body.entries)).toBe(true)
      }
    } finally {
      await rm(tree, { recursive: true, force: true })
    }
  })

  it('POST /pick-directory 路由已移除（目录选择改走官方 workspaces 服务）', async () => {
    const vhost = createFakeHost({})
    apply(vhost.ctx)
    expect(vhost.routes.some((entry) => entry.path === '/api/memoryleak/pick-directory')).toBe(false)
  })
})
