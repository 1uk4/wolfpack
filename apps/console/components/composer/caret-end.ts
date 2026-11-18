import type { FocusEvent, MouseEvent } from "react";

type Field = HTMLInputElement | HTMLTextAreaElement;

/** Focus a field with the caret after its last character. */
export function focusEnd(el: Field | null | undefined) {
	if (!el) return;
	el.focus();
	try {
		el.setSelectionRange(el.value.length, el.value.length);
	} catch {
		// inputs of a type without a selection
	}
}

/** onMouseDown: a click that brings focus in from outside lands the caret at the END of the text. A click in a field that already
 *  has focus is left to the browser, so the caret goes where the owner clicks. */
export function endOnOutsideMouseDown(e: MouseEvent<Field>) {
	const el = e.currentTarget;
	if (document.activeElement === el) return;
	if (e.button !== undefined && e.button !== 0) return;
	e.preventDefault();
	focusEnd(el);
}

/** onFocus: focus that arrives without a click (keyboard, script) also puts the caret at the end. */
export function endOnFocus(e?: FocusEvent<Field>) {
	const el = e?.currentTarget;
	if (!el) return;
	try {
		el.setSelectionRange(el.value.length, el.value.length);
	} catch {
		// no selection support
	}
}
