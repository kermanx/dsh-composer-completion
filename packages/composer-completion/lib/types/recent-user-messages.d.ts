/** Cross-Session user-request references for composer completion. */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { ProjectionDefinition, SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { z } from 'zod';
declare const referenceStateSchema: z.ZodObject<{
    sessionId: z.ZodString;
    userMessageIds: z.ZodArray<z.ZodString>;
    pending: z.ZodNullable<z.ZodObject<{
        turn: z.ZodNumber;
        messages: z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            sessionId: z.ZodString;
            messageId: z.ZodString;
            text: z.ZodString;
            sentAt: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strip>>;
    completed: z.ZodNullable<z.ZodObject<{
        seq: z.ZodNumber;
        messages: z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            sessionId: z.ZodString;
            messageId: z.ZodString;
            text: z.ZodString;
            sentAt: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
type ReferenceState = z.infer<typeof referenceStateSchema>;
declare module '@deepseek-ai/dsh-session-projection' {
    interface SessionProjectionStateMap {
        composerCompletionReferences: ReferenceState;
    }
}
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
/** Restore and incrementally maintain the reference data needed from each Session. */
export declare const referenceProjection: ProjectionDefinition<'composerCompletionReferences'>;
/** Persist, select, and cache-stabilize cross-Session user requests. */
export declare class RecentUserMessageStore {
    private readonly projections;
    readonly filePath: string;
    private state;
    private writes;
    private writeFailure;
    private lastSentSignature;
    constructor(projections: SessionProjectionRegistry, filePath?: string);
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
    private referenceState;
    private readState;
    private addMessages;
    private rotate;
    private selectedMessages;
    private eligibleMessages;
    private retainCandidates;
    private scheduleWrite;
}
export {};
//# sourceMappingURL=recent-user-messages.d.ts.map