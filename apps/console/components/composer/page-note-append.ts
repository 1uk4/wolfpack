/** The thread page's questionnaire-note sink. The floating chat's dictation run has no view of the page's note, so the page publishes its sink here while the note is the composer. */
let pageNoteAppend: ((t: string) => void) | null = null;
export function setPageNoteAppend(fn: ((t: string) => void) | null) {
	pageNoteAppend = fn;
}
export const getPageNoteAppend = () => pageNoteAppend;
