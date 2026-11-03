/**
 * dsh-qq-notify 通道测试（真实 HTTP 往返）。
 *
 * smoke.mjs 用假 fetch 验证「插件决策对不对」，这里起一个真的 HTTP 服务器，
 * 验证「发出去的报文符不符合 OneBot v11 / webhook 的约定」：
 *
 *   • onebot 成功：URL、user_id/group_id 类型、auto_escape、Bearer 令牌
 *   • onebot 被拒（retcode 100）：归类为不可重试
 *   • onebot 返回非 JSON：归类为不可重试
 *   • webhook 成功：JSON 字段完整
 *   • webhook 429：归为可重试
 *
 * 运行：node test/webhook.mjs（需要在非沙箱环境，因为要监听本地端口）
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { describeError, sendNotification, TransportError } from '../lib/transports.js'

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

/** 起一个只回固定响应的本地 HTTP 服务器，并记录收到的请求。 */
async function startServer(handler) {
  const received = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      received.push({ method: request.method, url: request.url, headers: request.headers, body })
      handler(request, response, body)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    received,
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function jsonResponse(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

function onebotConfig(port, overrides = {}) {
  return {
    transport: 'onebot',
    target: '10001',
    targetType: 'private',
    timeoutMs: 4000,
    onebot: {
      endpoint: `http://127.0.0.1:${port}`,
      actionPrivate: 'send_private_msg',
      actionGroup: 'send_group_msg',
      ...(overrides.onebot ?? {}),
    },
    ...overrides,
  }
}

const payload = {
  text: '[DSH] 任务完成 ✅\n会话: demo',
  subject: '[DSH] 任务完成 ✅',
  meta: { kind: 'task-complete', sessionId: 'sess-1', turn: 3, at: 1761228000000 },
}

async function main() {
  console.log('dsh-qq-notify 通道测试\n')

  await check('onebot：URL/报文符合 OneBot v11 约定，成功即返回', async () => {
    const server = await startServer((request, response) => jsonResponse(response, 200, {
      status: 'ok', retcode: 0, data: { message_id: 889 },
    }))
    try {
      const result = await sendNotification({
        ...payload,
        config: onebotConfig(server.port),
        secret: 'tok-123',
      })
      assert.equal(result.channel, 'onebot')
      assert.match(result.detail, /889/)

      const request = server.received[0]
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/send_private_msg')
      assert.equal(request.headers.authorization, 'Bearer tok-123')
      const body = JSON.parse(request.body)
      assert.equal(body.user_id, 10001, 'QQ 号必须是数字，不是字符串')
      assert.equal(body.auto_escape, true)
      assert.equal(body.message, payload.text)
    } finally {
      await server.close()
    }
  })

  await check('onebot：群消息用 send_group_msg + group_id', async () => {
    const server = await startServer((request, response) => jsonResponse(response, 200, {
      status: 'ok', retcode: 0, data: { message_id: 1 },
    }))
    try {
      await sendNotification({
        ...payload,
        config: onebotConfig(server.port, { targetType: 'group', target: '55555' }),
      })
      const request = server.received[0]
      assert.equal(request.url, '/send_group_msg')
      assert.equal(JSON.parse(request.body).group_id, 55555)
    } finally {
      await server.close()
    }
  })

  await check('onebot：retcode 非 0 归为不可重试的拒绝', async () => {
    const server = await startServer((request, response) => jsonResponse(response, 200, {
      status: 'failed', retcode: 100, wording: '账号未登录',
    }))
    try {
      await assert.rejects(
        () => sendNotification({ ...payload, config: onebotConfig(server.port) }),
        (error) => {
          assert.ok(error instanceof TransportError)
          assert.equal(error.code, 'ONEBOT_REJECTED')
          assert.equal(error.retryable, false)
          assert.match(error.hint ?? '', /未登录|好友/)
          return true
        },
      )
    } finally {
      await server.close()
    }
  })

  await check('onebot：返回非 JSON 时明确指出 endpoint 可能填错', async () => {
    const server = await startServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html>not an onebot server</html>')
    })
    try {
      await assert.rejects(
        () => sendNotification({ ...payload, config: onebotConfig(server.port) }),
        (error) => {
          assert.equal(error.code, 'ONEBOT_BAD_JSON')
          assert.equal(error.retryable, false)
          return true
        },
      )
    } finally {
      await server.close()
    }
  })

  await check('webhook：JSON 字段完整，成功即返回', async () => {
    const server = await startServer((request, response) => {
      response.writeHead(204)
      response.end()
    })
    try {
      const result = await sendNotification({
        ...payload,
        config: {
          transport: 'webhook',
          target: 'me',
          timeoutMs: 4000,
          webhook: { url: `http://127.0.0.1:${server.port}/hook`, tokenRef: 'X' },
        },
        secret: 'hook-token',
      })
      assert.equal(result.channel, 'webhook')
      const request = server.received[0]
      assert.equal(request.headers.authorization, 'Bearer hook-token')
      const body = JSON.parse(request.body)
      assert.equal(body.event, 'task-complete')
      assert.equal(body.title, payload.subject)
      assert.equal(body.message, payload.text)
      assert.equal(body.sessionId, 'sess-1')
      assert.equal(body.turn, 3)
      assert.equal(body.at, new Date(payload.meta.at).toISOString())
    } finally {
      await server.close()
    }
  })

  await check('webhook：429 归为可重试', async () => {
    const server = await startServer((request, response) => {
      response.writeHead(429)
      response.end('slow down')
    })
    try {
      await assert.rejects(
        () => sendNotification({
          ...payload,
          config: {
            transport: 'webhook',
            target: 'me',
            timeoutMs: 4000,
            webhook: { url: `http://127.0.0.1:${server.port}/hook`, tokenRef: 'X' },
          },
        }),
        (error) => {
          assert.equal(error.code, 'WEBHOOK_HTTP')
          assert.equal(error.retryable, true)
          return true
        },
      )
    } finally {
      await server.close()
    }
  })

  await check('未知通道立刻失败（配置写错不会静默）', async () => {
    await assert.rejects(
      () => sendNotification({ ...payload, config: { transport: 'qq-direct', target: '1', timeoutMs: 100 } }),
      (error) => {
        assert.equal(error.code, 'UNKNOWN_TRANSPORT')
        assert.equal(error.retryable, false)
        return true
      },
    )
  })

  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}（共 ${checks} 项）`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('测试自身异常:', error)
  process.exitCode = 1
})
