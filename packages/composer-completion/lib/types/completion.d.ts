/** Host-side completion generation and output-protocol decoding. */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import type { CompletionFrame, CompletionRequest } from './types.ts';
import type { ResolvedConfig } from './index.ts';
/** Cancellable completion generator independent from the main Agent loop. */
export declare class CompletionGenerator {
    private readonly ctx;
    private readonly sessionController;
    private readonly config;
    constructor(ctx: Context, sessionController: SessionController, config: ResolvedConfig);
    /** Stream full replacement-suffix snapshots for the addressed draft. */
    complete(request: CompletionRequest, signal: AbortSignal): AsyncIterable<CompletionFrame>;
}
//# sourceMappingURL=completion.d.ts.map