/** Composer overlay rendering ghost text and owning acceptance gestures. */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CompletionClientPolicy } from '../types.ts'
import {
  CompletionMemoryCache,
  CompletionStore,
  type CompletionRemote,
} from './completion-store.ts'
import {
  caretAtEnd,
  insertCompletion,
  probeComposer,
  type ComposerDom,
} from './composer-dom.ts'

export interface LoadedCompletionResources {
  readonly remote: CompletionRemote
  readonly policy: CompletionClientPolicy
  readonly cache: CompletionMemoryCache
}

export interface CompletionOverlayResources {
  readonly loadResources: () => Promise<LoadedCompletionResources | undefined>
}

export type CompletionOverlayProps = PropsRuntime<'conversation.input.overlay'> & CompletionOverlayResources
type ActiveCompletionOverlayProps = PropsRuntime<'conversation.input.overlay'> & LoadedCompletionResources

const EMPTY_GHOST_STYLE: CSSProperties = {
  position: 'absolute',
  inset: '4px 12px auto 16px',
  color: 'var(--dsw-alias-label-caption)',
  whiteSpace: 'pre-wrap',
  pointerEvents: 'none',
  userSelect: 'none',
  font: 'inherit',
  lineHeight: 'inherit',
}

function isEligible(
  dom: ComposerDom | undefined,
  input: InputState,
  running: boolean,
  composing: boolean,
): boolean {
  if (dom === undefined || running || composing) return false
  if (input.phase !== 'plain' || input.imageIds.length !== 0 || input.occurrences.length !== 0) return false
  if (dom.input.getAttribute('contenteditable') !== 'true' || document.activeElement !== dom.input) return false
  if (dom.card.querySelector('[role="listbox"]') !== null) return false
  return caretAtEnd(dom.input)
}

/** Load Host policy only after the browser plugin graph has finished booting. */
export function CompletionOverlay({
  loadResources,
  ...props
}: CompletionOverlayProps): ReactNode {
  const [resources, setResources] = useState<LoadedCompletionResources | undefined>()
  useEffect(() => {
    let live = true
    void loadResources().then(value => {
      if (live && value !== undefined) setResources(value)
    })
    return () => { live = false }
  }, [loadResources])
  if (resources === undefined) return <span aria-hidden style={{ display: 'none' }} />
  return <ActiveCompletionOverlay {...props} {...resources} />
}

/** Invisible slot occupant plus imperative/CSS ghost presentation. */
function ActiveCompletionOverlay({
  remote,
  policy,
  cache,
  useInput,
  inputActions,
  useSession,
}: ActiveCompletionOverlayProps): ReactNode {
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const [dom, setDom] = useState<ComposerDom | undefined>()
  const [interactionRevision, setInteractionRevision] = useState(0)
  const composingRef = useRef(false)
  const input = useInput(value => value)
  const running = useSession(value => value.running)
  const session = useSession(value => value.sessionId)
  const store = useMemo(() => new CompletionStore(remote, policy, cache), [cache, policy, remote])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    setDom(anchor === null ? undefined : probeComposer(anchor))
  }, [])

  useEffect(() => () => { store.dispose() }, [store])

  useEffect(() => {
    const editor = dom?.input
    if (editor === undefined) return
    const changed = (): void => { setInteractionRevision(value => value + 1) }
    const compositionStart = (): void => {
      composingRef.current = true
      changed()
    }
    const compositionEnd = (): void => {
      composingRef.current = false
      changed()
    }
    editor.addEventListener('focusin', changed)
    editor.addEventListener('focusout', changed)
    editor.addEventListener('compositionstart', compositionStart)
    editor.addEventListener('compositionend', compositionEnd)
    document.addEventListener('selectionchange', changed)
    return () => {
      editor.removeEventListener('focusin', changed)
      editor.removeEventListener('focusout', changed)
      editor.removeEventListener('compositionstart', compositionStart)
      editor.removeEventListener('compositionend', compositionEnd)
      document.removeEventListener('selectionchange', changed)
    }
  }, [dom?.input])

  const eligible = isEligible(dom, input, running, composingRef.current)
  useEffect(() => {
    store.update({ sessionId: session, draft: input.draft, eligible, running })
  }, [eligible, input, interactionRevision, running, session, store])

  useEffect(() => {
    if (dom === undefined || snapshot.suggestion === null || input.draft === '') return
    const value = JSON.stringify(snapshot.suggestion)
    const previous = dom.input.style.getPropertyValue('--dsh-composer-hint')
    const priority = dom.input.style.getPropertyPriority('--dsh-composer-hint')
    dom.input.style.setProperty('--dsh-composer-hint', value)
    return () => {
      if (dom.input.style.getPropertyValue('--dsh-composer-hint') !== value) return
      if (previous === '') dom.input.style.removeProperty('--dsh-composer-hint')
      else dom.input.style.setProperty('--dsh-composer-hint', previous, priority)
    }
  }, [dom, input, snapshot.suggestion])

  const emptyGhost = dom !== undefined && input?.draft === '' ? snapshot.suggestion : null
  useEffect(() => {
    if (dom === undefined || emptyGhost === null) return
    const placeholder = dom.grow.querySelector<HTMLElement>('[data-composer-placeholder]')
    if (placeholder === null) return
    const previous = placeholder.style.visibility
    placeholder.style.visibility = 'hidden'
    return () => { placeholder.style.visibility = previous }
  }, [dom, emptyGhost])

  useEffect(() => {
    const editor = dom?.input
    if (editor === undefined) return
    const keydown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.target !== editor) return
      if (event.key === 'Escape') {
        if (!store.dismiss()) return
        event.preventDefault()
        return
      }
      if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
      const suffix = store.getSnapshot().suggestion
      if (suffix === null || suffix === ''
        || !isEligible(dom, input, running, composingRef.current)) return
      event.preventDefault()
      if (insertCompletion(editor, suffix, input.draft, inputActions.setDraft)) store.accepted()
    }
    document.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('keydown', keydown) }
  }, [dom, input, inputActions.setDraft, running, store])

  return (
    <>
      <span ref={anchorRef} aria-hidden style={{ display: 'none' }} />
      {emptyGhost === null || dom === undefined ? null : createPortal(
        <div aria-hidden data-composer-empty-completion style={EMPTY_GHOST_STYLE}>{emptyGhost}</div>,
        dom.grow,
      )}
    </>
  )
}
