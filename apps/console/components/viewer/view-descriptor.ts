/** What the right-hand viewer shows: a kind (picks the renderer) and an id within that kind. `title` is an optional hint. */
export type ViewDescriptor = { kind: string; id: string; title?: string };

export const viewKey = (d: Pick<ViewDescriptor, "kind" | "id">): string => `${d.kind}:${d.id}`;

/** Inverse of viewKey: splits at the first colon (ids may contain colons). Null when there is no kind or id. */
export function parseViewKey(s: string): { kind: string; id: string } | null {
	const i = s.indexOf(":");
	if (i <= 0 || i === s.length - 1) return null;
	return { kind: s.slice(0, i), id: s.slice(i + 1) };
}
