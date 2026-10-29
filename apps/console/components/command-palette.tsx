"use client";

/**
 * The ⌘K command palette. Opens on `lh:kbd-open-palette` (the registry's
 * dispatcher). Ranking and item building are pure (src/core/palette.ts);
 * this file only gathers sources and renders. cmdk's dialog provides the
 * a11y: Escape closes, focus is trapped and restored to the opener.
 *
 * Sources: wolves + threads (same endpoints as the sidebar) refetched on
 * each open; the librarian graph (archived work on) fetched lazily on the
 * first open and cached for the session.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Command } from "cmdk";
import { DialogTitle } from "@radix-ui/react-dialog";
import { usePathname, useRouter } from "next/navigation";
import {
	actionForBinding,
	buildCommandItems,
	createSwrCache,
	currentWolfOf,
	eventBinding,
	findKbSource,
	graphItems,
	kbdEventForAction,
	rankPalette,
	threadItems,
	wolfItems,
	type PaletteItem,
} from "@/src/core";
import { fetchKbGraph, fetchWolves, postConsolidate, postPromote } from "@/components/kb-client";

type Wolves = { name: string; status?: string; librarian?: boolean; kbReadable?: boolean }[];

/** Session cache of the KB-derived items: shown instantly on every open,
 *  refetched in the background each time. Failures/empty never stick. */
const graphCache = createSwrCache(async (): Promise<PaletteItem[]> => {
	const w = await fetchWolves();
	if (!w.ok) throw new Error(w.message);
	return loadGraphItems(w.data.wolves);
});

async function loadGraphItems(wolves: Wolves): Promise<PaletteItem[]> {
	const source = findKbSource(wolves)?.name;
	if (!source) throw new Error("No wolf can read the knowledge base");
	const g = await fetchKbGraph(source, { archivedWork: true });
	if (!g.ok) throw new Error(g.message);
	return graphItems(g.data.nodes);
}

async function loadThreadItems(wolves: Wolves): Promise<PaletteItem[]> {
	const lists = await Promise.all(
		wolves.map(async (wolf) => {
			try {
				const res = await fetch(`/api/wolves/${encodeURIComponent(wolf.name)}/threads`, { cache: "no-store" });
				const d = (await res.json()) as { threads: { id: string; title: string }[] };
				return threadItems(wolf.name, d.threads);
			} catch {
				return [];
			}
		}),
	);
	return lists.flat();
}

type Load = "loading" | "ready" | "error";

export function CommandPalette() {
	const router = useRouter();
	const pathname = usePathname();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState("");
	const [sources, setSources] = useState<PaletteItem[]>([]);
	const [sourcesState, setSourcesState] = useState<Load>("loading");
	const [kbItems, setKbItems] = useState<PaletteItem[]>(() => graphCache.peek() ?? []);
	const [kbState, setKbState] = useState<Load>(() => (graphCache.peek() ? "ready" : "loading"));
	const [result, setResult] = useState<{ wolf: string; text: string } | null>(null);
	const [busy, setBusy] = useState(false);

	const wolf = currentWolfOf(pathname);
	// Bumped on every open/close so late async results can tell they are stale.
	const epochRef = useRef(0);
	const busyRef = useRef(false);
	const pendingModelRef = useRef(false);

	const close = useCallback(() => setOpen(false), []);

	// ⌘K toggles; opening starts clean.
	useEffect(() => {
		const onToggle = () => setOpen((o) => !o);
		window.addEventListener(kbdEventForAction("open-palette"), onToggle);
		return () => window.removeEventListener(kbdEventForAction("open-palette"), onToggle);
	}, []);

	useEffect(() => {
		epochRef.current++;
		if (!open) {
			// Switch model: after the dialog is gone and focus has been restored.
			if (pendingModelRef.current) {
				pendingModelRef.current = false;
				requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(kbdEventForAction("open-model-picker"))));
			}
			return;
		}
		const epoch = epochRef.current;
		const live = () => epochRef.current === epoch;
		setQuery("");
		setResult(null);
		setSourcesState("loading");
		setKbState(graphCache.peek() ? "ready" : "loading");
		void (async () => {
			const w = await fetchWolves();
			if (!live()) return;
			if (!w.ok) {
				setSourcesState("error");
				setKbState((s) => (s === "ready" ? s : "error"));
				return;
			}
			setSources([...wolfItems(w.data.wolves), ...(await loadThreadItems(w.data.wolves))]);
			if (live()) setSourcesState("ready");
		})();
		graphCache.refresh().then(
			(items) => {
				if (!live()) return;
				setKbItems(items);
				setKbState("ready");
			},
			() => live() && setKbState((s) => (s === "ready" ? s : "error")),
		);
	}, [open]);

	// One Esc, one action (the one-Esc law, as settings-dialog.tsx): claim at
	// the document so the window chain (dictation / abort turn) never fires.
	// Other registry shortcuts are swallowed while the palette is up (⌘K
	// itself still toggles); a route change closes it.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setOpen(false);
		};
		const swallow = (e: KeyboardEvent) => {
			const action = actionForBinding(eventBinding(e));
			if (action && action !== "open-palette") e.stopPropagation();
		};
		document.addEventListener("keydown", onKey);
		window.addEventListener("keydown", swallow, true);
		return () => {
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("keydown", swallow, true);
		};
	}, [open]);

	useEffect(() => setOpen(false), [pathname]);

	const groups = useMemo(
		() => rankPalette(query, [...buildCommandItems(wolf), ...sources, ...kbItems]),
		[query, wolf, sources, kbItems],
	);

	// Reset cmdk's selection to the top result when the query changes.
	const firstId = groups[0]?.items[0]?.id ?? "";
	useEffect(() => setSelected(firstId), [query, firstId]);

	const run = useCallback(
		async (item: PaletteItem) => {
			if (item.href) {
				setOpen(false);
				router.push(item.href);
				return;
			}
			if (item.command === "switch-model") {
				pendingModelRef.current = true;
				setOpen(false);
				return;
			}
			if (!wolf || busyRef.current) return;
			const epoch = epochRef.current;
			const show = (text: string) => {
				if (epochRef.current === epoch) setResult({ wolf, text });
			};
			busyRef.current = true;
			setBusy(true);
			try {
				if (item.command === "consolidate") {
					show(`Consolidating ${wolf}…`);
					const r = await postConsolidate(wolf);
					show(
						r.ok
							? `Consolidated ${r.data.observationsProcessed} observations → ${r.data.topicsCreated} new, ${r.data.topicsMerged} merged topics`
							: r.message,
					);
				} else if (item.command === "promote") {
					show(`Starting promote for ${wolf}…`);
					const r = await postPromote(wolf);
					show(r.ok ? `Promote started for ${wolf}` : r.message);
				}
			} catch (err) {
				show(err instanceof Error ? err.message : "Request failed");
			} finally {
				busyRef.current = false;
				setBusy(false);
			}
		},
		[router, wolf],
	);

	const emptyText =
		sourcesState === "loading" || kbState === "loading"
			? "Loading…"
			: sourcesState === "error" && kbState === "error"
				? "Couldn't load wolves or the knowledge graph."
				: "No results.";

	return (
		<Command.Dialog
			open={open}
			onOpenChange={setOpen}
			label="Command palette"
			shouldFilter={false}
			value={selected}
			onValueChange={setSelected}
			overlayClassName="fixed inset-0 z-50 bg-black/50"
			contentClassName="fixed left-1/2 top-[18vh] z-50 w-full max-w-[34rem] -translate-x-1/2 overflow-hidden rounded-xl border bg-card shadow-2xl"
		>
			<DialogTitle className="sr-only">Command palette</DialogTitle>
			<Command.Input
				data-testid="palette-input"
				value={query}
				onValueChange={setQuery}
				placeholder="Jump to a wolf, thread, entry or work item, or run a command…"
				className="w-full border-b bg-transparent px-4 py-3 text-sm text-card-foreground outline-none placeholder:text-muted-foreground"
			/>
			<Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
				<Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyText}</Command.Empty>
				{groups.map((g) => (
					<Command.Group
						key={g.kind}
						heading={g.label}
						className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-muted-foreground/70"
					>
						{g.items.map((item) => (
							<Command.Item
								key={item.id}
								value={item.id}
								disabled={busy && !!item.command && item.command !== "switch-model"}
								onSelect={() => void run(item)}
								className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm text-card-foreground data-[selected=true]:bg-accent data-[disabled=true]:opacity-50"
							>
								<span className="truncate">{item.label}</span>
								{item.hint && <span className="shrink-0 text-xs text-muted-foreground">{item.hint}</span>}
							</Command.Item>
						))}
					</Command.Group>
				))}
			</Command.List>
			{result && result.wolf === wolf && (
				<div role="status" data-testid="palette-result" className="border-t px-4 py-2 text-xs text-muted-foreground">
					{result.text}
				</div>
			)}
		</Command.Dialog>
	);
}
