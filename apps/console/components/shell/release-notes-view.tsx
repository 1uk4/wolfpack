"use client";

/**
 * Release notes in the app (work-wolfpack-DKce6er): the GitHub release body for a tag, rendered with the console's markdown renderer
 * (no raw HTML: escapeRawHtml, links open in a new tab) plus a "View on GitHub" link. `ReleaseNotesView` is the body; `ReleaseNotesDialog`
 * wraps it in a small modal and fetches /api/release-notes?tag=. The update notice uses it, and What's New on open can reuse the dialog.
 */
import { useEffect, useState, type ComponentProps } from "react";
import { XIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { InertImage, mdComponents } from "@/components/shell/md-blocks";
import { escapeRawHtml } from "@/src/core";
import { ZC } from "@/lib/z-layers";

export type NotesState = "loading" | "missing" | { body: string; url: string };

/** Only web and mail links are clickable; any other scheme (javascript:, data:, ...) renders as plain text. */
function NewTabLink(props: ComponentProps<"a">) {
	if (!/^(https?:|mailto:)/i.test(props.href ?? "")) return <span>{props.children}</span>;
	return <a href={props.href} target="_blank" rel="noreferrer noopener" className="wrap-anywhere font-medium text-primary underline">{props.children}</a>;
}
/** Images in a release body show their alt text; nothing is fetched from a remote host. */
const components = { ...mdComponents, a: NewTabLink, img: InertImage };

/** Fetch the notes for a tag from the console route; "missing" on 404 or any failure so the caller can fall back to the release link. */
export function useReleaseNotes(tag: string | null): NotesState {
	const [state, setState] = useState<NotesState>("loading");
	useEffect(() => {
		if (!tag) return;
		let alive = true;
		setState("loading");
		void fetch(`/api/release-notes?tag=${encodeURIComponent(tag)}`)
			.then((r) => (r.ok ? (r.json() as Promise<{ body?: string; url?: string }>) : null))
			.then((j) => alive && setState(j?.body ? { body: j.body, url: j.url ?? "" } : "missing"))
			.catch(() => alive && setState("missing"));
		return () => {
			alive = false;
		};
	}, [tag]);
	return state;
}

export function ReleaseNotesView({ state, fallbackUrl }: { state: NotesState; fallbackUrl?: string | null }) {
	if (state === "loading") return <p data-testid="release-notes-loading" className="text-xs text-muted-foreground">Loading release notes…</p>;
	const url = state === "missing" ? fallbackUrl : state.url || fallbackUrl;
	return (
		<div data-testid="release-notes" className="text-sm">
			{state === "missing" ? <p className="text-muted-foreground">Release notes aren't available here.</p> : <MessageResponse components={components} className="[--wp-prose-size:14px] [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h4]:text-sm">{escapeRawHtml(state.body)}</MessageResponse>}
			{url && (
				<p className="mt-3 text-xs">
					<a href={url} target="_blank" rel="noreferrer noopener" className="text-muted-foreground underline hover:text-foreground">View on GitHub</a>
				</p>
			)}
		</div>
	);
}

/** The modal shell around already-known notes state (the update notice owns the fetch; tests render this directly). */
export function ReleaseNotesModal({ state, title, fallbackUrl, onClose }: { state: NotesState; title: string; fallbackUrl?: string | null; onClose: () => void }) {
	return (
		<div role="dialog" aria-modal="true" aria-label={title} className={`fixed inset-0 ${ZC.modal} flex items-center justify-center bg-black/50 p-4`} onClick={onClose}>
			<div className="relative max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-lg border bg-background p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
				<button type="button" aria-label="Close" onClick={onClose} className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
					<XIcon className="size-4" />
				</button>
				<h2 className="mb-3 pr-6 text-sm font-semibold">{title}</h2>
				<ReleaseNotesView state={state} fallbackUrl={fallbackUrl} />
			</div>
		</div>
	);
}

/** Fetches the notes for `tag` and shows them in the modal; reusable by What's New on open. */
export function ReleaseNotesDialog({ tag, title, fallbackUrl, onClose }: { tag: string; title?: string; fallbackUrl?: string | null; onClose: () => void }) {
	return <ReleaseNotesModal state={useReleaseNotes(tag)} title={title ?? tag} fallbackUrl={fallbackUrl} onClose={onClose} />;
}
