import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/** Composer overlay rendering ghost text and owning acceptance gestures. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, } from 'react';
import { createPortal } from 'react-dom';
import { CompletionStore, } from "./completion-store.js";
import { caretAtEnd, insertCompletion, probeComposer, } from "./composer-dom.js";
const EMPTY_GHOST_STYLE = {
    position: 'absolute',
    inset: '4px 12px auto 16px',
    color: 'var(--dsw-alias-label-caption)',
    whiteSpace: 'pre-wrap',
    pointerEvents: 'none',
    userSelect: 'none',
    font: 'inherit',
    lineHeight: 'inherit',
};
function isEligible(dom, input, running, composing) {
    if (dom === undefined || running || composing)
        return false;
    if (input.phase !== 'plain' || input.imageIds.length !== 0 || input.occurrences.length !== 0)
        return false;
    if (dom.input.getAttribute('contenteditable') !== 'true' || document.activeElement !== dom.input)
        return false;
    if (dom.card.querySelector('[role="listbox"]') !== null)
        return false;
    return caretAtEnd(dom.input);
}
/** Load Host policy only after the browser plugin graph has finished booting. */
export function CompletionOverlay({ loadResources, ...props }) {
    const [resources, setResources] = useState();
    useEffect(() => {
        let live = true;
        void loadResources().then(value => {
            if (live && value !== undefined)
                setResources(value);
        });
        return () => { live = false; };
    }, [loadResources]);
    if (resources === undefined)
        return _jsx("span", { "aria-hidden": true, style: { display: 'none' } });
    return _jsx(ActiveCompletionOverlay, { ...props, ...resources });
}
/** Invisible slot occupant plus imperative/CSS ghost presentation. */
function ActiveCompletionOverlay({ remote, policy, cache, useInput, inputActions, useSession, }) {
    const anchorRef = useRef(null);
    const [dom, setDom] = useState();
    const [interactionRevision, setInteractionRevision] = useState(0);
    const composingRef = useRef(false);
    const input = useInput(value => value);
    const running = useSession(value => value.running);
    const session = useSession(value => value.sessionId);
    const store = useMemo(() => new CompletionStore(remote, policy, cache), [cache, policy, remote]);
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    useLayoutEffect(() => {
        const anchor = anchorRef.current;
        setDom(anchor === null ? undefined : probeComposer(anchor));
    }, []);
    useEffect(() => () => { store.dispose(); }, [store]);
    useEffect(() => {
        const editor = dom?.input;
        if (editor === undefined)
            return;
        const changed = () => { setInteractionRevision(value => value + 1); };
        const compositionStart = () => {
            composingRef.current = true;
            changed();
        };
        const compositionEnd = () => {
            composingRef.current = false;
            changed();
        };
        editor.addEventListener('focusin', changed);
        editor.addEventListener('focusout', changed);
        editor.addEventListener('compositionstart', compositionStart);
        editor.addEventListener('compositionend', compositionEnd);
        document.addEventListener('selectionchange', changed);
        return () => {
            editor.removeEventListener('focusin', changed);
            editor.removeEventListener('focusout', changed);
            editor.removeEventListener('compositionstart', compositionStart);
            editor.removeEventListener('compositionend', compositionEnd);
            document.removeEventListener('selectionchange', changed);
        };
    }, [dom?.input]);
    const eligible = isEligible(dom, input, running, composingRef.current);
    useEffect(() => {
        store.update({ sessionId: session, draft: input.draft, eligible, running });
    }, [eligible, input, interactionRevision, running, session, store]);
    useEffect(() => {
        if (dom === undefined || snapshot.suggestion === null || input.draft === '')
            return;
        const value = JSON.stringify(snapshot.suggestion);
        const previous = dom.input.style.getPropertyValue('--dsh-composer-hint');
        const priority = dom.input.style.getPropertyPriority('--dsh-composer-hint');
        dom.input.style.setProperty('--dsh-composer-hint', value);
        return () => {
            if (dom.input.style.getPropertyValue('--dsh-composer-hint') !== value)
                return;
            if (previous === '')
                dom.input.style.removeProperty('--dsh-composer-hint');
            else
                dom.input.style.setProperty('--dsh-composer-hint', previous, priority);
        };
    }, [dom, input, snapshot.suggestion]);
    const emptyGhost = dom !== undefined && input?.draft === '' ? snapshot.suggestion : null;
    useEffect(() => {
        if (dom === undefined || emptyGhost === null)
            return;
        const placeholder = dom.grow.querySelector('[data-composer-placeholder]');
        if (placeholder === null)
            return;
        const previous = placeholder.style.visibility;
        placeholder.style.visibility = 'hidden';
        return () => { placeholder.style.visibility = previous; };
    }, [dom, emptyGhost]);
    useEffect(() => {
        const editor = dom?.input;
        if (editor === undefined)
            return;
        const keydown = (event) => {
            if (event.defaultPrevented || event.target !== editor)
                return;
            if (event.key === 'Escape') {
                if (!store.dismiss())
                    return;
                event.preventDefault();
                return;
            }
            if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey)
                return;
            const suffix = store.getSnapshot().suggestion;
            if (suffix === null || suffix === ''
                || !isEligible(dom, input, running, composingRef.current))
                return;
            event.preventDefault();
            if (insertCompletion(editor, suffix, input.draft, inputActions.setDraft))
                store.accepted();
        };
        document.addEventListener('keydown', keydown);
        return () => { document.removeEventListener('keydown', keydown); };
    }, [dom, input, inputActions.setDraft, running, store]);
    return (_jsxs(_Fragment, { children: [_jsx("span", { ref: anchorRef, "aria-hidden": true, style: { display: 'none' } }), emptyGhost === null || dom === undefined ? null : createPortal(_jsx("div", { "aria-hidden": true, "data-composer-empty-completion": true, style: EMPTY_GHOST_STYLE, children: emptyGhost }), dom.grow)] }));
}
//# sourceMappingURL=CompletionOverlay.js.map