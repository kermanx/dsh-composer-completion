/** Host-side completion generation and output-protocol decoding. */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import type { RecentUserMessageStore } from './recent-user-messages.ts';
import { CompletionRequestLog } from './request-log.ts';
import type { CompletionFrame, CompletionRequest } from './types.ts';
import type { ResolvedConfig } from './index.ts';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'composer-completion': {
            readonly kind: 'composer-completion';
        };
    }
}
/** Cancellable completion generator independent from the main Agent loop. */
export declare class CompletionGenerator {
    private readonly ctx;
    private readonly sessionController;
    private readonly recentUserMessages;
    private readonly config;
    private readonly requestLog;
    private readonly onLogError;
    constructor(ctx: Context, sessionController: SessionController, recentUserMessages: RecentUserMessageStore, config: ResolvedConfig, requestLog: CompletionRequestLog, onLogError?: (error: unknown) => void);
    /** Stream full replacement-suffix snapshots for the addressed draft. */
    complete(request: CompletionRequest, signal: AbortSignal): AsyncIterable<CompletionFrame>;
}
//# sourceMappingURL=completion.d.ts.map