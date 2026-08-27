/** Host-side completion generation and output-protocol decoding. */

import type { Context } from '@deepseek-ai/cordis'
import {
  createUserMessage,
  ReasoningEffortId,
  type FinishReason,
  type GenerateOptions,
  type Message,
} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import {
  buildCompletionPrompt,
  completionAnchor,
  PROMPT_VERSION,
  STOP_SEQUENCES,
  SYSTEM_PROMPT,
} from './prompt.ts'
import type {
  CompletionContext,
  CompletionFrame,
  CompletionRequest,
} from './types.ts'
import type { ResolvedConfig } from './index.ts'

class CompletionProtocolDecoder {
  private static readonly OPEN = '<COMPLETION>'
  private static readonly CLOSE = '</COMPLETION>'
  private static readonly NONE = '<NO_COMPLETION/>'

  private raw = ''
  private mode: 'pending' | 'completion' | 'none' | 'closed' | 'invalid' = 'pending'

  /** Consume one provider delta and return the complete visible suffix snapshot. */
  push(delta: string, maxCharacters: number): string | undefined {
    if (this.mode === 'none' || this.mode === 'closed' || this.mode === 'invalid') return undefined
    this.raw += delta
    const candidate = this.raw.trimStart()
    if (candidate === '') return undefined
    if (CompletionProtocolDecoder.NONE.startsWith(candidate)) return undefined
    if (candidate.startsWith(CompletionProtocolDecoder.NONE)) {
      this.mode = 'none'
      return ''
    }
    if (CompletionProtocolDecoder.OPEN.startsWith(candidate)) return undefined
    if (!candidate.startsWith(CompletionProtocolDecoder.OPEN)) {
      this.mode = 'invalid'
      return ''
    }
    this.mode = 'completion'
    const content = candidate.slice(CompletionProtocolDecoder.OPEN.length)
    const close = content.indexOf(CompletionProtocolDecoder.CLOSE)
    if (close >= 0) {
      this.mode = 'closed'
      return this.limit(content.slice(0, close), maxCharacters)
    }
    const withheld = this.closingPrefixLength(content)
    return this.limit(withheld === 0 ? content : content.slice(0, -withheld), maxCharacters)
  }

  /** Return the terminal protocol value; malformed or explicit refusal is empty. */
  finish(maxCharacters: number): string {
    const projected = this.push('', maxCharacters)
    if (projected !== undefined) return projected
    if (this.mode !== 'completion' && this.mode !== 'closed') return ''
    const candidate = this.raw.trimStart()
    const content = candidate.slice(CompletionProtocolDecoder.OPEN.length)
    const close = content.indexOf(CompletionProtocolDecoder.CLOSE)
    return this.limit(close < 0 ? content : content.slice(0, close), maxCharacters)
  }

  private limit(text: string, maxCharacters: number): string {
    return [...text].slice(0, maxCharacters).join('')
  }

  private closingPrefixLength(text: string): number {
    const limit = Math.min(text.length, CompletionProtocolDecoder.CLOSE.length - 1)
    for (let length = limit; length > 0; length -= 1) {
      if (CompletionProtocolDecoder.CLOSE.startsWith(text.slice(-length))) return length
    }
    return 0
  }
}

function throwForFinish(reason: FinishReason, signal: AbortSignal): void {
  switch (reason.kind) {
    case 'stop':
    case 'max-tokens':
      return
    case 'aborted':
      if (signal.aborted) return
      throw new TypertRemoteFailure({ code: 'internal', message: reason.failure.message, details: {} })
    case 'error':
      throw new TypertRemoteFailure({ code: 'internal', message: reason.failure.message, details: {} })
    case 'tool-calls':
      throw new TypertRemoteFailure({
        code: 'internal',
        message: 'Composer completion unexpectedly requested a tool',
        details: {},
      })
    default:
      throw new TypertRemoteFailure({
        code: 'internal',
        message: `Unsupported composer-completion finish reason "${String((reason as { kind?: unknown }).kind)}"`,
        details: {},
      })
  }
}

/** Cancellable completion generator independent from the main Agent loop. */
export class CompletionGenerator {
  constructor(
    private readonly ctx: Context,
    private readonly sessionController: SessionController,
    private readonly config: ResolvedConfig,
  ) {}

  /** Stream full replacement-suffix snapshots for the addressed draft. */
  async *complete(request: CompletionRequest, signal: AbortSignal): AsyncIterable<CompletionFrame> {
    if (!this.config.enabled) return
    signal.throwIfAborted()
    const resolved = await this.sessionController.resolveAgent(request.sessionId as SessionId)
    if ('error' in resolved) throw new TypertRemoteFailure(resolved.error)
    const { agent } = resolved
    const prompt = buildCompletionPrompt(
      agent.session,
      request.draft,
      this.config.maxInputBytes,
      this.config.maxDraftBytes,
    )
    if (prompt === undefined) return

    const context: CompletionContext = {
      anchorMessageId: prompt.anchorMessageId,
      model: this.config.model,
      promptVersion: PROMPT_VERSION,
    }
    const messages: Message[] = [createUserMessage({
      content: [{ type: 'text', text: prompt.text }],
      source: { kind: 'plugin', plugin: '@kermanx/dsh-composer-completion' },
    })]
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    const options: GenerateOptions = {
      provider: this.config.provider,
      model: this.config.model,
      reasoningEffort: ReasoningEffortId(this.config.reasoningEffort),
      messages,
      system: SYSTEM_PROMPT,
      temperature: this.config.temperature,
      maxTokens: this.config.maxOutputTokens,
      stop: [...STOP_SEQUENCES],
      signal: requestSignal,
    }

    const decoder = new CompletionProtocolDecoder()
    let visible = ''
    for await (const chunk of this.ctx.llm.stream(options)) {
      if (requestSignal.aborted) return
      if (completionAnchor(agent.session) !== prompt.anchorMessageId) return
      if (chunk.type === 'finish') {
        throwForFinish(chunk.reason, requestSignal)
        continue
      }
      if (chunk.type !== 'text-delta') continue
      const next = decoder.push(chunk.text, this.config.maxOutputCharacters)
      if (next === undefined || next === visible) continue
      visible = next
      yield { type: 'update', context, text: visible }
    }
    if (completionAnchor(agent.session) !== prompt.anchorMessageId) return
    visible = decoder.finish(this.config.maxOutputCharacters)
    yield { type: 'done', context, text: visible }
  }
}
