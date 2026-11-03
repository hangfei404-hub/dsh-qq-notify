/**
 * dsh-qq-notify — 在 DeepSeek Harness 的关键节点通过 QQ 发提醒。
 *
 * 设计要点（为什么这样写）：
 *
 * 1. **只订阅、不改写。** 全部逻辑挂在 `session/event` 这一个只读旁路事件上，
 *    不向会话追加任何事件、不改消息历史，因此不进入模型上下文、不影响 KV cache、
 *    不影响 turn 的正常结束。
 * 2. **监听器必须同步返回。** 监听到事件后只做一次入队（O(1) 内存操作），真正的
 *    网络发送交给独立的后台循环。发送再慢、再失败，都发生在 harness 主流程之外。
 * 3. **任何异常都不外溢。** 映射、发送、重试全部包在 try/catch 里，最坏情况是
 *    「这次没通知到」，绝不会让一次通知拖垮一次任务。
 * 4. **配置里只放凭证引用。** 密码／令牌一律通过 `ctx.credentials`（数据落在
 *    `$DSH_HOME/.credentials.yaml`）解析，跟 harness 其它密钥同一套机制。
 */
import z from '@deepseek-ai/schemastery'
import { describeError, sendNotification, truncate, TransportError } from './transports.js'

/** cordis 插件名（loader 诊断里显示的名字）。 */
export const name = 'qq-notify'

/** 可订阅的事件类型，也是配置里 `events` 的合法取值。 */
export const EVENT_KINDS = ['task-complete', 'task-failed', 'needs-confirmation', 'needs-discussion']

/** 各事件类型发出去时的标题。 */
const TITLES = {
  'task-complete': '任务完成 ✅',
  'task-failed': '任务失败 ⚠️',
  'needs-confirmation': '需要你确认 🔐',
  'needs-discussion': '等你决定 💬',
  'test': '连通性测试 🔔',
}

/** 硬编码默认值：即使 schemastery 没参与解析，行为也完全确定。 */
const DEFAULTS = {
  enabled: false,
  transport: 'onebot',
  account: '',
  target: '',
  targetType: 'private',
  events: ['task-complete', 'needs-confirmation', 'needs-discussion'],
  rootOnly: true,
  minTurnDurationMs: 0,
  previewChars: 160,
  throttleMs: 1500,
  timeoutMs: 8000,
  retries: 2,
  maxQueue: 50,
  dryRun: false,
  onebot: {
    endpoint: 'http://127.0.0.1:3000',
    accessTokenRef: 'ONEBOT_ACCESS_TOKEN',
    actionPrivate: 'send_private_msg',
    actionGroup: 'send_group_msg',
  },
  smtp: {
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    from: '',
    passwordRef: 'QQ_SMTP_AUTH_CODE',
    subjectPrefix: '[DSH]',
  },
  webhook: {
    url: '',
    tokenRef: '',
  },
}

/** loader／设置页用的 schema。`credential-ref` 角色保证这些字段只存引用、不存密钥。 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).description('总开关；false 时插件加载但不做任何事'),
  transport: z.union(['onebot', 'smtp', 'webhook']).default(DEFAULTS.transport)
    .description('发送通道：onebot=本地 QQ 机器人桥接；smtp=QQ 邮箱；webhook=自定义中转'),
  account: z.string().default(DEFAULTS.account).description('发件 QQ 号（smtp 通道必填）'),
  target: z.string().default(DEFAULTS.target).description('接收通知的 QQ 号或邮箱'),
  targetType: z.union(['private', 'group']).default(DEFAULTS.targetType)
    .description('onebot 通道：私聊或群'),
  events: z.array(z.union(EVENT_KINDS)).default(DEFAULTS.events).role('table')
    .description('订阅哪些事件'),
  rootOnly: z.boolean().default(DEFAULTS.rootOnly).description('只对主会话发通知，忽略子代理会话'),
  minTurnDurationMs: z.number().step(1).min(0).default(DEFAULTS.minTurnDurationMs)
    .description('回合短于该毫秒数时不发「任务完成」，用来滤掉一问一答'),
  previewChars: z.number().step(1).min(0).max(2000).default(DEFAULTS.previewChars)
    .description('正文摘要最大字符数，0 表示不带摘要'),
  throttleMs: z.number().step(1).min(0).default(DEFAULTS.throttleMs).role('ms')
    .description('两次发送之间的最小间隔，避免被 QQ 限流'),
  timeoutMs: z.number().step(1).min(1000).default(DEFAULTS.timeoutMs).role('ms')
    .description('单次发送超时'),
  retries: z.number().step(1).min(0).max(5).default(DEFAULTS.retries)
    .description('失败重试次数（仅对可重试错误）'),
  maxQueue: z.number().step(1).min(1).max(1000).default(DEFAULTS.maxQueue)
    .description('待发队列上限，超出丢弃最旧的'),
  dryRun: z.boolean().default(DEFAULTS.dryRun).description('只写日志不真发，用来验证事件是否按预期触发'),
  onebot: z.object({
    endpoint: z.string().default(DEFAULTS.onebot.endpoint),
    accessTokenRef: z.string().role('credential-ref').default(DEFAULTS.onebot.accessTokenRef),
    actionPrivate: z.string().default(DEFAULTS.onebot.actionPrivate),
    actionGroup: z.string().default(DEFAULTS.onebot.actionGroup),
  }),
  smtp: z.object({
    host: z.string().default(DEFAULTS.smtp.host),
    port: z.number().step(1).min(1).max(65535).default(DEFAULTS.smtp.port),
    secure: z.boolean().default(DEFAULTS.smtp.secure),
    from: z.string().default(DEFAULTS.smtp.from),
    passwordRef: z.string().role('credential-ref').default(DEFAULTS.smtp.passwordRef),
    subjectPrefix: z.string().default(DEFAULTS.smtp.subjectPrefix),
  }),
  webhook: z.object({
    url: z.string().default(DEFAULTS.webhook.url),
    tokenRef: z.string().role('credential-ref').default(DEFAULTS.webhook.tokenRef),
  }),
})

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

/** 一层对象合并；`undefined` 不覆盖默认值，避免 schema 与手写默认值互相打架。 */
function mergeDefaults(base, override) {
  const result = { ...base }
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) continue
    const current = base[key]
    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      result[key] = mergeDefaults(current, value)
      continue
    }
    result[key] = value
  }
  return result
}

/** 把配置收敛成一份完整、确定的值。 */
export function resolveConfig(raw) {
  const merged = mergeDefaults(DEFAULTS, raw ?? {})
  // 只有「没写 events」才回落默认值；显式写 [] 表示什么都不订阅，必须尊重。
  merged.events = Array.isArray(merged.events)
    ? merged.events.filter((kind) => EVENT_KINDS.includes(kind))
    : [...DEFAULTS.events]
  // 数值字段兜底：YAML 里写成字符串时也尽量救回来。
  for (const key of ['minTurnDurationMs', 'previewChars', 'throttleMs', 'timeoutMs', 'retries', 'maxQueue']) {
    const value = Number(merged[key])
    merged[key] = Number.isFinite(value) ? value : DEFAULTS[key]
  }
  return merged
}

/** 配置体检：返回需要用户修的问题列表，空数组表示可用。 */
function validate(config) {
  const problems = []
  if (!config.target) problems.push('缺少 target（接收通知的 QQ 号 / 邮箱）')
  if (config.transport === 'smtp' && !config.account) problems.push('smtp 通道缺少 account（发件 QQ 号）')
  if (config.transport === 'webhook' && !config.webhook.url) problems.push('webhook 通道缺少 webhook.url')
  if (config.transport === 'onebot' && !config.onebot.endpoint) problems.push('onebot 通道缺少 onebot.endpoint')
  return problems
}

/** 先尝试 harness 的命名 logger，取不到就退回 console —— 两种都不会抛。 */
function createLogger(ctx) {
  let logger
  try {
    logger = typeof ctx.logger === 'function' ? ctx.logger('qq-notify') : undefined
  } catch {
    logger = undefined
  }
  const write = (level, message) => {
    try {
      const method = logger && typeof logger[level] === 'function' ? logger[level] : undefined
      if (method !== undefined) {
        method.call(logger, message)
        return
      }
      const fallback = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      fallback.call(console, `[qq-notify] ${message}`)
    } catch {
      /* 日志本身不能再制造故障 */
    }
  }
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    debug: (message) => write('debug', message),
  }
}

/** 可取消的 sleep；取消时 reject，调用方统一 catch。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 数字补零。 */
const pad = (value) => String(value).padStart(2, '0')

/** 本地时间 `YYYY-MM-DD HH:mm:ss`。 */
function formatTime(epochMs) {
  const date = new Date(epochMs)
  if (Number.isNaN(date.getTime())) return '未知时间'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 人类可读的时长：`48s` / `2m18s` / `1h02m`。 */
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m${seconds === 0 ? '' : `${pad(seconds)}s`}`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${pad(minutes % 60)}m`
}

/** 从任意路径里取最后一段，作为「工作区」显示名。 */
function workspaceName(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  const parts = cwd.split(/[\\/]+/).filter((part) => part.length > 0)
  return parts.length === 0 ? cwd : parts[parts.length - 1]
}

/** 把一条消息里的纯文本块拼起来（忽略 tool-call 等非文本块）。 */
function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const texts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      texts.push(block.text)
    }
  }
  return texts.join('\n')
}

/** 折叠空白，便于塞进一行摘要。 */
function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/* ------------------------------------------------------------------ *
 * 会话 → 通知内容
 * ------------------------------------------------------------------ */

/** 找到某个回合的 `turn/start` 事件（用于算用时和步数）。 */
function findTurnStart(events, turn) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start' && event.data?.turn === turn) return { index, event }
  }
  return undefined
}

/** 统计一个回合里模型实际产出的步数。 */
function countSteps(events, startIndex) {
  let steps = 0
  for (let index = startIndex + 1; index < events.length; index += 1) {
    if (events[index]?.type === 'assistant/message') steps += 1
  }
  return steps
}

/** 取最后一条助手文本，作为「这次做了什么」的摘要。 */
function latestAssistantText(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const text = collapse(messageText(event.data?.message))
    if (text.length > 0) return text
  }
  return ''
}

/** 会话标题：优先用 harness 的 sessionTitle 服务，取不到就退回首条用户消息。 */
function sessionTitleOf(ctx, session, events) {
  try {
    const service = ctx.get('sessionTitle')
    if (service !== undefined && typeof service.get === 'function') {
      const snapshot = service.get(session)
      if (typeof snapshot === 'string' && snapshot.trim().length > 0) return snapshot.trim()
      if (snapshot && typeof snapshot.title === 'string' && snapshot.title.trim().length > 0) {
        return snapshot.title.trim()
      }
    }
  } catch {
    /* 标题只是锦上添花，失败就降级 */
  }
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const text = collapse(messageText(event.data))
    if (text.length > 0) return truncate(text, 24)
  }
  return undefined
}

/** 解析工具调用参数（不同模型可能给对象或 JSON 字符串）。 */
function toolArguments(raw) {
  if (raw === null || raw === undefined) return {}
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return { __raw: raw }
  }
}

/**
 * 把一个会话事件翻译成一条待发通知。
 * @returns {{ kind: string, title: string, fields: Array<[string, string|undefined]>, at: number, sessionId?: string, turn?: number, dedupe: string } | undefined}
 */
function describeEvent(ctx, session, event, config) {
  const events = Array.isArray(session?.events) ? session.events : []
  const sessionId = typeof session?.id === 'string' ? session.id : ''
  const at = typeof event?.time === 'number' ? event.time : Date.now()
  const shared = { at, sessionId }

  const baseFields = () => {
    const fields = [['会话', sessionTitleOf(ctx, session, events)]]
    const workspace = workspaceName(session?.header?.cwd)
    if (workspace !== undefined) fields.push(['工作区', workspace])
    return fields
  }

  switch (event?.type) {
    case 'turn/end': {
      const reason = event.data?.reason ?? {}
      const turn = event.data?.turn
      // 用户自己按了停止、会话被释放：这两种不算「需要你知道」的结果，不打扰。
      if (reason.kind === 'aborted' || reason.kind === 'disposed' || reason.kind === 'idle') return undefined
      const kind = reason.kind === 'completed' ? 'task-complete' : 'task-failed'
      if (!config.events.includes(kind)) return undefined

      const started = findTurnStart(events, turn)
      const durationMs = started === undefined ? undefined : Math.max(0, at - started.event.time)
      if (kind === 'task-complete' && config.minTurnDurationMs > 0
        && durationMs !== undefined && durationMs < config.minTurnDurationMs) {
        return undefined
      }

      const turnText = [
        turn === undefined ? undefined : `#${turn}`,
        durationMs === undefined ? undefined : `用时 ${formatDuration(durationMs)}`,
        started === undefined ? undefined : `${countSteps(events, started.index)} 步`,
      ].filter((part) => part !== undefined).join(' · ')

      const fields = baseFields()
      if (turnText.length > 0) fields.push(['回合', turnText])

      if (kind === 'task-failed') {
        const error = reason.error
        const detail = typeof error === 'string' ? error : (error?.message ?? error?.name)
        fields.push(['原因', truncate(collapse(detail ?? '回合以错误结束'), 200)])
      }
      if (config.previewChars > 0) {
        const preview = latestAssistantText(events)
        if (preview.length > 0) fields.push(['摘要', truncate(preview, config.previewChars)])
      }
      return {
        kind,
        title: TITLES[kind],
        fields,
        ...shared,
        turn,
        dedupe: `${sessionId}#turn:${String(turn)}=${kind}`,
      }
    }

    case 'approval/asked': {
      if (!config.events.includes('needs-confirmation')) return undefined
      const toolName = event.data?.toolName
      const reason = event.data?.reason
      const fields = [['动作', toolName === undefined ? '等待授权' : `调用 ${toolName}`]]
      if (typeof reason === 'string' && reason.trim().length > 0) {
        fields.push(['原因', truncate(collapse(reason), 160)])
      }
      fields.push(...baseFields())
      return {
        kind: 'needs-confirmation',
        title: TITLES['needs-confirmation'],
        fields,
        ...shared,
        dedupe: `${sessionId}#approval:${String(event.data?.id ?? event.seq)}`,
      }
    }

    case 'tool/call': {
      const toolName = event.data?.name
      const args = toolArguments(event.data?.arguments)

      if (toolName === 'ask_user_question') {
        if (!config.events.includes('needs-discussion')) return undefined
        const questions = Array.isArray(args.questions) ? args.questions : []
        const first = questions[0] ?? {}
        const fields = [['问题', truncate(collapse(first.question ?? '模型在等你回答问题'), 160)]]
        const options = Array.isArray(first.options)
          ? first.options.map((option) => option?.label).filter((label) => typeof label === 'string')
          : []
        if (options.length > 0) fields.push(['选项', truncate(options.join(' / '), 160)])
        if (questions.length > 1) fields.push(['数量', `${questions.length} 个问题`])
        fields.push(...baseFields())
        return {
          kind: 'needs-discussion',
          title: TITLES['needs-discussion'],
          fields,
          ...shared,
          dedupe: `${sessionId}#ask:${String(event.data?.callId ?? event.seq)}`,
        }
      }

      if (toolName === 'exit_plan_mode') {
        if (!config.events.includes('needs-confirmation')) return undefined
        const fields = [['动作', '计划已就绪，等待你批准']]
        const plan = typeof args.plan === 'string' ? args.plan : ''
        if (plan.trim().length > 0 && config.previewChars > 0) {
          fields.push(['计划', truncate(collapse(plan), Math.max(80, config.previewChars))])
        }
        fields.push(...baseFields())
        return {
          kind: 'needs-confirmation',
          title: TITLES['needs-confirmation'],
          fields,
          ...shared,
          dedupe: `${sessionId}#plan:${String(event.data?.callId ?? event.seq)}`,
        }
      }

      return undefined
    }

    default:
      return undefined
  }
}

/** 拼出最终发出去的文本。 */
function formatNotice(notice, config) {
  const lines = [`[DSH] ${notice.title}`]
  for (const [label, value] of notice.fields) {
    if (value === undefined || value === null || String(value).length === 0) continue
    lines.push(`${label}: ${value}`)
  }
  lines.push(`时间: ${formatTime(notice.at)}`)
  if (notice.kind === 'test' || config.transport === 'smtp') {
    lines.push('', '—— 由 dsh-qq-notify 自动发送，请勿直接回复 ——')
  }
  return lines.join('\n')
}

/** 邮件标题。 */
function formatSubject(notice, config) {
  const prefix = config.smtp.subjectPrefix ?? '[DSH]'
  return `${prefix} ${notice.title}`.trim()
}

/* ------------------------------------------------------------------ *
 * 插件本体
 * ------------------------------------------------------------------ */

/**
 * 挂载通知插件。加载即返回，不做任何 IO；真正的发送在后台队列里。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {object} rawConfig loader 传入的配置。
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const log = createLogger(ctx)

  if (!config.enabled) {
    log.debug('未启用（enabled: false），已跳过')
    return
  }

  const problems = validate(config)
  if (problems.length > 0) {
    for (const problem of problems) log.warn(`配置问题: ${problem}`)
    log.warn('配置不完整，通知功能已停用（不影响 harness 正常运行，补齐配置后重启即可）')
    return
  }
  if (config.events.length === 0) {
    log.warn('events 为空，不会发送任何通知（想彻底关掉请把 enabled 设为 false）')
    return
  }

  const lifetime = new AbortController()
  const stats = { queued: 0, sent: 0, failed: 0, dropped: 0, lastError: null, lastSentAt: 0 }
  /** @type {Array<{ notice: object, text: string, subject: string }>} */
  const queue = []
  const seen = new Set()
  let draining = false

  /** 对同一事件只通知一次（插件热重载或事件重复时不会刷屏）。 */
  const isDuplicate = (dedupeKey) => {
    if (seen.has(dedupeKey)) return true
    if (seen.size > 512) seen.clear()
    seen.add(dedupeKey)
    return false
  }

  /** 取凭证：先问 harness 的 credentials 服务，再退回进程环境变量。 */
  const resolveSecret = async (ref) => {
    if (typeof ref !== 'string' || ref.length === 0) return undefined
    try {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined && typeof credentials.resolve === 'function') {
        const hit = await credentials.resolve(ref)
        if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
      }
    } catch (error) {
      log.warn(`读取凭据 ${ref} 失败: ${describeError(error)}`)
    }
    const ambient = process.env[ref]
    return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
  }

  /** 当前通道需要哪一份凭证。 */
  const secretRefOf = () => {
    if (config.transport === 'smtp') return config.smtp.passwordRef
    if (config.transport === 'onebot') return config.onebot.accessTokenRef
    if (config.transport === 'webhook') return config.webhook.tokenRef
    return undefined
  }

  /** 真正发一条，含重试与失败归因。 */
  const deliver = async (job) => {
    const secretRef = secretRefOf()
    let secret
    try {
      secret = await resolveSecret(secretRef)
    } catch {
      secret = undefined
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await sendNotification({
          config,
          text: job.text,
          subject: job.subject,
          secret,
          meta: job.notice,
          signal: lifetime.signal,
        })
        stats.sent += 1
        stats.lastSentAt = Date.now()
        stats.lastError = null
        log.info(`已发送「${job.notice.title}」→ ${config.target}（${result.channel}: ${result.detail}）`)
        return
      } catch (error) {
        const failure = error instanceof TransportError ? error : new TransportError(describeError(error), {
          detail: describeError(error),
          retryable: true,
          cause: error,
        })
        stats.lastError = {
          at: Date.now(),
          kind: job.notice.kind,
          code: failure.code,
          message: failure.message,
        }

        const canRetry = failure.retryable && attempt < config.retries && !lifetime.signal.aborted
        if (!canRetry) {
          stats.failed += 1
          log.warn(`发送失败（已试 ${attempt + 1} 次）: ${describeError(failure)}`)
          try {
            if (typeof ctx.emit === 'function') ctx.emit('qq-notify/failure', stats.lastError)
          } catch {
            /* 旁路事件发不出去也无所谓 */
          }
          return
        }

        const delay = Math.min(800 * 2 ** attempt, 8000)
        log.warn(`发送失败，${delay}ms 后重试（${attempt + 1}/${config.retries}）: ${failure.message}`)
        await sleep(delay, lifetime.signal).catch(() => undefined)
        if (lifetime.signal.aborted) return
      }
    }
  }

  /** 后台串行消费队列：保证顺序、遵守限流，且与主流程完全解耦。 */
  const drain = async () => {
    if (draining) return
    draining = true
    try {
      while (queue.length > 0 && !lifetime.signal.aborted) {
        const job = queue.shift()
        const wait = config.throttleMs - (Date.now() - stats.lastSentAt)
        if (wait > 0) await sleep(wait, lifetime.signal)
        if (lifetime.signal.aborted) return
        await deliver(job)
      }
    } catch (error) {
      // 理论上不会走到这里（deliver 自吞异常），兜一层防止未处理拒绝。
      log.warn(`发送队列异常（已隔离）: ${describeError(error)}`)
    } finally {
      draining = false
    }
  }

  /** 入队：同步、O(1)、不 await —— 这是「不阻塞主流程」的关键。 */
  const enqueue = (notice) => {
    if (lifetime.signal.aborted) return
    if (isDuplicate(notice.dedupe)) return

    const subject = formatSubject(notice, config)
    const text = formatNotice(notice, config)

    if (config.dryRun) {
      stats.queued += 1
      log.info(`[dryRun] ${subject}\n${text}`)
      return
    }

    if (queue.length >= config.maxQueue) {
      queue.shift()
      stats.dropped += 1
      log.warn(`待发队列已满（${config.maxQueue}），丢弃最早的一条通知`)
    }
    queue.push({ notice, text, subject })
    stats.queued += 1
    void drain()
  }

  // ---- 唯一的入口：只读旁路事件 ----
  ctx.on('session/event', (session, event) => {
    try {
      // 子代理会话默认不打扰（它们的结果会汇总到主会话里）。
      if (config.rootOnly && session?.header?.parentSession !== undefined) return
      const notice = describeEvent(ctx, session, event, config)
      if (notice !== undefined) enqueue(notice)
    } catch (error) {
      // 映射阶段的任何意外都只记一条日志，绝不让异常回到会话派发路径。
      log.warn(`事件处理失败（已忽略）: ${describeError(error)}`)
    }
  })

  // ---- 卸载：取消在途请求、清空队列 ----
  ctx.effect(() => () => {
    lifetime.abort(new Error('qq-notify disposed'))
    queue.length = 0
    log.debug('已卸载')
  }, 'qq-notify.lifetime')

  // ---- 给外部（脚本、UI）一个只读状态口子 ----
  const api = {
    get status() {
      return { ...stats, pending: queue.length, transport: config.transport, target: config.target }
    },
    /** 手动发一条：`ctx.get('qqNotify').sendTest('hello')` */
    sendTest: (message) => {
      const notice = {
        kind: 'test',
        title: TITLES.test,
        fields: [['内容', String(message ?? 'dsh-qq-notify 配置正常')]],
        at: Date.now(),
        dedupe: `test:${Date.now()}:${Math.random()}`,
      }
      enqueue(notice)
      return true
    },
  }
  try {
    if (typeof ctx.provide === 'function') ctx.provide('qqNotify', api)
  } catch {
    /* 服务名被占用时忽略即可，主功能不依赖它 */
  }

  log.info(`已启用：transport=${config.transport} · target=${config.target} · events=${config.events.join(',')}`
    + `${config.dryRun ? ' · dryRun' : ''}`)
}
