/** Browser-safe request, stream, and policy values for composer completion. */
/** Exact draft prefix submitted for one completion attempt. */
export interface CompletionRequest {
    readonly sessionId: string;
    readonly draft: string;
}
/** Stable context identifying the conversation prefix used by a result. */
export interface CompletionContext {
    readonly anchorMessageId: string;
    readonly model: string;
    readonly promptVersion: string;
}
/** Progressive full-suffix snapshots followed by one terminal snapshot. */
export type CompletionFrame = {
    readonly type: 'update';
    readonly context: CompletionContext;
    readonly text: string;
} | {
    readonly type: 'done';
    readonly context: CompletionContext;
    readonly text: string;
};
/** Browser scheduling and retention policy resolved from Host configuration. */
export interface CompletionClientPolicy {
    readonly enabled: boolean;
    readonly model: string;
    readonly promptVersion: string;
    readonly debounceMs: number;
    readonly minPrefixCharacters: number;
    readonly requestTimeoutMs: number;
    readonly maxOutputCharacters: number;
    readonly cacheEntries: number;
    readonly cacheTtlMs: number;
}
//# sourceMappingURL=types.d.ts.map