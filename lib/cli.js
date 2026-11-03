#!/usr/bin/env node
/**
 * dsh-qq-notify / cli — 配置自测工具。
 *
 * 用来回答「我的配置到底能不能发出去」这个问题，不必等 harness 真的跑完一个任务：
 *
 *   node lib/cli.js --config qq-notify.json
 *   node lib/cli.js --transport smtp --account 123456789 --target 987654321
 *   node lib/cli.js --transport onebot --target 987654321 --endpoint http://127.0.0.1:3000
 *
 * 只做一件事：按配置发一条「连通性测试」，然后把结果和修复建议打印出来。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describeError, sendNotification, TransportError } from './transports.js'
import { defaultCredentialsPath, readCredentialFromFile } from './credentials-file.js'
import { resolveConfig } from './index.js'

const HELP = `
dsh-qq-notify 配置自测

用法:
  node lib/cli.js [选项]

配置文件:
  --config <file>        JSON 配置文件（字段与 cordis.patch.yml 里的 config 一致）

命令行直配（不写配置文件时使用）:
  --transport <name>     onebot | smtp | webhook
  --account <qq>         发件 QQ 号（smtp 必填）
  --target <qq|email>    接收通知的 QQ 号 / 邮箱
  --target-type <type>   private | group（onebot 用）
  --endpoint <url>       OneBot HTTP 根地址，默认 http://127.0.0.1:3000
  --url <url>            webhook 地址
  --host <host>          SMTP 主机，默认 smtp.qq.com
  --port <port>          SMTP 端口，默认 465
  --no-secure            SMTP 使用明文连接 + STARTTLS（587 端口）
  --from <email>         发件地址，默认 <account>@qq.com

凭证:
  --password-env <NAME>     从哪个环境变量读密钥（默认读配置里的 credential 引用名）
  --credentials-file <path> 指定凭证文件，默认 $DSH_HOME/.credentials.yaml
  --no-credentials-file     完全不读凭证文件，只用环境变量

其他:
  --message <text>       测试消息内容
  --dry-run              只打印将要发送的内容，不真的发送
  -h, --help             显示本帮助
`.trim()

/** 极简参数解析：只认 `--key value` 与 `--flag`。 */
function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      options[key] = true
      continue
    }
    options[key] = next
    index += 1
  }
  return options
}

/** 读取 JSON 配置文件。 */
function readJsonConfig(filePath) {
  const absolute = path.resolve(filePath)
  const text = fs.readFileSync(absolute, 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${absolute} 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const options = parseArgs(argv)

  if (options.help === true || argv.length === 0) {
    console.log(HELP)
    return 0
  }

  // 1. 组装配置：文件优先，命令行覆盖单个字段。
  let raw = {}
  if (typeof options.config === 'string') {
    raw = readJsonConfig(options.config)
  }
  const overrides = {
    transport: options.transport,
    account: options.account,
    target: options.target,
    targetType: options['target-type'],
    dryRun: options['dry-run'] === true ? true : undefined,
    onebot: {
      endpoint: options.endpoint,
    },
    smtp: {
      host: options.host,
      port: options.port === undefined ? undefined : Number(options.port),
      secure: options['no-secure'] === true ? false : undefined,
      from: options.from,
    },
    webhook: {
      url: options.url,
    },
  }
  if (overrides.smtp.secure === false && options.port === undefined) overrides.smtp.port = 587
  if (raw.transport === undefined && overrides.transport === undefined) overrides.transport = 'onebot'
  raw = { ...raw, ...stripUndefined(overrides) }
  raw.enabled = true
  raw.events = raw.events ?? ['task-complete']

  const config = resolveConfig(raw)

  // 2. 找密钥。
  const secretRef = config.transport === 'smtp'
    ? config.smtp.passwordRef
    : config.transport === 'onebot' ? config.onebot.accessTokenRef : config.webhook.tokenRef
  const envName = typeof options['password-env'] === 'string' ? options['password-env'] : secretRef
  let secret
  if (typeof envName === 'string' && envName.length > 0) {
    secret = process.env[envName]
  }
  if (secret === undefined && options['no-credentials-file'] !== true && typeof secretRef === 'string') {
    const credentialsPath = typeof options['credentials-file'] === 'string'
      ? path.resolve(options['credentials-file'])
      : defaultCredentialsPath()
    secret = readCredentialFromFile(secretRef, { path: credentialsPath })
    if (secret !== undefined) {
      console.log(`（密钥取自 ${credentialsPath} 里的 ${secretRef}）`)
    } else {
      console.log(`（在 ${credentialsPath} 里没找到 ${secretRef}，继续尝试不带密钥发送）`)
    }
  }

  // 3. 发送。
  const message = typeof options.message === 'string'
    ? options.message
    : '这是一条来自 dsh-qq-notify 的连通性测试，收到即表示配置可用。'
  const text = [
    '[DSH] 连通性测试 🔔',
    `通道: ${config.transport}`,
    `目标: ${config.target}`,
    `时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    message,
    '',
    '—— 由 dsh-qq-notify 自动发送，请勿直接回复 ——',
  ].join('\n')

  console.log(`通道 ${config.transport} → ${config.target}${config.targetType === 'group' ? '（群）' : ''}`)
  console.log('----- 将要发送的内容 -----')
  console.log(text)
  console.log('--------------------------')

  if (config.dryRun) {
    console.log('dryRun 已开启，未实际发送。')
    return 0
  }

  try {
    const result = await sendNotification({
      config,
      text,
      subject: `${config.smtp.subjectPrefix ?? '[DSH]'} 连通性测试`,
      secret,
      meta: { kind: 'test' },
    })
    console.log(`\n✅ 发送成功（${result.channel}）：${result.detail}`)
    return 0
  } catch (error) {
    const failure = error instanceof TransportError ? error : undefined
    // describeError 已经带上「详情 / 建议」，这里不再重复打印
    console.error(`\n❌ 发送失败：${describeError(error)}`)
    if (config.transport === 'onebot') {
      console.error('   排查顺序：1) OneBot 桥接进程是否在跑 2) endpoint 是否指向 HTTP 服务根地址'
        + ' 3) 机器人账号是否已登录 4) accessTokenRef 是否与桥接配置一致')
    }
    if (config.transport === 'smtp') {
      console.error('   排查顺序：1) 授权码是否已开通并写入凭证  2) account 是否为纯 QQ 号'
        + ' 3) 网络是否能直连 smtp.qq.com:465')
    }
    return 1
  }
}

/** 去掉值为 undefined 的键（命令行没给的项不覆盖配置文件）。 */
function stripUndefined(value) {
  if (value === null || typeof value !== 'object') return value
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    const cleaned = stripUndefined(item)
    if (cleaned !== undefined) result[key] = cleaned
  }
  return Object.keys(result).length === 0 ? undefined : result
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
