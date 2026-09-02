/**
 * IMAP 协议冒烟测试：起一个说真话的本地 IMAP 服务器（明文 socket，实现
 * 真实协议响应），让**真正的 imapflow** 走完 downloadMailWindowToTemp 的
 * 完整流程。此前的伪客户端按想象实现接口，测不出「client.messageSearch
 * is not a function」这类 API 名/协议漂移问题——这个文件就是那类问题的
 * 回归网。
 *
 * 服务器只实现 downloadMailWindowToTemp 用到的最小命令集：
 * CAPABILITY / LOGIN / SELECT / UID SEARCH / UID FETCH / LOGOUT，
 * 其余命令一律 tagged OK（imapflow 对极简服务器是容忍的）。
 */
import { describe, expect, it } from 'vitest'
import net from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadMailWindowToTemp } from '../src/mail.js'
import { resolveMemoryleakSettings } from '../src/settings-schema.js'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** IMAP INTERNALDATE 格式：18-Aug-2026 11:00:00 +0800 */
function imapDate(date) {
  const pad = (value) => String(value).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${String(date.getDate()).padStart(2, '0')}-${MONTHS[date.getMonth()]}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
}

/** 模拟服务器日期粒度的 SINCE：同日就算命中（精确过滤在插件内存里做）。 */
function imapDay(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/**
 * 起一个一次性明文 IMAP 服务器。
 * messages: [{ seq, uid, date: Date, fromName, fromUser, fromHost, subject, source, inWindow }]
 */
function startFakeImapServer(messages) {
  const state = { commands: [], searchSince: null, fetchRanges: [], sourceUids: [] }
  const server = net.createServer((socket) => {
    let buffer = ''
    const write = (text) => socket.write(text)
    const ok = (tag, note = 'done') => write(`${tag} OK ${note}\r\n`)
    socket.write('* OK IMAP4rev1 MemoryLeak smoke ready\r\n')
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const at = buffer.indexOf('\r\n')
        if (at === -1) return
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        const match = /^(\S+) (UID )?(\S+)(?: (.*))?$/.exec(line.trim())
        if (match === null) continue
        const tag = match[1]
        // 注意：match[2] 捕获了尾部空格，拼命令名时要去掉（'UID ' + 'SEARCH' ≠ 'UIDSEARCH'）
        const command = `${match[2] ?? ''}${match[3]}`.toUpperCase().replace(/\s+/g, '')
        const rest = (match[4] ?? '').trim()
        state.commands.push(`${match[2] ?? ''}${match[3]} ${rest}`.trim())
        if (command === 'CAPABILITY') {
          write('* CAPABILITY IMAP4rev1\r\n')
          ok(tag)
        } else if (command === 'ID') {
          write('* ID NIL\r\n')
          ok(tag)
        } else if (command === 'LOGIN') {
          ok(tag, 'logged in')
        } else if (command === 'SELECT' || command === 'EXAMINE') {
          write(`* ${messages.length} EXISTS\r\n`)
          write('* 0 RECENT\r\n')
          write('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n')
          write('* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flags permitted\r\n')
          write('* OK [UIDVALIDITY 1] UIDs valid\r\n')
          write(`* OK [UIDNEXT ${messages.reduce((max, item) => Math.max(max, item.uid), 0) + 1}] Predicted next UID\r\n`)
          ok(tag, '[READ-WRITE] SELECT completed')
        } else if (command === 'UIDSEARCH') {
          state.searchSince = rest
          const day = /SINCE (.+)$/i.exec(rest)?.[1] ?? null
          const hits = messages.filter((item) => day === null || imapDay(item.date) === sameDayKey(day)).map((item) => item.uid)
          write(`* SEARCH ${hits.join(' ')}\r\n`)
          ok(tag)
        } else if (command === 'UIDFETCH') {
          state.fetchRanges.push(rest)
          const uidSet = rest.split(/\s+/)[0] ?? ''
          const wanted = uidSet.split(',').flatMap((part) => part.split(':').map(Number))
          const wantSource = /BODY(\.PEEK)?\[\]/i.test(rest) || /SOURCE/i.test(rest)
          for (const message of messages.filter((item) => wanted.includes(item.uid))) {
            if (wantSource) {
              // imapflow 对 {source:true} 发的是 BODY.PEEK[]，响应必须用 BODY[] 项（映射回 msg.source）
              const raw = Buffer.from(message.source, 'utf8')
              write(`* ${message.seq} FETCH (UID ${message.uid} BODY[] {${raw.length}}\r\n`)
              socket.write(raw)
              write(')\r\n')
              state.sourceUids.push(message.uid)
            } else {
              // ENVELOPE 地址结构 = (name adl mailbox host)：mailbox 是 @ 前的用户部分，
              // name 必须放在第一个字段（放 mailbox 会被 imapflow 拼成「名字@用户@主机」）
              const from = `(("${message.fromName}" NIL "${message.fromUser}" "${message.fromHost}"))`
              const envelope = `("${imapDate(message.date)}" "${message.subject}" ${from} ${from} ${from} ((NIL NIL "me" "here.local")) NIL NIL NIL "<${message.uid}@smoke>")`
              write(`* ${message.seq} FETCH (UID ${message.uid} INTERNALDATE "${imapDate(message.date)}" ENVELOPE ${envelope})\r\n`)
            }
          }
          ok(tag)
        } else if (command === 'LOGOUT') {
          write('* BYE MemoryLeak smoke bye\r\n')
          ok(tag, 'LOGOUT completed')
          socket.end()
        } else {
          ok(tag)
        }
      }
    })
  })
  server.listen(0, '127.0.0.1')
  return { server, state, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** 把服务器收到的 SINCE 参数（IMAP 日期串，如 1-Sep-2026）还原成可比较的日键。 */
function sameDayKey(imapDayString) {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(imapDayString.trim())
  if (match === null) return imapDayString.trim()
  const month = MONTHS.findIndex((name) => name.toLowerCase() === match[2].toLowerCase())
  return `${Number(match[3])}-${month}-${Number(match[1])}`
}

describe('downloadMailWindowToTemp × 真实 imapflow（协议冒烟）', () => {
  it('真 imapflow 客户端走完 SEARCH → 信封 → 逐封 SOURCE 下载', async () => {
    const day = (hour) => new Date(2026, 8, 1, hour, 0, 0) // 2026-09-01 本地
    const messages = [
      { seq: 1, uid: 101, date: day(9), fromName: '昨晚', fromUser: 'old', fromHost: 'b.c', subject: '窗口外', source: 'Subject: outside\r\n\r\nold body', inWindow: false },
      { seq: 2, uid: 102, date: day(11), fromName: '老板', fromUser: 'boss', fromHost: 'b.c', subject: '周报', source: 'Subject: weekly\r\n\r\nplease send weekly report', inWindow: true },
      { seq: 3, uid: 103, date: day(12), fromName: 'PM', fromUser: 'pm', fromHost: 'b.c', subject: '新规范', source: 'Subject: spec\r\n\r\nspec next week', inWindow: true },
    ]
    const { server, state, close } = await new Promise((resolve) => {
      const started = startFakeImapServer(messages)
      started.server.on('listening', () => resolve(started))
    })
    const dir = await mkdtemp(join(tmpdir(), 'dsh-ml-imap-smoke-'))
    try {
      const settings = resolveMemoryleakSettings({
        mailHost: '127.0.0.1',
        mailPort: server.address().port,
        mailSecure: false, // 明文连接：冒烟服务器不协商 TLS
        mailUser: 'a@b.c',
        mailPassword: 'secret',
        mailFolder: 'INBOX',
      })
      // vault 状态语义上等于「上次读完 10:00」：窗口 (10:00, now]
      const window = { start: new Date(2026, 8, 1, 10, 0, 0), end: new Date(2026, 8, 1, 15, 0, 0) }
      const result = await downloadMailWindowToTemp({ settings, window, dir })

      // 窗口精确过滤：只有 11:00 / 12:00 两封（09:00 虽在 SINCE 日期内被服务器返回，但被分钟级过滤排除）
      expect(result.emails.map((mail) => mail.subject)).toEqual(['周报', '新规范'])
      expect(result.emails.map((mail) => mail.from)).toEqual(['老板 <boss@b.c>', 'PM <pm@b.c>'])
      expect(result.dropped).toBe(0)
      expect(result.searched).toBe(3) // 服务器日期粒度 SINCE 返回全部三封
      // 文件真实落盘且内容是服务器给的 SOURCE 原文
      const written = await readFile(join(dir, '0001.eml'), 'utf8')
      expect(written).toContain('please send weekly report')
      expect(state.sourceUids.sort()).toEqual([102, 103])
      // SEARCH 命令真的发生了（这是 messageSearch 事故的回归断言）
      expect(state.commands.some((cmd) => /^UID SEARCH/i.test(cmd))).toBe(true)
      expect(state.searchSince).toMatch(/SINCE/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await close()
    }
  })
})
