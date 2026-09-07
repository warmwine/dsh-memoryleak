/**
 * MemoryLeak 的真实模型工具（ctx.tools.register 注册）。
 *
 * /ml note、/ml ask、/ml mail 的模型侧能力全部走这里：命令只做本地检查
 * 并把任务交给模型的原生回合（agent.followup），模型在回合里调用这些工
 * 具完成整理 / 问答 / 读信——工具卡片、结果、最终回复都是原生渲染。
 *
 * 确定性守卫全部留在工具里、由代码执行：
 *   - memory_note_write：sanitizeNoteObject（字段白名单 / 条数长度上限 /
 *     表格注入清洗）+ persistNoteResult（零丢失合并 / 表格对齐 / 备份）；
 *   - memory_ask_gather：预算 / 相关度打分 / 去重的资料汇集；
 *   - memory_mail_fetch + memory_mail_commit：两段式读信——下载解析不推
 *     进进度，分析完成由模型显式 commit，进度才前进（分析失败 = 重读同
 *     一批邮件，绝不漏信）。
 *
 * 定义是**普通对象**（tools.register 的注册契约：name / description /
 * parameters(JSON Schema) / output { schema, render } / execute），不依赖
 * 任何宿主包。deps 是测试 seam。
 *
 * @module dsh-memoryleak/tools
 */
import { rm } from 'node:fs/promises'
import { resolveMemoryleakSettings } from './settings-schema.js'
import { resolveEffectiveSettings } from './vault.js'
import { readVaultMailStateEnd } from './vault.js'
import {
  isMailConfigured,
  mailWindowLabel,
  resolveMailWindow,
  formatMailMoment,
  fitMailEmailsToBudget,
  sanitizeMailTodoItems,
} from './core/mail.js'
import {
  MOMENTO_DIR,
  readKnownState,
  readSkillFile,
  persistNoteResult,
} from './note.js'
import { gatherAskMaterials } from './ask.js'
import {
  downloadMailWindowToTemp,
  parseEmailFiles,
  makeTempDirUnderTmpdir,
  sweepStaleTempDirs,
  writeMailState,
} from './mail.js'
import {
  STRUCTURED_FIELD_RULES,
  resolveStructuredTargets,
  sanitizeNoteObject,
} from './core/note.js'
import { readVaultNoteConfig } from './vault.js'

/* ---------------- 公共小件 ---------------- */

/** 今天日期（yyyy-mm-dd）。 */
function todayIso() {
  const at = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** vault 未设置时的统一报错值。 */
const VAULT_UNSET = () => ({ error: '尚未设置 Vault 目录——请先执行 /ml init（或在 GUI 设置 → MemoryLeak 填写）。' })

/**
 * 解析工具执行环境：全局设置 → vault 就绪 → 生效设置（vault 覆盖层）。
 * 返回 { error } 表示环境不满足（模型可见）。
 */
async function resolveToolEnv(scope) {
  const globalSettings = resolveMemoryleakSettings(scope.get())
  if (globalSettings.vault === '') return { error: VAULT_UNSET().error }
  const settings = await resolveEffectiveSettings(globalSettings)
  return { vaultDir: globalSettings.vault, settings }
}

/**
 * 构造工具定义数组（不注册；注册见 registerMemoryleakTools）。
 *
 * @param {{ scope: { get(): object }, deps?: object }} input
 *   deps（全部可选，测试注入）：makeTempDir / sweep / now / parseEml /
 *   createClient / gather / download —— 覆盖对应默认实现。
 * @returns {Array<object>} registry-ready 工具定义
 */
export function createMemoryleakToolDefinitions({ scope, deps = {} }) {
  const makeTempDir = deps.makeTempDir ?? makeTempDirUnderTmpdir
  const sweep = deps.sweep ?? sweepStaleTempDirs
  const now = deps.now ?? (() => new Date())
  /** 每个会话待提交的读信窗口（memory_mail_fetch 写入、memory_mail_commit 消费）。 */
  const pendingMailWindow = new Map()
  /** agent → 稳定键。 */
  const agentKeyOf = (exec) => {
    const id = exec?.agent !== null && typeof exec?.agent === 'object' && typeof exec.agent.id === 'string' ? exec.agent.id : '_anonymous'
    return id
  }

  return [
    /* ---------- /ml note · 第一步：存量与约定 ---------- */
    {
      name: 'memory_note_context',
      description:
        '获取 MemoryLeak 知识库（Vault）的当前状态：已有结构化登记行、已有知识条目标题、记录约定（noteSkill）与结构化字段说明。调用 memory_note_write 提交整理结果之前必须先调用本工具，以便增量增补而不是重建。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            date: { type: 'string' },
            known: { type: 'string' },
            skill: { type: 'string' },
            fieldRules: { type: 'string' },
          },
          required: ['date', 'known', 'fieldRules'],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.error !== undefined ? value.error : [value.known, value.skill, value.fieldRules].filter((part) => typeof part === 'string' && part !== '').join('\n\n'),
          },
        ],
      },
      async execute() {
        const env = await resolveToolEnv(scope)
        if (env.error !== undefined) return { date: todayIso(), known: env.error, fieldRules: '' }
        const { vaultDir } = env
        const noteConfig = await readVaultNoteConfig(vaultDir)
        const { targets, errors } = resolveStructuredTargets(noteConfig.noteStructured)
        if (errors.length > 0) {
          return { date: todayIso(), known: `noteStructured 配置有误：\n${errors.join('\n')}`, fieldRules: '' }
        }
        const known = await readKnownState(vaultDir, targets)
        const skill = await readSkillFile(vaultDir, noteConfig.noteSkill)
        // 渲染与旧版 buildNotePrompt 的存量段完全同构（行为一致性）
        const knownParts = []
        const knownStructured = Object.entries(known.structured).filter(([, rows]) => rows.length > 0)
        for (const [kind, rows] of knownStructured) knownParts.push(`${kind} 已有 ${rows.length} 行：`, JSON.stringify(rows), '')
        if (known.titles.length > 0) {
          knownParts.push(`${MOMENTO_DIR} 已有知识条目标题：${known.titles.map((title) => `「${title}」`).join('、')}`)
        }
        if (knownParts.length === 0) knownParts.push('Vault 还是空的：没有任何已登记内容。这是第一次整理，可以全量登记对话中出现的信息。')
        else knownParts.push('增量增补规则：structured 只输出需要新增或修改的行（修改 = 主键不变、只填有变化的字段，留空 = 保留原值；无变化的行不要重复输出）；momento 只在确有新知识时输出，对已有条目的补充沿用相同标题（会以「更新」分节追加）。')
        const fieldRules = [
          'structured 字段规范：',
          STRUCTURED_FIELD_RULES.databases,
          STRUCTURED_FIELD_RULES.servers,
          STRUCTURED_FIELD_RULES.credentials,
          STRUCTURED_FIELD_RULES.glossary,
        ].join('\n')
        const skillWarning = skill.warning !== null ? `\n（注意：${skill.warning}）` : ''
        return {
          date: todayIso(),
          known: knownParts.join('\n'),
          fieldRules,
          ...(skill.text !== '' || skillWarning !== '' ? { skill: `${skill.text !== '' ? `本 Vault 的记录约定（note skill）：\n${skill.text}` : ''}${skillWarning}`.trim() } : {}),
        }
      },
    },

    /* ---------- /ml note · 第二步：守卫写盘 ---------- */
    {
      name: 'memory_note_write',
      description:
        '把整理结果写入 MemoryLeak 知识库（Vault）：工作记录进日志 ## NOTE、知识条目进 MOMENTO/、结构化登记按主键零丢失合并。参数即整理协议；所有字段清洗与合并守卫由代码执行，违规写入会被明确拒绝（可修正参数后重试）。',
      parameters: {
        type: 'object',
        required: ['summary'],
        properties: {
          summary: { type: 'string', description: '本段工作的一句话总结（不超过 80 字）。' },
          note: { type: 'array', items: { type: 'string' }, description: '工作流水条目（3–8 条，一句话一条；没有给空数组）。' },
          momento: {
            type: 'object',
            properties: {
              entries: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['title', 'body'],
                  properties: {
                    title: { type: 'string', description: '知识点标题（简短稳定，作为文件名）。' },
                    body: { type: 'string', description: '知识点正文（markdown）。' },
                    tags: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
            description: '值得长期保留的知识条目（没有给空对象/空数组）。',
          },
          structured: {
            type: 'object',
            additionalProperties: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: { type: 'string' },
              },
            },
            description: '结构化登记：databases / servers / credentials / glossary 各一个数组，行为主键 + 字段（只登记对话中真实出现的信息）。',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string' },
            written: { type: 'string' },
            warnings: { type: 'string' },
          },
          required: ['summary', 'written'],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: [`${value.summary}`, value.written, value.warnings].filter((part) => typeof part === 'string' && part !== '').join('\n'),
          },
        ],
      },
      async execute(args) {
        const env = await resolveToolEnv(scope)
        if (env.error !== undefined) return { summary: '未执行', written: env.error }
        const { vaultDir, settings } = env
        const noteConfig = await readVaultNoteConfig(vaultDir)
        const { targets } = resolveStructuredTargets(noteConfig.noteStructured)
        // 与旁路路径同一套清洗（白名单 / 上限 / 注入清洗）；不合规抛 NoteParseError，
        // 执行器会以错误结果回给模型——可修正后重试。
        const parsed = sanitizeNoteObject(args, targets)
        const persisted = await persistNoteResult({ vaultDir, settings, now, parsed, targets, backup: noteConfig.noteBackup === true })
        const written = [
          `工作记录 → ${persisted.noteFile} ## NOTE${persisted.created ? '（新建文件）' : ''}`,
          persisted.momentoFiles.length > 0 ? `知识库 → ${persisted.momentoFiles.join('、')}` : '',
          persisted.indexFile !== null ? `索引 → ${persisted.indexFile}` : '',
        ].filter((line) => line !== '')
        const warnings = [...parsed.warnings, ...persisted.warnings]
        return {
          summary: persisted.summary,
          written: written.join('\n'),
          ...(warnings.length > 0 ? { warnings: `注意：\n${warnings.map((warning) => `- ${warning}`).join('\n')}` } : {}),
        }
      },
    },

    /* ---------- /ml ask · 资料汇集 ---------- */
    {
      name: 'memory_ask_gather',
      description:
        '从 MemoryLeak 知识库（Vault）汇集与问题相关的资料：MOMENTO 索引、结构化登记、知识条目（按关键词相关度排序）、近期日志，预算内截断。回答 Vault 相关问题前先调用本工具。',
      parameters: {
        type: 'object',
        required: ['question'],
        properties: {
          question: { type: 'string', description: '用户的问题（原文即可，用于关键词相关度排序）。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            included: { type: 'number' },
            total: { type: 'number' },
            materials: { type: 'string' },
          },
          required: ['included', 'total', 'materials'],
        },
        render: (_args, value) => [{ type: 'text', text: value.materials }],
      },
      async execute(args) {
        const env = await resolveToolEnv(scope)
        if (env.error !== undefined) return { included: 0, total: 0, materials: env.error }
        const { vaultDir } = env
        const noteConfig = await readVaultNoteConfig(vaultDir)
        const { targets } = resolveStructuredTargets(noteConfig.noteStructured)
        const { materials, included, total } = await gatherAskMaterials(vaultDir, targets, String(args.question ?? ''))
        if (total === 0) {
          return {
            included: 0,
            total: 0,
            materials: 'Vault 里还没有可引用的内容（MOMENTO/ 知识文件、结构化登记、日志均为空）。请如实告诉用户：先 /ml note 整理一段对话，或直接把笔记写进 Vault 再问。',
          }
        }
        // 渲染与旧版 buildAskPrompt 的资料块完全同构
        const blocks = materials.map((item) => `### ${item.path}\n${item.content}`)
        const materialsText = [
          `─── 资料开始（${included}/${total} 个文件，按相关度与优先级选取）───`,
          '',
          blocks.join('\n\n'),
          '',
          '─── 资料结束 ───',
          '',
          '回答规则：只依据上面的资料回答；资料里没有的就直说笔记里没有，不要编造；引用事实时标注来源文件名；用中文 markdown 结构化（先结论后依据）；资料有过时或矛盾之处如实指出。',
        ].join('\n')
        return { included, total, materials: materialsText }
      },
    },

    /* ---------- /ml mail · 第一步：下载解析（不推进进度） ---------- */
    {
      name: 'memory_mail_fetch',
      description:
        '从已配置的工作邮箱增量下载「上次读完 → 现在」的新邮件：IMAP 下载到系统临时目录、纯代码解析为纯文本（附件不下载），立即清理临时目录。本工具不推进读信进度——分析完成后必须调用 memory_mail_commit。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            windowLabel: { type: 'string' },
            emails: { type: 'string' },
          },
          required: ['windowLabel', 'emails'],
        },
        render: (_args, value) => [{ type: 'text', text: [value.windowLabel, value.emails].filter((part) => typeof part === 'string' && part !== '').join('\n') }],
      },
      async execute(_args, exec) {
        const env = await resolveToolEnv(scope)
        if (env.error !== undefined) return { windowLabel: '未执行', emails: env.error }
        const { vaultDir, settings } = env
        if (!isMailConfigured(settings)) {
          return { windowLabel: '未执行', emails: '邮箱还没配置——请让用户先执行 /ml mail setup 或在 GUI 设置 → MemoryLeak 填写邮箱配置。' }
        }
        const lastEnd = await readVaultMailStateEnd(vaultDir)
        const window = resolveMailWindow({ lastReadEnd: lastEnd, now })
        const label = mailWindowLabel(window)
        await sweep()
        const dir = await makeTempDir()
        try {
          const downloaded = await downloadMailWindowToTemp({ settings, window, dir }, deps)
          const totalInWindow = downloaded.emails.length + downloaded.dropped
          if (totalInWindow === 0) {
            await writeMailState(vaultDir, window.end) // 空窗口直接推进（与旧版一致：无可分析内容）
            pendingMailWindow.delete(agentKeyOf(exec))
            return { windowLabel: `窗口 ${label}`, emails: `窗口内没有新邮件。读信进度已推进，请用一句话告知用户「没有新邮件」。` }
          }
          const parsed = await parseEmailFiles(dir, downloaded.emails, deps)
          const fitted = fitMailEmailsToBudget(parsed)
          // 记录待提交窗口（commit 才推进进度；fetch 失败/未 commit = 下次重读同一批）
          pendingMailWindow.set(agentKeyOf(exec), { end: window.end, label })
          // 渲染与旧版 buildMailReadPrompt 的邮件分段完全同构
          const blocks = fitted.emails.map((mail, position) => {
            const index = typeof mail.index === 'number' ? mail.index : position + 1
            return [`### 邮件 ${index} · ${mail.date}`, `发件人：${mail.from}`, `主题：${mail.subject}`, '正文：', mail.text].join('\n')
          })
          const notes = []
          if (downloaded.dropped > 0) notes.push(`注意：原窗口内共有 ${totalInWindow} 封，因单次上限只带入了最新的 ${fitted.emails.length} 封（丢的是最旧的）。`)
          if (fitted.dropped > 0) notes.push(`注意：因总预算又丢弃了最旧的 ${fitted.dropped} 封。`)
          notes.push('附件未下载，正文为纯文本提取（富文本排版已丢失）。')
          const emailsText = [
            `─── 邮件开始（${fitted.emails.length} 封，窗口：${label}；目录 ${settings.mailFolder}）───`,
            '',
            blocks.join('\n\n'),
            '',
            '─── 邮件结束 ───',
            '',
            ...notes,
            '',
            `分析要求：通读后向用户输出 markdown 阅读报告——只有两段：**总评**（一句话整体重要程度与主题）+ **重要事项**（唯一的清单，编号列表 1. 2. 3. …：把所有重要的事务与信息都列上——需要用户动手处理的、需要跟进的、以及值得知道的重要信息；需要处理的条目标注期限（明说才是 yyyy-mm-dd）与来源发件人，按时间或重要性排序）。「重要事项」务必用编号列表。只依据邮件内容，不要编造。全部报告完成后调用 memory_mail_commit 推进读信进度，并通过它的 todos 参数把「重要事项」清单按编号顺序原样提交（每项 {text, due, from, subject}，due 只填报告里明说的 yyyy-mm-dd 期限；清单为空就给空数组）——用户会用 /ml mail todo <编号> 把任意一条转成待办。`,
          ].join('\n')
          return { windowLabel: `窗口 ${label}`, emails: emailsText }
        } finally {
          // 铁律：邮件原文只存在于临时目录——正文已解析进结果，目录立即删除
          await rm(dir, { recursive: true, force: true }).catch(() => {})
        }
      },
    },

    /* ---------- /ml mail · 第二步：推进进度 + 记录重要事项清单 ---------- */
    {
      name: 'memory_mail_commit',
      description:
        '推进 /ml mail 的读信进度到本次已分析的窗口末端，并把阅读报告「重要事项」清单存入 Vault 供 /ml mail todo <序号> 转成待办。必须在 memory_mail_fetch 的邮件全部分析完成、报告输出之后调用（todos 按报告「重要事项」编号顺序提交）；调用后下次 read 从这里继续（漏调用 = 下次重读同一批邮件，安全方向的失败）。',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '阅读报告「重要事项」清单，与报告编号顺序一致（报告里没有重要事项就给空数组）。每项 {text, due, from, subject}。',
            items: {
              type: 'object',
              required: ['text'],
              properties: {
                text: { type: 'string', description: '重要事项内容（与报告一致）。' },
                due: { type: 'string', description: '期限 yyyy-mm-dd（报告未标注给空串）。' },
                from: { type: 'string', description: '相关发件人（可空串）。' },
                subject: { type: 'string', description: '相关邮件主题（可空串）。' },
              },
            },
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            committedUntil: { type: 'string' },
          },
          required: ['committedUntil'],
        },
        render: (_args, value) => [{ type: 'text', text: value.committedUntil }],
      },
      async execute(args, exec) {
        const env = await resolveToolEnv(scope)
        if (env.error !== undefined) return { committedUntil: env.error }
        const { vaultDir } = env
        const key = agentKeyOf(exec)
        const pending = pendingMailWindow.get(key)
        if (pending === undefined) {
          return { committedUntil: '没有待提交的读信窗口——先调用 memory_mail_fetch 获取邮件。' }
        }
        // 待办清单：提交了就清洗存盘（空数组 = 本批无待办，覆盖旧清单）；
        // 没提交就不动旧清单（模型忘传不抹掉上一次的可寻址列表）。
        let todos = null
        let todosNote = ''
        if (args !== null && typeof args === 'object' && 'todos' in args) {
          const { items, warnings } = sanitizeMailTodoItems(args.todos)
          todos = items
          todosNote = items.length > 0 ? `重要事项清单已记录 ${items.length} 条（/ml mail todo <序号> 可把任意一条转成待办）。` : '本批没有重要事项，已清空引用清单。'
          if (warnings.length > 0) todosNote += '\n' + warnings.map((warning) => `- ${warning}`).join('\n')
        }
        await writeMailState(vaultDir, pending.end, todos)
        pendingMailWindow.delete(key)
        return { committedUntil: `读信进度已推进到 ${formatMailMoment(pending.end)}（窗口：${pending.label}）。下次 read 从这里继续。${todosNote === '' ? '' : '\n' + todosNote}` }
      },
    },
  ]
}

/**
 * 把工具注册进宿主工具注册表（挂在调用方 Fiber 上，随插件停用回收）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ scope: { get(): object }, deps?: object }} input
 * @returns {() => void} 反注册函数
 */
export function registerMemoryleakTools(ctx, { scope, deps = {} }) {
  const definitions = createMemoryleakToolDefinitions({ scope, deps })
  const disposers = definitions.map((definition) => ctx.tools.register(definition))
  return () => {
    for (const dispose of disposers) dispose()
  }
}
