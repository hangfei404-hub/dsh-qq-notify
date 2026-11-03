/**
 * dsh-qq-notify / credentials-file — 只供自测 CLI 使用的「顺手读一下凭证文件」。
 *
 * 注意：插件本体**不走这里**，它用 `ctx.credentials.resolve(ref)` 让 harness 自己解析。
 * 这个模块只是为了让 `node lib/cli.js` 能在不启动 harness 的情况下也能读到密钥。
 *
 * 需要同时认识两种文档布局：
 *
 *   // 0.2.x（当前）：版本化文档，密钥在 refs 下
 *   version: 1
 *   refs:
 *     DEEPSEEK_API_KEY: sk-...
 *     QQ_SMTP_AUTH_CODE: abcdefghijklmnop
 *   records:
 *     client-connection/browser-session:
 *       kind: grant
 *       payload: {...}
 *
 *   // 0.1.x（预发布）：一层扁平映射
 *   DEEPSEEK_API_KEY: sk-...
 *
 * 只做「取一个键」这件事，所以不引入 YAML 依赖；解析失败一律返回 undefined，
 * 让调用方回落到环境变量，而不是猜一个值。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 默认凭证文件位置：`$DSH_HOME/.credentials.yaml`，DSH_HOME 缺省为 `~/.dsh`。 */
export function defaultCredentialsPath() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, '.credentials.yaml')
}

/** 去掉值两端成对的引号，并还原最常见的转义。 */
function unquote(raw) {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  // 未加引号时，YAML 里 ` #` 之后是注释
  const hash = value.search(/\s#/)
  return (hash < 0 ? value : value.slice(0, hash)).trim()
}

/** 拆分 `key: value`（忽略行首缩进）；不是这种形状就返回 undefined。 */
function splitEntry(line) {
  const match = /^([^\s:#][^:#]*?)\s*:\s*(.*)$/.exec(line.trimStart())
  if (match === null) return undefined
  return { key: match[1].trim(), raw: match[2] }
}

/** 统计行首空格数。 */
function indentOf(line) {
  return line.length - line.trimStart().length
}

/**
 * 从凭证文件里取一个引用名的值。
 * @param {string} ref 引用名（POSIX 标识符形状）。
 * @param {{ path?: string }} [options] 覆盖默认路径。
 * @returns {string | undefined} 取不到时返回 undefined（不抛异常）。
 */
export function readCredentialFromFile(ref, options = {}) {
  const filename = options.path ?? defaultCredentialsPath()
  let text
  try {
    text = fs.readFileSync(filename, 'utf8')
  } catch {
    return undefined
  }
  return parseCredentialText(text, ref)
}

/**
 * 从文档正文里取一个引用名的值（与文件 IO 解耦，便于测试）。
 * @param {string} text 文档正文。
 * @param {string} ref 引用名。
 * @returns {string | undefined}
 */
export function parseCredentialText(text, ref) {
  const lines = text.split(/\r?\n/)

  /** 顶层出现 `version:` 就是版本化文档：此时只认 `refs` 段，绝不回落到根键。 */
  const versioned = lines.some((line) => (
    indentOf(line) === 0 && splitEntry(line)?.key === 'version'
  ))

  if (versioned) {
    let refsIndent = -1
    for (const line of lines) {
      const entry = splitEntry(line)
      if (entry === undefined || entry.key !== 'refs') continue
      refsIndent = indentOf(line)
      break
    }
    // 没有 refs 段（或写成 `refs: {}`）就是「没有任何密钥」
    if (refsIndent < 0) return undefined

    /** refs 段内第一个非空行的缩进，就是成员缩进。 */
    let memberIndent
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim().length === 0) continue
      const indent = indentOf(line)
      if (indent <= refsIndent) continue
      memberIndent ??= indent
      if (indent !== memberIndent) continue
      const entry = splitEntry(line)
      if (entry === undefined || entry.key !== ref) continue
      return readValue(lines, index, memberIndent, entry.raw)
    }
    return undefined
  }

  // 预发布的扁平布局：只认顶层（无缩进）的 key。
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    if (indentOf(line) !== 0) continue
    const entry = splitEntry(line)
    if (entry === undefined || entry.key !== ref) continue
    return readValue(lines, index, 0, entry.raw)
  }
  return undefined
}

/** 读取一个条目的值，支持 `|` / `>` 块标量。 */
function readValue(lines, index, indent, raw) {
  const inline = raw.trim()
  const blockMatch = /^([|>])[+-]?$/.exec(inline)
  if (blockMatch === null) {
    const value = unquote(inline)
    return value.length > 0 ? value : undefined
  }
  // 块标量：收集后续更深缩进的行
  const collected = []
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    if (line.trim().length === 0) {
      collected.push('')
      continue
    }
    if (indentOf(line) <= indent) break
    collected.push(line.trimStart())
  }
  const joined = blockMatch[1] === '|' ? collected.join('\n') : collected.join(' ')
  const value = joined.trim()
  return value.length > 0 ? value : undefined
}
