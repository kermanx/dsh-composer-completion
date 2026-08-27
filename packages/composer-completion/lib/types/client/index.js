/** Browser plugin mounting its own Remote descriptors and composer overlay. */
import { createElement } from 'react';
import completionRemote from '@kermanx/dsh-composer-completion/remote';
import { CompletionMemoryCache } from "./completion-store.js";
import { CompletionOverlay, } from "./CompletionOverlay.js";
export const inject = ['remote'];
function registerUi(ctx) {
    const remote = ctx.remote;
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
            catch {
                // A missing Host half disables the optional UI without poisoning the composer.
                return undefined;
            }
        })();
        return resources;
    };
    ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'composer-completion',
        order: 100,
    }, (props) => createElement(CompletionOverlay, {
        ...props,
        loadResources,
    })));
}
/** Mount the package-local Remote contribution before starting its namespace consumer. */
export async function apply(ctx) {
    const disposeRemote = await ctx.remote.$mount(completionRemote);
    const ui = ctx.inject(['remote.composerCompletion', 'slots'], registerUi);
    try {
        await ui;
    }
    catch (error) {
        await ui.dispose();
        await disposeRemote();
        throw error;
    }
    return async () => {
        await ui.dispose();
        await disposeRemote();
    };
}
//# sourceMappingURL=index.js.map