import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { CompletionGenerator } from '../lib/types/completion.js'
import { RecentUserMessageStore, referenceProjection } from '../lib/types/recent-user-messages.js'
import { CompletionRequestLog, buildCompletionPromptFromTranscript, replayRequest } from '../lib/types/request-log.js'

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'composer-completion-test-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(referenceProjection)
  const file = join(directory, 'references.json')
  const store = new RecentUserMessageStore(ctx.sessionProjections, file)
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') store.recordCompletedTurn(session, event)
  })
  t.after(async () => {
    try {
      await store.flush()
      await ctx.fiber.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  return { ctx, store, file, log: new CompletionRequestLog({ directory: join(directory, 'requests') }) }
}

function user(session, text, source = { kind: 'user' }) {
  const message = createUserMessage({ content: [{ type: 'text', text }], source })
  session.append('user/message', message, { surfaceOp: 'append' })
  return message
}

function assistant(session, text, turn = 1) {
  const message = createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'test', model: 'test' },
  })
  session.append('assistant/message', { turn, step: 1, message, stream: [] }, { surfaceOp: 'append' })
  return message
}

const signal = () => new AbortController().signal

test('records only eligible human requests from completed turns and preserves the existing state file', async t => {
  const { ctx, store, file } = await harness(t)
  const session = ctx.sessions.create()
  session.append('turn/start', { turn: 1 })
  user(session, '保留这个请求')
  user(session, '模型内部提示', { kind: 'composer-completion' })
  user(session, '长'.repeat(101))
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  user(session, '不要收录失败的请求')
  session.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } })
  const selected = await store.select(ctx.sessions.create(), signal())
  assert.deepEqual(selected.messages.map(message => message.text), ['保留这个请求'])
  const persisted = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(persisted.version, 1)
  assert.equal(persisted.messages.length, 1)
  const restoredStore = new RecentUserMessageStore(ctx.sessionProjections, file)
  assert.deepEqual(await restoredStore.select(ctx.sessions.create(), signal()), selected)
  await restoredStore.flush()
})

test('replays a partially completed turn after restore and excludes inherited requests in a fork', async t => {
  const { ctx, store } = await harness(t)
  const source = ctx.sessions.create()
  source.append('turn/start', { turn: 1 })
  user(source, '恢复后仍然可以记录')
  const restored = Session.create(source.id, source.snapshotEvents(), source.header)
  const end = restored.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  store.recordCompletedTurn(restored, end)
  const fresh = ctx.sessions.create()
  assert.equal((await store.select(fresh, signal())).messages.length, 1)
  assert.equal((await store.select(restored, signal())).messages.length, 0)
  const child = Session.create(SessionId('fork'), restored.snapshotEvents())
  assert.equal((await store.select(child, signal())).messages.length, 0)
  assert.equal((await store.select(fresh, signal())).messages.length, 1)
})

const config = {
  enabled: true,
  provider: 'test',
  model: 'test',
  reasoningEffort: 'off',
  temperature: 0.01,
  maxInputBytes: 65_536,
  maxDraftBytes: 16_384,
  maxOutputTokens: 64,
  requestTimeoutMs: 10_000,
  maxOutputCharacters: 512,
  debounceMs: 250,
  minPrefixCharacters: 0,
  cacheEntries: 128,
  cacheTtlMs: 300_000,
}

test('streams with the current message source contract without adding conversation events', async t => {
  const { ctx, store, log } = await harness(t)
  const session = ctx.sessions.create()
  session.append('turn/start', { turn: 1 })
  user(session, '修改输入框')
  const anchor = assistant(session, '可以继续说明具体要求。')
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const seq = session.seq
  let options
  const generator = new CompletionGenerator({ llm: {
    async *stream(request) {
      options = request
      // Inputs are durable before the provider is contacted.
      const [entry] = await log.list()
      assert.deepEqual((await log.read(entry.id)).history, session.deriveMessages())
      yield { type: 'text-delta', text: '<COMPLETION>补全内容</COMPLETION>' }
      yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 8, totalTokens: 58 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  } }, { resolveAgent: async () => ({ agent: { session } }) }, store, config, log)
  const frames = await Array.fromAsync(generator.complete({ sessionId: session.id, draft: '增加' }, signal()))
  assert.equal(frames.at(-1).type, 'done')
  assert.equal(frames.at(-1).text, '补全内容')
  assert.equal(frames.at(-1).context.anchorMessageId, anchor.id)
  assert.deepEqual(options.messages[0].source, { kind: 'composer-completion' })
  assert.match(options.messages[0].content[0].text, /CURRENT INPUT\n增加<CURSOR>$/)
  assert.equal(session.seq, seq)
  const [entry] = await log.list()
  const record = await log.read(entry.id)
  const { signal: liveSignal, ...savedOptions } = options
  assert.deepEqual(record.request, savedOptions)
  assert.deepEqual(record.input, { sessionId: session.id, draft: '增加' })
  assert.deepEqual(record.history, session.deriveMessages())
  assert.equal(record.result.status, 'completed')
  assert.equal(record.result.completion, '补全内容')
  assert.deepEqual(record.result.usage, { inputTokens: 50, outputTokens: 8, totalTokens: 58 })
  assert.equal((await log.usage()).total.totalTokens, 58)
  assert.deepEqual(record.result.chunks.map(value => value.chunk.type), ['text-delta', 'usage', 'finish'])
  const rebuilt = buildCompletionPromptFromTranscript(record.transcript, record.input.draft,
    record.references, record.config.maxInputBytes, record.config.maxDraftBytes)
  assert.equal(rebuilt.text, savedOptions.messages[0].content[0].text)
  // A changed live conversation must not affect replay of the saved request.
  user(session, '这是之后的新请求')
  await Array.fromAsync(replayRequest({ async *stream(request) {
    const { signal: replaySignal, ...replayed } = request
    assert.deepEqual(replayed, savedOptions)
    assert.notEqual(replaySignal, liveSignal)
  } }, log, entry.id))
})

test('preserves typed session failures and returns typed generation failures', async t => {
  const { ctx, store, log } = await harness(t)
  const failure = new RemoteError('session/not-found', 'Session is unavailable', { sessionId: 'missing' })
  const missing = new CompletionGenerator({}, { resolveAgent: async () => ({ error: failure }) }, store, config, log)
  await assert.rejects(
    Array.fromAsync(missing.complete({ sessionId: 'missing', draft: '' }, signal())),
    error => error === failure,
  )
  assert.deepEqual(await log.list(), [])
  const session = ctx.sessions.create()
  assistant(session, '已有回答')
  const generator = new CompletionGenerator({ llm: {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Provider failed' } } }
    },
  } }, { resolveAgent: async () => ({ agent: { session } }) }, store, config, log)
  await assert.rejects(
    Array.fromAsync(generator.complete({ sessionId: session.id, draft: '' }, signal())),
    error => error.isDSHRemoteError && error.code === 'gateway/internal' && error.message === 'Provider failed',
  )
  const [entry] = await log.list()
  const { result } = await log.read(entry.id)
  assert.equal(result.status, 'error')
  assert.equal(result.error.message, 'Provider failed')
  assert.equal(result.chunks[0].chunk.reason.kind, 'error')
})

test('persists partial output on caller cancellation, timeout, stale history, and early iterator close', async t => {
  for (const outcome of ['cancelled', 'timeout', 'stale', 'interrupted']) {
    await t.test(outcome, async t => {
      const { ctx, store, log } = await harness(t)
      const session = ctx.sessions.create()
      assistant(session, '已有回答')
      const controller = new AbortController()
      const generator = new CompletionGenerator({ llm: {
        async *stream(request) {
          yield { type: 'text-delta', text: '<COMPLETION>部分内容' }
          if (outcome === 'cancelled') controller.abort()
          if (outcome === 'timeout') {
            await new Promise(resolve => {
              const timer = setTimeout(resolve, 2000)
              request.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
            })
          }
          if (outcome === 'stale') user(session, '改变会话')
        },
      } }, { resolveAgent: async () => ({ agent: { session } }) }, store,
      { ...config, requestTimeoutMs: outcome === 'timeout' ? 100 : config.requestTimeoutMs }, log)
      const iterator = generator.complete({ sessionId: session.id, draft: '' }, controller.signal)
      const first = await iterator.next()
      assert.equal(first.value.text, '部分内容')
      if (outcome === 'interrupted') await iterator.return()
      else assert.equal((await iterator.next()).done, true)
      const [entry] = await log.list()
      const record = await log.read(entry.id)
      assert.equal(record.result.status, outcome)
      assert.equal(record.result.completion, '部分内容')
      assert.equal(record.result.chunks.length, 1)
      assert.equal(record.history.at(-1).role, 'assistant')
    })
  }
})

test('preserves untruncated history and keeps completion available when logging fails', async t => {
  const { ctx, store, log, file } = await harness(t)
  const session = ctx.sessions.create()
  user(session, '保留完整历史'.repeat(500))
  assistant(session, '已有回答')
  const warnings = []
  const llm = { async *stream() { yield { type: 'text-delta', text: '<NO_COMPLETION/>' } } }
  const controller = { resolveAgent: async () => ({ agent: { session } }) }
  const generator = new CompletionGenerator({ llm }, controller, store,
    { ...config, maxInputBytes: 256, maxDraftBytes: 32 }, log)
  await Array.fromAsync(generator.complete({ sessionId: session.id, draft: '' }, signal()))
  const [entry] = await log.list()
  const record = await log.read(entry.id)
  assert.equal(record.transcript[0].text, '保留完整历史'.repeat(500))
  assert.ok(Buffer.byteLength(record.request.messages[0].content[0].text) <= 256)
  const brokenLog = new CompletionRequestLog({ directory: file })
  const degraded = new CompletionGenerator({ llm }, controller, store, config, brokenLog, error => warnings.push(error))
  const frames = await Array.fromAsync(degraded.complete({ sessionId: session.id, draft: '' }, signal()))
  assert.equal(frames.at(-1).type, 'done')
  assert.equal(warnings.length, 1)
})
