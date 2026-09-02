#!/usr/bin/env node
/**
 * probe-mail-tls.mjs —— /ml mail 连通性诊断（独立脚本，不属于插件代码）。
 *
 * 用法：
 *   node scripts/probe-mail-tls.mjs mail.corp.example.com          # 自动探测 993 + 143
 *   node scripts/probe-mail-tls.mjs mail.corp.example.com 993      # 只探一个端口
 *
 * 只做三件事，绝不发送凭证、绝不登录、绝不改动邮箱：
 *   1. TCP 层：端口通不通
 *   2. TLS 层：隐式 TLS（993 式）能否握手；证书是谁签的、发给谁、有效期
 *      （若因证书被 Node 拒绝，会放宽校验再取一次证书信息——仅诊断用）
 *   3. IMAP 层：明文端口读问候语与 CAPABILITY（看有没有 STARTTLS /
 *      LOGINDISABLED），并实际做一次 STARTTLS 升级测试
 *
 * 在运行 `dsh web` 的那台机器上跑（插件是从宿主进程发起连接的，
 * 防火墙/DNS 视角要一致）。
 */
import net from 'node:net'
import tls from 'node:tls'

const host = process.argv[2]
const portArg = process.argv[3] ? Number(process.argv[3]) : null

if (typeof host !== 'string' || host === '') {
  console.error('用法：node scripts/probe-mail-tls.mjs <主机名或IP> [端口]（缺省探测 993 与 143）')
  process.exit(1)
}

const IS_IP = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')
const tlsOptions = (extra = {}) => ({ ...(IS_IP ? {} : { servername: host }), ...extra })
const LINE = '─'.repeat(60)
const CERT_ERRORS = ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID', 'EDEPTH_ZERO_SELF_SIGNED_CERT']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function describeError(error) {
  const code = error?.code ?? ''
  const map = {
    ECONNREFUSED: '端口没开：服务未监听或被防火墙拦。on-prem Exchange 的 IMAP4 服务默认是禁用的——去服务器上看看 Get-Service MSExchangeImap4* 是否 Running。',
    ETIMEDOUT: '网络不可达或被丢包：检查地址拼写、VPN、防火墙。',
    ENOTFOUND: '域名解析不了：检查主机名，或在 /etc/hosts / DNS 里确认。',
    EHOSTUNREACH: '路由不可达：本机到服务器没有网络路径。',
    ERR_TLS_WRONG_VERSION_NUMBER: '对端说的不是 TLS：这个端口是明文协议（或根本不是 IMAP）——993+TLS 的组合对它不成立。',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书链验证不过：内部 CA 签发或证书链不完整。Node 严格校验拒绝 → 这就是插件连不上的原因（证书本身能拿到）。',
    DEPTH_ZERO_SELF_SIGNED_CERT: '自签证书：Node 拒绝。同上。',
    SELF_SIGNED_CERT_IN_CHAIN: '证书链里有自签节点：内部 PKI 常见。同上。',
    ERR_TLS_CERT_ALTNAME_INVALID: '证书里的域名和你连的主机名不一致：改用证书里的名字连，或者需要跳过校验的选项。',
  }
  return `${code}${map[code] === undefined ? '' : ` → ${map[code]}`}`
}

function showCert(prefix, cert) {
  if (cert === undefined || cert === null) {
    console.log(`${prefix}（拿不到证书信息）`)
    return
  }
  const cn = (input) => {
    if (typeof input?.CN === 'string') return input.CN
    if (Array.isArray(input)) return input.map((item) => item?.CN ?? item?.O ?? '?').join(' + ')
    return JSON.stringify(input) ?? '?'
  }
  console.log(`${prefix}`)
  console.log(`    颁发给：${cn(cert.subject)}`)
  console.log(`    签发者：${cn(cert.issuer)}${cert.issuer === undefined ? '' : ''}`)
  console.log(`    有效期至：${cert.valid_to ?? '?'}`)
  console.log(`    自签判定：${cert.authority === false ? '是（自签，浏览器/Node 都不会信任）' : '否（有签发者，链是否可信取决于本机信任库）'}`)
}

/* ---------------- 1. TCP ---------------- */
async function probeTcp(port) {
  console.log(`\n${LINE}\n[1/3] TCP 连通性 ${host}:${port}\n${LINE}`)
  await new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (label) => {
      socket.destroy()
      console.log(label)
      resolve()
    }
    socket.setTimeout(8000)
    socket.on('connect', () => done(`✅ 端口开着（TCP 可建立连接）`))
    socket.on('timeout', () => done(`❌ 8 秒无响应（超时）——多半是防火墙丢包或地址不对`))
    socket.on('error', (error) => done(`❌ ${describeError(error)}`))
  })
}

/* ---------------- 2. 隐式 TLS（993 式） ---------------- */
async function probeImplicitTls(port) {
  console.log(`\n${LINE}\n[2/3] 隐式 TLS 探测 ${host}:${port}（对应插件「端口 993 + TLS 开」）\n${LINE}`)
  const attempt = (rejectUnauthorized) =>
    new Promise((resolve) => {
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(result)
      }
      const socket = tls.connect(tlsOptions({ host, port, rejectUnauthorized }))
      const result = { ok: false, cert: null, error: null }
      socket.setTimeout(8000)
      socket.on('secureConnect', () => finish({ ...result, ok: true, cert: socket.getPeerCertificate() }))
      socket.on('timeout', () => finish({ ...result, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }))
      socket.on('error', (error) => finish({ ...result, error }))
      socket.on('close', () => {
        if (!settled) finish({ ...result, error: Object.assign(new Error('closed during handshake'), { code: 'CLOSED' }) })
      })
    })

  const strict = await attempt(true)
  if (strict.ok) {
    console.log('✅ TLS 握手成功，且证书通过 Node 严格校验')
    showCert('服务器证书：', strict.cert)
    console.log('\n结论：这一侧没问题。插件用「端口 %d + TLS 开」应能连上；如果插件仍报错，问题在认证层（密码/授权码），不是 TLS。', port)
    return
  }
  console.log(`❌ 严格校验下握手失败：${describeError(strict.error)}`)
  if (CERT_ERRORS.includes(strict.error?.code)) {
    console.log('\n证书类失败——放宽校验再取一次证书信息（仅诊断用，不代表可以安全忽略）：')
    const lax = await attempt(false)
    if (lax.ok) showCert('服务器证书：', lax.cert)
    else console.log(`（放宽后仍失败：${describeError(lax.error)}——可能握手中途被服务器掐断）`)
    console.log('\n结论：TLS 本身能协商，但 Node 不信任这张证书 → 当前版本插件连不上是预期行为；这正是「跳过证书校验」选项的适用场景。')
    return
  }
  if (strict.error?.code === 'ERR_TLS_WRONG_VERSION_NUMBER') {
    console.log('\n结论：这个端口不说 TLS。要么它是明文端口（用 TLS 关 + STARTTLS，见下一步），要么不是 IMAP。')
    return
  }
  console.log('\n结论：TLS 层未达成，按上面的错误码对照排查。')
}

/* ---------------- 3. 明文 + STARTTLS（143 式） ---------------- */
async function probePlainStarttls(port) {
  console.log(`\n${LINE}\n[3/3] 明文 + STARTTLS 探测 ${host}:${port}（对应插件「端口 143 + TLS 关」）\n${LINE}`)
  const lines = []
  const result = await new Promise((resolve) => {
    let settled = false
    let upgraded = null
    const settle = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    const socket = net.connect({ host, port })
    socket.setTimeout(8000)
    socket.on('connect', () => {
      socket.write('a1 CAPABILITY\r\n')
    })
    socket.on('timeout', () => settle({ kind: 'error', label: '❌ 8 秒无响应' }))
    socket.on('error', (error) => settle({ kind: 'error', label: `❌ ${describeError(error)}` }))
    socket.on('close', () => {
      if (settled) return
      if (lines.length === 0) {
        settle({ kind: 'error', label: '❌ 连接建立但对端没说话就关闭了——该端口大概率只说 TLS（明文探测不适用），或不是 IMAP' })
        return
      }
      settle({ kind: 'error', label: '❌ 对端在明文阶段关闭了连接（部分服务器拒绝明文问候）' })
    })
    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      lines.push(...text.split(/\r?\n/).filter((line) => line !== ''))
      const capabilityLine = lines.find((line) => /CAPABILITY/i.test(line))
      if (capabilityLine !== undefined && upgraded === null && !/STARTTLS/i.test(capabilityLine)) {
        socket.write('a2 LOGOUT\r\n')
        settle({ kind: 'error', label: '✅ 明文 IMAP 问候正常，但 CAPABILITY 里没有 STARTTLS' })
        return
      }
      if (capabilityLine !== undefined && upgraded === null && /STARTTLS/i.test(capabilityLine)) {
        upgraded = 'requested'
        socket.write('a3 STARTTLS\r\n')
        return
      }
      if (upgraded === 'requested' && /a3 OK/i.test(text)) {
        upgraded = 'upgrading'
        // 明文升级为 TLS：复用同一个 socket
        let tlsSettled = false
        const tlsSocket = tls.connect(tlsOptions({ socket, rejectUnauthorized: true }))
        tlsSocket.setTimeout(8000)
        const tlsDone = (value) => {
          if (tlsSettled || settled) return
          tlsSettled = true
          tlsSocket.destroy()
          settle(value)
        }
        tlsSocket.on('secureConnect', () => tlsDone({ kind: 'starttls-ok', cert: tlsSocket.getPeerCertificate() }))
        tlsSocket.on('timeout', () => tlsDone({ kind: 'error', label: '❌ STARTTLS 升级超时' }))
        tlsSocket.on('error', (error) => tlsDone({ kind: 'starttls-cert-error', error }))
        tlsSocket.on('close', () => {
          if (!tlsSettled && !settled) tlsDone({ kind: 'error', label: '❌ STARTTLS 升级中途被对端关闭' })
        })
      }
    })
  })

  const greeting = lines.find((line) => line.startsWith('* OK') || line.startsWith('* PREAUTH'))
  if (greeting !== undefined) console.log(`服务器问候：${greeting.slice(0, 100)}`)
  const caps = lines.find((line) => /CAPABILITY/i.test(line))
  if (caps !== undefined) console.log(`能力列表：${caps.replace(/^\* CAPABILITY /i, '').slice(0, 160)}`)
  if (/\bLOGINDISABLED\b/i.test(caps ?? '')) console.log('⚠️ 能力里有 LOGINDISABLED：明文端口禁止登陆（正常且安全）——必须走 TLS 才能认证')
  if (/\bSTARTTLS\b/i.test(caps ?? '')) console.log('✅ 服务器声明支持 STARTTLS')

  if (result.kind === 'starttls-ok') {
    console.log('\n✅ STARTTLS 升级成功，且证书通过 Node 严格校验')
    showCert('服务器证书：', result.cert)
    console.log('\n结论：插件用「端口 %d + TLS 关」即可（imapflow 会自动 STARTTLS）。', port)
  } else if (result.kind === 'starttls-cert-error') {
    console.log(`\n❌ STARTTLS 能升级但证书校验失败：${describeError(result.error)}`)
    console.log('结论：同自签/内部 CA 场景——需要「跳过证书校验」选项才能过。')
  } else {
    console.log(`\n${result.label}`)
  }
}

/* ---------------- 主流程 ---------------- */
console.log(`探测目标：${host}${portArg === null ? '（端口缺省，探测 993 与 143）' : `:${portArg}`}`)
console.log(`本脚本只做连接与读取，不发送任何凭证。`)
const ports = portArg === null ? [993, 143] : [portArg]
for (const port of ports) {
  await probeTcp(port)
  await probeImplicitTls(port)
  await probePlainStarttls(port)
}
console.log(`\n${LINE}\n探测结束。把上面输出（尤其 ❌ 行与证书信息）发回给助手，即可定位是端口/证书/服务配置哪一层的问题。\n`)
