/** Browser plugin mounting its own Remote descriptors and composer overlay. */
import { createElement } from 'react';
import completionRemote from '@kermanx/dsh-composer-completion/remote';
import { CompletionMemoryCache } from "./completion-store.js";
import { CompletionOverlay, } from "./CompletionOverlay.js";
export const inject = ['remote', 'slots'];
/** Mount the package-local Remote contribution and ghost-text slot occupant. */
export async function apply(ctx) {
    const remote = ctx.remote;
    const disposeRemote = await remote.$mount(completionRemote);
    let resources;
    const loadResources = () => {
        resources ??= (async () => {
            try {
                const result = await remote.composerCompletion.policy();
                if (!result.ok || !result.value.enabled)
                    return undefined;
                return {
                    remote: remote.composerCompletion,
                    policy: result.value,
                    cache: new CompletionMemoryCache(result.value.cacheEntries, result.value.cacheTtlMs),
                };
            }
            catch (error) {
                // A missing Host half disables the optional UI without poisoning the composer.
                console.warn('[composer-completion] Host Remote unavailable', error);
                return undefined;
            }
        })();
        return resources;
    };
    const disposeSlot = ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'composer-completion',
        order: 100,
    }, (props) => createElement(CompletionOverlay, {
        ...props,
        loadResources,
    })));
    return async () => {
        disposeSlot();
        await disposeRemote();
    };
}
//# sourceMappingURL=index.js.map