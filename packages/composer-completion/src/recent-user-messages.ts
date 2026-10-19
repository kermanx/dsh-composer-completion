/** Cross-Session user-request references for composer completion. */

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { completionStoragePath } from './storage.ts'

const FILE_VERSION = 1
const REFERENCE_COUNT = 30
const MAX_MESSAGE_CODE_POINTS = 100
const RETAINED_CANDIDATE_COUNT = REFERENCE_COUNT * 4

const storedMessageSchema = z.object({
  key: z.string().min(1),
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  text: z.string().refine(
    text => text.trim() !== '' && [...text].length <= MAX_MESSAGE_CODE_POINTS,
    `must contain 1-${MAX_MESSAGE_CODE_POINTS} Unicode code points`,
  ),
  sentAt: z.number().int().nonnegative(),
}).strict()

const persistedStateSchema = z.object({
  version: z.literal(FILE_VERSION),
  messages: z.array(storedMessageSchema),
  selectedKeys: z.array(z.string().min(1)).max(REFERENCE_COUNT),
  newMessagesSinceRotation: z.number().int().nonnegative(),
}).strict()

type StoredMessage = z.infer<typeof storedMessageSchema>
type PersistedState = z.infer<typeof persistedStateSchema>

const referenceStateSchema = z.object({
  sessionId: z.string(),
  userMessageIds: z.array(z.string()),
  pending: z.object({
    turn: z.number().int(),
    messages: z.array(storedMessageSchema),
  }).nullable(),
  completed: z.object({
    seq: z.number().int().nonnegative(),
    messages: z.array(storedMessageSchema),
  }).nullable(),
})

type ReferenceState = z.infer<typeof referenceStateSchema>

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    composerCompletionReferences: ReferenceState
  }
}

/** One stable reference request selected for the next model prompt. */
export interface ReferenceUserMessage {
  readonly key: string
  readonly text: string
}

/** Reference selection plus the identity used to predict prefix-cache reuse. */
export interface ReferenceSelection {
  readonly messages: readonly ReferenceUserMessage[]
  readonly signature: string
}

function messageText(message: Message): string {
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function storedMessage(
  sessionId: string,
  event: Extract<SessionEvent, { type: 'user/message' }>,
): StoredMessage | undefined {
  if (event.data.source.kind !== 'user') return undefined
  const text = messageText(event.data)
  if (text.trim() === '' || [...text].length > MAX_MESSAGE_CODE_POINTS) return undefined
  const messageId = String(event.data.id)
  return {
    key: `${sessionId}:${messageId}`,
    sessionId,
    messageId,
    text,
    sentAt: event.time,
  }
}

/** Restore and incrementally maintain the reference data needed from each Session. */
export const referenceProjection: ProjectionDefinition<'composerCompletionReferences'> = {
  key: 'composerCompletionReferences',
  stateVersion: 1,
  stateSchema: referenceStateSchema,
  init: header => ({ sessionId: String(header.id), userMessageIds: [], pending: null, completed: null }),
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start':
        return { ...state, pending: { turn: event.data.turn, messages: [] }, completed: null }
      case 'user/message': {
        if (event.data.source.kind !== 'user') return state
        const message = storedMessage(state.sessionId, event)
        return {
          ...state,
          userMessageIds: [...state.userMessageIds, String(event.data.id)],
          pending: state.pending === null || message === undefined ? state.pending : {
            ...state.pending,
            messages: [...state.pending.messages, message],
          },
        }
      }
      case 'turn/end':
        if (state.pending?.turn !== event.data.turn) return state
        return {
          ...state,
          pending: null,
          completed: event.data.reason.kind === 'completed'
            ? { seq: event.seq, messages: state.pending.messages }
            : null,
        }
      default:
        return state
    }
  },
}

function selectionSignature(messages: readonly StoredMessage[]): string {
  return messages.map(message => message.key).join('\n')
}

/** Persist, select, and cache-stabilize cross-Session user requests. */
export class RecentUserMessageStore {
  readonly filePath: string

  private state: PersistedState
  private writes: Promise<void> = Promise.resolve()
  private writeFailure: unknown
  private lastSentSignature: string | undefined

  constructor(
    private readonly projections: SessionProjectionRegistry,
    filePath = completionStoragePath('recent-user-messages.json'),
  ) {
    this.filePath = filePath
    this.state = this.readState()
  }

  /** Record qualifying human messages only after their turn completes normally. */
  recordCompletedTurn(
    session: Session,
    turnEnd: Extract<SessionEvent, { type: 'turn/end' }>,
  ): void {
    if (turnEnd.data.reason.kind !== 'completed') return
    const { completed } = this.referenceState(session)
    if (completed?.seq !== turnEnd.seq) return
    if (this.addMessages(completed.messages, true)) this.scheduleWrite()
  }

  /** Select a frozen reference prefix, rotating only when a cache miss is expected. */
  async select(
    session: Session,
    signal: AbortSignal,
  ): Promise<ReferenceSelection> {
    await this.flush()
    signal.throwIfAborted()
    const currentIds = new Set(this.referenceState(session).userMessageIds)
    const selected = this.selectedMessages(String(session.id), currentIds)
    const currentSignature = selectionSignature(selected)
    const cacheExpected = this.lastSentSignature !== undefined
      && this.lastSentSignature === currentSignature
    if (!cacheExpected || this.state.newMessagesSinceRotation >= REFERENCE_COUNT) {
      this.rotate(String(session.id), currentIds)
      await this.flush()
    }
    const messages = this.selectedMessages(String(session.id), currentIds)
    return {
      messages: messages.map(message => ({ key: message.key, text: message.text })),
      signature: selectionSignature(messages),
    }
  }

  /** Mark the stable reference prefix as sent to the provider. */
  markSent(signature: string): void {
    this.lastSentSignature = signature
  }

  /** Wait for every admitted state-file replacement and surface write failures. */
  async flush(): Promise<void> {
    await this.writes
    if (this.writeFailure !== undefined) throw this.writeFailure
  }

  private referenceState(session: Session): ReferenceState {
    const state = this.projections.stateOf(session, 'composerCompletionReferences')
    if (state === undefined) throw new Error('composer-completion: reference projection is not registered')
    return state
  }

  private readState(): PersistedState {
    try {
      return persistedStateSchema.parse(JSON.parse(readFileSync(this.filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          version: FILE_VERSION,
          messages: [],
          selectedKeys: [],
          newMessagesSinceRotation: 0,
        }
      }
      throw new Error(
        `composer-completion: failed to read recent user messages from "${this.filePath}"`,
        { cause: error },
      )
    }
  }

  private addMessages(messages: readonly StoredMessage[], countAsNew: boolean): boolean {
    const known = new Set(this.state.messages.map(message => message.key))
    let added = 0
    for (const message of messages) {
      if (known.has(message.key)) continue
      known.add(message.key)
      this.state.messages.push(message)
      added += 1
    }
    if (added === 0) return false
    if (countAsNew) this.state.newMessagesSinceRotation += added
    this.retainCandidates()
    return true
  }

  private rotate(currentSessionId: string, currentIds: ReadonlySet<string>): void {
    const selected = this.eligibleMessages(currentSessionId, currentIds).slice(-REFERENCE_COUNT)
    this.state.selectedKeys = selected.map(message => message.key)
    this.state.newMessagesSinceRotation = 0
    this.retainCandidates()
    this.scheduleWrite()
  }

  private selectedMessages(
    currentSessionId: string,
    currentIds: ReadonlySet<string>,
  ): StoredMessage[] {
    const byKey = new Map(this.state.messages.map(message => [message.key, message]))
    const seenMessageIds = new Set<string>()
    const selected: StoredMessage[] = []
    for (const key of this.state.selectedKeys) {
      const message = byKey.get(key)
      if (message === undefined
        || message.sessionId === currentSessionId
        || currentIds.has(message.messageId)
        || seenMessageIds.has(message.messageId)) continue
      seenMessageIds.add(message.messageId)
      selected.push(message)
    }
    return selected
  }

  private eligibleMessages(
    currentSessionId: string,
    currentIds: ReadonlySet<string>,
  ): StoredMessage[] {
    const seenMessageIds = new Set<string>()
    return [...this.state.messages]
      .sort((left, right) => left.sentAt - right.sentAt || left.key.localeCompare(right.key))
      .filter((message) => {
        if (message.sessionId === currentSessionId
          || currentIds.has(message.messageId)
          || seenMessageIds.has(message.messageId)) return false
        seenMessageIds.add(message.messageId)
        return true
      })
  }

  private retainCandidates(): void {
    const selected = new Set(this.state.selectedKeys)
    const newest = [...this.state.messages]
      .sort((left, right) => right.sentAt - left.sentAt || right.key.localeCompare(left.key))
      .slice(0, RETAINED_CANDIDATE_COUNT)
    const keep = new Set([...selected, ...newest.map(message => message.key)])
    this.state.messages = this.state.messages.filter(message => keep.has(message.key))
  }

  private scheduleWrite(): void {
    const payload = `${JSON.stringify(this.state, null, 2)}\n`
    const temporary = `${this.filePath}.${process.pid}.tmp`
    this.writes = this.writes
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
        await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 })
        await rename(temporary, this.filePath)
      })
      .catch((error: unknown) => {
        this.writeFailure ??= new Error(
          `composer-completion: failed to persist recent user messages to "${this.filePath}"`,
          { cause: error },
        )
      })
  }
}
