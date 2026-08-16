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
  const ctx = {
    settings,
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
  return { ctx, routes, commands, effects, settings, askLog }
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
    expect(command.input.hint).toBe('<文本> / todo add <文本> / todo list [all|open|done] [关键词]')
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
    await host.settings.replace('memoryleak', { journalMode: 'weekly' })
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
    const result = await command.handler({
      agent: { session: { header: { cwd: join(journalWs, 'gone') } } },
      rawInput: 'x',
      signal: new AbortController().signal,
    })
    expect(result.kind).toBe('error')
    expect(result.text).toMatch(/日志写入失败|工作区/)
  })
})

describe('/ml todo add（交互添加 + sleep 过滤，端到端）', () => {
  const answers = { type: 'deadline', prio: 'urgent', date: { custom: '2026-09-01' } }
  const host = createFakeHost(answers)
  let command
  let todoWs

  beforeAll(async () => {
    apply(host.ctx)
    command = host.commands.find((definition) => definition.name === 'ml')
    todoWs = await mkdtemp(join(tmpdir(), 'dsh-memoryleak-todo-'))
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
    // 提问形态：第一轮两个固定选项问题，第二轮日期自由输入
    expect(host.askLog[0].questions.map((q) => q.id)).toEqual(['type', 'prio'])
    expect(host.askLog[0].questions[0].options).toHaveLength(3)
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
    const anytimeHost = createFakeHost({ type: 'anytime', prio: 'medium' })
    apply(anytimeHost.ctx)
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
    const badHost = createFakeHost({ type: '不存在的类型', prio: 'urgent' })
    apply(badHost.ctx)
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
    const badDateHost = createFakeHost({ type: 'deadline', prio: 'low', date: { custom: '明天' } })
    apply(badDateHost.ctx)
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
    expect(result.text).toContain('/ml todo add <待办内容>')
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

  it('d <n>：按序号切换完成态（落盘 + 回显）', async () => {
    const result = await run('todo d 1')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('#1 → 已完成 ☑')
    const daily = `${formatDate(new Date())}.md`
    const content = await readFile(join(dWs, daily), 'utf8')
    expect(content).toContain('- [x] (ml:active medium) 早已唤醒')
  })

  it('d done 别名 + 再次切换回未完成', async () => {
    const result = await run('todo done 1')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('#1 → 未完成 ☐')
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
