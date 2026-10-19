import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import {
  CompletionRequestLog, REQUEST_LOG_MAX_BYTES, RequestLogCapacityError, replayRequest, requestForReplay,
} from '../lib/types/request-log.js'

const exec = promisify(execFile)
const moduleUrl = new URL('../lib/types/request-log.js', import.meta.url).href
const cli = new URL('../scripts/request-log.mjs', import.meta.url)

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'completion-request-log-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

function snapshot(noise = '', sessionId = 'session-1') {
  const history = [
    { id: 'user-1', role: 'user', content: [{ type: 'text', text: `先前的请求${noise}` }], source: { kind: 'user' } },
    { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: '已处理' }], source: { provider: 'test', model: 'test' } },
  ]
  return {
    input: { sessionId, draft: '再增加' },
    context: { anchorMessageId: 'assistant-1', model: 'test', promptVersion: 'v1' },
    history,
    transcript: history.map(message => ({ id: message.id, role: message.role, text: message.content[0].text })),
    references: [{ key: 'other-session:other-request', text: '用中文回答' }],
    config: { requestTimeoutMs: 10_000 },
    request: { provider: 'test', model: 'test', system: '原始系统提示词', temperature: 0.01, maxTokens: 64,
      reasoningEffort: 'off', stop: ['<CURSOR>'], messages: [history[0]] },
  }
}

function result() {
  return { status: 'completed', finishedAt: Date.now(), durationMs: 12, completion: '补全',
    chunks: [{ elapsedMs: 10, chunk: { type: 'text-delta', text: '<COMPLETION>补全</COMPLETION>' } }] }
}

async function diskBytes(path) {
  const files = await readdir(path, { withFileTypes: true })
  const sizes = await Promise.all(files.map(async file => file.isDirectory()
    ? diskBytes(join(path, file.name)) : (await stat(join(path, file.name))).size))
  return sizes.reduce((total, size) => total + size, 0)
}

test('snapshots are durable, immutable, independently replayable, and exportable', async t => {
  const path = await directory(t)
  const log = new CompletionRequestLog({ directory: path })
  const input = snapshot()
  const original = structuredClone(input)
  const pending = log.begin(input)
  input.history[0].content[0].text = 'later mutation'
  const id = await pending
  assert.equal((await log.read(id)).result, undefined)
  const output = result()
  assert.equal(await log.finish(id, output), true)
  const restarted = new CompletionRequestLog({ directory: path })
  const record = await restarted.read(id)
  const { version, createdAt, id: storedId, result: storedResult, ...saved } = record
  assert.equal(version, 1)
  assert.equal(storedId, id)
  assert.ok(createdAt > 0)
  assert.deepEqual(saved, original)
  assert.deepEqual(storedResult, { ...output, usage: null })
  const restored = requestForReplay(record)
  restored.messages[0].content[0].text = 'experiment'
  assert.deepEqual(record.request, original.request)
  const replayedChunks = await Array.fromAsync(replayRequest({
    async *stream(options) {
      const { signal, ...rest } = options
      assert.equal(signal.aborted, false)
      assert.deepEqual(rest, { ...original.request, model: 'experiment-model', temperature: 0.2 })
      yield output.chunks[0].chunk
    },
  }, restarted, id, { model: 'experiment-model', temperature: 0.2 }))
  assert.deepEqual(replayedChunks, [output.chunks[0].chunk])
  const { stdout } = await exec(process.execPath, [cli.pathname, 'export', id, '--dir', path])
  assert.deepEqual(JSON.parse(stdout), record)
  const options = await exec(process.execPath, [cli.pathname, 'options', id, '--dir', path])
  assert.deepEqual(JSON.parse(options.stdout), original.request)
  const listing = await exec(process.execPath, [cli.pathname, 'list', '--dir', path])
  const inventory = JSON.parse(listing.stdout)
  assert.equal(inventory.bytes, await diskBytes(path))
  assert.equal(inventory.maxBytes, 50 * 1024 * 1024)
  assert.equal(inventory.entries.length, 1)
  assert.equal(inventory.entries[0].sessionId, original.input.sessionId)
  assert.equal(inventory.sessions[0].requests, 1)
  assert.equal(inventory.sessions[0].bytes, inventory.bytes)
  const [sessionDirectory] = await readdir(path)
  const requestFile = await readFile(join(path, sessionDirectory, `${id}.request.json`), 'utf8')
  assert.match(requestFile, /^\{\n  "input":/)
  assert.deepEqual(JSON.parse(requestFile).history, original.history)
  assert.equal(JSON.parse(await readFile(join(path, sessionDirectory, 'session.json'), 'utf8')).sessionId, original.input.sessionId)
  await assert.rejects(restarted.read('../../outside'), /invalid/)
})

test('reading or replaying one request protects its entire session across restart, including older siblings', async t => {
  const path = await directory(t)
  const log = new CompletionRequestLog({ directory: path })
  const data = randomBytes(100).toString('hex')
  const a = [await log.begin(snapshot(data, 'a')), await log.begin(snapshot(data, 'a'))]
  const b = [await log.begin(snapshot(data, 'b')), await log.begin(snapshot(data, 'b'))]
  for (const id of [...a, ...b]) await log.finish(id, result())
  const cap = await diskBytes(path) + 20
  await Array.fromAsync(replayRequest({ async *stream() {} }, log, a[0]))
  const restarted = new CompletionRequestLog({ directory: path, maxBytes: cap })
  const before = await restarted.list()
  const accessA = before.find(entry => entry.id === a[0]).accessedAt
  assert.equal(before.find(entry => entry.id === a[1]).accessedAt, accessA)
  assert.ok(accessA > before.find(entry => entry.id === b[1]).accessedAt)
  assert.deepEqual(await restarted.list(), before)
  const c = await restarted.begin(snapshot(data, 'c'))
  assert.ok(await diskBytes(path) <= cap)
  assert.deepEqual(new Set((await restarted.list()).map(entry => entry.id)), new Set([...a, c]))
  for (const id of b) await assert.rejects(restarted.read(id), /not found/)
  // Evicted requests cannot reappear if their provider finishes late.
  assert.equal(await restarted.finish(b[0], result()), false)
  assert.equal((await readdir(path)).length, 2)
  const sessions = await restarted.listSessions()
  assert.equal(sessions.reduce((total, session) => total + session.bytes, 0), await diskBytes(path))
  assert.deepEqual((await restarted.read(a[1])).input.sessionId, 'a')
})

test('new requests and results refresh and protect all requests in their session', async t => {
  for (const operation of ['begin', 'finish']) {
    await t.test(operation, async t => {
      const path = await directory(t)
      const log = new CompletionRequestLog({ directory: path })
      const data = randomBytes(100).toString('hex')
      const a = [await log.begin(snapshot(data, 'a')), await log.begin(snapshot(data, 'a'))]
      const b = [await log.begin(snapshot(data, 'b')), await log.begin(snapshot(data, 'b'))]
      const limited = new CompletionRequestLog({ directory: path, maxBytes: await diskBytes(path) + 10 })
      if (operation === 'begin') a.push(await limited.begin(snapshot(data, 'a')))
      else await limited.finish(a[0], result())
      assert.deepEqual(new Set((await limited.list()).map(entry => entry.id)), new Set(a))
      assert.equal(await limited.finish(b[0], result()), false)
      assert.equal((await limited.listSessions()).length, 1)
      assert.ok(await diskBytes(path) <= limited.maxBytes)
    })
  }
})

test('a session exceeding the budget is evicted whole without evicting other sessions', async t => {
  for (const operation of ['begin', 'finish']) {
    await t.test(operation, async t => {
      const path = await directory(t)
      const log = new CompletionRequestLog({ directory: path })
      const data = randomBytes(100).toString('hex')
      const a = [await log.begin(snapshot(data, 'a')), await log.begin(snapshot(data, 'a'))]
      const b = await log.begin(snapshot('', 'b'))
      const bytes = await diskBytes(path)
      const limited = new CompletionRequestLog({ directory: path, maxBytes: bytes + 10 })
      // Rejecting a brand-new oversized session must not evict any existing session.
      await assert.rejects(limited.begin(snapshot('x'.repeat(bytes), 'huge')), RequestLogCapacityError)
      assert.equal(await diskBytes(path), bytes)
      if (operation === 'begin') {
        // Each request fits alone, but the accumulated session does not.
        await assert.rejects(limited.begin(snapshot(data, 'a')), RequestLogCapacityError)
      } else {
        await assert.rejects(limited.finish(a[0], { ...result(), completion: 'x'.repeat(bytes) }), RequestLogCapacityError)
      }
      assert.deepEqual((await limited.list()).map(entry => entry.id), [b])
      for (const id of a) await assert.rejects(limited.read(id), /not found/)
      assert.equal(await limited.finish(a[1], result()), false)
      assert.equal((await readdir(path)).length, 1)
      assert.deepEqual((await limited.read(b)).history, snapshot().history)
    })
  }
  assert.throws(() => new CompletionRequestLog({ maxBytes: REQUEST_LOG_MAX_BYTES + 1 }), RangeError)
})

test('restart retains pending inputs and removes orphaned results and interrupted temporary writes', async t => {
  const path = await directory(t)
  const log = new CompletionRequestLog({ directory: path })
  const id = await log.begin(snapshot())
  const [sessionDirectory] = await readdir(path)
  const sessionPath = join(path, sessionDirectory)
  const orphan = `${Date.now()}-${randomUUID()}`
  await writeFile(join(sessionPath, `${orphan}.result.json`), 'interrupted result')
  await writeFile(join(sessionPath, `.${id}-${randomUUID()}.tmp`), 'interrupted write')
  const restarted = new CompletionRequestLog({ directory: path })
  assert.deepEqual((await restarted.read(id)).request, snapshot().request)
  assert.deepEqual(new Set(await readdir(sessionPath)), new Set(['session.json', `${id}.request.json`]))
  assert.equal((await restarted.list())[0].hasResult, false)
  assert.equal((await stat(join(sessionPath, `${id}.request.json`))).mode & 0o777, 0o600)
  // Simulate a process exiting after atomic session eviction but before physical deletion.
  await rename(sessionPath, join(path, `.evicted-${sessionDirectory}-${randomUUID()}`))
  assert.deepEqual(await restarted.list(), [])
  assert.deepEqual(await readdir(path), [])
})

test('independent processes share the same byte budget without corrupting records', async t => {
  const path = await directory(t)
  const cap = 10_000
  const child = `
    import { CompletionRequestLog } from ${JSON.stringify(moduleUrl)};
    const log = new CompletionRequestLog({ directory: process.argv[1], maxBytes: ${cap} });
    const snapshot = ${JSON.stringify(snapshot(randomBytes(80).toString('hex')))};
    for (let i = 0; i < 8; i++) {
      snapshot.input.sessionId = 'worker-' + process.argv[2] + '-session-' + Math.floor(i / 2);
      const id = await log.begin(snapshot);
      await log.finish(id, ${JSON.stringify(result())});
    }
  `
  await Promise.all([0, 1, 2].map(worker => exec(process.execPath, ['--input-type=module', '-e', child, path, String(worker)])))
  const log = new CompletionRequestLog({ directory: path, maxBytes: cap })
  const entries = await log.list()
  assert.ok(entries.length > 0 && entries.length < 24)
  assert.ok(await diskBytes(path) <= cap)
  for (const entry of entries) {
    const record = await log.read(entry.id)
    assert.equal(record.version, 1)
    assert.equal(record.result.status, 'completed')
  }
  for (const directory of await readdir(path)) {
    assert.ok((await readdir(join(path, directory))).every(name => name.endsWith('.json')))
  }
})

function resultWithUsage(...usages) {
  return { ...result(), chunks: usages.map((usage, index) => ({
    elapsedMs: index + 1, chunk: { type: 'usage', usage },
  })) }
}

test('token reports count the latest usage once, include cached input, and expose missing totals', async t => {
  const path = await directory(t)
  const log = new CompletionRequestLog({ directory: path })
  const a = await log.begin(snapshot('', 'a'))
  const lastUsage = { inputTokens: 20, outputTokens: 5, cacheReadTokens: 10, reasoningTokens: 2, totalTokens: 35 }
  await log.finish(a, resultWithUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 12 }, lastUsage, lastUsage))
  assert.deepEqual((await log.read(a)).result.usage, lastUsage)
  const second = await log.begin(snapshot('', 'a'))
  await log.finish(second, { ...resultWithUsage({
    inputTokens: 7, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 2, reasoningTokens: 1, totalTokens: 16,
  }), status: 'error' })
  // Pending or failed calls without provider accounting are unknown, not zero.
  await log.begin(snapshot('', 'b'))
  const failed = await log.begin(snapshot('', 'b'))
  await log.finish(failed, { ...result(), status: 'error' })
  const partial = await log.begin(snapshot('', 'b'))
  await log.finish(partial, { ...resultWithUsage({ inputTokens: 11, outputTokens: 4, cacheReadTokens: 8 }), status: 'cancelled' })
  const zero = await log.begin(snapshot('', 'b'))
  await log.finish(zero, resultWithUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }))

  // Older result files only have raw chunks; their last usage remains recoverable.
  for (const directory of await readdir(path)) {
    const file = join(path, directory, `${a}.result.json`)
    const text = await readFile(file, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (text === undefined) continue
    const envelope = JSON.parse(text)
    delete envelope.result.usage
    await writeFile(file, JSON.stringify(envelope, null, 2))
  }
  const before = await log.listSessions()
  const restarted = new CompletionRequestLog({ directory: path })
  const report = await restarted.usage()
  assert.equal(report.scope, 'retained-logs')
  assert.deepEqual(report.total, {
    requests: 6, requestsWithoutUsage: 2, requestsWithoutTotalTokens: 3,
    uncachedInputTokens: 38, outputTokens: 12, cacheReadTokens: 22, cacheWriteTokens: 2,
    reasoningTokens: 3, countedTokens: 74, knownTotalTokens: 51, totalTokens: null,
  })
  const sessionA = report.sessions.find(session => session.sessionId === 'a')
  assert.equal(sessionA.requests, 2)
  assert.equal(sessionA.totalTokens, 51)
  assert.equal(sessionA.countedTokens, 51)
  assert.equal(sessionA.requestsWithoutUsage, 0)
  const sessionB = report.sessions.find(session => session.sessionId === 'b')
  assert.equal(sessionB.requests, 4)
  assert.equal(sessionB.totalTokens, null)
  assert.equal(sessionB.knownTotalTokens, 0)
  assert.equal(sessionB.countedTokens, 23)
  const { stdout } = await exec(process.execPath, [cli.pathname, 'usage', '--dir', path])
  assert.deepEqual(JSON.parse(stdout), report)
  assert.deepEqual(await restarted.listSessions(), before)
})

test('token totals cover retained sessions and change consistently with whole-session eviction', async t => {
  const path = await directory(t)
  const log = new CompletionRequestLog({ directory: path })
  assert.equal((await log.usage()).total.totalTokens, 0)
  for (const [sessionId, totalTokens] of [['a', 10], ['b', 20]]) {
    const id = await log.begin(snapshot('', sessionId))
    await log.finish(id, resultWithUsage({ inputTokens: totalTokens - 5, outputTokens: 5, totalTokens }))
  }
  assert.equal((await log.usage()).total.totalTokens, 30)
  const capped = new CompletionRequestLog({ directory: path, maxBytes: await diskBytes(path) + 20 })
  const c = await capped.begin(snapshot('', 'c'))
  await capped.finish(c, resultWithUsage({ inputTokens: 25, outputTokens: 5, totalTokens: 30 }))
  const report = await capped.usage()
  assert.deepEqual(report.sessions.map(session => session.sessionId), ['b', 'c'])
  assert.equal(report.total.totalTokens, 50)
  assert.equal(report.total.knownTotalTokens, 50)
  assert.equal(report.total.requestsWithoutUsage, 0)
  assert.ok(await diskBytes(path) <= capped.maxBytes)
})
