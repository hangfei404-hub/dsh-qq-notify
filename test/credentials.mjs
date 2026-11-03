/**
 * 凭证文件解析测试。
 *
 * 这里只测「自测 CLI 顺手读密钥」的那点逻辑，但它必须覆盖两种真实布局：
 *   • 0.2.x 的版本化文档（密钥在 refs 下）—— 当前发行版
 *   • 0.1.x 的扁平文档（密钥在顶层）—— 旧预发布版，harness 启动时会自动迁移
 *
 * 搞错的后果很具体：把键写到根上，harness 会当成「外来键」忽略并告警，
 * 发送时就报「未取到授权码」，人却以为已经存好了。
 *
 * 运行：node test/credentials.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseCredentialText, readCredentialFromFile } from '../lib/credentials-file.js'

let checks = 0
let failures = 0

function check(name, fn) {
  checks += 1
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  ❌ ${name}\n     ${String(error?.message ?? error).split('\n')[0]}`)
  }
}

const REF = 'QQ_SMTP_AUTH_CODE'

/** 与你这台机器上真实文件同构的版本化文档。 */
const VERSIONED = `version: 1
refs:
  DEEPSEEK_API_KEY: sk-0123456789abcdef
  QQ_SMTP_AUTH_CODE: abcdefghijklmnop
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: should-not-be-returned
  deepseek-account-platform/device:
    kind: grant
    payload:
      id: 11111111-2222-3333-4444-555555555555
`

function main() {
  console.log('dsh-qq-notify 凭证文件解析测试\n')

  check('版本化文档：能从 refs 段取到密钥', () => {
    assert.equal(parseCredentialText(VERSIONED, REF), 'abcdefghijklmnop')
  })

  check('版本化文档：不会误取 records 里的同名字段', () => {
    assert.equal(parseCredentialText(VERSIONED, 'secret'), undefined)
    assert.equal(parseCredentialText(VERSIONED, 'id'), undefined)
    assert.equal(parseCredentialText(VERSIONED, 'payload'), undefined)
  })

  check('版本化文档：refs 里的其它引用也能取到', () => {
    assert.equal(parseCredentialText(VERSIONED, 'DEEPSEEK_API_KEY'), 'sk-0123456789abcdef')
  })

  check('版本化文档：不存在的引用返回 undefined', () => {
    assert.equal(parseCredentialText(VERSIONED, 'QQ_NOT_SET'), undefined)
  })

  check('扁平旧布局：顶层键仍能取到（迁移前的文件）', () => {
    const flat = `DEEPSEEK_API_KEY: sk-abc\n${REF}: defghijklmnopqrs\n`
    assert.equal(parseCredentialText(flat, REF), 'defghijklmnopqrs')
  })

  check('引号包裹的值会去掉引号', () => {
    const doc = `version: 1\nrefs:\n  ${REF}: "abcdef ghij"\n`
    assert.equal(parseCredentialText(doc, REF), 'abcdef ghij')
    const single = `version: 1\nrefs:\n  ${REF}: 'abcdefghijklmnop'\n`
    assert.equal(parseCredentialText(single, REF), 'abcdefghijklmnop')
  })

  check('未加引号时行尾注释不算值的一部分', () => {
    const doc = `version: 1\nrefs:\n  ${REF}: abcdefghijklmnop  # 2026-10 生成\n`
    assert.equal(parseCredentialText(doc, REF), 'abcdefghijklmnop')
  })

  check('注释行与空行不影响解析', () => {
    const doc = [
      '# 我的密钥',
      'version: 1',
      'refs:',
      '',
      '  # 邮箱授权码',
      `  ${REF}: abcdefghijklmnop`,
      '',
      'records: {}',
      '',
    ].join('\n')
    assert.equal(parseCredentialText(doc, REF), 'abcdefghijklmnop')
  })

  check('空值视为「没有这个密钥」（harness 也是这个语义）', () => {
    assert.equal(parseCredentialText(`version: 1\nrefs:\n  ${REF}: ""\n`, REF), undefined)
    assert.equal(parseCredentialText(`version: 1\nrefs:\n  ${REF}:\n`, REF), undefined)
  })

  check('把键错写在根上（常见错误）时取不到，而不是返回错值', () => {
    const wrong = `version: 1\n${REF}: abcdefghijklmnop\nrefs: {}\n`
    assert.equal(parseCredentialText(wrong, REF), undefined)
  })

  check('块标量值也能读（多行密钥的极端情况）', () => {
    const doc = `version: 1\nrefs:\n  ${REF}: |\n    line-one\n    line-two\nother: x\n`
    assert.equal(parseCredentialText(doc, REF), 'line-one\nline-two')
  })

  check('文件不存在时安静返回 undefined，不抛异常', () => {
    assert.equal(readCredentialFromFile(REF, { path: path.join(os.tmpdir(), 'no-such-credentials.yaml') }), undefined)
  })

  check('真实文件路径可读（临时文件往返）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qq-cred-'))
    const file = path.join(dir, '.credentials.yaml')
    fs.writeFileSync(file, VERSIONED, 'utf8')
    try {
      assert.equal(readCredentialFromFile(REF, { path: file }), 'abcdefghijklmnop')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}（共 ${checks} 项）`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
