/** Independent Host Remote owner for conversation-composer completion. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { CompletionGenerator } from './completion.ts'
import { PROMPT_VERSION, promptFramingBytes } from './prompt.ts'
import { RecentUserMessageStore } from './recent-user-messages.ts'
import type {
  CompletionClientPolicy,
  CompletionFrame,
  CompletionRequest,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    composerCompletion: ComposerCompletionService
  }
}

/** Host generation, browser scheduling, and cache-retention policy. */
export interface Config {
  readonly enabled?: boolean
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly temperature?: number
  readonly maxInputBytes?: number
  readonly maxDraftBytes?: number
  readonly maxOutputTokens?: number
  readonly requestTimeoutMs?: number
  readonly debounceMs?: number
  readonly minPrefixCharacters?: number
  readonly maxOutputCharacters?: number
  readonly cacheEntries?: number
  readonly cacheTtlMs?: number
}

export interface ResolvedConfig {
  readonly enabled: boolean
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string
  readonly temperature: number
  readonly maxInputBytes: number
  readonly maxDraftBytes: number
  readonly maxOutputTokens: number
  readonly requestTimeoutMs: number
  readonly debounceMs: number
  readonly minPrefixCharacters: number
  readonly maxOutputCharacters: number
  readonly cacheEntries: number
  readonly cacheTtlMs: number
}

const DEFAULTS: ResolvedConfig = {
  enabled: true,
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'off',
  temperature: 0.01,
  maxInputBytes: 65_536,
  maxDraftBytes: 16_384,
  maxOutputTokens: 64,
  requestTimeoutMs: 10_000,
  debounceMs: 250,
  minPrefixCharacters: 0,
  maxOutputCharacters: 512,
  cacheEntries: 128,
  cacheTtlMs: 300_000,
}

/** Loader-owned schema for every deployment-varying completion value. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  provider: z.string().default(DEFAULTS.provider),
  model: z.string().default(DEFAULTS.model),
  reasoningEffort: z.string().default(DEFAULTS.reasoningEffort),
  temperature: z.number().min(0).max(2).default(DEFAULTS.temperature),
  maxInputBytes: z.number().step(1).min(1).default(DEFAULTS.maxInputBytes),
  maxDraftBytes: z.number().step(1).min(1).default(DEFAULTS.maxDraftBytes),
  maxOutputTokens: z.number().step(1).min(1).default(DEFAULTS.maxOutputTokens),
  requestTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(DEFAULTS.requestTimeoutMs),
  debounceMs: z.number().step(1).min(0).max(60_000).default(DEFAULTS.debounceMs),
  minPrefixCharacters: z.number().step(1).min(0).default(DEFAULTS.minPrefixCharacters),
  maxOutputCharacters: z.number().step(1).min(1).default(DEFAULTS.maxOutputCharacters),
  cacheEntries: z.number().step(1).min(1).default(DEFAULTS.cacheEntries),
  cacheTtlMs: z.number().step(1).min(1).max(2_147_483_647).default(DEFAULTS.cacheTtlMs),
})

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    enabled: config.enabled ?? DEFAULTS.enabled,
    provider: config.provider ?? DEFAULTS.provider,
    model: config.model ?? DEFAULTS.model,
    reasoningEffort: config.reasoningEffort ?? DEFAULTS.reasoningEffort,
    temperature: config.temperature ?? DEFAULTS.temperature,
    maxInputBytes: config.maxInputBytes ?? DEFAULTS.maxInputBytes,
    maxDraftBytes: config.maxDraftBytes ?? DEFAULTS.maxDraftBytes,
    maxOutputTokens: config.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    debounceMs: config.debounceMs ?? DEFAULTS.debounceMs,
    minPrefixCharacters: config.minPrefixCharacters ?? DEFAULTS.minPrefixCharacters,
    maxOutputCharacters: config.maxOutputCharacters ?? DEFAULTS.maxOutputCharacters,
    cacheEntries: config.cacheEntries ?? DEFAULTS.cacheEntries,
    cacheTtlMs: config.cacheTtlMs ?? DEFAULTS.cacheTtlMs,
  }
  if (promptFramingBytes(resolved.maxDraftBytes) > resolved.maxInputBytes) {
    throw new Error(
      'composer-completion: maxInputBytes must exceed maxDraftBytes plus prompt framing',
    )
  }
  return resolved
}

/** Host service backing the generated `remote.composerCompletion` namespace. */
export class ComposerCompletionService extends TypertRemoteService {
  static inject = ['llm', 'sessionController', 'typert']
  static Config = Config

  private readonly resolved: ResolvedConfig
  private readonly generator: CompletionGenerator
  private readonly recentUserMessages: RecentUserMessageStore

  constructor(ctx: Context, config: Config) {
    super(ctx, 'composerCompletion', { namespace: 'composerCompletion' })
    this.resolved = resolveConfig(config)
    this.recentUserMessages = new RecentUserMessageStore()
    this.generator = new CompletionGenerator(
      ctx,
      ctx.sessionController,
      this.recentUserMessages,
      this.resolved,
    )
    ctx.effect(() => async () => {
      await this.recentUserMessages.flush()
    }, 'composer-completion.recent-user-messages')
    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') this.recentUserMessages.recordCompletedTurn(session, event)
    })
  }

  /** Return the browser policy paired with this Host generation policy. */
  @Remote('policy')
  policy(): CompletionClientPolicy {
    return {
      enabled: this.resolved.enabled,
      model: this.resolved.model,
      promptVersion: PROMPT_VERSION,
      debounceMs: this.resolved.debounceMs,
      minPrefixCharacters: this.resolved.minPrefixCharacters,
      requestTimeoutMs: this.resolved.requestTimeoutMs,
      maxOutputCharacters: this.resolved.maxOutputCharacters,
      cacheEntries: this.resolved.cacheEntries,
      cacheTtlMs: this.resolved.cacheTtlMs,
    }
  }

  /** Stream user-input suffix snapshots without mutating Session history. */
  @Remote({ mode: 'stream' })
  complete(request: CompletionRequest, signal: AbortSignal): AsyncIterable<CompletionFrame> {
    return this.generator.complete(request, signal)
  }
}

export default ComposerCompletionService
