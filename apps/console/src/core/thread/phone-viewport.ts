/**
 * What counts as a phone for the floating chat and the graph's bottom-corner pieces (icon position, activity panel offset). PURE.
 * Narrow (< 768px) is a phone; so is a short touch screen (<= 500px tall, coarse pointer): a phone turned to landscape is 844x390 and must not
 * be laid out as a desktop. One definition, so the chat icon and the panel that clears it can never disagree.
 */
export const PHONE_QUERY = "(max-width: 767px), (max-height: 500px) and (pointer: coarse)";

/** The same rule as PHONE_QUERY, for tests and non-CSS callers. */
export function isPhoneViewport(width: number, height: number, coarsePointer: boolean): boolean {
	return width < 768 || (height <= 500 && coarsePointer);
}
