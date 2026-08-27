/** Composer overlay rendering ghost text and owning acceptance gestures. */
import { type ReactNode } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { CompletionClientPolicy } from '../types.ts';
import { CompletionMemoryCache, type CompletionRemote } from './completion-store.ts';
export interface LoadedCompletionResources {
    readonly remote: CompletionRemote;
    readonly policy: CompletionClientPolicy;
    readonly cache: CompletionMemoryCache;
}
export interface CompletionOverlayResources {
    readonly loadResources: () => Promise<LoadedCompletionResources | undefined>;
}
export type CompletionOverlayProps = PropsRuntime<'conversation.input.overlay'> & CompletionOverlayResources;
/** Load Host policy only after the browser plugin graph has finished booting. */
export declare function CompletionOverlay({ loadResources, ...props }: CompletionOverlayProps): ReactNode;
//# sourceMappingURL=CompletionOverlay.d.ts.map