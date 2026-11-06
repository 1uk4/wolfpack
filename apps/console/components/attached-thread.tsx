"use client";

/**
 * AttachedThreadProvider: the ONE thread the floating chat bar talks to (`{wolf, slug, threadId}`), persisted in
 * localStorage. Navigation never touches it; only `attach()` does ("Attach bar here", the switcher).
 *
 * It also holds what the bar and its switcher read: the wolf roster and each wolf's thread list, kept live from the
 * /api/events channel (thread-updated patches a row in place, needs-you-changed patches the status and refetches that
 * wolf's list). The bar has no stream of its own: "working" is the attached row's `status === "busy"` (plus an optimistic
 * flag between a send and the first busy/idle event).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
	buildSwitcher,
	loadAttached,
	loadMinimized,
	resolveAttached,
	saveAttached,
	saveMinimized,
	threadSlug,
	type AttachedRef,
	type BarThread,
	type KeyValueStore,
	type SwitcherGroup,
	type ThreadsByWolf,
	type WolfLite,
} from "@/src/core";
import { useOptionalServerEvent, useOptionalServerResync } from "@/components/server-events";
import { openFeatureThread, type KbResult } from "@/components/kb-client";

export interface AttachedThreadApi {
	attached: AttachedRef | null;
	/** The quiet one-liner after a fallback to the home thread. */
	note: string | null;
	minimized: boolean;
	setMinimized: (v: boolean) => void;
	wolves: readonly WolfLite[];
	threads: ThreadsByWolf;
	groups: SwitcherGroup[];
	/** The attached thread's row (undefined until the lists loaded). */
	attachedThread: BarThread | undefined;
	/** A turn is running on the attached thread. */
	working: boolean;
	/** The bar just sent: show "working" until the wolf reports the turn's status. */
	markSent: () => void;
	attach: (ref: { wolf: string; threadId: string; slug?: string }) => void;
	/** Open (or create) the work item's feature thread on `wolf`, then attach. Resolves to an error message or null. */
	attachWorkItem: (wolf: string, workItemId: string) => Promise<string | null>;
	refresh: () => void;
}

const Ctx = createContext<AttachedThreadApi | null>(null);

/** Null outside the provider (a standalone render): the bar then draws nothing. */
export function useAttachedThread(): AttachedThreadApi | null {
	return useContext(Ctx);
}

function browserStore(): KeyValueStore | null {
	try {
		return typeof window === "undefined" ? null : (window.localStorage ?? null);
	} catch {
		return null;
	}
}

/** "Attach bar here" on a work item: open (create when it has none) the item's thread, then attach. Pure over its seams. */
export async function attachToWorkItem(
	wolf: string,
	workItemId: string,
	open: (wolf: string, id: string) => Promise<KbResult<{ id: string; title: string }>>,
	attach: (ref: { wolf: string; threadId: string }) => void,
): Promise<string | null> {
	const r = await open(wolf, workItemId);
	if (!r.ok) return r.message;
	attach({ wolf, threadId: r.data.id });
	return null;
}

async function getJson<T>(url: string): Promise<T | undefined> {
	try {
		const res = await fetch(url, { cache: "no-store" });
		return res.ok ? ((await res.json()) as T) : undefined;
	} catch {
		return undefined;
	}
}

export function AttachedThreadProvider({
	children,
	storage,
	openThread = openFeatureThread,
}: {
	children: ReactNode;
	/** Test seam; defaults to localStorage. */
	storage?: KeyValueStore | null;
	openThread?: typeof openFeatureThread;
}) {
	const store = storage === undefined ? browserStore() : storage;
	const storeRef = useRef(store);
	storeRef.current = store;
	const [attached, setAttachedState] = useState<AttachedRef | null>(null);
	const attachedRef = useRef<AttachedRef | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const [minimized, setMinimizedState] = useState(false);
	const [wolves, setWolves] = useState<readonly WolfLite[]>([]);
	const [threads, setThreads] = useState<ThreadsByWolf>({});
	const [sent, setSent] = useState(false);
	const loaded = useRef(false);

	const setAttached = useCallback((ref: AttachedRef | null, n: string | null) => {
		attachedRef.current = ref;
		setAttachedState(ref);
		setNote(n);
		saveAttached(storeRef.current, ref);
	}, []);

	// Restore the persisted choice once (post-mount: SSR-safe).
	useEffect(() => {
		attachedRef.current = loadAttached(storeRef.current);
		setAttachedState(attachedRef.current);
		setMinimizedState(loadMinimized(storeRef.current));
	}, []);

	const settle = useCallback((ws: readonly WolfLite[], ts: ThreadsByWolf) => {
		const res = resolveAttached(attachedRef.current, ws, ts);
		const cur = attachedRef.current;
		if (res.attached && (res.attached.threadId !== cur?.threadId || res.attached.wolf !== cur?.wolf)) setAttached(res.attached, res.note);
	}, [setAttached]);

	const refresh = useCallback(() => {
		void (async () => {
			const r = await getJson<{ wolves?: WolfLite[] }>("/api/wolves");
			const ws = Array.isArray(r?.wolves) ? r.wolves : undefined;
			if (!ws) return;
			const next: Record<string, readonly BarThread[] | undefined> = {};
			await Promise.all(
				ws.filter((w) => w.status !== "offline").map(async (w) => {
					const t = await getJson<{ threads?: BarThread[] }>(`/api/wolves/${encodeURIComponent(w.name)}/threads`);
					next[w.name] = Array.isArray(t?.threads) ? t.threads : undefined;
				}),
			);
			loaded.current = true;
			setWolves(ws);
			setThreads(next);
			settle(ws, next);
		})();
	}, [settle]);

	useEffect(() => refresh(), [refresh]);
	useOptionalServerResync(refresh);

	const refreshWolf = useCallback((wolf: string) => {
		void getJson<{ threads?: BarThread[] }>(`/api/wolves/${encodeURIComponent(wolf)}/threads`).then((t) => {
			if (!Array.isArray(t?.threads)) return;
			setThreads((prev) => ({ ...prev, [wolf]: t.threads }));
		});
	}, []);

	const patchStatus = useCallback((wolf: string, threadId: string, status: "idle" | "busy" | "needs-you") => {
		setThreads((prev) => (prev[wolf] ? { ...prev, [wolf]: prev[wolf]!.map((t) => (t.id === threadId ? { ...t, status } : t)) } : prev));
	}, []);

	useOptionalServerEvent("needs-you-changed", (ev) => {
		if (ev.threadId && ev.status) patchStatus(ev.wolf, ev.threadId, ev.status);
		const a = attachedRef.current;
		if (a && ev.wolf === a.wolf && (!ev.threadId || ev.threadId === a.threadId)) {
			// The turn's end: fetch the thread's state (status, archived) rather than trust the frame alone.
			if (ev.status !== "busy") setSent(false);
			refreshWolf(ev.wolf);
		}
	});
	useOptionalServerEvent("thread-updated", (ev) => {
		const a = attachedRef.current;
		const id = ev.thread.id;
		if (ev.thread.status) patchStatus(ev.wolf, id, ev.thread.status);
		if (a && ev.wolf === a.wolf && id === a.threadId) {
			if (ev.thread.status && ev.thread.status !== "busy") setSent(false);
			refreshWolf(ev.wolf);
		}
	});

	const attach = useCallback<AttachedThreadApi["attach"]>((ref) => {
		setSent(false);
		setAttached({ wolf: ref.wolf, threadId: ref.threadId, slug: ref.slug ?? threadSlug(ref.wolf, ref.threadId) }, null);
		refreshWolf(ref.wolf);
	}, [setAttached, refreshWolf]);

	const attachWorkItem = useCallback((wolf: string, id: string) => attachToWorkItem(wolf, id, openThread, attach), [openThread, attach]);

	const setMinimized = useCallback((v: boolean) => {
		setMinimizedState(v);
		saveMinimized(storeRef.current, v);
	}, []);

	const attachedThread = attached ? threads[attached.wolf]?.find((t) => t.id === attached.threadId) : undefined;
	const working = attachedThread?.status === "busy" || sent;
	const markSent = useCallback(() => setSent(true), []);
	// An optimistic "sent" must not stick when no status frame ever arrives (e.g. an instant turn): the list refetch settles it.
	useEffect(() => {
		if (sent && attachedThread?.status === "idle") {
			const t = setTimeout(() => setSent(false), 4000);
			return () => clearTimeout(t);
		}
	}, [sent, attachedThread?.status]);

	const groups = useMemo(() => buildSwitcher(wolves, threads), [wolves, threads]);
	const value = useMemo<AttachedThreadApi>(
		() => ({ attached, note, minimized, setMinimized, wolves, threads, groups, attachedThread, working, markSent, attach, attachWorkItem, refresh }),
		[attached, note, minimized, setMinimized, wolves, threads, groups, attachedThread, working, markSent, attach, attachWorkItem, refresh],
	);
	return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** "Attach bar here" on a thread page: a quiet header button; absent outside the provider. */
export function AttachBarButton({ wolf, slug, threadId }: { wolf: string; slug: string; threadId: string }) {
	const api = useAttachedThread();
	if (!api) return null;
	const here = api.attached?.wolf === wolf && api.attached.threadId === threadId;
	return (
		<button
			type="button"
			data-testid="attach-bar-here"
			disabled={here}
			onClick={() => api.attach({ wolf, threadId, slug })}
			className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50 max-md:hidden"
		>
			{here ? "Bar attached" : "Attach bar here"}
		</button>
	);
}

/** "Attach bar here" on a work item: opens (creating when there is none) the item's thread on `wolf`, then attaches. */
export function AttachBarWorkButton({ wolf, workItemId, label = "Attach bar here", onError }: { wolf: string; workItemId: string; label?: string; onError?: (m: string | null) => void }) {
	const api = useAttachedThread();
	if (!api) return null;
	return (
		<button
			type="button"
			data-testid="attach-bar-work"
			data-wolf={wolf}
			onClick={() => void api.attachWorkItem(wolf, workItemId).then((m) => onError?.(m))}
			className="rounded-md border border-border px-3 py-1 text-sm hover:bg-accent max-md:hidden"
		>
			{label}
		</button>
	);
}
