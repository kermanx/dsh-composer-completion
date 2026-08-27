/** Browser plugin mounting its own Remote descriptors and composer overlay. */

import type { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import completionRemote from '@kermanx/dsh-composer-completion/remote'
import type { CompletionClientPolicy } from '../types.ts'
import { CompletionMemoryCache, type CompletionRemote } from './completion-store.ts'
import {
  CompletionOverlay,
  type LoadedCompletionResources,
} from './CompletionOverlay.tsx'

type ComposerCompletionRemote = ClientRemote & {
  readonly composerCompletion: CompletionRemote & {
    policy(): Promise<
      | { readonly ok: true; readonly value: CompletionClientPolicy }
      | { readonly ok: false; readonly error: unknown }
    >
  }
}

export const inject = ['remote']

function registerUi(ctx: Context): void {
  const remote = ctx.remote as ComposerCompletionRemote
  let resources: Promise<LoadedCompletionResources | undefined> | undefined
  const loadResources = (): Promise<LoadedCompletionResources | undefined> => {
    resources ??= (async () => {
      try {
        const result = await remote.composerCompletion.policy()
        if (!result.ok || !result.value.enabled) return undefined
        return {
          remote: remote.composerCompletion,
          policy: result.value,
          cache: new CompletionMemoryCache(result.value.cacheEntries, result.value.cacheTtlMs),
        }
      } catch {
        // A missing Host half disables the optional UI without poisoning the composer.
        return undefined
      }
    })()
    return resources
  }
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'composer-completion',
    order: 100,
  }, (props: PropsRuntime<'conversation.input.overlay'>) => createElement(CompletionOverlay, {
    ...props,
    loadResources,
  })))
}

/** Mount the package-local Remote contribution before starting its namespace consumer. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(completionRemote)
  const ui = ctx.inject(['remote.composerCompletion', 'slots'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}
