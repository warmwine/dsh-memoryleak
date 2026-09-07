/**
 * core/mail 纯逻辑测试：窗口、配置判定、筛选、预算、prompt、解析、渲染
 * 与流式 digest —— 无 fs、无网络、无 LLM。
 */
import { describe, expect, it } from 'vitest'
import {
  MAIL_BODY_CLIP,
  MailParseError,
  buildMailReadPrompt,
  createMailDigestStream,
  fitMailEmailsToBudget,
  formatMailMoment,
  hasTrustedCertificate,
  isMailConfigured,
  mailWindowLabel,
  mergeTrustedCertificates,
  parseMailReadJson,
  parseMailStateEnd,
  renderMailReadMarkdown,
  resolveMailWindow,
  sanitizeMailTodoItems,
  selectMailEmails,
} from '../src/core/mail.js'

const at = (iso) => new Date(iso)

describe('isMailConfigured（配置判定）', () => {
  it('主机 + 账号 + 对应登陆方式的凭证齐全才算配置', () => {
    expect(isMailConfigured({ mailAuth: 'password', mailHost: 'imap.x.com', mailUser: 'a@b.c', mailPassword: 'pw' })).toBe(true)
    expect(isMailConfigured({ mailAuth: 'xoauth2', mailHost: 'imap.x.com', mailUser: 'a@b.c', mailToken: 'tok' })).toBe(true)
    expect(isMailConfigured({ mailAuth: 'password', mailHost: 'imap.x.com', mailUser: 'a@b.c', mailPassword: '' })).toBe(false)
    // xoauth2 时不看密码，看 token
    expect(isMailConfigured({ mailAuth: 'xoauth2', mailHost: 'imap.x.com', mailUser: 'a@b.c', mailPassword: 'pw', mailToken: '' })).toBe(false)
    expect(isMailConfigured({ mailHost: '', mailUser: 'a@b.c', mailPassword: 'pw' })).toBe(false)
    expect(isMailConfigured(undefined)).toBe(false)
  })
})

describe('sanitizeMailTodoItems（memory_mail_commit 提交的待办清单清洗）', () => {
  it('合法条目清洗通过：期限白名单、来源限长', () => {
    const { items, warnings } = sanitizeMailTodoItems([
      { text: '回复周报', due: '2026-09-05', from: 'boss@b.c', subject: '周报' },
      { text: '顺手看看', due: '下周三', from: '', subject: '' },
    ])
    expect(warnings).toEqual([])
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({ text: '回复周报', due: '2026-09-05', from: 'boss@b.c', subject: '周报' })
    // 非法期限清成空串
    expect(items[1].due).toBe('')
  })

  it('缺 text 丢弃并告警；非对象行忽略', () => {
    const { items, warnings } = sanitizeMailTodoItems([{ text: '  ' }, '垃圾', null, { text: '有效' }])
    expect(items).toHaveLength(1)
    expect(items[0].text).toBe('有效')
    expect(warnings.some((item) => item.includes('缺 text'))).toBe(true)
  })

  it('undefined/null 视为未提交（无告警）；非数组给告警', () => {
    expect(sanitizeMailTodoItems(undefined)).toEqual({ items: [], warnings: [] })
    expect(sanitizeMailTodoItems(null)).toEqual({ items: [], warnings: [] })
    const { warnings } = sanitizeMailTodoItems('不是数组')
    expect(warnings).toHaveLength(1)
  })

  it('条数上限与超长清洗', () => {
    const { items, warnings } = sanitizeMailTodoItems(
      Array.from({ length: 35 }, (_, index) => ({ text: `待办${index}` + '长'.repeat(220) })),
    )
    expect(items).toHaveLength(30)
    expect(items[0].text.length).toBeLessThanOrEqual(200)
    expect(warnings.some((item) => item.includes('上限'))).toBe(true)
  })
})

describe('信任证书合并与判定（自建服务器内部/自签证书）', () => {
  const PEM_A = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----'
  const PEM_B = '-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----'

  it('mergeTrustedCertificates：空输入直通；同块去重；不同块都保留', () => {
    expect(mergeTrustedCertificates('', PEM_A)).toBe(`${PEM_A}\n`)
    expect(mergeTrustedCertificates(undefined, PEM_A)).toBe(`${PEM_A}\n`)
    expect(mergeTrustedCertificates(PEM_A, PEM_A)).toBe(`${PEM_A}\n`)
    expect(mergeTrustedCertificates(PEM_A, PEM_B)).toBe(`${PEM_A}\n${PEM_B}\n`)
    // 内容相同但换行风格不同的块视为同一张
    expect(mergeTrustedCertificates(PEM_A, '-----BEGIN CERTIFICATE----- AAA -----END CERTIFICATE-----')).toBe(`${PEM_A}\n`)
  })

  it('hasTrustedCertificate：按内容判定；空目标视为已包含', () => {
    expect(hasTrustedCertificate(PEM_A, PEM_A)).toBe(true)
    expect(hasTrustedCertificate(`${PEM_A}\n${PEM_B}`, PEM_B)).toBe(true)
    expect(hasTrustedCertificate(PEM_A, PEM_B)).toBe(false)
    expect(hasTrustedCertificate(PEM_A, '')).toBe(true)
  })
})

describe('读信窗口', () => {
  it('有合法 lastReadEnd → 增量窗口 (lastReadEnd, now]', () => {
    const now = at('2026-08-18T15:00:00')
    // 用绝对时刻差构造，避免测试依赖运行时区
    const lastEnd = new Date(now.getTime() - 5.5 * 3600 * 1000)
    const window = resolveMailWindow({ lastReadEnd: lastEnd.toISOString(), now: () => now })
    expect(window.mode).toBe('incremental')
    expect(window.end.getTime()).toBe(now.getTime())
    expect(window.start.getTime()).toBe(lastEnd.getTime())
    expect(mailWindowLabel(window)).toContain('上次读完')
  })

  it('没有状态 → 当天 00:00（默认当天）', () => {
    const now = at('2026-08-18T15:00:00')
    const window = resolveMailWindow({ lastReadEnd: null, now: () => now })
    expect(window.mode).toBe('today')
    expect(window.start.getFullYear()).toBe(2026)
    expect(window.start.getHours()).toBe(0)
    expect(mailWindowLabel(window)).toContain('今天 00:00')
  })

  it('状态非法 / 未来时刻 → 回退当天（防时钟回拨与手改坏）', () => {
    const now = at('2026-08-18T15:00:00')
    for (const bad of ['', 'not-a-date', '2026-08-19T00:00:00']) {
      expect(resolveMailWindow({ lastReadEnd: bad, now: () => now }).mode).toBe('today')
    }
    expect(parseMailStateEnd(undefined)).toBe(null)
    expect(parseMailStateEnd('2026-08-18T09:30:00.000Z') instanceof Date).toBe(true)
  })

  it('formatMailMoment 本地时间补零', () => {
    expect(formatMailMoment(at('2026-08-18T09:05:00'))).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

describe('selectMailEmails（窗口过滤 + 截断保最新）', () => {
  const start = at('2026-08-18T00:00:00')
  const end = at('2026-08-18T23:59:59')

  it('只留 (start, end]；升序排列', () => {
    const { kept, dropped } = selectMailEmails(
      [
        { id: 1, date: at('2026-08-18T08:00:00') },
        { id: 2, date: at('2026-08-17T23:59:59') }, // start 边界外（含当天 00:00 整点 = 上一轮的 end）
        { id: 3, date: at('2026-08-18T00:00:00') }, // 等于 start → 排除（开区间）
        { id: 4, date: at('2026-08-19T00:00:00') }, // end 之后
        { id: 5, date: at('2026-08-18T12:00:00') },
      ],
      { start, end },
      50,
    )
    expect(kept.map((item) => item.id)).toEqual([1, 5])
    expect(dropped).toBe(0)
  })

  it('超上限保留最新、丢最旧（截断计数如实）', () => {
    const candidates = [10, 11, 12, 13, 14].map((day) => ({ id: day - 9, date: at(`2026-08-${day}T08:00:00`) }))
    const { kept, dropped } = selectMailEmails(candidates, { start: at('2026-08-10T00:00:00'), end: at('2026-08-20T00:00:00') }, 3)
    expect(kept.map((item) => item.id)).toEqual([3, 4, 5])
    expect(dropped).toBe(2)
  })
})

describe('fitMailEmailsToBudget（预算自适应）', () => {
  it('预算内不动正文', () => {
    const emails = [{ text: 'a'.repeat(100) }, { text: 'b'.repeat(200) }]
    const fitted = fitMailEmailsToBudget(emails, 5000)
    expect(fitted.dropped).toBe(0)
    expect(fitted.emails[0].text).toHaveLength(100)
    expect(fitted.emails[1].text).toHaveLength(200)
  })

  it('超预算先对半降截断长度', () => {
    const emails = [{ text: 'a'.repeat(4000) }, { text: 'b'.repeat(4000) }]
    const fitted = fitMailEmailsToBudget(emails, 4000, 4000, 300)
    expect(fitted.dropped).toBe(0)
    expect(fitted.perEmail).toBe(2000)
    expect(fitted.emails[0].text.endsWith('…')).toBe(true)
  })

  it('降到底仍超 → 丢最旧保最新', () => {
    const emails = [{ text: 'a'.repeat(5000) }, { text: 'b'.repeat(5000) }, { text: 'c'.repeat(5000) }]
    // 4000→12000 超；2000 低于 floor(2500) 直接到底；2×2500=5000 恰好塞下 → 丢最旧 1 封
    const fitted = fitMailEmailsToBudget(emails, 5000, 4000, 2500)
    expect(fitted.dropped).toBe(1)
    expect(fitted.emails.map((item) => item.text[0])).toEqual(['b', 'c'])
  })

  it('单封超预算也会被截断到预算内（极端不丢光）', () => {
    const emails = [{ text: 'x'.repeat(9000) }]
    const fitted = fitMailEmailsToBudget(emails, 4000, 4000, 300)
    expect(fitted.emails).toHaveLength(1)
    expect(fitted.emails[0].text.length).toBeLessThanOrEqual(4000)
  })

  it('空列表直通', () => {
    expect(fitMailEmailsToBudget([])).toEqual({ emails: [], dropped: 0, perEmail: MAIL_BODY_CLIP })
  })
})

describe('buildMailReadPrompt', () => {
  it('邮件按时间序分段，含窗口与目录信息、严格 JSON 协议', () => {
    const prompt = buildMailReadPrompt({
      emails: [
        { index: 1, date: '2026-08-18 09:00', from: 'Boss <boss@b.c>', subject: '周报', text: '请交周报' },
        { index: 2, date: '2026-08-18 11:00', from: 'pm@b.c', subject: '新规范', text: '下周生效' },
      ],
      windowLabel: '上次读完（2026-08-18 09:30）→ 现在',
      date: '2026-08-18',
      folder: 'INBOX',
    })
    expect(prompt).toContain('### 邮件 1 · 2026-08-18 09:00')
    expect(prompt).toContain('发件人：Boss <boss@b.c>')
    expect(prompt).toContain('主题：周报')
    expect(prompt).toContain('窗口：上次读完（2026-08-18 09:30）→ 现在')
    expect(prompt).toContain('"todos"')
    expect(prompt).toContain('"reads"')
    expect(prompt).toContain('目录 INBOX')
    expect(prompt).toContain('今天：2026-08-18')
  })

  it('有丢弃时如实告知', () => {
    const prompt = buildMailReadPrompt({ emails: [{ date: 'd', from: 'f', subject: 's', text: 't' }], windowLabel: 'w', date: '2026-08-18', dropped: 3 })
    expect(prompt).toContain('只带入了最新的 1 封')
  })
})

describe('parseMailReadJson（严格清洗）', () => {
  const good = {
    summary: ' 两件事 ',
    events: ['服务器周三迁移', ''],
    todos: [
      { text: '回复周报', due: '2026-08-20', from: 'boss@b.c', subject: '周报' },
      { text: '', from: 'x', subject: 'y' },
      { text: '带坏 due 的', due: '下周三', from: '', subject: '' },
    ],
    reads: [{ text: '新规范', from: 'pm@b.c', subject: '规范', note: '下周生效' }],
  }

  it('容错剥 fence；字段清洗与白名单', () => {
    const parsed = parseMailReadJson('```json\n' + JSON.stringify(good) + '\n```')
    expect(parsed.summary).toBe('两件事')
    expect(parsed.events).toEqual(['服务器周三迁移'])
    expect(parsed.todos).toHaveLength(2)
    expect(parsed.todos[0]).toEqual({ text: '回复周报', due: '2026-08-20', from: 'boss@b.c', subject: '周报' })
    // 非法 due 清成空串
    expect(parsed.todos[1].due).toBe('')
    expect(parsed.reads[0].note).toBe('下周生效')
    // 缺 text 的条目逐条告警而非整体失败
    expect(parsed.warnings.some((item) => item.includes('缺 text'))).toBe(true)
  })

  it('条数与长度上限生效', () => {
    const padded = {
      summary: 'x'.repeat(400),
      events: Array.from({ length: 30 }, (_, index) => `事件${index}`),
      todos: Array.from({ length: 40 }, (_, index) => ({ text: `待办${index}` })),
      reads: [],
    }
    const parsed = parseMailReadJson(JSON.stringify(padded))
    expect(parsed.summary.length).toBeLessThanOrEqual(300)
    expect(parsed.events).toHaveLength(20)
    expect(parsed.todos).toHaveLength(30)
    expect(parsed.warnings.some((item) => item.includes('上限'))).toBe(true)
  })

  it('非法输入：空 / 非 JSON / 非对象 / 全空内容', () => {
    expect(() => parseMailReadJson('')).toThrow(MailParseError)
    expect(() => parseMailReadJson('这不是 JSON')).toThrow(MailParseError)
    expect(() => parseMailReadJson('[]')).toThrow(MailParseError)
    expect(() => parseMailReadJson('{"summary":"","events":[],"todos":[],"reads":[]}')).toThrow(MailParseError)
  })

  it('杂文字包裹的 JSON 也能截取', () => {
    const parsed = parseMailReadJson('好的，以下是结果：\n{"summary":"ok","events":[],"todos":[],"reads":[]}')
    expect(parsed.summary).toBe('ok')
  })
})

describe('renderMailReadMarkdown', () => {
  it('总评 / 重要事件 / 待办 / 待阅 分段；due 与来源附加', () => {
    const markdown = renderMailReadMarkdown({
      summary: '两件事',
      events: ['服务器迁移'],
      todos: [{ text: '回复周报', due: '2026-08-20', from: 'boss@b.c', subject: '周报' }],
      reads: [{ text: '新规范', from: 'pm@b.c', subject: '规范', note: '下周生效' }],
    })
    expect(markdown).toContain('**总评** 两件事')
    expect(markdown).toContain('**重要事件**')
    expect(markdown).toContain('- 回复周报（期限 2026-08-20） —— boss@b.c · 周报')
    expect(markdown).toContain('**待阅（值得一看）**')
    expect(markdown).toContain('- 新规范 —— 下周生效（pm@b.c · 规范）')
  })

  it('空段不渲染；无 due / 无来源不残留装饰', () => {
    const markdown = renderMailReadMarkdown({ summary: '', events: [], todos: [{ text: '干活', due: '', from: '', subject: '' }], reads: [] })
    expect(markdown).toBe('**待办（需要处理）**\n- 干活')
  })
})

describe('createMailDigestStream（前缀补全式增量摘要）', () => {
  it('边流边出 markdown 分段；未完成的结构不产出也不抛错', () => {
    const digest = createMailDigestStream()
    // 半截 summary：补全后 summary 为空 → 无产出
    expect(digest.push('{"summary": ')).toBe('')
    expect(digest.push('"两件事", ')).toContain('**总评** 两件事')
    // events 完成一条即出一条
    const eventsPiece = digest.push('"events": ["服务器迁移"], ')
    expect(eventsPiece).toContain('**重要事件**')
    expect(eventsPiece).toContain('- 服务器迁移')
    // todos 数组进行中（末项缺值）→ 补全解析出前一条
    const todosPiece = digest.push('"todos": [{"text": "回复周报", "due": "2026-08-20", "from": "", "subject": ""}, {')
    expect(todosPiece).toContain('**待办（需要处理）**')
    expect(todosPiece).toContain('- 回复周报')
    expect(digest.push('这绝对不是 JSON 的后半段')).toBe('')
  })

  it('fence 包裹不影响；空 delta 不产出', () => {
    const digest = createMailDigestStream()
    expect(digest.push('```json\n{"summary":"s","events":[],"todos":[{"text":"t"}],"reads":[]}\n```')).toContain('**总评** s')
    expect(digest.push('')).toBe('')
  })

  it('截断的字符串值（流中途）安全补全：只出增量差量', () => {
    const digest = createMailDigestStream()
    // 字符串未闭合 → 补全闭合，把已有半句当 summary 先出一版
    expect(digest.push('{"summary": "正在输出一半')).toBe('**总评** 正在输出一半')
    const piece = digest.push('的摘要", "events": [], "todos": [], "reads": []}')
    // 前一轮已把「正在输出一半」当作完整 summary 输出，本轮只补差量
    expect(piece).toBe('的摘要')
  })
})
