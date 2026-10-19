import type { GenerateOptions, LlmRuntime, Message, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { ResolvedConfig } from './index.ts';
import type { TranscriptEntry } from './prompt.ts';
import type { ReferenceUserMessage } from './recent-user-messages.ts';
import type { CompletionContext, CompletionRequest } from './types.ts';
export { buildCompletionPromptFromTranscript, completionTranscriptFromMessages } from './prompt.ts';
/** Hard ceiling for all JSON files, including session metadata (50 MiB). */
export declare const REQUEST_LOG_MAX_BYTES: number;
/** JSON-serializable call at the DSH LLM boundary; credentials stay with the provider. */
export type SavedGenerateOptions = Omit<GenerateOptions, 'signal'>;
/** Frozen inputs sufficient for both exact replay and new context-building experiments. */
export interface CompletionRequestSnapshot {
    readonly input: CompletionRequest;
    readonly context: CompletionContext;
    /** Full derived conversation, including non-text content and tool messages. */
    readonly history: readonly Message[];
    readonly transcript: readonly TranscriptEntry[];
    readonly references: readonly ReferenceUserMessage[];
    readonly config: ResolvedConfig;
    readonly request: SavedGenerateOptions;
}
/** Provider stream as observed by the plugin, including usage and finish chunks. */
export interface LoggedChunk {
    readonly elapsedMs: number;
    readonly chunk: StreamChunk;
}
/** How this invocation stopped; incomplete records have no result at all. */
export type CompletionLogStatus = 'completed' | 'error' | 'cancelled' | 'timeout' | 'stale' | 'interrupted';
/** Error data retained without depending on Error's non-enumerable JSON behavior. */
export interface LoggedError {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
    readonly code?: string;
}
/** Result is stored separately so recording it never rewrites the potentially large history. */
export interface CompletionRequestResult {
    readonly status: CompletionLogStatus;
    readonly dispatchedAt?: number;
    readonly finishedAt: number;
    readonly durationMs: number;
    readonly chunks: readonly LoggedChunk[];
    /** Last provider usage snapshot; null means none was received. Absent in older logs. */
    readonly usage?: TokenUsage | null;
    readonly completion: string;
    readonly error?: LoggedError;
}
/** Versioned archive envelope. A missing result means execution did not record a settlement. */
export interface CompletionRequestRecord extends CompletionRequestSnapshot {
    readonly version: 1;
    readonly id: string;
    readonly createdAt: number;
    readonly result?: CompletionRequestResult;
}
/** Cheap inventory; listing does not refresh LRU recency. */
export interface CompletionRequestLogEntry {
    readonly id: string;
    readonly sessionId: string;
    readonly createdAt: number;
    /** Last access to any request in the containing session. */
    readonly accessedAt: number;
    readonly bytes: number;
    readonly hasResult: boolean;
}
/** One indivisible eviction unit; bytes includes its session.json metadata. */
export interface CompletionRequestLogSession {
    readonly sessionId: string;
    readonly accessedAt: number;
    readonly bytes: number;
    readonly entries: readonly CompletionRequestLogEntry[];
}
/** Only observed counters are summed; missing usage is counted explicitly. */
export interface CompletionTokenTotals {
    requests: number;
    requestsWithoutUsage: number;
    requestsWithoutTotalTokens: number;
    uncachedInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** Informational breakdown; never added again to the total. */
    reasoningTokens: number;
    /** Sum of observed disjoint input/cache/output counters; may be incomplete. */
    countedTokens: number;
    /** Sum of the full-call totals that providers actually reported. */
    knownTotalTokens: number;
    /** Exact aggregate only when every request has a reported total. */
    totalTokens: number | null;
}
/** Usage for currently retained logs, with the same accounting per session. */
export interface CompletionTokenReport {
    readonly scope: 'retained-logs';
    readonly total: CompletionTokenTotals;
    readonly sessions: readonly (CompletionTokenTotals & {
        readonly sessionId: string;
    })[];
}
/** DSH usage events replace the previous snapshot; they are not token deltas. */
export declare function completionTokenUsage(result: CompletionRequestResult | undefined): TokenUsage | null;
/** A session must fit as a whole: its individual requests are never pruned. */
export declare class RequestLogCapacityError extends Error {
    constructor();
}
/** Capture ordinary and remote failures for later experiment inspection. */
export declare function loggedError(error: unknown): LoggedError;
/**
 * Plain JSON request/result pairs grouped by session, coordinated by a directory lock.
 * session.json mtime is the durable access clock for every request in that session.
 */
export declare class CompletionRequestLog {
    readonly directory: string;
    readonly maxBytes: number;
    constructor(options?: {
        readonly directory?: string;
        readonly maxBytes?: number;
    });
    /** Persist the full request before its model stream is opened. */
    begin(snapshot: CompletionRequestSnapshot): Promise<string>;
    /** Attach one settlement; an evicted in-flight request is never resurrected. */
    finish(id: string, result: CompletionRequestResult): Promise<boolean>;
    /** Read a self-contained request and refresh the entire session's LRU position. */
    read(id: string): Promise<CompletionRequestRecord>;
    /** Inspect newest requests first without refreshing any session's access time. */
    list(): Promise<readonly CompletionRequestLogEntry[]>;
    /** Inspect sessions and their complete byte cost, most recently accessed first. */
    listSessions(): Promise<readonly CompletionRequestLogSession[]>;
    /** Aggregate saved usage without refreshing session recency or making model calls. */
    usage(): Promise<CompletionTokenReport>;
    private readResult;
    private metadataPath;
    private path;
    private validateId;
    private locked;
    private scan;
    private scanSession;
    private checkSessionCapacity;
    private makeRoom;
    private removeSession;
    private touch;
    private write;
}
/** Restore the exact saved request, with explicit experiment overrides and no live Session reads. */
export declare function requestForReplay(record: CompletionRequestRecord, overrides?: Partial<SavedGenerateOptions>): SavedGenerateOptions;
/** Replay against a caller-supplied DSH runtime, using its current provider credentials. */
export declare function replayRequest(llm: Pick<LlmRuntime, 'stream'>, log: CompletionRequestLog, id: string, overrides?: Partial<SavedGenerateOptions>, signal?: AbortSignal): AsyncIterable<StreamChunk>;
//# sourceMappingURL=request-log.d.ts.map