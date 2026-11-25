"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ViewRendererProps } from "../registry";
import { useViewerReload } from "../viewer-actions";

/**
 * The CSP the wolf's HTML runs under: inline script and style and data: images and fonts, nothing else, so it cannot fetch,
 * open sockets, load remote files or navigate. Together with `sandbox="allow-scripts"` (no allow-same-origin: opaque origin,
 * no cookies, no storage, no access to the console) this is the whole trust boundary.
 */
export const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";

/** Best effort: removes `<meta http-equiv="refresh">` tags. Regex stripping can be dodged by odd markup; the iframe onLoad guard is the real backstop. */
const META_REFRESH = /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?\s*refresh\b[^>]*>/gi;

/**
 * Puts the CSP meta before everything the author wrote. A meta CSP only governs what is parsed after it, so it must be the first
 * thing in the document; prepending a doctype and the meta means author markup (its own head, metas, scripts) can never come first.
 * An author `<!doctype>` or `<head>` after ours is tolerated by the parser, and a second CSP can only tighten the policy.
 */
export function buildSrcdoc(html: string): string {
	return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">${html.replace(META_REFRESH, "")}`;
}

type State = { phase: "loading" } | { phase: "nowolf" } | { phase: "navigated" } | { phase: "ready"; html: string } | { phase: "error"; status: number | null; outdated?: boolean };

export const frameUrl = (wolf: string, path: string) => `/api/wolves/${encodeURIComponent(wolf)}/frame-file?path=${encodeURIComponent(path)}`;

/** Kind "frame": a workspace HTML file in a sandboxed iframe. Frames send no messages to the console: there is no message listener. */
export function FrameViewRenderer({ descriptor, wolf = "", onTitle }: ViewRendererProps) {
	const path = descriptor.id;
	const rev = descriptor.rev;
	const [state, setState] = useState<State>({ phase: "loading" });
	const [nonce, setNonce] = useState(0);
	// Load events seen by the current iframe: the first is our srcdoc; any later one means the frame navigated away.
	const loads = useRef(0);

	useEffect(() => {
		onTitle(descriptor.title ?? path);
	}, [descriptor.title, path, onTitle]);

	// Refetch on mount, Reload (nonce) and a new show_view rev; a stale response never overwrites a newer one.
	useEffect(() => {
		let live = true;
		loads.current = 0;
		// Never fetch with an empty wolf: that is /api/wolves//..., a 404 that reads as "gone".
		if (!wolf) {
			setState({ phase: "nowolf" });
			return;
		}
		setState({ phase: "loading" });
		fetch(frameUrl(wolf, path), { cache: "no-store" })
			.then(async (res) => {
				if (!live) return;
				if (res.ok) return setState({ phase: "ready", html: await res.text() });
				// A 404 from a host that predates the frame route is not a missing file: the console tags it host_outdated.
				const outdated = res.status === 404 && ((await res.json().catch(() => null)) as { code?: string } | null)?.code === "host_outdated";
				if (live) setState({ phase: "error", status: res.status, ...(outdated ? { outdated: true } : {}) });
			})
			.catch(() => live && setState({ phase: "error", status: null }));
		return () => {
			live = false;
		};
	}, [wolf, path, rev, nonce]);

	const reload = useCallback(() => setNonce((n) => n + 1), []);
	useViewerReload(reload);

	if (state.phase === "loading") return <p className="p-4 text-sm text-muted-foreground" role="status">Loading frame…</p>;
	if (state.phase === "nowolf") {
		return (
			<div className="p-4 text-sm text-muted-foreground" role="alert" data-testid="frame-error">
				This frame cannot be loaded here: no wolf is known for this view.
			</div>
		);
	}
	if (state.phase === "navigated") {
		return (
			<div className="flex flex-col items-start gap-3 p-4 text-sm" role="alert" data-testid="frame-navigated">
				<p className="text-muted-foreground">This frame tried to navigate away and was stopped.</p>
				<Button variant="outline" size="sm" onClick={reload}>Reload</Button>
			</div>
		);
	}
	if (state.phase === "error") {
		const gone = state.status === 404 && !state.outdated;
		return (
			<div className="flex flex-col items-start gap-3 p-4 text-sm" role="alert" data-testid="frame-error" data-gone={gone ? "true" : undefined}>
				<p className="text-muted-foreground">
					{gone ? `This frame is gone: ${path}` : state.outdated ? `This wolf's host needs an update to show frames (${path}).` : state.status === null ? "Could not load the frame (network error)." : `Could not load the frame (status ${state.status}).`}
				</p>
				<Button variant="outline" size="sm" onClick={reload}>Reload</Button>
			</div>
		);
	}
	return (
		<iframe
			key={nonce}
			title={descriptor.title ?? path}
			data-testid="frame-iframe"
			sandbox="allow-scripts"
			referrerPolicy="no-referrer"
			srcDoc={buildSrcdoc(state.html)}
			onLoad={() => {
				loads.current += 1;
				if (loads.current > 1) setState({ phase: "navigated" });
			}}
			className="block h-full w-full border-0 bg-white"
		/>
	);
}
