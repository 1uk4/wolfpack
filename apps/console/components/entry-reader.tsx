"use client";

/** A KB entry page body (/kb/entry/[id]). Scaffold placeholder; the Entry-reader task fills it in. */
export function EntryReader({ id }: { id: string }) {
	return (
		<div className="p-6 text-sm text-muted-foreground" data-testid="entry-reader" data-entry={id}>
			{id}
		</div>
	);
}
