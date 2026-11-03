/**
 * dsh-qq-notify / transports — 与 cordis 无关的纯发送层。
 *
 * 三种通道共用一个契约：`send(config, { text, subject, meta, signal })` 成功返回
 * `{ channel, detail }`，失败抛出 {@link TransportError}。错误对象带 `retryable`
 * 标记，让上层队列决定是否重试（例如 401／鉴权失败不重试，超时／连接失败重试）。
 *
 * 本文件只依赖 node: 内置模块，所以插件不需要任何 npm 依赖即可加载。
 */
import net from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import tls from 'node:tls'

const CRLF = '\r\n'

/** 发送层统一错误：带上可操作的提示与是否值得重试。 */
export class TransportError extends Error {
  /**
   * @param {string} message 面向用户的一句话结论。
   * @param {{ code?: string, detail?: string, hint?: string, retryable?: boolean, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'TransportError'
    this.code = options.code ?? 'TRANSPORT_ERROR'
    this.detail = options.detail
    this.hint = options.hint
    this.retryable = options.retryable ?? true
  }
}

/** 把任意异常收敛成一句可直接写日志的话（含 hint）。 */
export function describeError(error) {
  if (error instanceof TransportError) {
    const parts = [error.message]
    if (error.detail) parts.push(`详情: ${error.detail}`)
    if (error.hint) parts.push(`建议: ${error.hint}`)
    return parts.join(' | ')
  }
  const message = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  return code && !message.includes(code) ? `${message} (${code})` : message
}

/** 把 QQ 号转成 OneBot 期望的数字；非纯数字目标原样透传。 */
function numericId(value) {
  const text = String(value ?? '').trim()
  return /^\d{1,18}$/.test(text) ? Number(text) : text
}

/**
 * 带超时与外部取消的 fetch。Node 18+ 的全局 fetch 已足够，不引入依赖。
 * @returns {Promise<{ status: number, ok: boolean, text: string }>}
 */
async function request(url, init, timeoutMs, signal) {
  const timeoutController = new AbortController()
  const timer = setTimeout(() => {
    timeoutController.abort(new Error(`请求超时（${timeoutMs}ms）`))
  }, timeoutMs)
  const forwardAbort = () => timeoutController.abort(signal?.reason)
  signal?.addEventListener('abort', forwardAbort, { once: true })
  try {
    const response = await fetch(url, { ...init, signal: timeoutController.signal })
    const text = await response.text()
    return { status: response.status, ok: response.ok, text }
  } catch (error) {
    const reason = signal?.aborted === true ? '调用方已取消' : '网络请求失败'
    throw new TransportError(`${reason}: ${url}`, {
      code: 'NETWORK',
      detail: describeError(error),
      hint: '确认服务端已启动、地址与端口正确、本机可访问该网络',
      retryable: !signal?.aborted,
      cause: error,
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

/* ------------------------------------------------------------------ *
 * 通道 1：OneBot v11 HTTP（NapCat / LLOneBot / Lagrange / go-cqhttp）
 * ------------------------------------------------------------------ */

/**
 * 通过本地 OneBot v11 HTTP 接口发消息。
 *
 * 这是能真正把消息发到「QQ 消息列表」的通道：QQ 登录态由桥接进程（NapCat 扫码或
 * Lagrange 账号登录）持有，插件只发 HTTP 请求，因此插件侧永远不接触 QQ 密码。
 */
export async function sendViaOnebot(notification) {
  const { config, text, signal } = notification
  const onebot = config.onebot ?? {}
  const group = config.targetType === 'group'
  const base = String(onebot.endpoint ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
  const action = group
    ? String(onebot.actionGroup ?? 'send_group_msg')
    : String(onebot.actionPrivate ?? 'send_private_msg')
  const url = `${base}/${action}`
  const headers = { 'content-type': 'application/json; charset=utf-8' }
  if (notification.secret) headers.authorization = `Bearer ${notification.secret}`

  const body = {
    [group ? 'group_id' : 'user_id']: numericId(config.target),
    message: text,
    // 让 OneBot 把 message 当纯文本，不解析 CQ 码，避免消息内容被解释成富媒体指令。
    auto_escape: true,
  }

  const response = await request(
    url,
    { method: 'POST', headers, body: JSON.stringify(body) },
    config.timeoutMs,
    signal,
  )

  if (!response.ok) {
    throw new TransportError(`OneBot 接口返回 HTTP ${response.status}`, {
      code: 'ONEBOT_HTTP',
      detail: truncate(response.text, 300),
      hint: response.status === 401 || response.status === 403
        ? 'accessTokenRef 指向的令牌与桥接进程的 access token 不一致'
        : '确认 endpoint 指向 OneBot 的 HTTP 服务根地址（不带 /send_private_msg）',
      retryable: response.status >= 500,
    })
  }

  let payload
  try {
    payload = JSON.parse(response.text)
  } catch {
    throw new TransportError('OneBot 返回的不是 JSON', {
      code: 'ONEBOT_BAD_JSON',
      detail: truncate(response.text, 300),
      hint: 'endpoint 可能指向了普通网页而不是 OneBot HTTP 服务',
      retryable: false,
    })
  }

  const ok = payload?.status === 'ok' || payload?.retcode === 0
  if (!ok) {
    throw new TransportError(
      `OneBot 拒绝了消息（retcode=${String(payload?.retcode ?? 'unknown')}）`,
      {
        code: 'ONEBOT_REJECTED',
        detail: truncate(payload?.wording ?? payload?.message ?? JSON.stringify(payload), 300),
        hint: 'retcode 100/102 通常是账号未登录或目标不是好友；确认机器人账号在线且 target 正确',
        retryable: false,
      },
    )
  }

  return { channel: 'onebot', detail: `message_id=${String(payload?.data?.message_id ?? '-')}` }
}

/* ------------------------------------------------------------------ *
 * 通道 2：QQ 邮箱 SMTP（QQ号 + SMTP 授权码）
 * ------------------------------------------------------------------ */

/** 去掉头字段里的换行，避免邮件头注入（SMTP 层面这是真实风险）。 */
function sanitizeHeader(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
}

/** RFC 2047 编码的 Subject，保证中文标题不乱码。 */
function encodeHeaderWord(value) {
  const safe = sanitizeHeader(value)
  // 纯 ASCII 且不含特殊字符时直接放原文，便于收件端显示。
  if (/^[\x20-\x7e]*$/.test(safe)) return safe
  return `=?UTF-8?B?${Buffer.from(safe, 'utf8').toString('base64')}?=`
}

/** base64 每 76 字符折行，符合 MIME 对行宽的要求。 */
function wrapBase64(text) {
  const encoded = Buffer.from(text, 'utf8').toString('base64')
  const lines = []
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76))
  }
  return lines.join(CRLF)
}

/** 组装一封纯文本邮件（正文 base64，规避 8bit 与点号转义问题）。 */
function buildMessage({ from, to, subject, text }) {
  return [
    `From: ${sanitizeHeader(from)}`,
    `To: ${sanitizeHeader(to)}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(text),
  ].join(CRLF)
}

/**
 * 把一个 socket 包装成「发一行、读一个完整应答」的通道。
 * SMTP 应答可能是多行（`250-...` 续行，最后一行 `250 ...`），这里按协议拼完整。
 */
function createChannel(socket) {
  let buffer = ''
  let failure = null
  let pending = null
  // 刻意不调用 socket.setEncoding('utf8')：socket 一旦进入字符串模式，
  // 之后 STARTTLS 升级时 TLS 层会读到被解码坏的数据（bad record type）。
  // 用 StringDecoder 自行解码，既保持二进制模式又不切断多字节字符。
  const decoder = new StringDecoder('utf8')

  const takeReply = () => {
    const lines = []
    let position = 0
    for (;;) {
      const index = buffer.indexOf(CRLF, position)
      if (index < 0) return null
      const line = buffer.slice(position, index)
      position = index + CRLF.length
      if (!/^\d{3}/.test(line)) continue
      lines.push(line)
      if (line[3] === '-') continue
      buffer = buffer.slice(position)
      return { code: Number(line.slice(0, 3)), lines, text: lines.join('\n') }
    }
  }

  const pump = () => {
    if (pending === null) return
    const reply = takeReply()
    if (reply !== null) {
      const settle = pending
      pending = null
      settle.resolve(reply)
      return
    }
    if (failure !== null) {
      const settle = pending
      pending = null
      settle.reject(failure)
    }
  }

  const onData = (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    pump()
  }
  const onError = (error) => {
    failure = failure ?? error
    pump()
  }
  const onClose = () => {
    failure = failure ?? new Error('SMTP 连接被对端关闭')
    pump()
  }

  socket.on('data', onData)
  socket.on('error', onError)
  socket.on('close', onClose)

  return {
    read() {
      if (failure !== null) return Promise.reject(failure)
      const reply = takeReply()
      if (reply !== null) return Promise.resolve(reply)
      return new Promise((resolve, reject) => {
        pending = { resolve, reject }
      })
    },
    write(text) {
      socket.write(text)
    },
    /** 解绑监听：STARTTLS 升级时必须先放手，让新 socket 接管。 */
    detach() {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      failure = failure ?? new Error('SMTP 连接已切换')
      pump()
    },
  }
}

/** 只等待 socket 建立完成（或超时／出错）。 */
function waitForSocket(socket, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`连接 ${event} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      socket.off(event, onOk)
      socket.off('error', onFail)
    }
    const onOk = () => {
      cleanup()
      resolve()
    }
    const onFail = (error) => {
      cleanup()
      reject(error)
    }
    socket.once(event, onOk)
    socket.once('error', onFail)
  })
}

/** 断言 SMTP 应答码在期望集合内，否则抛出可读错误。 */
function expect(reply, codes, step) {
  if (codes.includes(reply.code)) return reply
  const hint = reply.code === 535 || reply.code === 530
    ? 'SMTP 鉴权失败：passwordRef 必须是 QQ 邮箱「设置 → 账户 → POP3/SMTP 服务」生成的 16 位授权码，不是 QQ 登录密码'
    : reply.code === 550 || reply.code === 553
      ? '收件地址被拒绝：target 需要是完整邮箱或可拼成 <QQ号>@qq.com 的号码'
      : undefined
  throw new TransportError(`SMTP ${step} 失败（${reply.code}）`, {
    code: `SMTP_${reply.code}`,
    detail: reply.text,
    hint,
    // SMTP 语义：4xx 是暂时性错误可以重试，5xx 是永久性错误（鉴权失败、地址被拒）重试无意义。
    retryable: reply.code >= 400 && reply.code < 500,
  })
}

/** 从 EHLO 应答里读能力列表，用于判断是否支持 STARTTLS / AUTH。 */
function capabilities(reply) {
  const found = new Set()
  for (const line of reply.lines.slice(1)) {
    const token = line.slice(4).trim().split(/\s+/)[0]
    if (token) found.add(token.toUpperCase())
  }
  return found
}

/** 建立 SMTP 会话（含可选 STARTTLS），返回已鉴权的上下文。 */
async function openSmtpSession({ host, port, secure, user, secret, timeoutMs, signal }) {
  const connectOptions = { host, port, servername: host }
  let socket = secure
    ? tls.connect(connectOptions)
    : net.connect({ host, port })
  let channel = createChannel(socket)
  let finished = false

  const abortHandler = () => {
    socket.destroy(new Error('调用方已取消'))
  }
  signal?.addEventListener('abort', abortHandler, { once: true })

  // 整个会话的硬超时：对端只连不应答时也必须失败，否则会永久占住发送队列。
  const deadline = setTimeout(() => {
    socket.destroy(new Error(`SMTP 会话超时（${timeoutMs}ms）`))
  }, timeoutMs)

  const release = () => {
    finished = true
    clearTimeout(deadline)
    signal?.removeEventListener('abort', abortHandler)
  }

  try {
    const greeting = await channel.read()
    expect(greeting, [220], '握手')

    channel.write(`EHLO dsh-qq-notify${CRLF}`)
    let ehlo = expect(await channel.read(), [250], 'EHLO')
    let caps = capabilities(ehlo)

    if (!secure && port !== 465) {
      if (!caps.has('STARTTLS')) {
        throw new TransportError('服务器未提供 STARTTLS，无法在不加密的通道上发送凭据', {
          code: 'SMTP_NO_STARTTLS',
          hint: '把 smtp.secure 设为 true 并使用 465 端口',
          retryable: false,
        })
      }
      channel.write(`STARTTLS${CRLF}`)
      expect(await channel.read(), [220], 'STARTTLS')

      channel.detach()
      socket = tls.connect({ socket, servername: host })
      await waitForSocket(socket, 'secureConnect', timeoutMs)
      channel = createChannel(socket)

      channel.write(`EHLO dsh-qq-notify${CRLF}`)
      ehlo = expect(await channel.read(), [250], 'EHLO(TLS)')
      caps = capabilities(ehlo)
    }

    if (caps.has('AUTH')) {
      channel.write(`AUTH LOGIN${CRLF}`)
      const login = await channel.read()
      if (login.code === 334) {
        channel.write(`${Buffer.from(user, 'utf8').toString('base64')}${CRLF}`)
        expect(await channel.read(), [334], 'AUTH(用户名)')
        channel.write(`${Buffer.from(secret, 'utf8').toString('base64')}${CRLF}`)
        expect(await channel.read(), [235], 'AUTH(密码)')
      } else if (login.code === 504 || login.code === 500) {
        // 少数实现只支持 PLAIN：base64("\0user\0pass")
        const token = Buffer.from(`\0${user}\0${secret}`, 'utf8').toString('base64')
        channel.write(`AUTH PLAIN ${token}${CRLF}`)
        expect(await channel.read(), [235], 'AUTH PLAIN')
      } else {
        expect(login, [334], 'AUTH')
      }
    }

    return {
      channel,
      close() {
        if (finished) return
        release()
        try {
          socket.end()
        } catch {
          /* 连接可能已断开，忽略 */
        }
        setTimeout(() => socket.destroy(), 50).unref?.()
      },
    }
  } catch (error) {
    // 半途失败也必须断开连接：否则对端会一直挂着这条会话（也拖住 close 调用）。
    if (!finished) {
      release()
      try {
        socket.destroy()
      } catch {
        /* 已经断开 */
      }
    }
    if (error instanceof TransportError) throw error
    throw new TransportError('SMTP 会话失败', {
      code: 'SMTP_SESSION',
      detail: describeError(error),
      hint: '检查 host/port 是否可达、网络是否允许出站 465/587',
      retryable: true,
      cause: error,
    })
  }
}

/**
 * 通过 QQ 邮箱 SMTP 发送通知邮件。
 *
 * 这就是「用 QQ 账号凭证发提醒」在 QQ 官方能力范围内的做法：`<QQ号>@qq.com`
 * 作为发件人，凭 SMTP 授权码登录。QQ 登录密码不能用于 SMTP，也不应该被保存。
 */
export async function sendViaSmtp(notification) {
  const { config, text, subject, signal } = notification
  const smtp = config.smtp ?? {}
  const account = sanitizeHeader(config.account)
  if (!account) {
    throw new TransportError('smtp 通道缺少 account（发件 QQ 号）', {
      code: 'SMTP_NO_ACCOUNT',
      hint: '在配置里写 account: "你的QQ号"',
      retryable: false,
    })
  }
  const user = account.includes('@') ? account : `${account}@qq.com`
  const from = smtp.from ? sanitizeHeader(smtp.from) : user
  const rawTarget = sanitizeHeader(config.target)
  const to = rawTarget.includes('@') ? rawTarget : `${rawTarget}@qq.com`

  if (!notification.secret) {
    throw new TransportError(`未取到 SMTP 授权码（凭证引用 ${String(smtp.passwordRef)}）`, {
      code: 'SMTP_NO_SECRET',
      hint: '把授权码写进 ~/.dsh/.credentials.yaml，或在环境变量里设置同名变量',
      retryable: false,
    })
  }

  const host = smtp.host ?? 'smtp.qq.com'
  const secure = smtp.secure !== false
  const port = Number(smtp.port ?? (secure ? 465 : 587))

  const session = await openSmtpSession({
    host,
    port,
    secure,
    user,
    secret: notification.secret,
    timeoutMs: config.timeoutMs,
    signal,
  })

  try {
    const { channel } = session
    channel.write(`MAIL FROM:<${from}>${CRLF}`)
    expect(await channel.read(), [250], 'MAIL FROM')

    channel.write(`RCPT TO:<${to}>${CRLF}`)
    expect(await channel.read(), [250, 251], 'RCPT TO')

    channel.write(`DATA${CRLF}`)
    expect(await channel.read(), [354], 'DATA')

    const message = buildMessage({ from, to, subject, text })
    channel.write(`${message}${CRLF}.${CRLF}`)
    expect(await channel.read(), [250], '正文投递')

    channel.write(`QUIT${CRLF}`)
    // 对端不一定会回 221，收尾失败不影响「已投递」的事实。
    await channel.read().catch(() => undefined)

    return { channel: 'smtp', detail: `${from} → ${to}` }
  } finally {
    session.close()
  }
}

/* ------------------------------------------------------------------ *
 * 通道 3：通用 webhook（自建中转、Server酱、ntfy、企业微信机器人…）
 * ------------------------------------------------------------------ */

/** POST 一段 JSON 到任意中转地址，由中转侧负责落到 QQ。 */
export async function sendViaWebhook(notification) {
  const { config, text, subject, meta, signal } = notification
  const webhook = config.webhook ?? {}
  if (!webhook.url) {
    throw new TransportError('webhook 通道缺少 url', {
      code: 'WEBHOOK_NO_URL',
      hint: '在 webhook.url 填入你的中转地址',
      retryable: false,
    })
  }

  const headers = { 'content-type': 'application/json; charset=utf-8' }
  if (notification.secret) headers.authorization = `Bearer ${notification.secret}`

  const body = JSON.stringify({
    event: meta?.kind ?? 'notification',
    title: subject,
    message: text,
    target: config.target,
    sessionId: meta?.sessionId,
    turn: meta?.turn,
    at: new Date(meta?.at ?? Date.now()).toISOString(),
  })

  const response = await request(
    webhook.url,
    { method: 'POST', headers, body },
    config.timeoutMs,
    signal,
  )

  if (!response.ok) {
    throw new TransportError(`webhook 返回 HTTP ${response.status}`, {
      code: 'WEBHOOK_HTTP',
      detail: truncate(response.text, 300),
      hint: '确认中转地址可访问、令牌正确、返回 2xx',
      retryable: response.status >= 500 || response.status === 429,
    })
  }

  return { channel: 'webhook', detail: `HTTP ${response.status}` }
}

/* ------------------------------------------------------------------ */

function truncate(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

const SENDERS = {
  onebot: sendViaOnebot,
  smtp: sendViaSmtp,
  webhook: sendViaWebhook,
}

/**
 * 按配置里的 `transport` 分发一次发送。
 * @param {{ config: object, text: string, subject: string, secret?: string, meta?: object, signal?: AbortSignal }} notification
 * @returns {Promise<{ channel: string, detail: string }>}
 */
export async function sendNotification(notification) {
  const sender = SENDERS[notification.config.transport]
  if (sender === undefined) {
    throw new TransportError(`未知的 transport: ${String(notification.config.transport)}`, {
      code: 'UNKNOWN_TRANSPORT',
      hint: '可选值: onebot | smtp | webhook',
      retryable: false,
    })
  }
  return sender(notification)
}

export { truncate }
