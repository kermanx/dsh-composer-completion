/** Independent Host Remote owner for conversation-composer completion. */
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { CompletionClientPolicy, CompletionFrame, CompletionRequest } from './types.ts';
export type * from './types.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        composerCompletion: ComposerCompletionService;
    }
}
/** Host generation, browser scheduling, and cache-retention policy. */
export interface Config {
    readonly enabled?: boolean;
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly temperature?: number;
    readonly maxInputBytes?: number;
    readonly maxDraftBytes?: number;
    readonly maxOutputTokens?: number;
    readonly requestTimeoutMs?: number;
    readonly debounceMs?: number;
    readonly minPrefixCharacters?: number;
    readonly maxOutputCharacters?: number;
    readonly cacheEntries?: number;
    readonly cacheTtlMs?: number;
}
export interface ResolvedConfig {
    readonly enabled: boolean;
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort: string;
    readonly temperature: number;
    readonly maxInputBytes: number;
    readonly maxDraftBytes: number;
    readonly maxOutputTokens: number;
    readonly requestTimeoutMs: number;
    readonly debounceMs: number;
    readonly minPrefixCharacters: number;
    readonly maxOutputCharacters: number;
    readonly cacheEntries: number;
    readonly cacheTtlMs: number;
}
/** Loader-owned schema for every deployment-varying completion value. */
export declare const Config: z<Config>;
/** Host service backing the generated `remote.composerCompletion` namespace. */
export declare class ComposerCompletionService extends TypertRemoteService {
    static inject: string[];
    static Config: z<Config>;
    private readonly resolved;
    private readonly generator;
    constructor(ctx: Context, config: Config);
    /** Return the browser policy paired with this Host generation policy. */
    policy(): CompletionClientPolicy;
    /** Stream user-input suffix snapshots without mutating Session history. */
    complete(request: CompletionRequest, signal: AbortSignal): AsyncIterable<CompletionFrame>;
}
export default ComposerCompletionService;
//# sourceMappingURL=index.d.ts.map