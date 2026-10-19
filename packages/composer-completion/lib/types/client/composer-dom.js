/** Fail-closed DOM integration with the resident conversation composer. */
/** Resolve only the public composer markers below this overlay occurrence. */
export function probeComposer(anchor) {
    const card = anchor.closest('[data-composer-card]');
    if (card === null)
        return undefined;
    const input = card.querySelector('[data-composer-input]');
    if (input === null)
        return undefined;
    const grow = input.parentElement;
    if (grow === null)
        return undefined;
    return {
        card,
        input,
        grow,
    };
}
/** Whether the live browser selection is collapsed at the end of this editor. */
export function caretAtEnd(input) {
    const selection = document.getSelection();
    if (selection === null || !selection.isCollapsed || selection.focusNode === null)
        return false;
    if (selection.focusNode !== input && !input.contains(selection.focusNode))
        return false;
    try {
        const tail = document.createRange();
        tail.selectNodeContents(input);
        tail.setStart(selection.focusNode, selection.focusOffset);
        return tail.toString() === '';
    }
    catch {
        return false;
    }
}
/** Insert one accepted suffix through the editor's revision-guarded public action. */
export function insertCompletion(input, suffix, actions) {
    if (suffix === '' || document.activeElement !== input || !caretAtEnd(input))
        return false;
    return actions.insertText(suffix, actions.captureInsertion());
}
//# sourceMappingURL=composer-dom.js.map