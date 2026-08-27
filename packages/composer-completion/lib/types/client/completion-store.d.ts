/** Debounced, cancellable completion state with typed-through and LRU reuse. */
import type { CompletionClientPolicy, CompletionContext, CompletionFrame, CompletionRequest } from '../types.ts';
export interface CompletionRemote {
    complete(request: CompletionRequest, signal?: AbortSignal): AsyncIterable<CompletionFrame>;
}
export interface CompletionEnvironment {
    readonly sessionId: string;
    readonly draft: string;
    readonly eligible: boolean;
    readonly running: boolean;
}
export interface CompletionSnapshot {
    readonly suggestion: string | null;
}
export interface CacheHit {
    readonly draft: string;
    readonly completion: string;
    readonly context: CompletionContext;
}
/** Session-local completed-result cache; prompt and completion bodies never leave memory. */
export declare class CompletionMemoryCache {
    private readonly limit;
    private readonly ttlMs;
    private readonly entries;
    private clock;
    constructor(limit: number, ttlMs: number);
    clearSession(sessionId: string): void;
    find(sessionId: string, anchorMessageId: string, model: string, promptVersion: string, draft: string): CacheHit | undefined;
    put(sessionId: string, context: CompletionContext, draft: string, completion: string): void;
    private prune;
}
/** One mounted composer's scheduling and network lifecycle. */
export declare class CompletionStore {
    private readonly remote;
    private readonly policy;
    private readonly cache;
    private snapshot;
    private readonly listeners;
    private environment;
    private timer;
    private inflight;
    private settled;
    private activeAnchor;
    private previousRunning;
    private generation;
    private disposed;
    constructor(remote: CompletionRemote, policy: CompletionClientPolicy, cache: CompletionMemoryCache);
    readonly subscribe: (listener: () => void) => (() => void);
    readonly getSnapshot: () => CompletionSnapshot;
    update(environment: CompletionEnvironment): void;
    dismiss(): boolean;
    accepted(): void;
    dispose(): void;
    private schedule;
    private start;
    private reset;
    private resetConversation;
    private cancelTimer;
    private abortInflight;
    private publish;
}
//# sourceMappingURL=completion-store.d.ts.map