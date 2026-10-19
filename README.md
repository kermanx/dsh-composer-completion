# dsh-composer-completion

> 个人开源项目，非 DeepSeek 官方产品。

`dsh-composer-completion` 是一个独立的 DeepSeek Harness 插件，为 Web 主输入框提供类似代码补全的灰字续写。插件使用独立的 Flash 模型生成建议；按 `Tab` 接受，按 `Esc` 忽略。

## 功能

- 在用户停顿后显示灰字补全，当前输入为空时也可以建议下一段输入
- 只补全主输入框文本，不参与 `/` 指令或 `@` 引用菜单
- 使用当前会话中的 User 与 Assistant 消息作为上下文，并把持续变化的草稿放在提示词末尾以提高前缀缓存命中率
- 新输入与已有补全一致时复用结果；输入偏离时取消旧请求
- 模型可以明确返回“不补全”，不会为了展示灰字而强行生成内容
- 不修改 DeepSeek Harness 源码，也不会把补全请求写入主会话记录

## 安装

### 前置条件

- 已配置可用模型 Provider 的 DeepSeek Harness `0.2.1-rc.2`

### 步骤

```sh
git clone https://github.com/kermanx/dsh-composer-completion.git
cd dsh-composer-completion
dsh plugin --profile web add "$PWD/packages/composer-completion"
```

停止并重新运行 `dsh web`，然后刷新页面。客户端插件在 Web 服务启动时组装，首次安装后必须重启。

## 使用

将光标放在主输入框末尾并短暂停顿。出现灰字后：

- `Tab`：接受当前补全
- `Esc`：隐藏当前补全
- 继续输入：匹配时逐字复用补全；不匹配时重新请求

补全只会在输入框处于普通文本状态、光标位于末尾、没有 `/` 或 `@` 菜单、且主 Agent 未运行时出现。

## 配置

默认使用 `deepseek-official` Provider 的 `deepseek-v4-flash`，输出上限为 64 tokens。可以在 Web profile 的 `cordis.patch.yml` 中覆盖配置：

```yaml
- id: composer-completion
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
    maxOutputTokens: 64
    debounceMs: 250
```

修改配置后需要重启 `dsh web`。

## 请求日志与重放

每次实际发起补全模型调用前，插件把输入快照写入 `$DSH_HOME/composer-completion/requests`；未设置 `DSH_HOME` 时使用 `~/.dsh/composer-completion/requests`。

- 保存完整的结构化会话消息、截断前的补全文本历史、跨会话参考请求、草稿、配置及实际传给 DSH LLM 的 `system/messages` 和生成参数。重放不依赖原会话仍然存在。
- 调用结束后保存原始流片段（包括 usage 和 finish）、时间、显示的补全文本及完成、错误、取消、超时等状态。输入和结果分别存储，因此进程意外退出后仍能重放已落盘的请求。
- 使用带缩进的普通 JSON 文件，按 session 分目录保存，每个目录包含 `session.json`、`<id>.request.json` 和 `<id>.result.json`。目录名是 session ID 的哈希，原始 ID 保存在 `session.json` 和请求中。
- 所有 JSON 文件合计最多 **50 MiB（52,428,800 字节）**，按 session 的 LRU 顺序整组淘汰。读取、重放或写入任一请求都会刷新整个 session 的访问时间；列出日志不更新。锁协调多个进程，访问顺序在重启后保留。
- 单个 session 自身超限时也整组淘汰，不在会话内部删除单条请求或截断历史。日志写入失败会输出警告并继续补全；生成期间已被淘汰的请求不会在结束时重新写回。

查看日志和导出实验数据：

```sh
node packages/composer-completion/scripts/request-log.mjs list
node packages/composer-completion/scripts/request-log.mjs usage
node packages/composer-completion/scripts/request-log.mjs export <id> > request.json
node packages/composer-completion/scripts/request-log.mjs options <id> > model-request.json
```

安装包也提供 `composer-completion-log` 命令；可以用 `--dir <directory>` 读取复制出来的日志目录。`export` 输出完整记录，`options` 仅输出可重放的模型请求。这些命令不调用模型。

`usage`（或 `await log.usage()`）按 session 和所有保留日志汇总 token 消耗，不刷新 LRU。每个结果文件的 `result.usage` 保存该请求最后一次 usage 快照，避免多次上报被重复相加；旧日志也可以从原始流片段恢复用量。

- `totalTokens`：所有请求都有 Provider 报告的完整总量时，给出准确合计；否则为 `null`。`knownTotalTokens` 是已知完整总量的合计。
- `uncachedInputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`outputTokens`：分别汇总已观测的分项。`countedTokens` 是这四项之和，可能不完整；`reasoningTokens` 单列展示，不重复加进总量。
- `requestsWithoutUsage` 和 `requestsWithoutTotalTokens`：指出缺失用量或完整总量的请求数，包括未结束、取消后未返回 usage 的请求；不会把它们视为消耗 0。

统计范围由 `scope: "retained-logs"` 标识。已被 LRU 淘汰的会话、落盘失败的调用以及另行执行的重放不在统计内，因此这不是永久累计的账单总量。

在已有 DSH LLM runtime 的实验脚本中，可以原样重放或覆盖模型参数：

```js
import {
  CompletionRequestLog,
  replayRequest,
  buildCompletionPromptFromTranscript,
} from '@kermanx/dsh-composer-completion/request-log'

const log = new CompletionRequestLog()
const [entry] = await log.list()
const record = await log.read(entry.id)

// 省略 overrides 即使用当时的原始模型请求；凭据由当前 ctx.llm 提供。
for await (const chunk of replayRequest(ctx.llm, log, entry.id, { temperature: 0.2 })) {
  console.log(chunk)
}

// 也可以用保存的历史、参考请求和草稿重新组装提示词，调整上下文预算。
const prompt = buildCompletionPromptFromTranscript(
  record.transcript, record.input.draft, record.references,
  32_768, record.config.maxDraftBytes,
)
```

重放会产生新的模型调用，使用原记录中的请求超时；它返回原始流，不覆盖原始结果。日志包含会话内容，但不保存 Provider 凭据。`history` 是当时的派生消息列表，不是 Session 事件数据库；`transcript` 是补全使用的用户与 Assistant 文本。

## 开发

仓库提交了可直接安装的构建产物。开发依赖固定为匹配的 dsh 发布版本，无需另外准备 DeepSeek Harness checkout：

```sh
pnpm install
pnpm build
pnpm test
```
