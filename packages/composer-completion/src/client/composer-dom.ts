/** Fail-closed DOM integration with the resident conversation composer. */

import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'

export interface ComposerDom {
  readonly card: HTMLElement
  readonly input: HTMLElement
  readonly grow: HTMLElement
}

/** Resolve only the public composer markers below this overlay occurrence. */
export function probeComposer(anchor: HTMLElement): ComposerDom | undefined {
  const card = anchor.closest<HTMLElement>('[data-composer-card]')
  if (card === null) return undefined
  const input = card.querySelector<HTMLElement>('[data-composer-input]')
  if (input === null) return undefined
  const grow = input.parentElement
  if (grow === null) return undefined
  return {
    card,
    input,
    grow,
  }
}

/** Whether the live browser selection is collapsed at the end of this editor. */
export function caretAtEnd(input: HTMLElement): boolean {
  const selection = document.getSelection()
  if (selection === null || !selection.isCollapsed || selection.focusNode === null) return false
  if (selection.focusNode !== input && !input.contains(selection.focusNode)) return false
  try {
    const tail = document.createRange()
    tail.selectNodeContents(input)
    tail.setStart(selection.focusNode, selection.focusOffset)
    return tail.toString() === ''
  } catch {
    return false
  }
}

/** Insert one accepted suffix through the editor's revision-guarded public action. */
export function insertCompletion(
  input: HTMLElement,
  suffix: string,
  actions: Pick<InputActions, 'captureInsertion' | 'insertText'>,
): boolean {
  if (suffix === '' || document.activeElement !== input || !caretAtEnd(input)) return false
  return actions.insertText(suffix, actions.captureInsertion())
}
