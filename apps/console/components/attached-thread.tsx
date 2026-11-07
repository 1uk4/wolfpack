"use client";

/**
 * AttachedThreadProvider: the ONE thread the floating chat bar talks to (`{wolf, slug, threadId}`), persisted in
 * localStorage. Navigation never touches it; `attach()` (starting dictation on a thread pops it out) sets it and `dock()` clears it (the chat-bar docks it on landing on the thread or using another composer).
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
	LEGACY_KEYS,
	loadMinimized,
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

export interface AttachedThreadApi {
	attached: AttachedRef | null;
	/** The stored popped-out thread has been read (post-mount). */
	ready: boolean;
	/** The quiet one-liner after a fallback to the home thread. */
	minimized: boolean;
	setMinimized: (v: boolean) => void;
	/** Attachments pending in a thread page's composer (published by ThreadChat): the floating chat cannot send them and says so. */
	pageAttachments: { threadId: string; count: number } | null;
	setPageAttachments: (threadId: string, count: number) => void;
	wolves: readonly WolfLite[];
	threads: ThreadsByWolf;
	groups: SwitcherGroup[];
	/** The attached thread's row (undefined until the lists loaded). */
	attachedThread: BarThread | undefined;
	/** A turn is running on the attached thread. */
	working: boolean;
	/** The bar just sent: show "working" until the wolf reports the turn's status. */
	markSent: () => void;
	/** A send failed: drop the optimistic "working". */
	clearSent: () => void;
	/** Phone: a thread page's strip row asked for the floating chat as a full-screen sheet (the dock is off on thread pages). */
	phoneSheet: boolean;
	setPhoneSheet: (v: boolean) => void;
	attach: (ref: { wolf: string; threadId: string; slug?: string }) => void;
	/** Dock the floating chat: clears the popped-out thread (its draft stays in the draft store). */
	dock: () => void;
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
}: {
	children: ReactNode;
	/** Test seam; defaults to localStorage. */
	storage?: KeyValueStore | null;
}) {
	const store = storage === undefined ? browserStore() : storage;
	const storeRef = useRef(store);
	storeRef.current = store;
	const [attached, setAttachedState] = useState<AttachedRef | null>(null);
	const attachedRef = useRef<AttachedRef | null>(null);
	const [ready, setReady] = useState(false);
	const [minimized, setMinimizedState] = useState(false);
	const [phoneSheet, setPhoneSheet] = useState(false);
	const [pageAttachments, setPageAttachmentsState] = useState<{ threadId: string; count: number } | null>(null);
	const setPageAttachments = useCallback(
		(threadId: string, count: number) => setPageAttachmentsState((prev) => (count === 0 ? (prev?.threadId === threadId ? null : prev) : prev?.threadId === threadId && prev.count === count ? prev : { threadId, count })),
		[],
	);
	const [wolves, setWolves] = useState<readonly WolfLite[]>([]);
	const [threads, setThreads] = useState<ThreadsByWolf>({});
	const [sent, setSent] = useState(false);
	const wolvesRef = useRef<readonly WolfLite[]>([]);
	const threadsRef = useRef<ThreadsByWolf>({});
	/** Bumped by every deliberate attach: a list fetch that started before it must not re-settle the target. */
	const gen = useRef(0);
	/** Fetch sequence numbers: a list fetched before a wolf's fresher per-wolf refresh must not overwrite it. */
	const seq = useRef(0);
	const wolfSeq = useRef<Record<string, number>>({});

	const setAttached = useCallback((ref: AttachedRef | null) => {
		attachedRef.current = ref;
		setAttachedState(ref);
		saveAttached(storeRef.current, ref);
	}, []);

	// Restore the persisted choice once (post-mount: SSR-safe).
	useEffect(() => {
		attachedRef.current = loadAttached(storeRef.current);
		setAttachedState(attachedRef.current);
		setMinimizedState(loadMinimized(storeRef.current));
		setReady(true);
		for (const k of LEGACY_KEYS) {
			try {
				storeRef.current?.removeItem(k);
			} catch {
				/* best effort */
			}
		}
	}, []);

	// A popped-out thread that is gone or archived (on a wolf whose list is known) docks; there is no fallback thread.
	const settle = useCallback((_ws: readonly WolfLite[], ts: ThreadsByWolf) => {
		const cur = attachedRef.current;
		const list = cur ? ts[cur.wolf] : undefined;
		if (!cur || !list) return;
		const hit = list.find((t) => t.id === cur.threadId);
		if (!hit || hit.closed) setAttached(null);
	}, [setAttached]);

	const commit = useCallback((ws: readonly WolfLite[], ts: ThreadsByWolf) => {
		wolvesRef.current = ws;
		threadsRef.current = ts;
		setWolves(ws);
		setThreads(ts);
	}, []);

	const refresh = useCallback(() => {
		const g = gen.current;
		const started = ++seq.current;
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
			// Per wolf, keep a list that a later fetch (an attach's refreshWolf) already committed.
			for (const w of Object.keys(next)) if ((wolfSeq.current[w] ?? 0) > started && threadsRef.current[w]) next[w] = threadsRef.current[w];
			for (const w of ws) if (w.status !== "offline") wolfSeq.current[w.name] = Math.max(wolfSeq.current[w.name] ?? 0, started);
			commit(ws, next);
			if (g === gen.current) settle(ws, next);
		})();
	}, [settle, commit]);

	useEffect(() => refresh(), [refresh]);
	useOptionalServerResync(refresh);

	/** Refetch one wolf's list, then re-settle the target (a live archive or delete falls back to home). */
	const refreshWolf = useCallback((wolf: string) => {
		const g = gen.current;
		const started = ++seq.current;
		void getJson<{ threads?: BarThread[] }>(`/api/wolves/${encodeURIComponent(wolf)}/threads`).then((t) => {
			if (!Array.isArray(t?.threads)) return;
			if ((wolfSeq.current[wolf] ?? 0) > started) return; // a newer fetch of this wolf already landed
			wolfSeq.current[wolf] = started;
			const next = { ...threadsRef.current, [wolf]: t.threads };
			commit(wolvesRef.current, next);
			if (g === gen.current) settle(wolvesRef.current, next);
		});
	}, [commit, settle]);

	const patchStatus = useCallback((wolf: string, threadId: string, status: "idle" | "busy" | "needs-you") => {
		const prev = threadsRef.current;
		if (!prev[wolf]) return;
		commit(wolvesRef.current, { ...prev, [wolf]: prev[wolf]!.map((t) => (t.id === threadId ? { ...t, status } : t)) });
	}, [commit]);

	useOptionalServerEvent("needs-you-changed", (ev) => {
		if (ev.threadId && ev.status) patchStatus(ev.wolf, ev.threadId, ev.status);
		const a = attachedRef.current;
		if (a && ev.wolf === a.wolf && (!ev.threadId || ev.threadId === a.threadId)) {
			// A busy frame is patched in place; the turn's end fetches the thread's state (status, archived).
			if (ev.status !== "busy") {
				setSent(false);
				refreshWolf(ev.wolf);
			}
		}
	});
	useOptionalServerEvent("thread-updated", (ev) => {
		const a = attachedRef.current;
		const id = ev.thread.id;
		if (ev.thread.status) patchStatus(ev.wolf, id, ev.thread.status);
		if (a && ev.wolf === a.wolf && id === a.threadId) {
			if (ev.thread.status !== "busy") {
				if (ev.thread.status) setSent(false);
				refreshWolf(ev.wolf);
			}
		}
	});

	const attach = useCallback<AttachedThreadApi["attach"]>((ref) => {
		gen.current++;
		setSent(false);
		setAttached({ wolf: ref.wolf, threadId: ref.threadId, slug: ref.slug ?? threadSlug(ref.wolf, ref.threadId) });
		refreshWolf(ref.wolf);
	}, [setAttached, refreshWolf]);

	const dock = useCallback(() => {
		setSent(false);
		setAttached(null);
	}, [setAttached]);

	const setMinimized = useCallback((v: boolean) => {
		setMinimizedState(v);
		saveMinimized(storeRef.current, v);
	}, []);

	const attachedThread = attached ? threads[attached.wolf]?.find((t) => t.id === attached.threadId) : undefined;
	const working = attachedThread?.status === "busy" || sent;
	const markSent = useCallback(() => setSent(true), []);
	const clearSent = useCallback(() => setSent(false), []);
	// An optimistic "sent" must not stick when no status frame ever arrives (an instant turn, a lost frame, a row that never
	// loaded): once the wolf does not report the thread busy, it lapses after 4s.
	const rowStatus = attachedThread?.status;
	useEffect(() => {
		if (!sent || rowStatus === "busy") return;
		const t = setTimeout(() => setSent(false), 4000);
		return () => clearTimeout(t);
	}, [sent, rowStatus]);

	const groups = useMemo(() => buildSwitcher(wolves, threads), [wolves, threads]);
	const value = useMemo<AttachedThreadApi>(
		() => ({ attached, ready, minimized, setMinimized, pageAttachments, setPageAttachments, phoneSheet, setPhoneSheet, wolves, threads, groups, attachedThread, working, markSent, clearSent, attach, dock, refresh }),
		[attached, ready, minimized, setMinimized, pageAttachments, setPageAttachments, phoneSheet, wolves, threads, groups, attachedThread, working, markSent, clearSent, attach, dock, refresh],
	);
	return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
