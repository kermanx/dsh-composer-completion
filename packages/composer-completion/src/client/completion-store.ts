/** Debounced, cancellable completion state with typed-through and LRU reuse. */

import type {
  CompletionClientPolicy,
  CompletionContext,
  CompletionFrame,
  CompletionRequest,
} from '../types.ts'

export interface CompletionRemote {
  complete(request: CompletionRequest, signal?: AbortSignal): AsyncIterable<CompletionFrame>
}

export interface CompletionEnvironment {
  readonly sessionId: string
  readonly draft: string
  readonly eligible: boolean
  readonly running: boolean
}

export interface CompletionSnapshot {
  readonly suggestion: string | null
}

interface CacheEntry {
  readonly sessionId: string
  readonly context: CompletionContext
  readonly draft: string
  readonly completion: string
  readonly expiresAt: number
  usedAt: number
}

export interface CacheHit {
  readonly draft: string
  readonly completion: string
  readonly context: CompletionContext
}

/** Session-local completed-result cache; prompt and completion bodies never leave memory. */
export class CompletionMemoryCache {
  private readonly entries: CacheEntry[] = []
  private clock = 0

  constructor(
    private readonly limit: number,
    private readonly ttlMs: number,
  ) {}

  clearSession(sessionId: string): void {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      if (this.entries[index]?.sessionId === sessionId) this.entries.splice(index, 1)
    }
  }

  find(
    sessionId: string,
    anchorMessageId: string,
    model: string,
    promptVersion: string,
    draft: string,
  ): CacheHit | undefined {
    const now = Date.now()
    this.prune(now)
    let winner: CacheEntry | undefined
    for (const entry of this.entries) {
      if (entry.sessionId !== sessionId
        || entry.context.anchorMessageId !== anchorMessageId
        || entry.context.model !== model
        || entry.context.promptVersion !== promptVersion
        || !draft.startsWith(entry.draft)) continue
      const typed = draft.slice(entry.draft.length)
      const reusable = entry.completion === ''
        ? typed === ''
        : entry.completion.startsWith(typed) && typed.length < entry.completion.length
      if (!reusable || (winner !== undefined && winner.draft.length >= entry.draft.length)) continue
      winner = entry
    }
    if (winner === undefined) return undefined
    winner.usedAt = ++this.clock
    return { draft: winner.draft, completion: winner.completion, context: winner.context }
  }

  put(sessionId: string, context: CompletionContext, draft: string, completion: string): void {
    const existing = this.entries.find(entry => entry.sessionId === sessionId
      && entry.context.anchorMessageId === context.anchorMessageId
      && entry.context.model === context.model
      && entry.context.promptVersion === context.promptVersion
      && entry.draft === draft)
    if (existing !== undefined) {
      Object.assign(existing, { completion, expiresAt: Date.now() + this.ttlMs, usedAt: ++this.clock })
      return
    }
    this.entries.push({
      sessionId,
      context,
      draft,
      completion,
      expiresAt: Date.now() + this.ttlMs,
      usedAt: ++this.clock,
    })
    this.prune(Date.now())
    while (this.entries.length > this.limit) {
      let oldest = 0
      for (let index = 1; index < this.entries.length; index += 1) {
        if ((this.entries[index]?.usedAt ?? 0) < (this.entries[oldest]?.usedAt ?? 0)) oldest = index
      }
      this.entries.splice(oldest, 1)
    }
  }

  private prune(now: number): void {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      if ((this.entries[index]?.expiresAt ?? 0) <= now) this.entries.splice(index, 1)
    }
  }
}

interface SettledCompletion {
  readonly sessionId: string
  readonly draft: string
  readonly completion: string
  readonly context?: CompletionContext
}

interface InflightCompletion {
  readonly generation: number
  readonly sessionId: string
  readonly baseDraft: string
  readonly abort: AbortController
  generated: string
}

type Projection =
  | { readonly kind: 'visible'; readonly text: string }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'diverged' }

const COMPLETION_BOUNDARY = /\.{3,}|…+|[？?，,。.]/u

function firstCompletionFragment(text: string): string {
  const boundary = COMPLETION_BOUNDARY.exec(text)
  if (boundary === null || boundary.index === undefined) return text
  return text.slice(0, boundary.index + boundary[0].length)
}

function project(baseDraft: string, completion: string, draft: string): Projection {
  if (!draft.startsWith(baseDraft)) return { kind: 'diverged' }
  const typed = draft.slice(baseDraft.length)
  if (completion.startsWith(typed)) {
    const text = firstCompletionFragment(completion.slice(typed.length))
    return text === '' ? { kind: 'waiting' } : { kind: 'visible', text }
  }
  if (typed.startsWith(completion)) return { kind: 'waiting' }
  return { kind: 'diverged' }
}

/** One mounted composer's scheduling and network lifecycle. */
export class CompletionStore {
  private snapshot: CompletionSnapshot = { suggestion: null }
  private readonly listeners = new Set<() => void>()
  private environment: CompletionEnvironment | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private inflight: InflightCompletion | undefined
  private settled: SettledCompletion | undefined
  private activeAnchor: string | undefined
  private previousRunning = false
  private generation = 0
  private disposed = false

  constructor(
    private readonly remote: CompletionRemote,
    private readonly policy: CompletionClientPolicy,
    private readonly cache: CompletionMemoryCache,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getSnapshot = (): CompletionSnapshot => this.snapshot

  update(environment: CompletionEnvironment): void {
    if (this.disposed) return
    const previous = this.environment
    this.environment = environment
    if (previous !== undefined && previous.sessionId !== environment.sessionId) this.reset(previous.sessionId)
    if (environment.running && !this.previousRunning) this.resetConversation(environment.sessionId)
    this.previousRunning = environment.running

    if (!this.policy.enabled || !environment.eligible
      || environment.draft.length < this.policy.minPrefixCharacters) {
      this.cancelTimer()
      this.abortInflight()
      this.publish(null)
      return
    }

    const inflight = this.inflight
    if (inflight !== undefined && inflight.sessionId === environment.sessionId) {
      const projection = project(inflight.baseDraft, inflight.generated, environment.draft)
      if (projection.kind !== 'diverged') {
        this.publish(projection.kind === 'visible' ? projection.text : null)
        return
      }
      this.abortInflight()
    }

    const settled = this.settled
    if (settled !== undefined
      && settled.sessionId === environment.sessionId
      && settled.draft === environment.draft) {
      this.publish(settled.completion === '' ? null : settled.completion)
      return
    }

    if (this.activeAnchor !== undefined) {
      const cached = this.cache.find(
        environment.sessionId,
        this.activeAnchor,
        this.policy.model,
        this.policy.promptVersion,
        environment.draft,
      )
      if (cached !== undefined) {
        const projection = project(cached.draft, cached.completion, environment.draft)
        const text = projection.kind === 'visible' ? projection.text : ''
        this.settled = {
          sessionId: environment.sessionId,
          draft: environment.draft,
          completion: text,
          context: cached.context,
        }
        this.publish(text === '' ? null : text)
        return
      }
    }

    this.publish(null)
    this.schedule()
  }

  dismiss(): boolean {
    if (this.snapshot.suggestion === null) return false
    this.cancelTimer()
    this.abortInflight()
    const environment = this.environment
    if (environment !== undefined) {
      this.settled = { sessionId: environment.sessionId, draft: environment.draft, completion: '' }
    }
    this.publish(null)
    return true
  }

  accepted(): void {
    this.cancelTimer()
    this.abortInflight()
    this.settled = undefined
    this.publish(null)
  }

  dispose(): void {
    this.disposed = true
    this.cancelTimer()
    this.abortInflight()
    this.listeners.clear()
  }

  private schedule(): void {
    this.cancelTimer()
    const environment = this.environment
    if (environment === undefined) return
    const generation = ++this.generation
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.start(generation, environment)
    }, this.policy.debounceMs)
  }

  private async start(generation: number, requested: CompletionEnvironment): Promise<void> {
    if (this.disposed || generation !== this.generation) return
    const current = this.environment
    if (current === undefined || !current.eligible || current.running
      || current.sessionId !== requested.sessionId || current.draft !== requested.draft) return

    const abort = new AbortController()
    const timeout = setTimeout(() => { abort.abort() }, this.policy.requestTimeoutMs)
    const inflight: InflightCompletion = {
      generation,
      sessionId: requested.sessionId,
      baseDraft: requested.draft,
      abort,
      generated: '',
    }
    this.inflight = inflight
    let context: CompletionContext | undefined
    let done = false
    try {
      for await (const frame of this.remote.complete({
        sessionId: requested.sessionId,
        draft: requested.draft,
      }, abort.signal)) {
        if (this.inflight !== inflight || abort.signal.aborted) return
        if (context !== undefined
          && (context.anchorMessageId !== frame.context.anchorMessageId
            || context.model !== frame.context.model
            || context.promptVersion !== frame.context.promptVersion)) return
        context = frame.context
        if (this.activeAnchor !== frame.context.anchorMessageId) {
          this.cache.clearSession(requested.sessionId)
          this.activeAnchor = frame.context.anchorMessageId
        }
        inflight.generated = frame.text
        const live = this.environment
        if (live === undefined || !live.eligible || live.running || live.sessionId !== requested.sessionId) return
        const projection = project(requested.draft, frame.text, live.draft)
        if (projection.kind === 'diverged') {
          abort.abort()
          this.publish(null)
          this.schedule()
          return
        }
        this.publish(projection.kind === 'visible' ? projection.text : null)
        if (frame.type === 'done') done = true
      }
    } catch {
      if (!abort.signal.aborted) this.publish(null)
      return
    } finally {
      clearTimeout(timeout)
      if (this.inflight === inflight) this.inflight = undefined
    }

    const live = this.environment
    if (live === undefined || live.sessionId !== requested.sessionId) return
    if (context !== undefined && done) {
      this.cache.put(requested.sessionId, context, requested.draft, inflight.generated)
    }
    const projection = project(requested.draft, inflight.generated, live.draft)
    const completion = projection.kind === 'visible' ? projection.text : ''
    this.settled = {
      sessionId: live.sessionId,
      draft: live.draft,
      completion,
      ...(context === undefined ? {} : { context }),
    }
    this.publish(completion === '' ? null : completion)
  }

  private reset(sessionId: string): void {
    this.cancelTimer()
    this.abortInflight()
    this.cache.clearSession(sessionId)
    this.activeAnchor = undefined
    this.settled = undefined
    this.publish(null)
  }

  private resetConversation(sessionId: string): void {
    this.cache.clearSession(sessionId)
    this.activeAnchor = undefined
    this.settled = undefined
    this.cancelTimer()
    this.abortInflight()
    this.publish(null)
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
    this.generation += 1
  }

  private abortInflight(): void {
    const inflight = this.inflight
    if (inflight === undefined) return
    this.inflight = undefined
    inflight.abort.abort()
    this.generation += 1
  }

  private publish(suggestion: string | null): void {
    if (this.snapshot.suggestion === suggestion) return
    this.snapshot = { suggestion }
    for (const listener of this.listeners) listener()
  }
}
