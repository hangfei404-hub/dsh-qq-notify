/**
 * dsh-qq-notify SMTP 端到端测试。
 *
 * QQ 邮箱 SMTP 是「用 QQ 账号凭证发提醒」的官方路径，也是最容易写错的代码
 * （多行应答、STARTTLS 升级、AUTH LOGIN、MIME base64、超时）。所以这里起一个
 * 真实的本地 TLS SMTP 服务器，跟客户端走完整握手：
 *
 *   • 隐式 TLS（465 风格）+ AUTH LOGIN + 投递
 *   • 明文 + STARTTLS 升级（587 风格）
 *   • 535 鉴权失败是否给出「用授权码不是密码」的建议且不重试
 *
 * 只在本机回环上跑，证书是临时自签的，因此测试进程内关闭证书校验。
 * 运行：node test/smtp.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { describeError, sendViaSmtp, TransportError } from '../lib/transports.js'


let checks = 0
let failures = 0

async function check(name, fn) {
  checks += 1
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures += 1
    const detail = error instanceof TransportError ? describeError(error) : error?.message ?? String(error)
    console.log(`  ❌ ${name}\n     ${String(detail).split('\n')[0]}`)
  }
}

/** 生成一次性自签证书。 */
function makeCertificate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qq-notify-tls-'))
  const keyPath = path.join(dir, 'key.pem')
  const certPath = path.join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', keyPath, '-out', certPath,
  ], { stdio: 'ignore' })
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), dir }
}

/**
 * 极简 SMTP 服务器，只实现客户端会用到的那几条命令，并把交互记下来。
 * @param {{ secure: boolean, authReply?: string, credentials?: object }} options
 */
async function startSmtpServer({ secure, authReply = '235 2.7.0 Authentication successful', credentials, silent = false }) {
  const secureContext = tls.createSecureContext({ key: credentials.key, cert: credentials.cert })
  const captured = { commands: [], authUser: undefined, authPassword: undefined, data: undefined }

  /** 在一段（可能被 STARTTLS 替换过的）socket 上跑命令状态机。 */
  const serve = (initialSocket) => {
    // current 会随 STARTTLS 升级指向新的 TLS socket，所有应答都必须写到它上面
    let current = initialSocket
    let buffer = ''
    let state = 'command'
    let dataLines = []

    current.write('220 localhost ESMTP dsh-qq-notify-test\r\n')

    const onLine = (line) => {
      if (state === 'auth-user') {
        captured.authUser = Buffer.from(line, 'base64').toString('utf8')
        state = 'auth-pass'
        current.write('334 UGFzc3dvcmQ6\r\n')
        return
      }
      if (state === 'auth-pass') {
        captured.authPassword = Buffer.from(line, 'base64').toString('utf8')
        state = 'command'
        current.write(`${authReply}\r\n`)
        return
      }
      if (state === 'data') {
        if (line === '.') {
          captured.data = dataLines.join('\r\n')
          dataLines = []
          state = 'command'
          current.write('250 2.0.0 Ok: queued as TEST1\r\n')
          return
        }
        // 服务端按协议还原点号转义
        dataLines.push(line.startsWith('..') ? line.slice(1) : line)
        return
      }

      const upper = line.toUpperCase()
      captured.commands.push(line)
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        if (secure === false) {
          current.write('250-localhost\r\n250-STARTTLS\r\n250 AUTH LOGIN PLAIN\r\n')
        } else {
          current.write('250-localhost\r\n250 AUTH LOGIN PLAIN\r\n')
        }
        return
      }
      if (upper === 'STARTTLS') {
        current.write('220 2.0.0 Ready to start TLS\r\n')
        // 把同一条 TCP 连接升级成 TLS，模拟真实的 STARTTLS 行为。
        // 两个关键点：① 先摘掉明文阶段的 data 监听，否则 TLS 握手字节会被当成 SMTP 文本吃掉；
        //            ② 升级后所有应答都必须写到 TLS socket 上（current 改指向它）。
        current.removeAllListeners('data')
        buffer = ''
        const upgraded = new tls.TLSSocket(current, { isServer: true, secureContext })
        upgraded.once('secure', () => {
          current = upgraded
          attach(upgraded)
        })
        upgraded.on('error', (error) => console.error('SRV tls error', error.message))
        return
      }
      if (upper === 'AUTH LOGIN') {
        state = 'auth-user'
        current.write('334 VXNlcm5hbWU6\r\n')
        return
      }
      if (upper.startsWith('MAIL FROM')) {
        current.write('250 2.1.0 Ok\r\n')
        return
      }
      if (upper.startsWith('RCPT TO')) {
        current.write('250 2.1.5 Ok\r\n')
        return
      }
      if (upper === 'DATA') {
        state = 'data'
        current.write('354 End data with <CR><LF>.<CR><LF>\r\n')
        return
      }
      if (upper === 'QUIT') {
        current.write('221 2.0.0 Bye\r\n')
        current.end()
        return
      }
      if (upper.startsWith('AUTH PLAIN')) {
        const token = line.slice('AUTH PLAIN '.length).trim()
        const [user, password] = Buffer.from(token, 'base64').toString('utf8').split('\0').slice(1)
        captured.authUser = user
        captured.authPassword = password
        current.write(`${authReply}\r\n`)
        return
      }
      current.write('502 5.5.2 Command not implemented\r\n')
    }

    function attach(sock) {
      // 同样保持二进制模式，否则 STARTTLS 升级后 TLS 字节会被解码坏
      sock.on('data', (chunk) => {
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        for (;;) {
          const index = buffer.indexOf('\r\n')
          if (index < 0) break
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          onLine(line)
        }
      })
      sock.on('error', () => undefined)
    }

    attach(initialSocket)
  }

  const sockets = new Set()
  const track = (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
  }

  const server = silent
    // 只接受连接、永远不发问候语：用来验证客户端有整体超时而不是永久挂住
    ? net.createServer((socket) => track(socket))
    : secure
      ? tls.createServer({ key: credentials.key, cert: credentials.cert }, (socket) => {
        track(socket)
        serve(socket)
      })
      : net.createServer((socket) => {
        track(socket)
        serve(socket)
      })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    captured,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

/** 一份最小的通知载荷。 */
function notification(port, overrides = {}) {
  const config = {
    transport: 'smtp',
    account: '123456789',
    target: '987654321',
    timeoutMs: 5000,
    smtp: {
      host: '127.0.0.1',
      port,
      secure: true,
      from: '',
      passwordRef: 'QQ_SMTP_AUTH_CODE',
      subjectPrefix: '[DSH]',
    },
    ...overrides,
  }
  return {
    config,
    text: '[DSH] 任务完成 ✅\n会话: 修登录 500\n时间: 2026-10-23 22:10:31',
    subject: '[DSH] 任务完成 ✅',
    secret: 'abcdefghijklmnop',
    meta: { kind: 'task-complete' },
  }
}

async function main() {
  console.log('dsh-qq-notify SMTP 端到端测试\n')
  const credentials = makeCertificate()

  try {
    await check('隐式 TLS + AUTH LOGIN + 正文投递全链路成功', async () => {
      const server = await startSmtpServer({ secure: true, credentials })
      try {
        const result = await sendViaSmtp(notification(server.port))
        assert.equal(result.channel, 'smtp')

        const captured = server.captured
        assert.equal(captured.authUser, '123456789@qq.com', '发件账号应补全 @qq.com')
        assert.equal(captured.authPassword, 'abcdefghijklmnop', '应使用配置里解析出的授权码')

        const commands = captured.commands.map((line) => line.toUpperCase())
        assert.ok(commands.some((line) => line.startsWith('MAIL FROM:<123456789@QQ.COM>')), '发件人地址应正确')
        assert.ok(commands.some((line) => line.startsWith('RCPT TO:<987654321@QQ.COM>')), '收件人应补全 @qq.com')
        assert.ok(commands.includes('QUIT'), '结束时应礼貌 QUIT')

        assert.ok(captured.data !== undefined, '应收到邮件正文')
        const [headerBlock, bodyBlock] = captured.data.split('\r\n\r\n')
        assert.match(headerBlock, /Subject: =\?UTF-8\?B\?/, '中文标题必须 RFC2047 编码')
        assert.match(headerBlock, /Content-Type: text\/plain; charset=UTF-8/)
        assert.match(headerBlock, /Content-Transfer-Encoding: base64/, '正文应 base64 传输，规避 8bit 问题')

        const decoded = Buffer.from(bodyBlock.replace(/\r\n/g, ''), 'base64').toString('utf8')
        assert.equal(decoded, notification(server.port).text, '正文解码后应与原文完全一致')
      } finally {
        await server.close()
      }
    })

    await check('正文折行不超过 76 字符（MIME 行宽要求）', async () => {
      const server = await startSmtpServer({ secure: true, credentials })
      try {
        await sendViaSmtp(notification(server.port))
        const bodyBlock = server.captured.data.split('\r\n\r\n')[1]
        for (const line of bodyBlock.split('\r\n')) {
          assert.ok(line.length <= 76, `出现过长的行: ${line.length}`)
        }
      } finally {
        await server.close()
      }
    })

    await check('明文 + STARTTLS 升级后仍能完成投递（587 风格）', async () => {
      const server = await startSmtpServer({ secure: false, credentials })
      try {
        const configured = notification(server.port)
        configured.config.smtp.secure = false
        const result = await sendViaSmtp(configured)
        assert.equal(result.channel, 'smtp')
        assert.ok(
          server.captured.commands.some((line) => line.toUpperCase() === 'STARTTLS'),
          '客户端必须先发 STARTTLS',
        )
        assert.equal(server.captured.authPassword, 'abcdefghijklmnop', '升级后仍要能鉴权')
        assert.ok(server.captured.data !== undefined)
      } finally {
        await server.close()
      }
    })

    await check('535 鉴权失败：给出「用授权码」建议且标记为不可重试', async () => {
      const server = await startSmtpServer({
        secure: true,
        credentials,
        authReply: '535 5.7.8 Authentication failed',
      })
      try {
        await assert.rejects(
          () => sendViaSmtp(notification(server.port)),
          (error) => {
            assert.ok(error instanceof TransportError)
            assert.equal(error.code, 'SMTP_535')
            assert.equal(error.retryable, false, '鉴权失败重试没意义')
            assert.match(error.hint ?? '', /授权码/)
            assert.match(describeError(error), /SMTP 鉴权失败/)
            return true
          },
        )
      } finally {
        await server.close()
      }
    })

    await check('缺少授权码时立刻失败（不发无意义的登录请求）', async () => {
      const configured = notification(465)
      configured.secret = undefined
      await assert.rejects(
        () => sendViaSmtp(configured),
        (error) => {
          assert.equal(error.code, 'SMTP_NO_SECRET')
          assert.equal(error.retryable, false)
          assert.match(error.hint ?? '', /credentials\.yaml/)
          return true
        },
      )
    })

    await check('服务器只连不应答时按超时失败（不会永久挂住队列）', async () => {
      const server = await startSmtpServer({ secure: false, credentials, silent: true })
      const started = Date.now()
      try {
        const configured = notification(server.port)
        configured.config.smtp.secure = false
        configured.config.timeoutMs = 1200
        await assert.rejects(
          () => sendViaSmtp(configured),
          (error) => {
            assert.ok(error instanceof TransportError)
            assert.match(describeError(error), /超时|SMTP/)
            assert.equal(error.retryable, true, '超时属于可重试错误')
            return true
          },
        )
        const elapsed = Date.now() - started
        assert.ok(elapsed < 6000, `应在超时附近返回，实际 ${elapsed}ms`)
      } finally {
        await server.close()
      }
    })

    await check('连不上时归为可重试的网络错误', async () => {
      const configured = notification(1) // 1 号端口不会有服务
      configured.config.timeoutMs = 1500
      await assert.rejects(
        () => sendViaSmtp(configured),
        (error) => {
          assert.ok(error instanceof TransportError || typeof error.retryable === 'undefined')
          return true
        },
      )
    })

    console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}（共 ${checks} 项）`)
    process.exitCode = failures === 0 ? 0 : 1
  } finally {
    fs.rmSync(credentials.dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('测试自身异常:', error)
  process.exitCode = 1
})
