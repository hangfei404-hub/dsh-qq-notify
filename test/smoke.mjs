/**
 * dsh-qq-notify 冒烟测试：用假 ctx 驱动真实插件代码，验证
 *   ① 事件 → 通知的映射是否正确
 *   ② 不打扰的边界（用户取消、子代理会话、未订阅事件、重复事件）
 *   ③ 失败重试与「失败不抛异常」的隔离性
 *
 * 运行：node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { apply, Config, resolveConfig, EVENT_KINDS } from '../lib/index.js'

const results = []
let failures = 0

async function check(name, fn) {
  try {
    await fn()
    results.push(`  ✅ ${name}`)
  } catch (error) {
    failures += 1
    results.push(`  ❌ ${name}\n     ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

/* ------------------------------------------------------------------ *
 * 测试脚手架
 * ------------------------------------------------------------------ */

/** 构造一个只实现插件用到的那几个 API 的假 ctx。 */
function makeCtx({ credentials } = {}) {
  const listeners = new Map()
  const disposers = []
  const provided = new Map()
  const emitted = []
  const logs = []

  const record = (level) => (message) => logs.push({ level, message })

  const ctx = {
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    async emit(event, ...args) {
      emitted.push({ event, args })
      return undefined
    },
    effect(callback) {
      disposers.push(callback())
    },
    get(name) {
      if (name === 'credentials') return credentials
      return provided.get(name)
    },
    provide(name, value) {
      provided.set(name, value)
    },
    logger() {
      return { info: record('info'), warn: record('warn'), debug: record('debug'), error: record('error') }
    },
  }

  return {
    ctx,
    logs,
    emitted,
    provided,
    /** 派发一个 session/event，返回是否抛异常（应为 false）。 */
    async fire(session, event) {
      let threw = false
      for (const handler of listeners.get('session/event') ?? []) {
        try {
          await handler(session, event)
        } catch {
          threw = true
        }
      }
      return threw
    },
    /** 触发插件卸载逻辑。 */
    dispose() {
      for (const disposer of disposers) {
        if (typeof disposer === 'function') disposer()
      }
    },
  }
}

function makeSession({ id = 'sess-1', cwd = 'C:\\Users\\me\\WorkBuddy\\demo', parent, title } = {}) {
  return {
    id,
    header: {
      version: 0,
      id,
      createdAt: Date.now(),
      cwd,
      ...(parent === undefined ? {} : { parentSession: parent }),
    },
    title,
    events: [],
  }
}

/** 往会话里追加一个事件，返回该事件（插件从 session.events 里读上下文）。 */
function pushEvent(session, type, data, timeOffsetMs = 0) {
  const event = {
    type,
    seq: session.events.length,
    time: Date.now() + timeOffsetMs,
    data,
  }
  session.events.push(event)
  return event
}

/** 等某个条件成立，超时算失败。 */
async function waitFor(predicate, timeoutMs = 3000, label = '条件') {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待${label}超时（${timeoutMs}ms）`)
}

/** 记录所有 fetch 调用，并按预设队列返回响应。 */
function stubFetch(responses = []) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const next = responses.length > 1 ? responses.shift() : responses[0]
    if (next instanceof Error) throw next
    const { status = 200, body = '{"status":"ok","retcode":0,"data":{"message_id":42}}' } = next ?? {}
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
    lastBody() {
      return JSON.parse(calls[calls.length - 1].init.body)
    },
  }
}

/** 常用配置：onebot 通道 + 关闭限流，让测试跑得快。 */
function baseConfig(overrides = {}) {
  return {
    enabled: true,
    transport: 'onebot',
    target: '10001',
    throttleMs: 0,
    retries: 0,
    ...overrides,
    onebot: { endpoint: 'http://127.0.0.1:3000', ...(overrides.onebot ?? {}) },
  }
}

/** 一次「模型跑完一轮」的最小事件序列。 */
async function runCompletedTurn(harness, session, { turn = 1, durationMs = 90_000, text = '已经修好登录接口的空指针问题。' } = {}) {
  const start = pushEvent(session, 'turn/start', { turn })
  pushEvent(session, 'user/message', { role: 'user', content: [{ type: 'text', text: '帮我修一下登录 500' }] }, 10)
  pushEvent(session, 'assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } }, 20)
  const end = pushEvent(session, 'turn/end', { turn, reason: { kind: 'completed' } }, durationMs)
  // 让 turn/start 的 time 与 turn/end 之间差出 durationMs，便于断言用时格式
  start.time = end.time - durationMs
  await harness.fire(session, end)
  return end
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

async function main() {
  console.log('dsh-qq-notify 冒烟测试\n')

  await check('Config schema 可被 schemastery 正常解析（loader 会用它校验）', () => {
    const parsed = Config({ target: '10001', transport: 'smtp' })
    assert.equal(parsed.transport, 'smtp')
    assert.equal(parsed.enabled, false, 'enabled 默认必须是 false，装完不会突然开始发消息')
    assert.deepEqual(parsed.events, ['task-complete', 'needs-confirmation', 'needs-discussion'])
  })

  await check('resolveConfig 会兜住缺省值并过滤非法事件名', () => {
    const config = resolveConfig({ events: ['task-complete', 'not-an-event'], throttleMs: '3000' })
    assert.deepEqual(config.events, ['task-complete'])
    assert.equal(config.throttleMs, 3000, '字符串数字应被救回成数字')
    assert.equal(config.onebot.endpoint, 'http://127.0.0.1:3000')
    assert.ok(EVENT_KINDS.includes('needs-discussion'))
    assert.deepEqual(
      resolveConfig({ events: [] }).events,
      [],
      '显式写 events: [] 表示不订阅任何事件，不能被默认值覆盖',
    )
  })

  await check('enabled:false 时插件完全不注册监听（装好不启用=零影响）', async () => {
    const harness = makeCtx()
    apply(harness.ctx, { enabled: false })
    const session = makeSession()
    const end = pushEvent(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    assert.equal(await harness.fire(session, end), false)
    assert.equal(harness.logs.filter((entry) => entry.level === 'info').length, 0)
  })

  await check('配置不完整时只告警、不抛异常', async () => {
    const harness = makeCtx()
    apply(harness.ctx, { enabled: true, transport: 'smtp', target: '' })
    assert.ok(harness.logs.some((entry) => entry.level === 'warn' && entry.message.includes('target')))
  })

  await check('turn/end(completed) → 发送「任务完成」，字段完整', async () => {
    const fetchStub = stubFetch()
    const harness = makeCtx()
    try {
      apply(harness.ctx, baseConfig())
      const session = makeSession()
      await runCompletedTurn(harness, session, { durationMs: 138_000 })

      await waitFor(() => fetchStub.calls.length === 1, 3000, '一次发送')
      const call = fetchStub.calls[0]
      assert.ok(call.url.endsWith('/send_private_msg'), `实际 URL: ${call.url}`)
      const body = fetchStub.lastBody()
      assert.equal(body.user_id, 10001, 'QQ 号应转成数字')
      assert.equal(body.auto_escape, true, '必须禁止 CQ 码解析')

      const text = body.message
      assert.match(text, /任务完成/)
      assert.match(text, /会话: 帮我修一下登录 500/)
      assert.match(text, /回合: #1 · 用时 2m18s · 1 步/)
      assert.match(text, /工作区: demo/)
      assert.match(text, /摘要: 已经修好登录接口的空指针问题。/)
      assert.match(text, /时间: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
    } finally {
      fetchStub.restore()
      harness.dispose()
    }
  })

  await check('turn/end(aborted) 不打扰（用户自己按了停止）', async () => {
    const fetchStub = stubFetch()
    const harness = makeCtx()
    try {
      apply(harness.ctx, baseConfig())
      const session = makeSession()
      const end = pushEvent(session, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
      await harness.fire(session, end)
      await new Promise((resolve) => setTimeout(resolve, 120))
      assert.equal(fetchStub.calls.length, 0)
    } finally {
      fetchStub.restore()
      harness.dispose()
    }
  })

  await check('默认事件集合不含 task-failed，失败回合默认不打扰', async () => {
    const fetchStub = stubFetch()
    const harness = makeCtx()
    try {
      apply(harness.ctx, baseConfig())
      const session = makeSession()
      const end = pushEvent(session, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } })
      await harness.fire(session, end)
      await new Promise((resolve) => setTimeout(resolve, 120))
      assert.equal(fetchStub.calls.length, 0)
    } finally {
      fetchStub.restore()
      harness.dispose()
    }
  })

  await check('task-failed 默认不订阅（要用显式打开），打开后发送并带原因', async () => {
    const fetchStub = stubFetch()
    const harness = makeCtx()
    try {
      apply(harness.ctx, baseConfig({ events: ['task-complete', 'task-failed'] }))
      const session = makeSession()
      const end = pushEvent(session, 'turn/end', {
        turn: 2,
        reason: { kind: 'error', error: { name: 'LlmError', message: 'provider returned 429' } },
      })
      await harness.fire(session, end)
      await waitFor(() => fetchStub.calls.length === 1, 3000, '一次发送')
      const text = fetchStub.lastBody().message
      assert.match(text, /任务失败/)
      assert.match(text, /原因: provider returned 429/)
    } finally {
      fetchStub.restore()
      harness.dispose()
    }
  })

  await check('子代理会话默认不发通知（rootOnly）', async () => {
    const fetchStub = stubFetch()
    const harness = makeCtx()
    try {
      apply(harness.ctx, baseConfig())
      const child = makeSession({ id: 'child-1', parent: 'sess-1' })
      const end = pushEvent(child, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
      await harness.fire(child, end)
      await new Promise((resolve) => setTimeout(resolve, 120))
      assert.equal(fetchStub.calls.length, 0)
    } finally {
      fetchStub.restore()
      harness.dispose()
    }
  })

  await check('approval/asked → 发送「需要你确认」，带工具名与原因', async () => {
    const fetchStub = stubFetch()
    const harness = makeCtx()
    try {
      apply(harness.ctx, baseConfig())
      const session = makeSession()
      const asked = pushEvent(session, 'approval/asked', {
        id: 'ap-1',
        toolName: 'bash',
        callId: 'call-1',
        reason: '需要在沙箱外执行 rm -rf build',
      })
      await harness.fire(session, asked)
      await waitFor(() => fetchStub.calls.length === 1, 3000, '一次发送')
      const text = fetchStub.lastBody().message
      assert.match(text, /需要你确认/)
      assert.match(text, /动作: 调用 bash/)
      assert.match(text, /原因: 需要在沙箱外执行 rm -rf build/)
    } finally {
      fetchStub.restore()
      harness.dispose()
    }
  })

  await check('ask_user_question → 发送「等你决定」，带问题与选项', async () => {
    const fetchStub = stubFetch()
    const harness = makeCtx()
    try {
      apply(harness.ctx, baseConfig())
      const session = makeSession()
      const call = pushEvent(session, 'tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-9',
        name: 'ask_user_question',
        arguments: {
          questions: [{
            id: 'q1',
            question: '数据库迁移用哪种方式？',
            options: [{ label: '在线迁移 (Recommended)' }, { label: '停机迁移' }],
          }],
        },
      })
      await harness.fire(session, call)
      await waitFor(() => fetchStub.calls.length === 1, 3000, '一次发送')
      const text = fetchStub.lastBody().message
      assert.match(text, /等你决定/)
      assert.match(text, /问题: 数据库迁移用哪种方式？/)
      assert.match(text, /选项: 在线迁移 \(Recommended\) \/ 停机迁移/)
    } finally {
      fetchStub.restore()
      harness.dispose()
    }
  })

  await check('exit_plan_mode → 也归入「需要你确认」', async () => {
    const fetchStub = stubFetch()
    const harness = makeCtx()
    try {
      apply(harness.ctx, baseConfig())
      const session = makeSession()
      const call = pushEvent(session, 'tool/call', {
        callId: 'call-plan',
        name: 'exit_plan_mode',
        arguments: { plan: '1. 抽公共组件 2. 补测试' },
      })
      await harness.fire(session, call)
      await waitFor(() => fetchStub.calls.length === 1, 3000, '一次发送')
      const text = fetchStub.lastBody().message
      assert.match(text, /需要你确认/)
      assert.match(text, /计划已就绪/)
      assert.match(text, /抽公共组件/)
    } finally {
      fetchStub.restore()
      harness.dispose()
    }
  })

  await check('events 白名单生效：只订阅 needs-confirmation 时忽略任务完成', async () => {
    const fetchStub = stubFetch()
    const harness = makeCtx()
    try {
      apply(harness.ctx, baseConfig({ events: ['needs-confirmation'] }))
      const session = makeSession()
      await runCompletedTurn(harness, session)
      await new Promise((resolve) => setTimeout(resolve, 120))
      assert.equal(fetchStub.calls.length, 0)
    } finally {
      fetchStub.restore()
      harness.dispose()
    }
  })

  await check('minTurnDurationMs 能滤掉短回合', async () => {
    const fetchStub = stubFetch()
    const harness = makeCtx()
    try {
      apply(harness.ctx, baseConfig({ minTurnDurationMs: 60_000 }))
      const session = makeSession()
      await runCompletedTurn(harness, session, { durationMs: 3_000 })
      await new Promise((resolve) => setTimeout(resolve, 120))
      assert.equal(fetchStub.calls.length, 0)
    } finally {
      fetchStub.restore()
      harness.dispose()
    }
  })

  await check('同一事件重复到达只发一次（去重）', async () => {
    const fetchStub = stubFetch()
    const harness = makeCtx()
    try {
      apply(harness.ctx, baseConfig())
      const session = makeSession()
      const end = await runCompletedTurn(harness, session)
      await harness.fire(session, end)
      await harness.fire(session, end)
      await waitFor(() => fetchStub.calls.length >= 1, 3000, '一次发送')
      await new Promise((resolve) => setTimeout(resolve, 120))
      assert.equal(fetchStub.calls.length, 1)
    } finally {
      fetchStub.restore()
      harness.dispose()
    }
  })

  await check('群消息走 send_group_msg 且用 group_id', async () => {
    const fetchStub = stubFetch()
    const harness = makeCtx()
    try {
      apply(harness.ctx, baseConfig({ targetType: 'group', target: '55555' }))
      const session = makeSession()
      await runCompletedTurn(harness, session)
      await waitFor(() => fetchStub.calls.length === 1, 3000, '一次发送')
      assert.ok(fetchStub.calls[0].url.endsWith('/send_group_msg'))
      assert.equal(fetchStub.lastBody().group_id, 55555)
    } finally {
      fetchStub.restore()
      harness.dispose()
    }
  })

  await check('发送失败（5xx）会重试，成功即止', async () => {
    const fetchStub = stubFetch([
      { status: 500, body: 'boom' },
      { status: 200 },
    ])
    const harness = makeCtx()
    try {
      apply(harness.ctx, baseConfig({ retries: 2 }))
      const session = makeSession()
      await runCompletedTurn(harness, session)
      await waitFor(() => harness.provided.get('qqNotify').status.sent === 1, 5000, '重试后成功')
      assert.equal(fetchStub.calls.length, 2)
      const status = harness.provided.get('qqNotify').status
      assert.equal(status.failed, 0)
      assert.ok(harness.logs.some((entry) => entry.level === 'warn' && entry.message.includes('重试')))
    } finally {
      fetchStub.restore()
      harness.dispose()
    }
  })

  await check('终态失败时给出反馈、计入 failed，且不外抛异常', async () => {
    const fetchStub = stubFetch([new Error('ECONNREFUSED 127.0.0.1:3000')])
    const harness = makeCtx()
    try {
      apply(harness.ctx, baseConfig({ retries: 0 }))
      const session = makeSession()
      const end = await runCompletedTurn(harness, session)
      assert.equal(await harness.fire(session, end), false, '内部异常不能让监听器抛出')
      await waitFor(() => harness.provided.get('qqNotify').status.failed === 1, 3000, '失败计数')
      const status = harness.provided.get('qqNotify').status
      assert.equal(status.sent, 0)
      assert.equal(status.lastError.code, 'NETWORK')
      assert.equal(status.lastError.kind, 'task-complete')
      assert.ok(harness.logs.some((entry) => entry.level === 'warn' && entry.message.includes('建议:')))
      // 失败也要通过旁路事件告诉外部
      assert.ok(harness.emitted.some((entry) => entry.event === 'qq-notify/failure'))
    } finally {
      fetchStub.restore()
      harness.dispose()
    }
  })

  await check('鉴权失败不重试（retryable=false）', async () => {
    const fetchStub = stubFetch([{ status: 401, body: 'unauthorized' }])
    const harness = makeCtx()
    try {
      apply(harness.ctx, baseConfig({ retries: 3 }))
      const session = makeSession()
      await runCompletedTurn(harness, session)
      await waitFor(() => harness.provided.get('qqNotify').status.failed === 1, 3000, '失败计数')
      assert.equal(fetchStub.calls.length, 1, '401 不应重试')
    } finally {
      fetchStub.restore()
      harness.dispose()
    }
  })

  await check('dryRun 只写日志、不发请求', async () => {
    const fetchStub = stubFetch()
    const harness = makeCtx()
    try {
      apply(harness.ctx, baseConfig({ dryRun: true }))
      const session = makeSession()
      await runCompletedTurn(harness, session)
      await new Promise((resolve) => setTimeout(resolve, 120))
      assert.equal(fetchStub.calls.length, 0)
      assert.ok(harness.logs.some((entry) => entry.message.includes('[dryRun]')))
    } finally {
      fetchStub.restore()
      harness.dispose()
    }
  })

  await check('可从 credentials 服务取令牌，并放进 Authorization 头', async () => {
    const fetchStub = stubFetch()
    const harness = makeCtx({
      credentials: {
        async resolve(ref) {
          return ref === 'ONEBOT_ACCESS_TOKEN' ? { value: 'secret-token', source: 'file' } : undefined
        },
      },
    })
    try {
      apply(harness.ctx, baseConfig())
      const session = makeSession()
      await runCompletedTurn(harness, session)
      await waitFor(() => fetchStub.calls.length === 1, 3000, '一次发送')
      assert.equal(fetchStub.calls[0].init.headers.authorization, 'Bearer secret-token')
    } finally {
      fetchStub.restore()
      harness.dispose()
    }
  })

  await check('卸载后不再发送（effect 清理生效）', async () => {
    const fetchStub = stubFetch()
    const harness = makeCtx()
    try {
      apply(harness.ctx, baseConfig())
      harness.dispose()
      const session = makeSession()
      await runCompletedTurn(harness, session)
      await new Promise((resolve) => setTimeout(resolve, 120))
      assert.equal(fetchStub.calls.length, 0)
    } finally {
      fetchStub.restore()
      harness.dispose()
    }
  })

  console.log(results.join('\n'))
  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}（共 ${results.length} 项）`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('测试自身异常:', error)
  process.exitCode = 1
})
