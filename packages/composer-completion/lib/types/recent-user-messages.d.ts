/** Cross-Session user-request references for composer completion. */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
/** One stable reference request selected for the next model prompt. */
export interface ReferenceUserMessage {
    readonly key: string;
    readonly text: string;
}
/** Reference selection plus the identity used to predict prefix-cache reuse. */
export interface ReferenceSelection {
    readonly messages: readonly ReferenceUserMessage[];
    readonly signature: string;
}
/** Persist, select, and cache-stabilize cross-Session user requests. */
export declare class RecentUserMessageStore {
    readonly filePath: string;
    private state;
    private writes;
    private writeFailure;
    private lastSentSignature;
    constructor(filePath?: string);
    /** Record qualifying human messages only after their turn completes normally. */
    recordCompletedTurn(session: Session, turnEnd: Extract<SessionEvent, {
        type: 'turn/end';
    }>): void;
    /** Select a frozen reference prefix, rotating only when a cache miss is expected. */
    select(session: Session, signal: AbortSignal): Promise<ReferenceSelection>;
    /** Mark the stable reference prefix as sent to the provider. */
    markSent(signature: string): void;
    /** Wait for every admitted state-file replacement and surface write failures. */
    flush(): Promise<void>;
    private readState;
    private addMessages;
    private rotate;
    private selectedMessages;
    private eligibleMessages;
    private retainCandidates;
    private scheduleWrite;
}
//# sourceMappingURL=recent-user-messages.d.ts.map