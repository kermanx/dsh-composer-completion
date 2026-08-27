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
        placeholder: grow.querySelector('[data-composer-placeholder]'),
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
/** Insert one accepted suffix through the editor's paste path, with standard fallbacks. */
export function insertCompletion(input, suffix, wholeDraft, setDraft) {
    if (suffix === '' || document.activeElement !== input || !caretAtEnd(input))
        return false;
    try {
        const clipboard = new DataTransfer();
        clipboard.setData('text/plain', suffix);
        const event = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: clipboard,
        });
        input.dispatchEvent(event);
        if (event.defaultPrevented)
            return true;
    }
    catch {
        // ClipboardEvent construction is unavailable in some embedded WebViews; use the browser edit command below.
    }
    try {
        if (document.execCommand('insertText', false, suffix))
            return true;
    }
    catch {
        // A disabled editing command falls through to the public whole-draft action.
    }
    setDraft(wholeDraft + suffix);
    return true;
}
//# sourceMappingURL=composer-dom.js.map