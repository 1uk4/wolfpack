"use client";

/**
 * The home surface at "/": the pack's KB graph, served by the librarian wolf.
 *
 * Owns the data side of the graph: the librarian lookup, the persisted
 * display/view settings (layer toggles + domain filter are the graph query),
 * the fetch (use-kb-graph.ts) and the `/?focus=<nodeId>` URL param. The
 * canvas, search, cards and settings panel are graph-view.tsx.
 *
 * States: loading, unavailable (no librarian online — a clear empty state,
 * not an error), error (with a retry), ready.
 *
 * For the Live-activity task: `controllerRef` (below) holds the mounted
 * canvas's renderer (`controllerRef.current?.renderer()`), and `kb.refetch()`
 * re-runs the current graph query; positions and camera survive the refetch.
 */
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { WaypointsIcon } from "lucide-react";
import { focusRemedy, parseFocusParam, type FocusRemedy } from "@/src/core";
import { GraphView, type GraphViewController } from "./graph-view";
import { useGraphSettings } from "./use-graph-settings";
import { useKbGraph } from "./use-kb-graph";
import { useLibrarian } from "./use-librarian";

function Placeholder({ title, children }: { title: string; children?: React.ReactNode }) {
	return (
		<div className="flex h-full w-full items-center justify-center px-4" data-testid="graph-placeholder">
			<div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
				<WaypointsIcon className="size-10 opacity-40" strokeWidth={1.25} />
				<div className="text-lg font-medium text-foreground">{title}</div>
				{children}
			</div>
		</div>
	);
}

/** The presentational states (exported for the SSR pins). */
export function GraphUnavailable({ message }: { message?: string | null }) {
	return (
		<Placeholder title="Knowledge graph unavailable">
			<p className="max-w-sm text-sm">
				The graph is served by the librarian wolf, and none is online right now.
				{message ? ` (${message})` : ""} Start the librarian and this page fills in on its own.
			</p>
		</Placeholder>
	);
}

function GraphHomeInner() {
	const router = useRouter();
	const params = useSearchParams();
	const { librarian, loading: librarianLoading } = useLibrarian();
	const { settings, loaded, changeSettings } = useGraphSettings();

	// Transient view changes a `/?focus=` target asked for (archived work,
	// den topics, no domain filter). Never persisted into the settings.
	const [forced, setForced] = useState<FocusRemedy>({});
	const focusParam = parseFocusParam(params);
	const kb = useKbGraph(librarian, librarianLoading || !loaded, {
		domain: forced.allDomains ? undefined : (settings.domain ?? undefined),
		archivedWork: settings.layers.archivedWork || !!forced.archivedWork,
		wikilinks: settings.layers.wikilinks,
		denTopics: settings.layers.denTopics || !!forced.denTopics,
	});
	const controllerRef = useRef<GraphViewController | null>(null);

	// A focus target the loaded graph lacks: widen the view once (the
	// remedy computed against what is currently applied); if nothing helps,
	// drop the param.
	const [notice, setNotice] = useState<string | null>(null);
	const graph = kb.graph;
	const present = focusParam !== null && graph !== null && graph.nodes.some((n) => n.id === focusParam);
	useEffect(() => {
		if (!focusParam || !graph || kb.status !== "ready" || present) return;
		const remedy = focusRemedy(focusParam, {
			layers: {
				archivedWork: settings.layers.archivedWork || !!forced.archivedWork,
				wikilinks: settings.layers.wikilinks,
				denTopics: settings.layers.denTopics || !!forced.denTopics,
			},
			domain: forced.allDomains ? null : settings.domain,
		});
		if (remedy) {
			setForced((f) => ({ ...f, ...remedy }));
			return;
		}
		setNotice("That item isn't in the graph.");
		router.replace("/", { scroll: false });
	}, [focusParam, graph, kb.status, present, settings, forced, router]);
	useEffect(() => {
		if (!notice) return;
		const id = setTimeout(() => setNotice(null), 4000);
		return () => clearTimeout(id);
	}, [notice]);

	let body: React.ReactNode;
	if (kb.status === "unavailable") body = <GraphUnavailable message={kb.message} />;
	else if (graph === null && kb.status === "error")
		body = (
			<Placeholder title="Couldn't load the knowledge graph">
				<p className="max-w-sm text-sm">{kb.message}</p>
				<button type="button" onClick={kb.refetch} className="rounded-lg border px-3 py-1 text-sm text-foreground hover:bg-accent">
					Retry
				</button>
			</Placeholder>
		);
	else if (graph === null || !loaded) body = <Placeholder title="Loading the knowledge graph…" />;
	else
		body = (
			<GraphView
				graph={graph}
				settings={settings}
				changeSettings={changeSettings}
				focusId={present ? focusParam : null}
				onFocusHandled={() => router.replace("/", { scroll: false })}
				controllerRef={controllerRef}
			/>
		);

	return (
		<div className="relative h-full w-full">
			{body}
			{kb.status === "error" && graph !== null && (
				<div className="absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-lg border bg-card/90 px-3 py-1.5 text-xs text-muted-foreground shadow-lg">
					<span>Couldn&apos;t refresh the graph: {kb.message}</span>
					<button type="button" onClick={kb.refetch} className="text-foreground underline">
						Retry
					</button>
				</div>
			)}
			{notice && (
				<div className="absolute bottom-3 left-3 z-10 rounded-lg border bg-card/90 px-3 py-1.5 text-xs text-muted-foreground shadow-lg">
					{notice}
				</div>
			)}
		</div>
	);
}

export function GraphHome() {
	// useSearchParams needs a Suspense boundary (the page is prerendered).
	return (
		<Suspense fallback={null}>
			<GraphHomeInner />
		</Suspense>
	);
}
