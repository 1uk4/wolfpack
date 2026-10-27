"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ActivityIcon, BotIcon, ChevronsLeftIcon, ChevronsRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MemoryPanel } from "@/components/memory-panel";
import { MEMORY_PANEL_OPEN_KEY, RIGHT_PANEL_KEY, parseOpen, parseSelections, resolveSelected, serializeOpen, serializeSelections, withSelection } from "@/src/core";

export type PanelProps = Record<string, unknown>;

/** What a panel's predicate and renderer are told about the thread it sits beside. */
export interface PanelContext {
	wolf: string;
	threadId: string;
	/** The props given to the last openPanel(id, props) for this panel on this thread. */
	props: PanelProps;
}

export interface PanelDef {
	id: string;
	label: string;
	icon: ComponentType<{ className?: string }>;
	render: (ctx: PanelContext) => ReactNode;
	/** A panel that is not available is not listed, cannot be selected and refuses openPanel. */
	available: (ctx: PanelContext) => boolean;
	/** data-testid of the panel's body wrapper (default `panel-body-<id>`). */
	testId?: string;
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
		testId: "memory-panel",
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

/** Stable for the life of a thread view: consumers that only call these never re-render on panel changes. */
export interface PanelHostActions {
	/** Select a panel and open the host. Returns false (and does nothing) when the panel is unknown or unavailable. */
	openPanel: (id: string, props?: PanelProps) => boolean;
	closePanel: () => void;
	/** Switch tab, keeping the props the panel was last opened with. */
	select: (id: string) => void;
	toggle: () => void;
}

export interface PanelHostState {
	selected: string | null;
	open: boolean;
	available: readonly PanelDef[];
	contexts: Readonly<Record<string, PanelContext>>;
}

const ActionsContext = createContext<PanelHostActions | null>(null);
const StateContext = createContext<PanelHostState | null>(null);

const NOOP_ACTIONS: PanelHostActions = { openPanel: () => false, closePanel: () => {}, select: () => {}, toggle: () => {} };
const NOOP_STATE: PanelHostState = { selected: null, open: false, available: [], contexts: {} };
let warned = false;

/** Other components call `usePanelHost().openPanel("subagent", { childThreadId })`. Outside a provider it refuses (false). */
export function usePanelHost(): PanelHostActions {
	const a = useContext(ActionsContext);
	if (!a && !warned && process.env.NODE_ENV !== "production") {
		warned = true;
		console.warn("usePanelHost() used outside <PanelHostProvider>: openPanel is a no-op");
	}
	return a ?? NOOP_ACTIONS;
}

/** The selected panel and open flag (re-renders on change). */
export const usePanelState = (): PanelHostState => useContext(StateContext) ?? NOOP_STATE;

interface HostState {
	/** Per-thread selection, as loaded from storage and changed here. */
	selections: Record<string, string>;
	/** Props from openPanel, keyed by thread then panel: one thread's childThreadId never reaches another's. */
	props: Record<string, Record<string, PanelProps>>;
	open: boolean;
}

const readStored = (): Record<string, string> => {
	try {
		return parseSelections(localStorage.getItem(RIGHT_PANEL_KEY));
	} catch {
		return {};
	}
};
const persistOpen = (open: boolean) => {
	try {
		localStorage.setItem(MEMORY_PANEL_OPEN_KEY, serializeOpen(open));
	} catch {}
};
/** Merge into what is in storage now (another tab or thread view may have written) instead of overwriting it. */
const persistSelection = (threadId: string, id: string) => {
	try {
		localStorage.setItem(RIGHT_PANEL_KEY, serializeSelections(withSelection(readStored(), threadId, id)));
	} catch {}
};

/**
 * Holds the right-panel state for one thread view. Selection is remembered per thread (localStorage
 * `lh.right-panel.v1`, non-default entries only); open/closed is global (the Memory panel's existing
 * `lh.memory-panel.open.v1`).
 */
export function PanelHostProvider({ wolf, threadId, panels = PANELS, children }: { wolf: string; threadId: string; panels?: readonly PanelDef[]; children: ReactNode }) {
	const [st, setSt] = useState<HostState>({ selections: {}, props: {}, open: true });
	useEffect(() => {
		try {
			const open = parseOpen(localStorage.getItem(MEMORY_PANEL_OPEN_KEY));
			setSt((s) => ({ ...s, selections: readStored(), open }));
		} catch {}
	}, []);
	// Latest state for the stable actions (they must not change identity with it).
	const stRef = useRef(st);
	stRef.current = st;

	const ctxOf = useCallback(
		(p: PanelDef): PanelContext => ({ wolf, threadId, props: st.props[threadId]?.[p.id] ?? {} }),
		[wolf, threadId, st.props],
	);

	const choose = useCallback(
		(id: string, props: PanelProps) => {
			persistSelection(threadId, id);
			persistOpen(true);
			setSt((s) => ({
				selections: withSelection(s.selections, threadId, id),
				props: { ...s.props, [threadId]: { ...s.props[threadId], [id]: props } },
				open: true,
			}));
		},
		[threadId],
	);
	const openPanel = useCallback(
		(id: string, props: PanelProps = {}) => {
			const def = panels.find((p) => p.id === id);
			if (!def || !def.available({ wolf, threadId, props })) return false;
			choose(id, props);
			return true;
		},
		[panels, wolf, threadId, choose],
	);
	const select = useCallback((id: string) => void openPanel(id, stRef.current.props[threadId]?.[id] ?? {}), [openPanel, threadId]);
	const closePanel = useCallback(() => {
		persistOpen(false);
		setSt((s) => ({ ...s, open: false }));
	}, []);
	const toggle = useCallback(() => {
		const next = !stRef.current.open;
		persistOpen(next);
		setSt((s) => ({ ...s, open: next }));
	}, []);

	const actions = useMemo<PanelHostActions>(() => ({ openPanel, closePanel, select, toggle }), [openPanel, closePanel, select, toggle]);

	const available = useMemo(() => panels.filter((p) => p.available(ctxOf(p))), [panels, ctxOf]);
	const selected = resolveSelected(st.selections[threadId], available.map((p) => p.id));
	const contexts = useMemo(() => Object.fromEntries(available.map((p) => [p.id, ctxOf(p)])), [available, ctxOf]);
	const state = useMemo<PanelHostState>(() => ({ selected, open: st.open, available, contexts }), [selected, st.open, available, contexts]);

	return (
		<ActionsContext.Provider value={actions}>
			<StateContext.Provider value={state}>{children}</StateContext.Provider>
		</ActionsContext.Provider>
	);
}

/**
 * The panel column: render it where the right side of the view goes (a flex sibling of the conversation).
 * A panel stays mounted once it has been shown (hidden while collapsed or deselected), so it keeps its
 * subscriptions and state.
 */
export function RightPanelHost() {
	const actions = useContext(ActionsContext);
	const state = useContext(StateContext);
	const [seen, setSeen] = useState<readonly string[]>([]);
	if (state?.selected && !seen.includes(state.selected)) setSeen([...seen, state.selected]);
	if (!actions || !state || !state.selected) return null;
	const { selected, open, available, contexts } = state;
	const mounted = available.filter((p) => p.id === selected || seen.includes(p.id));
	return (
		<aside
			className={open ? "relative flex w-80 shrink-0 flex-col border-l border-border text-sm" : "flex w-9 shrink-0 flex-col items-center border-l border-border py-2"}
			data-testid="panel-host"
			data-open={open}
			data-panel={selected}
		>
			{open ? (
				<div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3 w-full">
					<div role="tablist" aria-label="Side panels" className="flex min-w-0 items-center gap-1" data-testid="panel-switcher">
						{available.map((p) => {
							const Icon = p.icon;
							const active = p.id === selected;
							return (
								<button
									key={p.id}
									type="button"
									role="tab"
									aria-selected={active}
									data-testid={`panel-tab-${p.id}`}
									className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
									onClick={() => actions.select(p.id)}
								>
									<Icon className="size-3.5 shrink-0" />
									<span className="truncate">{p.label}</span>
								</button>
							);
						})}
					</div>
					<Button variant="ghost" size="icon" aria-label="Collapse side panel" onClick={actions.toggle}>
						<ChevronsRightIcon />
					</Button>
				</div>
			) : (
				<Button variant="ghost" size="icon" aria-label="Open side panel" onClick={actions.toggle}>
					<ChevronsLeftIcon />
				</Button>
			)}
			{mounted.map((p) => {
				const shown = open && p.id === selected;
				return (
					<div key={p.id} hidden={!shown} className={shown ? "flex min-h-0 flex-1 flex-col" : "hidden"} data-testid={p.testId ?? `panel-body-${p.id}`} data-open={shown}>
						{p.render(contexts[p.id]!)}
					</div>
				);
			})}
		</aside>
	);
}
