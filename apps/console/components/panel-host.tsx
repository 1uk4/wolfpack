"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { ActivityIcon, BotIcon, ChevronsLeftIcon, ChevronsRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MemoryPanel } from "@/components/memory-panel";
import { MEMORY_PANEL_OPEN_KEY, RIGHT_PANEL_KEY, parseOpen, parseSelections, resolveSelected, serializeOpen, serializeSelections } from "@/src/core";

export type PanelProps = Record<string, unknown>;

/** What a panel's predicate and renderer are told about the thread it sits beside. */
export interface PanelContext {
	wolf: string;
	threadId: string;
	/** The props given to the last openPanel(id, props) for this panel. */
	props: PanelProps;
}

export interface PanelDef {
	id: string;
	label: string;
	icon: ComponentType<{ className?: string }>;
	render: (ctx: PanelContext) => ReactNode;
	/** A panel that is not available is not listed, cannot be selected and refuses openPanel. */
	available: (ctx: PanelContext) => boolean;
}

/** Placeholder until ticket 3 brings the child transcript; unavailable (hidden) for now. */
export function SubagentPanel({ childThreadId }: { childThreadId: string }) {
	return (
		<div className="p-3 text-xs text-muted-foreground" data-testid="subagent-panel" data-child={childThreadId}>
			Subagent {childThreadId}
		</div>
	);
}

export const PANELS: readonly PanelDef[] = [
	{
		id: "memory",
		label: "Status",
		icon: ActivityIcon,
		available: () => true,
		render: ({ wolf, threadId }) => <MemoryPanel embedded wolf={wolf} threadId={threadId} />,
	},
	{
		id: "subagent",
		label: "Subagent",
		icon: BotIcon,
		available: () => false,
		render: ({ props }) => <SubagentPanel childThreadId={String(props.childThreadId ?? "")} />,
	},
];

export interface PanelHostApi {
	/** Select a panel and open the host. Returns false (and does nothing) when the panel is unknown or unavailable. */
	openPanel: (id: string, props?: PanelProps) => boolean;
	closePanel: () => void;
	selected: string | null;
	open: boolean;
}

interface PanelHostInternal extends PanelHostApi {
	available: readonly PanelDef[];
	shown: { def: PanelDef; ctx: PanelContext } | null;
	toggle: () => void;
	/** Switch tab, keeping the props the panel was last opened with. */
	select: (id: string) => void;
}

const PanelHostContext = createContext<PanelHostInternal | null>(null);
const NOOP: PanelHostInternal = { available: [], shown: null, toggle: () => {}, select: () => {}, openPanel: () => false, closePanel: () => {}, selected: null, open: false };

/** Other components call `usePanelHost().openPanel("subagent", { childThreadId })`. Outside a provider it is a no-op. */
export const usePanelHost = (): PanelHostApi => useContext(PanelHostContext) ?? NOOP;

interface HostState {
	selections: Record<string, string>;
	props: Record<string, PanelProps>;
	open: boolean;
}

/**
 * Holds the right-panel state for one thread view. Selection is remembered per thread (localStorage
 * `lh.right-panel.v1`); open/closed stays global (the Memory panel's existing `lh.memory-panel.open.v1`).
 */
export function PanelHostProvider({ wolf, threadId, panels = PANELS, children }: { wolf: string; threadId: string; panels?: readonly PanelDef[]; children: ReactNode }) {
	const [st, setSt] = useState<HostState>({ selections: {}, props: {}, open: true });
	useEffect(() => {
		try {
			const selections = parseSelections(localStorage.getItem(RIGHT_PANEL_KEY));
			const open = parseOpen(localStorage.getItem(MEMORY_PANEL_OPEN_KEY));
			setSt((s) => ({ ...s, selections, open }));
		} catch {}
	}, []);

	const ctxOf = useCallback((p: PanelDef): PanelContext => ({ wolf, threadId, props: st.props[p.id] ?? {} }), [wolf, threadId, st.props]);
	const available = useMemo(() => panels.filter((p) => p.available(ctxOf(p))), [panels, ctxOf]);
	const selected = resolveSelected(st.selections[threadId], available.map((p) => p.id));

	const persistOpen = (open: boolean) => {
		try {
			localStorage.setItem(MEMORY_PANEL_OPEN_KEY, serializeOpen(open));
		} catch {}
	};
	const persistSelection = (selections: Record<string, string>) => {
		try {
			localStorage.setItem(RIGHT_PANEL_KEY, serializeSelections(selections));
		} catch {}
	};

	const openPanel = useCallback(
		(id: string, props: PanelProps = {}) => {
			const def = panels.find((p) => p.id === id);
			if (!def || !def.available({ wolf, threadId, props })) return false;
			setSt((s) => {
				const selections = { ...s.selections, [threadId]: id };
				persistSelection(selections);
				persistOpen(true);
				return { selections, props: { ...s.props, [id]: props }, open: true };
			});
			return true;
		},
		[panels, wolf, threadId],
	);
	const closePanel = useCallback(() => {
		persistOpen(false);
		setSt((s) => ({ ...s, open: false }));
	}, []);

	const toggle = useCallback(() => {
		const next = !st.open;
		persistOpen(next);
		setSt((s) => ({ ...s, open: next }));
	}, [st.open]);
	const shownDef = available.find((p) => p.id === selected) ?? null;
	const shown = shownDef ? { def: shownDef, ctx: ctxOf(shownDef) } : null;
	const select = useCallback((id: string) => void openPanel(id, st.props[id] ?? {}), [openPanel, st.props]);
	const api = useMemo<PanelHostInternal>(
		() => ({ openPanel, closePanel, selected, open: st.open, available, shown, toggle, select }),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[openPanel, closePanel, selected, st.open, available, st.props, toggle, select],
	);

	return <PanelHostContext.Provider value={api}>{children}</PanelHostContext.Provider>;
}

/** The panel column itself: render it where the right side of the view goes (a flex sibling of the conversation). */
export function RightPanelHost() {
	const h = useContext(PanelHostContext);
	if (!h) return null;
	return <RightPanel shown={h.shown} available={h.available} open={h.open} onSelect={h.select} onToggle={h.toggle} />;
}

function RightPanel({ shown, available, open, onSelect, onToggle }: {
	shown: { def: PanelDef; ctx: PanelContext } | null;
	available: readonly PanelDef[];
	open: boolean;
	onSelect: (id: string) => void;
	onToggle: () => void;
}) {
	if (!shown) return null;
	if (!open) {
		return (
			<aside className="flex w-9 shrink-0 flex-col items-center border-l border-border py-2" data-testid="panel-host" data-open="false">
				<Button variant="ghost" size="icon" aria-label="Open side panel" onClick={onToggle}>
					<ChevronsLeftIcon />
				</Button>
			</aside>
		);
	}
	return (
		<aside className="relative flex w-80 shrink-0 flex-col border-l border-border text-sm" data-testid="panel-host" data-open="true" data-panel={shown.def.id}>
			<div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
				<div role="tablist" aria-label="Side panels" className="flex min-w-0 items-center gap-1" data-testid="panel-switcher">
					{available.map((p) => {
						const Icon = p.icon;
						const active = p.id === shown.def.id;
						return (
							<button
								key={p.id}
								type="button"
								role="tab"
								aria-selected={active}
								data-testid={`panel-tab-${p.id}`}
								className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
								onClick={() => onSelect(p.id)}
							>
								<Icon className="size-3.5 shrink-0" />
								<span className="truncate">{p.label}</span>
							</button>
						);
					})}
				</div>
				<Button variant="ghost" size="icon" aria-label="Collapse side panel" onClick={onToggle}>
					<ChevronsRightIcon />
				</Button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col" data-testid={`panel-body-${shown.def.id}`}>{shown.def.render(shown.ctx)}</div>
		</aside>
	);
}
