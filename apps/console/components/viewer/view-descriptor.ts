/** What the right-hand viewer shows: a kind (picks the renderer) and an id within that kind. `title` is an optional hint. */
export type ViewDescriptor = {
	kind: string;
	id: string;
	title?: string;
	/** Kind "frame" only: the wolf whose frames dir holds the file (id is the path inside it). */
	wolf?: string;
	/** Kind "frame" only: the show_view rev; a new rev for the same object refetches the file. */
	rev?: number;
};

/**
 * Validates a frame descriptor from untrusted data (a show_view object, stored state). The file is named `path` (alias `id`),
 * relative to the wolf's frames dir. `fallbackWolf` fills a missing wolf. Null unless kind is "frame" and wolf and path are non-empty strings.
 */
export function parseFrameDescriptor(d: unknown, fallbackWolf?: string): ViewDescriptor | null {
	if (!d || typeof d !== "object") return null;
	const o = d as Record<string, unknown>;
	const path = typeof o.path === "string" ? o.path : o.id;
	const wolf = typeof o.wolf === "string" ? o.wolf : fallbackWolf;
	if (o.kind !== "frame" || !wolf || typeof path !== "string" || !path) return null;
	return {
		kind: "frame",
		id: path,
		wolf,
		...(typeof o.title === "string" ? { title: o.title } : {}),
		...(typeof o.rev === "number" ? { rev: o.rev } : {}),
	};
}

export const viewKey = (d: Pick<ViewDescriptor, "kind" | "id">): string => `${d.kind}:${d.id}`;

/** Inverse of viewKey: splits at the first colon (ids may contain colons). Null when there is no kind or id. */
export function parseViewKey(s: string): { kind: string; id: string } | null {
	const i = s.indexOf(":");
	if (i <= 0 || i === s.length - 1) return null;
	return { kind: s.slice(0, i), id: s.slice(i + 1) };
}
