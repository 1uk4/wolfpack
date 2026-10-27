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
import { useCallback, useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { usePathname, useRouter } from "next/navigation";
import {
	buildCommandItems,
	currentWolfOf,
	findLibrarian,
	graphItems,
	kbdEventForAction,
	rankPalette,
	threadItems,
	wolfItems,
	type PaletteItem,
} from "@/src/core";
import { fetchKbGraph, fetchWolves, postConsolidate, postPromote } from "@/components/kb-client";

/** Session cache of the KB-derived items (null = not fetched yet). */
let graphCache: Promise<PaletteItem[]> | null = null;

function loadGraphItems(): Promise<PaletteItem[]> {
	graphCache ??= (async () => {
		const w = await fetchWolves();
		const librarian = w.ok ? findLibrarian(w.data.wolves)?.name : undefined;
		if (!librarian) return [];
		const g = await fetchKbGraph(librarian, { archivedWork: true });
		return g.ok ? graphItems(g.data.nodes) : [];
	})().then((items) => {
		if (items.length === 0) graphCache = null; // failed/empty: retry on the next open
		return items;
	});
	return graphCache;
}

async function loadWolfItems(): Promise<PaletteItem[]> {
	const w = await fetchWolves();
	if (!w.ok) return [];
	const lists = await Promise.all(
		w.data.wolves.map(async (wolf) => {
			try {
				const res = await fetch(`/api/wolves/${encodeURIComponent(wolf.name)}/threads`, { cache: "no-store" });
				const d = (await res.json()) as { threads: { id: string; title: string }[] };
				return threadItems(wolf.name, d.threads);
			} catch {
				return [];
			}
		}),
	);
	return [...wolfItems(w.data.wolves), ...lists.flat()];
}

export function CommandPalette() {
	const router = useRouter();
	const pathname = usePathname();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [sources, setSources] = useState<PaletteItem[]>([]);
	const [kbItems, setKbItems] = useState<PaletteItem[]>([]);
	const [result, setResult] = useState<string | null>(null);

	const wolf = currentWolfOf(pathname);

	useEffect(() => {
		const onOpen = () => {
			setQuery("");
			setResult(null);
			setOpen(true);
		};
		window.addEventListener(kbdEventForAction("open-palette"), onOpen);
		return () => window.removeEventListener(kbdEventForAction("open-palette"), onOpen);
	}, []);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		void loadWolfItems().then((items) => !cancelled && setSources(items));
		void loadGraphItems().then((items) => !cancelled && setKbItems(items));
		return () => {
			cancelled = true;
		};
	}, [open]);

	const groups = useMemo(
		() => rankPalette(query, [...buildCommandItems(wolf), ...sources, ...kbItems]),
		[query, wolf, sources, kbItems],
	);

	const run = useCallback(
		async (item: PaletteItem) => {
			if (item.href) {
				setOpen(false);
				router.push(item.href);
				return;
			}
			if (item.command === "switch-model") {
				setOpen(false);
				// After the dialog unmounts and focus restores, so the picker keeps focus.
				setTimeout(() => window.dispatchEvent(new CustomEvent(kbdEventForAction("open-model-picker"))), 0);
				return;
			}
			if (!wolf) return;
			if (item.command === "consolidate") {
				setResult(`Consolidating ${wolf}…`);
				const r = await postConsolidate(wolf);
				setResult(
					r.ok
						? `Consolidated ${r.data.observationsProcessed} observations → ${r.data.topicsCreated} new, ${r.data.topicsMerged} merged topics`
						: r.message,
				);
			} else if (item.command === "promote") {
				setResult(`Starting promote for ${wolf}…`);
				const r = await postPromote(wolf);
				setResult(r.ok ? `Promote started for ${wolf}` : r.message);
			}
		},
		[router, wolf],
	);

	return (
		<Command.Dialog
			open={open}
			onOpenChange={setOpen}
			label="Command palette"
			shouldFilter={false}
			overlayClassName="fixed inset-0 z-50 bg-black/50"
			contentClassName="fixed left-1/2 top-[18vh] z-50 w-full max-w-[34rem] -translate-x-1/2 overflow-hidden rounded-xl border bg-card shadow-2xl"
		>
			<Command.Input
				data-testid="palette-input"
				value={query}
				onValueChange={setQuery}
				placeholder="Jump to a wolf, thread, entry or work item, or run a command…"
				className="w-full border-b bg-transparent px-4 py-3 text-sm text-card-foreground outline-none placeholder:text-muted-foreground"
			/>
			<Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
				<Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">No results.</Command.Empty>
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
								onSelect={() => void run(item)}
								className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm text-card-foreground data-[selected=true]:bg-accent"
							>
								<span className="truncate">{item.label}</span>
								{item.hint && <span className="shrink-0 text-xs text-muted-foreground">{item.hint}</span>}
							</Command.Item>
						))}
					</Command.Group>
				))}
			</Command.List>
			{result && (
				<div role="status" data-testid="palette-result" className="border-t px-4 py-2 text-xs text-muted-foreground">
					{result}
				</div>
			)}
		</Command.Dialog>
	);
}
