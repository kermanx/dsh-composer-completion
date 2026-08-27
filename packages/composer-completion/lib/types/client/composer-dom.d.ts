/** Fail-closed DOM integration with the resident conversation composer. */
export interface ComposerDom {
    readonly card: HTMLElement;
    readonly input: HTMLElement;
    readonly grow: HTMLElement;
    readonly placeholder: HTMLElement | null;
}
/** Resolve only the public composer markers below this overlay occurrence. */
export declare function probeComposer(anchor: HTMLElement): ComposerDom | undefined;
/** Whether the live browser selection is collapsed at the end of this editor. */
export declare function caretAtEnd(input: HTMLElement): boolean;
/** Insert one accepted suffix through the editor's paste path, with standard fallbacks. */
export declare function insertCompletion(input: HTMLElement, suffix: string, wholeDraft: string, setDraft: (text: string) => void): boolean;
//# sourceMappingURL=composer-dom.d.ts.map