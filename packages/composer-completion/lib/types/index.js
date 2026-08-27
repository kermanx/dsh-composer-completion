/** Independent Host Remote owner for conversation-composer completion. */
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import z from '@deepseek-ai/schemastery';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { CompletionGenerator } from "./completion.js";
import { PROMPT_VERSION, promptFramingBytes } from "./prompt.js";
import { RecentUserMessageStore } from "./recent-user-messages.js";
const DEFAULTS = {
    enabled: true,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'off',
    temperature: 0.01,
    maxInputBytes: 65_536,
    maxDraftBytes: 16_384,
    maxOutputTokens: 64,
    requestTimeoutMs: 10_000,
    debounceMs: 250,
    minPrefixCharacters: 0,
    maxOutputCharacters: 512,
    cacheEntries: 128,
    cacheTtlMs: 300_000,
};
/** Loader-owned schema for every deployment-varying completion value. */
export const Config = z.object({
    enabled: z.boolean().default(DEFAULTS.enabled),
    provider: z.string().default(DEFAULTS.provider),
    model: z.string().default(DEFAULTS.model),
    reasoningEffort: z.string().default(DEFAULTS.reasoningEffort),
    temperature: z.number().min(0).max(2).default(DEFAULTS.temperature),
    maxInputBytes: z.number().step(1).min(1).default(DEFAULTS.maxInputBytes),
    maxDraftBytes: z.number().step(1).min(1).default(DEFAULTS.maxDraftBytes),
    maxOutputTokens: z.number().step(1).min(1).default(DEFAULTS.maxOutputTokens),
    requestTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(DEFAULTS.requestTimeoutMs),
    debounceMs: z.number().step(1).min(0).max(60_000).default(DEFAULTS.debounceMs),
    minPrefixCharacters: z.number().step(1).min(0).default(DEFAULTS.minPrefixCharacters),
    maxOutputCharacters: z.number().step(1).min(1).default(DEFAULTS.maxOutputCharacters),
    cacheEntries: z.number().step(1).min(1).default(DEFAULTS.cacheEntries),
    cacheTtlMs: z.number().step(1).min(1).max(2_147_483_647).default(DEFAULTS.cacheTtlMs),
});
function resolveConfig(config) {
    const resolved = {
        enabled: config.enabled ?? DEFAULTS.enabled,
        provider: config.provider ?? DEFAULTS.provider,
        model: config.model ?? DEFAULTS.model,
        reasoningEffort: config.reasoningEffort ?? DEFAULTS.reasoningEffort,
        temperature: config.temperature ?? DEFAULTS.temperature,
        maxInputBytes: config.maxInputBytes ?? DEFAULTS.maxInputBytes,
        maxDraftBytes: config.maxDraftBytes ?? DEFAULTS.maxDraftBytes,
        maxOutputTokens: config.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
        requestTimeoutMs: config.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
        debounceMs: config.debounceMs ?? DEFAULTS.debounceMs,
        minPrefixCharacters: config.minPrefixCharacters ?? DEFAULTS.minPrefixCharacters,
        maxOutputCharacters: config.maxOutputCharacters ?? DEFAULTS.maxOutputCharacters,
        cacheEntries: config.cacheEntries ?? DEFAULTS.cacheEntries,
        cacheTtlMs: config.cacheTtlMs ?? DEFAULTS.cacheTtlMs,
    };
    if (promptFramingBytes(resolved.maxDraftBytes) > resolved.maxInputBytes) {
        throw new Error('composer-completion: maxInputBytes must exceed maxDraftBytes plus prompt framing');
    }
    return resolved;
}
/** Host service backing the generated `remote.composerCompletion` namespace. */
let ComposerCompletionService = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _policy_decorators;
    let _complete_decorators;
    return class ComposerCompletionService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _policy_decorators = [Remote('policy')];
            _complete_decorators = [Remote({ mode: 'stream' })];
            __esDecorate(this, null, _policy_decorators, { kind: "method", name: "policy", static: false, private: false, access: { has: obj => "policy" in obj, get: obj => obj.policy }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _complete_decorators, { kind: "method", name: "complete", static: false, private: false, access: { has: obj => "complete" in obj, get: obj => obj.complete }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        static inject = ['llm', 'sessionController', 'typert'];
        static Config = Config;
        resolved = __runInitializers(this, _instanceExtraInitializers);
        generator;
        recentUserMessages;
        constructor(ctx, config) {
            super(ctx, 'composerCompletion', { namespace: 'composerCompletion' });
            this.resolved = resolveConfig(config);
            this.recentUserMessages = new RecentUserMessageStore();
            this.generator = new CompletionGenerator(ctx, ctx.sessionController, this.recentUserMessages, this.resolved);
            ctx.effect(() => async () => {
                await this.recentUserMessages.flush();
            }, 'composer-completion.recent-user-messages');
            ctx.on('session/event', (session, event) => {
                if (event.type === 'turn/end')
                    this.recentUserMessages.recordCompletedTurn(session, event);
            });
        }
        /** Return the browser policy paired with this Host generation policy. */
        policy() {
            return {
                enabled: this.resolved.enabled,
                model: this.resolved.model,
                promptVersion: PROMPT_VERSION,
                debounceMs: this.resolved.debounceMs,
                minPrefixCharacters: this.resolved.minPrefixCharacters,
                requestTimeoutMs: this.resolved.requestTimeoutMs,
                maxOutputCharacters: this.resolved.maxOutputCharacters,
                cacheEntries: this.resolved.cacheEntries,
                cacheTtlMs: this.resolved.cacheTtlMs,
            };
        }
        /** Stream user-input suffix snapshots without mutating Session history. */
        complete(request, signal) {
            return this.generator.complete(request, signal);
        }
    };
})();
export { ComposerCompletionService };
export default ComposerCompletionService;
//# sourceMappingURL=index.js.map