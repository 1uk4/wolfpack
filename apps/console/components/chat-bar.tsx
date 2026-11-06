"use client";

/**
 * THE FLOATING CHAT BAR: one pill, mounted once in the root layout, talking to the ONE thread the
 * AttachedThreadProvider holds, whatever page is open. It has NO stream and mounts no session model: it posts to the
 * thread's submit route (steering when a turn runs), aborts through the abort route, and shows "working…" from the
 * events channel (see attached-thread.tsx). Drafts share the thread page's key, so text carries across switches and
 * into the page's own composer, where the bar collapses to its chip.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronDownIcon, MessageSquareIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { AttachmentChips, Composer } from "@/components/composer";
import { BrailleSpinner } from "@/components/braille-spinner";
import { useAttachedThread } from "@/components/attached-thread";
import { threadBase } from "@/components/thread-transport";
import { fitImageWithTimeout, browserFitDeps } from "@/components/image-fit";
import { canSendWith, chipFor, FALLBACK_LIMIT, fetchAttachmentLimit, fitFailureMessage, friendlyUploadError, readyInfos, uploadFile, UploadError, type AttachmentLimit, type PendingAttachment } from "@/components/attachments";
import { useComposerDraft } from "@/lib/composer-draft";
import { useThreadColor } from "@/components/use-thread-color";
import { bindingForAction, formatBinding, kbdEventForAction, threadHref, type AttachedRef, type SwitcherGroup } from "@/src/core";

/** What a send does: a running turn takes the message as a steer, an idle thread starts a turn. */
export const whenBusyFor = (working: boolean): "steer" | "reject" => (working ? "steer" : "reject");

/** POST the message to the thread's submit route. A 409 on an optimistic idle (the turn started meanwhile) retries once as a steer. */
export async function submitToThread(
	ref: Pick<AttachedRef, "wolf" | "slug">,
	text: string,
	working: boolean,
	attachments: readonly { id: string }[] = [],
	fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<boolean> {
	const post = (whenBusy: "steer" | "reject") =>
		fetchFn(`${threadBase(ref.wolf, ref.slug)}/submit`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: text, whenBusy, ...(attachments.length ? { attachments: attachments.map((a) => ({ id: a.id })) } : {}) }),
		});
	try {
		let res = await post(whenBusyFor(working));
		if (res.status === 409 && !working) res = await post("steer");
		return res.ok;
	} catch {
		return false;
	}
}

/** The thread page's stop path: POST the abort route. */
export function abortThread(ref: Pick<AttachedRef, "wolf" | "slug">, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<unknown> {
	return fetchFn(`${threadBase(ref.wolf, ref.slug)}/abort`, { method: "POST" }).catch(() => undefined);
}

/** Is the open page the attached thread's own page (where the page composer takes over)? */
export function onOwnThreadPage(pathname: string | null, ref: Pick<AttachedRef, "wolf" | "threadId"> | null): boolean {
	return !!ref && pathname === threadHref(ref.wolf, ref.threadId);
}

export function ChatBar() {
	const api = useAttachedThread();
	const pathname = usePathname();
	if (!api || !api.attached) return null;
	return <BarInner key={`${api.attached.wolf}/${api.attached.threadId}`} ref0={api.attached} own={onOwnThreadPage(pathname, api.attached)} pathname={pathname} />;
}

function BarInner({ ref0, own, pathname }: { ref0: AttachedRef; own: boolean; pathname: string | null }) {
	const api = useAttachedThread()!;
	const { minimized, setMinimized, working, attachedThread, groups, note } = api;
	const [text, setText] = useState("");
	const textRef = useRef("");
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const [switcher, setSwitcher] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const applyText = useCallback((v: string) => {
		textRef.current = v;
		setText(v);
	}, []);
	const schedule = useComposerDraft(ref0.wolf, ref0.threadId, textRef, applyText);
	const onChange = useCallback((v: string) => {
		applyText(v);
		schedule(v);
	}, [applyText, schedule]);

	// Pasted / picked images upload exactly as on the thread page.
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	const patch = useCallback((key: string, p: Partial<PendingAttachment>) => setAttachments((prev) => prev.map((a) => (a.key === key ? { ...a, ...p } : a))), []);
	const limitRef = useRef<AttachmentLimit | undefined>(undefined);
	const fitChain = useRef<Promise<unknown>>(Promise.resolve());
	const uploadUrl = `${threadBase(ref0.wolf, ref0.slug)}/attachments`;
	const onFiles = useCallback((files: File[]) => {
		for (const file of files) {
			const key = `att-${Math.random().toString(36).slice(2)}`;
			const { chip, upload } = chipFor(file, key, Infinity);
			setAttachments((prev) => [...prev, chip]);
			if (!upload) continue;
			const fit = fitChain.current.then(async () => {
				limitRef.current ??= await fetchAttachmentLimit();
				const limit = limitRef.current ?? FALLBACK_LIMIT;
				return { limit, result: await fitImageWithTimeout(file, limit.maxBytes, browserFitDeps()) };
			});
			fitChain.current = fit.catch(() => {});
			void (async () => {
				let limit = FALLBACK_LIMIT;
				try {
					const fitted = await fit;
					limit = fitted.limit;
					if (!fitted.result.ok) return patch(key, { status: "error", error: fitFailureMessage(fitted.result.reason, limit.maxBytes, limit.mode === "relay", file.size) });
					const { id, name, mimeType, size } = await uploadFile(uploadUrl, fitted.result.file);
					patch(key, { status: "ready", id, name, mimeType, size });
				} catch (err) {
					const e = err as Error;
					patch(key, { status: "error", error: friendlyUploadError(e.message, e instanceof UploadError ? e.status : undefined, limit.maxBytes, limit.mode === "relay") });
				}
			})();
		}
	}, [uploadUrl, patch]);

	const send = useCallback(async () => {
		const t = textRef.current.trim();
		if (!canSendWith(t, attachments)) return;
		const refs = readyInfos(attachments);
		applyText("");
		schedule("");
		setAttachments((prev) => prev.filter((a) => a.status === "uploading"));
		setError(null);
		api.markSent();
		const ok = await submitToThread(ref0, t, working, refs);
		if (!ok) {
			setError("Could not send.");
			if (textRef.current === "") {
				applyText(t);
				schedule(t);
			}
		}
	}, [attachments, applyText, schedule, api, ref0, working]);
	const stop = useCallback(() => void abortThread(ref0), [ref0]);

	// Keyboard: focus (expanding when minimized) and the switcher; both rebindable in settings.
	useEffect(() => {
		const focus = () => {
			setMinimized(false);
			requestAnimationFrame(() => inputRef.current?.focus());
		};
		const sw = () => {
			setMinimized(false);
			setSwitcher(true);
		};
		window.addEventListener(kbdEventForAction("focus-chat-bar"), focus);
		window.addEventListener(kbdEventForAction("chat-bar-switcher"), sw);
		return () => {
			window.removeEventListener(kbdEventForAction("focus-chat-bar"), focus);
			window.removeEventListener(kbdEventForAction("chat-bar-switcher"), sw);
		};
	}, [setMinimized]);

	const all = useMemo(() => Object.values(api.threads).flatMap((l) => l ?? []), [api.threads]);
	const color = useThreadColor({ id: ref0.threadId, ...(attachedThread?.settings ? { settings: attachedThread.settings } : {}), ...(attachedThread?.parentThreadId ? { parentThreadId: attachedThread.parentThreadId } : {}) }, all).hex;
	const title = attachedThread ? (attachedThread.kind === "home" ? ref0.wolf : attachedThread.title) : ref0.slug;

	// Scroll room: pages that scroll get bottom padding while the full bar floats over them (globals.css).
	const full = !own && !minimized;
	const scrolls = !!pathname && /^\/(kb|work|kb-activity|pipeline)(\/|$)|^\/wolf\/[^/]+$/.test(pathname);
	useEffect(() => {
		const el = document.documentElement;
		if (full && scrolls) el.dataset.chatBar = "open";
		else delete el.dataset.chatBar;
		return () => void delete el.dataset.chatBar;
	}, [full, scrolls]);

	const chip = (
		<button
			type="button"
			data-testid="chat-bar-chip"
			onClick={() => (own ? setSwitcher((s) => !s) : minimized ? setMinimized(false) : setSwitcher((s) => !s))}
			className="flex max-w-56 items-center gap-1.5 rounded-full px-2.5 py-1 font-ui text-xs hover:bg-accent"
			title={`${ref0.wolf} · ${title}`}
		>
			<span data-testid="chat-bar-dot" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
			<span className="truncate">{title}</span>
			<span className="text-muted-foreground">{ref0.wolf}</span>
			{working && <BrailleSpinner />}
		</button>
	);

	if (own || minimized) {
		return (
			<div data-testid="chat-bar" data-state={own ? "collapsed" : "minimized"} className="fixed bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-full border bg-card shadow-md max-md:hidden" style={{ borderColor: color }}>
				<div className="flex items-center">
					{chip}
					{!own && (
						<button type="button" aria-label="Expand chat bar" data-testid="chat-bar-expand" onClick={() => setMinimized(false)} className="mr-1 rounded-full p-1 text-muted-foreground hover:bg-accent">
							<MessageSquareIcon className="size-3.5" />
						</button>
					)}
				</div>
				{switcher && <Switcher groups={groups} current={ref0} onClose={() => setSwitcher(false)} />}
			</div>
		);
	}

	return (
		<div data-testid="chat-bar" data-state="open" className="fixed bottom-3 left-1/2 z-30 w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 max-md:hidden">
			{/* Card surface slot (PtJkpk6): the thread's pending question/brief cards and the last-reply peek mount here, above the input. */}
			<div data-slot="chat-bar-card-surface" data-testid="chat-bar-card-surface" className="mb-2 empty:hidden" />
			<div className="relative rounded-2xl border bg-card shadow-lg" style={{ borderColor: color }}>
				<div className="flex items-center gap-1 px-1.5 pt-1">
					{chip}
					{working && <span data-testid="chat-bar-working" className="font-ui text-xs text-muted-foreground">working…</span>}
					{note && !working && <span data-testid="chat-bar-note" className="truncate font-ui text-xs text-muted-foreground">{note}</span>}
					{error && <span role="alert" className="truncate font-ui text-xs text-destructive">{error}</span>}
					<button type="button" aria-label="Minimize chat bar" data-testid="chat-bar-minimize" onClick={() => setMinimized(true)} className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent">
						<ChevronDownIcon className="size-4" />
					</button>
				</div>
				<Composer
					busy={working}
					value={text}
					onChange={onChange}
					onSend={() => void send()}
					onStop={stop}
					canSend={canSendWith(text, attachments)}
					inputRef={inputRef}
					placeholder={`Message ${title}…  (${formatBinding(bindingForAction("focus-chat-bar"))} to focus)`}
					onFiles={onFiles}
					onPickFiles={onFiles}
					chips={<AttachmentChips items={attachments} onRemove={(k) => setAttachments((prev) => prev.filter((a) => a.key !== k))} />}
				/>
				{switcher && <Switcher groups={groups} current={ref0} onClose={() => setSwitcher(false)} />}
			</div>
		</div>
	);
}

/** The thread switcher: home + needs-you + recent feature threads, grouped by wolf. */
export function Switcher({ groups, current, onClose }: { groups: SwitcherGroup[]; current: Pick<AttachedRef, "wolf" | "threadId">; onClose: () => void }) {
	const api = useAttachedThread();
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [onClose]);
	return (
		<div data-testid="chat-bar-switcher" className="absolute bottom-full left-0 mb-2 max-h-80 w-72 overflow-y-auto rounded-xl border bg-popover p-1 shadow-lg">
			<div className="flex items-center justify-between px-2 py-1 font-ui text-[10px] uppercase tracking-wide text-muted-foreground">
				<span>Attach the bar to…</span>
				<button type="button" aria-label="Close switcher" onClick={onClose}><XIcon className="size-3" /></button>
			</div>
			{groups.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">No threads yet.</p>}
			{groups.map((g) => (
				<div key={g.wolf} data-testid="switcher-group" data-wolf={g.wolf}>
					<p className="px-2 pt-1.5 font-ui text-[10px] uppercase tracking-wide text-muted-foreground">{g.wolf}</p>
					{g.entries.map((e) => (
						<button
							key={e.threadId}
							type="button"
							data-testid="switcher-entry"
							data-thread={e.threadId}
							data-status={e.status}
							aria-current={e.wolf === current.wolf && e.threadId === current.threadId ? "true" : undefined}
							onClick={() => {
								api?.attach({ wolf: e.wolf, threadId: e.threadId, slug: e.slug });
								onClose();
							}}
							className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent", e.wolf === current.wolf && e.threadId === current.threadId && "bg-accent")}
						>
							<span className="min-w-0 flex-1 truncate">{e.title}</span>
							{e.status === "needs-you" && <span className="font-ui text-[10px] text-amber-400">needs you</span>}
							{e.status === "busy" && <span className="font-ui text-[10px] text-muted-foreground">working</span>}
						</button>
					))}
				</div>
			))}
		</div>
	);
}
