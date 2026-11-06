# dsh-session-progress

把鼠标悬停在 DSH 侧栏的会话行上时，卡片里除了「进行中」，再多显示**最近 4 行真实进度**：思考、执行的命令、命令输出、回复。数据来自该会话自己的事件日志，不需要打开会话。

![会话 hover 卡片里的进度行](docs/hover.png)

（截图取自真实浏览器 hover 一张有历史的会话行，中文界面。）

```
┌────────────────────────────────┐
│ 开发 Copilot 差异显示插件         │
│ /home/zhujinhui/bought_data     │
│ 9分钟前                          │
│ 思考  先看会话日志的事件结构…      │
│ 命令  ls .dsh/sessions | head    │
│ 输出  session-b4c1a986 …         │
│ 回复  已确认，开始写插件。         │
│ ◌ 进行中                         │   ← 原有的状态行，保持不变
└────────────────────────────────┘
```

## 安装

```bash
# 从本地目录安装（开发中）
dsh plugin --profile web add /path/to/dsh-session-progress

# 从 npm 或 git 安装
dsh plugin --profile web add dsh-session-progress
dsh plugin --profile web add github:huieric/dsh-session-progress
```

安装后重启 `dsh web`（loader 行在启动时读取），浏览器刷新页面即可。

卸载：

```bash
dsh plugin --profile web remove dsh-session-progress
```

## 它怎么工作

| 半个插件 | 位置 | 职责 |
| --- | --- | --- |
| Host | `lib/index.js` | 注册同源路由 `GET /dsh-session-progress/tail`，把某个会话的尾部事件压缩成几行文本 |
| Browser | `lib/client.js` | 注册 `sidebar.session.row.hover` 槽位组件，卡片打开时轮询上面的路由，卡片关闭即停止 |

数据来源优先取内存里的活会话（`ctx.sessions`），拿不到再读会话账本（`ctx.sessionPersistence`，`session.v4.jsonl.zstd`），所以**已结束的会话和刚聊过的会话都能显示**。

事件到行的映射：

| 事件 | 行 |
| --- | --- |
| `user/message` | 你 |
| `assistant/message` → `reasoning` | 思考 |
| `assistant/message` → `tool-call` / `tool/call` | 命令（`command` 取首行，否则取 `file_path`/`path`/`query`…） |
| `tool/result` | 输出 |
| `assistant/message` → `text` | 回复 |

## 安全与隐私

- 路由**不是公开的**：每个请求都要过 `connection.requestRejection(req)`，即 Web API 同一套 Host/Origin + 签名 cookie 校验（未通过回 401/403）。
- 只接受形如 `session-<uuid>` 的 id，长度 ≤ 128，字符集 `[A-Za-z0-9._-]`，不做任何路径拼接。
- 数据不出本机：浏览器从 127.0.0.1 的同源路由取数，插件不发任何外部请求。
- `~/.dsh/session-progress/status.json` 只写 `version / pid / 时间戳 / 请求计数 / 最近一次会话 id`，**不写任何会话内容**，用于排查「插件到底有没有加载」。删掉该文件不影响功能。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `cacheMs` | `700` | 同一会话的轮询结果缓存时长，避免 1.2s 一次轮询反复读账本 |

在 profile 的 `cordis.patch.yml` 里改：

```yaml
- id: session-progress
  config:
    cacheMs: 1500
```

## 可见性

- 会话还没有任何事件时不显示（不会占位）。
- 行文本单行截断，hover 该行可看 `title` 全文。
- 只显示最近 4 行；命令行取首行，输出取纯文本片段。

## 开发

```bash
npm install          # 仅测试用的 react / react-dom / react-test-renderer
npm test             # node --test test/
```

测试覆盖三层，且不依赖正在运行的 DSH：

1. `test/tail.test.mjs` —— 事件到行的纯函数映射（含代理对截断、畸形事件）。
2. `test/host.test.mjs` —— 鉴权短路、方法/id 校验、live/stored 两条数据源、缓存、`status.json` 内容，并用**本机真实会话账本**跑一遍。
3. `test/client.test.mjs` —— 用 `vm` 按浏览器方式加载 `lib/client.js`，断言 `inject`/`apply` 注册的槽位与文案、CSS 只注入一次、`renderLines` 转义、以及用 `react-test-renderer` 真实挂载组件验证 `fetch → 渲染` 全链路。

## 兼容性

- DSH `>= 0.2.0-rc.1 < 0.3.0`
- Node `>= 20`（Host 侧没有额外依赖）

## License

MIT
