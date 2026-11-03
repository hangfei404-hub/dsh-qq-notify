# dsh-qq-notify

给 [DeepSeek Harness](https://github.com/deepseek-ai) 加一条「人不在电脑前也能知道进展」的通道：
任务跑完、需要你拍板、或者需要你确认一个高权限操作时，往你的 QQ 推一条消息。

- **只读旁路**：只订阅 `session/event`，不写会话、不进模型上下文、不影响任务本身。
- **不新增依赖**：网络代码只用 `node:` 内置模块；唯一的外部 import 是 harness 自带的
  `@deepseek-ai/schemastery`（声明配置 schema 用），不会给 harness 的依赖树加东西。
- **凭证不落配置**：配置里只写「引用名」，真正的密码／令牌走 harness 自己的
  `ctx.credentials`（落盘在 `$DSH_HOME/.credentials.yaml`）。
- **失败可查**：超时、重试、错误归因、修复建议，全部写进日志，并可通过 CLI 一键自测。

---

## 一、三条通道，先选一条

| 通道 | `transport` | 消息落在哪 | 需要什么 | 适合 |
|---|---|---|---|---|
| OneBot 机器人 | `onebot` | QQ 聊天窗口（实时） | 本地跑一个 QQ 桥接进程 | 想要「跟微信一样秒收」 |
| QQ 邮箱 | `smtp` | QQ 邮箱 / 手机 QQ 邮箱提醒 | QQ 号 + SMTP 授权码 | 不想装任何东西，纯出站网络 |
| 自定义中转 | `webhook` | 由你的中转服务决定 | 一个 HTTP 地址 | 已有 Server酱／ntfy／自建推送 |

### 关于「用 QQ 号和密码登录发消息」

这件事得说清楚，因为它决定了插件长什么样：

1. **QQ 登录密码不能用来发消息。** 早期 SmartQQ 那套 Web 协议早已下线，现在能登录的
   协议（NTQQ）是加密 + 设备指纹 + 动态签名的私有协议，没有任何仍在维护的开源库可以
   只靠「QQ 号 + 密码」在 Node 里稳定登录。硬写一个必然是装上去就掉线。
2. **就算写出来也不该把密码存在插件里。** 明文密码落到配置或凭证文件里，一旦泄露就是
   账号级风险，而且用非官方协议登录本身违反 QQ 用户协议，有封号风险。
3. **所以插件把「账号凭证」拆成了两半，各放该放的地方：**
   - 想要**官方支持的账号凭证**（`QQ号 + 授权码`）→ 用 `smtp` 通道，凭证由
     `ctx.credentials` 保管，插件只按引用名取值。
   - 想要**发到 QQ 聊天窗口**→ 用 `onebot` 通道，把「登录 QQ」这件事交给专门的桥接
     进程（NapCat / LLOneBot / Lagrange / go-cqhttp 等）。如果桥接是 **Lagrange**，它
     支持账号密码登录；密码写在 Lagrange 自己的配置里，仍然不经过本插件。

---

## 二、安装

环境要求：DeepSeek Harness 0.2.x（0.1.x 也能用，只是凭证文件格式不同，见第四节）、Node ≥ 18。

### 1. 放进 profile 的插件目录

```bash
git clone https://github.com/hangfei404-hub/dsh-qq-notify.git
cp -r dsh-qq-notify ~/.dsh/profiles/desktop/plugins/
```

Windows（PowerShell）：

```powershell
git clone https://github.com/hangfei404-hub/dsh-qq-notify.git
Copy-Item -Recurse dsh-qq-notify "$env:USERPROFILE\.dsh\profiles\desktop\plugins\"
```

### 2. 在 profile 配置里加一行

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
# 新增行必须写在 insert: 下面。顶层带 id 的条目表示「覆盖已存在的行」，
# 写成顶层形式会得到 `patch: entry "qq-notify" not found`。
- insert:
    - id: qq-notify
      name: './plugins/dsh-qq-notify/lib/index.js'
      config:
        enabled: true
        transport: smtp
        account: '100012345'          # 发件 QQ 号
        target: '100067890'           # 收件 QQ 号
        events: [task-complete, needs-confirmation, needs-discussion]
        smtp:
          passwordRef: QQ_SMTP_AUTH_CODE
```

`name` 是相对 profile 目录的路径，所以用 `./plugins/...`。

> 0.2.x 默认开启 profile 配置热加载（HMR），存盘即生效。若你的构建关掉了 HMR，需要重启；
> 设置里的「插件」页是打开那一刻的快照，重开设置才会刷新。插件名以路径形式出现是正常的，
> 搜索 `qq` 即可命中。

---

## 三、配置字段

写在 `cordis.patch.yml` 的 `config` 下，所有字段都可省略（省略即用默认值）。

### 通用

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关。`false` 时插件加载后立刻返回，不注册任何监听 |
| `transport` | `onebot` | `onebot` / `smtp` / `webhook` |
| `target` | 空 | 接收通知的 QQ 号或邮箱；**必填** |
| `targetType` | `private` | `private` 私聊 / `group` 群（仅 onebot） |
| `account` | 空 | 发件 QQ 号（smtp 必填） |
| `events` | 见下 | 订阅哪些事件类型 |
| `rootOnly` | `true` | 只对主会话通知，忽略子代理会话 |
| `minTurnDurationMs` | `0` | 回合短于该毫秒数不发「任务完成」，用来滤掉一问一答 |
| `previewChars` | `160` | 正文摘要字符数，`0` 关闭摘要 |
| `throttleMs` | `1500` | 两次发送最小间隔，防 QQ 限流 |
| `timeoutMs` | `8000` | 单次发送超时 |
| `retries` | `2` | 失败重试次数（只对可重试错误，如网络／5xx／超时） |
| `maxQueue` | `50` | 待发队列上限，满了丢最旧的 |
| `dryRun` | `false` | 只写日志不真发，用来确认「事件是否按预期触发」 |

### 事件类型 `events`

| 取值 | 触发点 | 默认订阅 |
|---|---|---|
| `task-complete` | 回合正常结束（`turn/end` 且原因为 `completed`） | ✅ |
| `needs-confirmation` | 工具申请授权（`approval/asked`）、计划模式等待批准（`exit_plan_mode`） | ✅ |
| `needs-discussion` | 模型调用 `ask_user_question` 停下来问你 | ✅ |
| `task-failed` | 回合以错误结束（`turn/end` 且原因为 `error`） | ❌ 按需打开 |

> 用户自己按「停止」、会话被关闭（`aborted` / `disposed`）**永远不发**——那不需要你
> 再回来处理。默认不订阅 `task-failed` 是因为报错回合可能很频繁，需要时再加。

### 通道私有配置

```yaml
# OneBot v11 HTTP（NapCat / LLOneBot / Lagrange / go-cqhttp）
onebot:
  endpoint: 'http://127.0.0.1:3000'      # HTTP 服务根地址，不要带 /send_private_msg
  accessTokenRef: 'ONEBOT_ACCESS_TOKEN'  # 桥接进程配的 access token（存凭证里）
  actionPrivate: 'send_private_msg'
  actionGroup: 'send_group_msg'

# QQ 邮箱 SMTP
smtp:
  host: 'smtp.qq.com'
  port: 465
  secure: true            # true=465 隐式 TLS；false=587 + STARTTLS
  from: ''                # 默认 <account>@qq.com
  passwordRef: 'QQ_SMTP_AUTH_CODE'
  subjectPrefix: '[DSH]'

# 自定义中转：收到 JSON { event, title, message, target, sessionId, turn, at }
webhook:
  url: ''
  tokenRef: ''            # 非空则带 Authorization: Bearer <值>
```

---

## 四、凭证放在哪

遵循 harness 的既有规则：**配置只放引用，密钥只放凭证库**。

- 配置里出现的 `passwordRef` / `accessTokenRef` / `tokenRef` 都只是**引用名**
  （POSIX 标识符形状，例如 `QQ_SMTP_AUTH_CODE`），schema 里标了 `credential-ref` 角色，
  设置界面也不会当成普通文本字段渲染。
- 插件通过 `ctx.get('credentials').resolve(ref)` **每次发送前现取，不缓存**，
  所以换掉授权码不需要重启 harness。
- 明文密钥从不写进 `cordis.patch.yml`，也不会出现在日志里（日志只打引用名）。

### 文件格式（按发行版不同，别混）

编辑 `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`），密钥放在 **`refs:` 段下**：

```yaml
version: 1
refs:
  DEEPSEEK_API_KEY: sk-…
  QQ_SMTP_AUTH_CODE: 你的十六位授权码     # ← 加这一行
records:
  …（原有内容不要动）
```

| 版本 | 结构 | 密钥写在哪 |
|---|---|---|
| 0.2.x（当前发行版） | `version: 1` + `refs:` + `records:` | `refs:` 段下面 |
| 0.1.x 预发布版 | 一层扁平映射 | 顶层 |

两个容易踩的点：

- **必须缩进在 `refs:` 下面。** 写到根上（和 `version:` 平级）会被 harness 当成
  「别的工具写的外来键」，只在启动时告警一句然后忽略，发送时报「未取到授权码」。
- **值不能为空。** 空字符串被视为「没有这个密钥」并被拒绝；删除键等于不配置。

授权码怎么拿：QQ 邮箱网页版 → 设置 → 账号 → 开启「POP3/SMTP 服务」→ 生成授权码。
**它不是你的 QQ 密码**，是 QQ 为第三方客户端单独发的 16 位口令，可以单独吊销。

不想写文件也可以改用环境变量（同名即可，凭证服务会回落到进程环境）：

```bash
export QQ_SMTP_AUTH_CODE=你的授权码       # Windows: set QQ_SMTP_AUTH_CODE=...
```

> 环境变量是**兜底**，不是覆盖：一旦 `refs` 里存了值，就以文件为准。想让环境变量生效，
> 就得把 `refs` 里那一行删掉。

安全边界要说清楚：`.credentials.yaml` 挡得住同机其他用户（目录 `0700`、文件 `0600`，
POSIX 上还会拒绝任何 group/other 可读的文件），挡不住以你身份运行的进程。所以不要把
主账号的高价值口令放进任何本地文件——SMTP 授权码的好处正是它可单独吊销、与登录密码隔离。

---

## 五、先自测，再启用

不用等任务跑完，直接验证链路：

```bash
cd ~/.dsh/profiles/desktop/plugins/dsh-qq-notify

# QQ 邮箱通道（会先从凭证文件里找 QQ_SMTP_AUTH_CODE）
node lib/cli.js --transport smtp --account 你的QQ号 --target 接收QQ号

# OneBot 通道
node lib/cli.js --transport onebot --target 接收QQ号 --endpoint http://127.0.0.1:3000

# 只看配置，不发请求
node lib/cli.js --transport smtp --account 你的QQ号 --target 接收QQ号 --dry-run
```

成功打印 `✅ 发送成功`；失败打印错误码、原因和排查顺序，并给出退出码 `1`。
它还会告诉你密钥是从哪里读到的（文件路径 + 引用名，只显示名字不显示值）。

---

## 六、发出来的消息长什么样

```
[DSH] 任务完成 ✅
会话: 修复登录接口 500
工作区: 2026-10-23-21-55-24
回合: #4 · 用时 2m18s · 6 步
摘要: 已修复 login.ts 里未处理空 token 的分支，并补了两个回归用例。
时间: 2026-10-23 22:10:31
```

```
[DSH] 需要你确认 🔐
动作: 调用 bash
原因: 需要在沙箱外执行 npm publish
会话: 发布 1.2.0
工作区: 2026-10-23-21-55-24
时间: 2026-10-23 22:12:05
```

```
[DSH] 等你决定 💬
问题: 数据库迁移用哪种方式？
选项: 在线迁移 (Recommended) / 停机迁移
会话: 迁移方案
工作区: 2026-10-23-21-55-24
时间: 2026-10-23 22:14:40
```

---

## 七、失败了怎么知道

四层反馈，从轻到重：

1. **重试**：网络错误、超时、5xx 会自动重试（退避 0.8s → 1.6s → 3.2s）。
2. **日志**：最终失败会写一条 `warn`，带错误码和修复建议，例如

   ```
   qq-notify: 发送失败（已试 3 次）: SMTP AUTH(密码) 失败（535） | 详情: 535 5.7.8 ...
   建议: passwordRef 必须是 QQ 邮箱生成的 16 位授权码，不是 QQ 登录密码
   ```
3. **旁路事件**：同时 `emit('qq-notify/failure', { at, kind, code, message })`，
   需要接监控的插件可以订阅。
4. **状态查询**：`ctx.get('qqNotify').status` 返回
   `{ queued, sent, failed, dropped, pending, lastError, transport, target }`。

另外 `ctx.get('qqNotify').sendTest('...')` 可以在运行中手动发一条。

> 注意：如果失败原因就是「QQ 通道本身不通」，别再指望 QQ 能告诉你。所以启用前
> 请先用 CLI 跑一次自测。

---

## 八、为什么它不会拖慢／拖垮任务

| 风险 | 处理方式 |
|---|---|
| 网络慢拖住回合 | 监听器同步返回，只做一次入队；网络请求在独立后台循环里 |
| 发送异常冒到会话派发 | 映射、发送、重试全部 try/catch 包裹，最坏是「这条没发出去」 |
| 事件风暴刷屏 | `throttleMs` 限流 + 同事件去重 + `maxQueue` 上限 |
| harness 退出时挂住 | `ctx.effect` 卸载钩子取消在途请求、清空队列；socket 与定时器全部释放 |
| 半途失败泄漏连接 | SMTP 会话失败时主动 destroy socket，且有整体超时兜底 |
| 子代理刷通知 | `rootOnly: true` 默认只发主会话 |
| 想先观察再开 | `dryRun: true` 只写日志，不产生任何外部请求 |

---

## 九、排错

**凭证文件里没有 `QQ_SMTP_AUTH_CODE`** — 正常，这个键要你自己加。插件只按名字去取，
不会创建。加在 `refs:` 下面（见第四节），然后跑
`node lib/cli.js --transport smtp --account 你的QQ --target 你的QQ`，
它会先告诉你「密钥取自哪里」或者「没找到」。

**日志里说「未取到授权码」，但文件里明明有** — 九成是写错了层级：键写在根上或
`records:` 下面。确认它缩进在 `refs:` 下、和其它引用并排。

**发送成功但设置界面看不到「已配置」** — 插件没有注册 `ctx.settings` 命名空间，
所以设置界面不会显示这个引用；以 CLI 和日志为准。

**OneBot 返回 `retcode 100/102`** — 机器人账号没登录或目标不是好友。先在桥接进程里
确认登录状态，再确认 `target` 是好友／群号。

**OneBot 返回 HTTP 401/403** — `accessTokenRef` 指向的值与桥接进程配置的 token 不一致。

**「OneBot 返回的不是 JSON」** — `endpoint` 指到了普通网页。它应该是 HTTP 服务的根地址，
例如 `http://127.0.0.1:3000`，插件请求的路径是 `/send_private_msg`。

**SMTP 535** — 用了 QQ 登录密码。必须换成「POP3/SMTP 服务」生成的 16 位授权码。

**SMTP 连接超时** — 出站 465/587 被防火墙拦了。换 `secure: false` + `port: 587`
走 STARTTLS 试试。

**收不到但日志说成功** — 检查 QQ 的「邮箱提醒」是否被免打扰，或消息进了陌生消息箱。

**事件没触发** — 先设 `dryRun: true`，跑一个任务看日志里有没有 `[dryRun] ...`。
有 → 通道问题；没有 → 看 `events` 白名单和 `minTurnDurationMs`。

---

## 十、关闭与卸载

- **临时关**：`enabled: false`，存盘即生效（未开 HMR 的构建需重启）。
- **彻底卸**：删掉 `cordis.patch.yml` 里的 `qq-notify` 那一段，再删
  `profiles/desktop/plugins/dsh-qq-notify` 目录。插件不写任何其他位置的状态。

---

## 十一、开发与测试

```bash
npm install                 # 只为本地开发装 @deepseek-ai/schemastery（运行时由 harness 提供）
npm test                    # 四套用例，共 49 项
node test/smoke.mjs         # 22 项：事件映射 / 去重 / 限流 / 重试 / 隔离性（假 ctx + 假 fetch）
node test/webhook.mjs       #  7 项：onebot 与 webhook 的真实 HTTP 往返与报文格式
node test/smtp.mjs          #  7 项：真实 TLS + STARTTLS 握手、MIME 编码、鉴权失败、超时
node test/credentials.mjs   # 13 项：凭证文件两种布局的解析（含「写错层级」的负例）
```

`smtp.mjs` 会在本机回环起一个真实 SMTP 服务器（临时自签证书），所以需要 `openssl`，
并且要在**允许监听本地端口**的环境里运行（部分沙箱会禁止）。

改代码前请先看这三条约束：

- 监听器**必须同步返回**，不要在 `session/event` 回调里 `await` 网络请求。
- 不要往会话 append 任何事件：本插件是纯观察者，写事件会污染 transcript 与 KV cache。
- 新增通道时实现 `send(notification) => { channel, detail }`，失败抛 `TransportError`
  并正确设置 `retryable`（4xx 类的永久错误不要重试）。

目录结构：

```
lib/index.js             # 插件本体（cordis 插件）：事件映射、队列、限流、重试
lib/transports.js        # 三个通道的发送实现（含手写 SMTP 客户端）
lib/credentials-file.js  # 读取 .credentials.yaml（供 CLI 自测用，兼容两种布局）
lib/cli.js               # 配置自测 CLI
test/                    # 49 项自动化用例
```

---

## License

MIT
