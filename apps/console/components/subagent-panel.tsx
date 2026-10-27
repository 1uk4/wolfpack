"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LedgerEntry, SubagentState, ThreadSummary } from "@wolfpack/client";
import { MessageResponse } from "@/components/ai-elements/message";
import { ToolGroup, ToolRow } from "@/components/tool-row";
import { useOptionalServerEvent } from "@/components/server-events";
import { useChatSession } from "@/components/session";
import { threadBase, threadTransport } from "@/components/thread-transport";
import { PROSE_BLOCK_CLASS, renderItems, threadSlug, workHref, type LhMessage } from "@/src/core";

const STATE_CLASS: Record<SubagentState, string> = {
	queued: "text-muted-foreground",
	running: "text-emerald-600 dark:text-emerald-400",
	waiting: "text-amber-600 dark:text-amber-400",
	done: "text-foreground",
	failed: "text-destructive",
	stopped: "text-muted-foreground",
};

export const formatElapsed = (ms: number): string => {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
export const formatTokens = (n: number): string => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`);

const PARTY: Record<LedgerEntry["from"], string> = { parent: "parent", child: "child", owner: "you", system: "system" };
/** Who spoke, to whom, in the ledger's words ("parent → child"). */
export const ledgerSender = (e: Pick<LedgerEntry, "from" | "to">): string => `${PARTY[e.from]} → ${PARTY[e.to]}`;

/** The hint under the message field: what sending does right now. */
export const messageHint = (state: SubagentState | undefined): { mode: "steer" | "resume"; text: string } =>
	state === "running" || state === "queued"
		? { mode: "steer", text: "The subagent is running: your message steers it." }
		: { mode: "resume", text: "The subagent is not running: your message resumes it." };

function Header({ summary, now, onStop }: { summary: ThreadSummary | null; now: number; onStop: () => void }) {
	if (!summary) return <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">Loading…</div>;
	const state = summary.state;
	const stoppable = state === "running" || state === "queued";
	const started = summary.startedAt ? Date.parse(summary.startedAt) : undefined;
	const ended = summary.finishedAt ? Date.parse(summary.finishedAt) : now;
	return (
		<div className="flex flex-col gap-1 border-b border-border px-3 py-2" data-testid="subagent-header">
			<div className="flex items-center justify-between gap-2">
				<div className="min-w-0 truncate font-medium" data-testid="subagent-title">
					{summary.title}
				</div>
				{stoppable && (
					<button type="button" data-testid="subagent-stop" className="rounded border border-border px-2 py-0.5 text-xs hover:bg-accent" onClick={onStop}>
						Stop
					</button>
				)}
			</div>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
				{summary.agent && <span data-testid="subagent-agent">{summary.agent}</span>}
				{state && (
					<span data-testid="subagent-state" data-state={state} className={`rounded-full border border-border px-1.5 ${STATE_CLASS[state]}`}>
						{state === "queued" && summary.queuePosition ? `queued #${summary.queuePosition}` : state}
					</span>
				)}
				{started !== undefined && <span data-testid="subagent-elapsed">{formatElapsed(ended - started)}</span>}
				{summary.tokens !== undefined && <span data-testid="subagent-tokens">{formatTokens(summary.tokens)} tokens</span>}
				{summary.taskId && (
					<a data-testid="subagent-task" href={workHref(summary.taskId)} className="underline underline-offset-2">
						{summary.taskId}
					</a>
				)}
			</div>
		</div>
	);
}

function Ledger({ entries }: { entries: readonly LedgerEntry[] | null }) {
	if (entries === null)
		return (
			<div className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground" data-testid="subagent-ledger-missing">
				This wolf has no subagent ledger.
			</div>
		);
	if (entries.length === 0) return null;
	return (
		<details className="border-b border-border px-3 py-1.5 text-xs" data-testid="subagent-ledger" open>
			<summary className="cursor-pointer text-muted-foreground">Ledger ({entries.length})</summary>
			<ol className="mt-1 flex max-h-40 flex-col gap-1 overflow-y-auto">
				{[...entries]
					.sort((a, b) => a.id - b.id)
					.map((e) => (
						<li key={e.id} data-testid="ledger-entry" data-kind={e.kind} data-from={e.from} className="flex gap-2">
							<span className="shrink-0 font-mono text-[11px] text-muted-foreground">
								{ledgerSender(e)} · {e.kind}
							</span>
							<span className="min-w-0 truncate" title={e.text}>
								{e.text}
							</span>
						</li>
					))}
			</ol>
		</details>
	);
}

/** The child's transcript, read-only: text and tool rows (no cards, no composer). */
function Transcript({ messages, streaming }: { messages: ReturnType<typeof useChatSession>["messages"]; streaming: boolean }) {
	const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
	const setOpen = (key: string) => (open: boolean) => setOpenRows((p) => ({ ...p, [key]: open }));
	return (
		<div className="flex flex-col gap-3" data-testid="subagent-transcript">
			{messages.map((m, mi) =>
				m.role === "user" ? (
					<div key={m.id || mi} data-testid="subagent-user-message" className="border-l-2 border-muted-foreground/30 pl-2 text-xs">
						<div className="font-medium uppercase tracking-wide text-muted-foreground">Brief / message</div>
						<div className="whitespace-pre-wrap">{m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")}</div>
					</div>
				) : (
					<div key={m.id || mi} data-testid="subagent-assistant-message" className="flex flex-col gap-2">
						{renderItems(m.parts, streaming && mi === messages.length - 1).map((item) => {
							switch (item.kind) {
								case "text":
									return (
										<div key={item.part.id || item.index} className={PROSE_BLOCK_CLASS}>
											<MessageResponse>{item.part.text}</MessageResponse>
										</div>
									);
								case "tool":
									return <ToolRow key={item.key} entry={item.entry} open={openRows[item.key]} onOpenChange={setOpen(item.key)} />;
								case "group":
									return (
										<ToolGroup key={item.key} entries={item.items.map((t) => t.entry)} open={openRows[item.key]} onOpenChange={setOpen(item.key)}>
											{item.items.map((t) => (
												<ToolRow key={t.key} entry={t.entry} open={openRows[t.key]} onOpenChange={setOpen(t.key)} />
											))}
										</ToolGroup>
									);
								default:
									return null;
							}
						})}
					</div>
				),
			)}
		</div>
	);
}

interface Loaded {
	summary: ThreadSummary & { busy?: boolean };
	messages: LhMessage[];
}

function Body({ wolf, slug, childThreadId, loaded, entries, onSettled, onStop }: { wolf: string; slug: string; childThreadId: string; loaded: Loaded; entries: LedgerEntry[] | null; onSettled: () => void; onStop: () => void }) {
	const transport = useMemo(() => threadTransport(wolf, slug), [wolf, slug]);
	const { messages, status, error, clearError, resumeStream } = useChatSession({
		chatId: childThreadId,
		initialMessages: loaded.messages,
		initiallyInFlight: loaded.summary.busy,
		transport,
	});
	const busy = status === "submitted" || status === "streaming";
	const summary = loaded.summary;
	// A turn that started elsewhere (a parent's resume): attach to it. Right after our own turn settles the summary is
	// still the stale "running" one: wait for the refetched summary before attaching again.
	const state = summary.state;
	const wasRunning = useRef(false);
	const settledSummary = useRef<ThreadSummary | null>(null);
	useEffect(() => {
		if (state === "running" && !busy && settledSummary.current !== summary) resumeStream();
	}, [state, busy, summary, resumeStream]);
	useEffect(() => {
		if (wasRunning.current && !busy) {
			settledSummary.current = summary;
			onSettled();
		}
		wasRunning.current = busy;
	}, [busy, onSettled]); // eslint-disable-line react-hooks/exhaustive-deps

	// Steer or resume from the live truth first (a running stream), then the summary: either can be stale, so a 409
	// from the wrong guess is retried once the other way.
	const hint = messageHint(busy ? "running" : state);
	const [text, setText] = useState("");
	const [expanded, setExpanded] = useState(false);
	const [sendError, setSendError] = useState<string | null>(null);
	const sending = useRef(false);
	const post = (input: string, whenBusy: "steer" | "reject") =>
		fetch(transport.submitUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: transport.submitBody({ type: "text", text: input }, { whenBusy: whenBusy as "steer" }) });
	const submit = async () => {
		const t = text.trim();
		if (!t || sending.current) return;
		sending.current = true;
		setSendError(null);
		try {
			let res = await post(t, hint.mode === "steer" ? "steer" : "reject");
			if (res.status === 409) res = await post(t, hint.mode === "steer" ? "reject" : "steer");
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				return void setSendError(body?.error ?? `Could not send the message (${res.status}).`);
			}
			setText("");
			onSettled();
			resumeStream();
		} catch (err) {
			setSendError(err instanceof Error ? err.message : "Could not send the message.");
		} finally {
			sending.current = false;
		}
	};
	const now = useNow(state === "running");

	return (
		<>
			<Header summary={summary} now={now} onStop={onStop} />
			<Ledger entries={entries} />
			<div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
				<Transcript messages={messages} streaming={status === "streaming"} />
				{error && (
					<div data-testid="subagent-error" className="mt-2 flex justify-between rounded border border-destructive/50 bg-destructive/10 px-2 py-1 text-xs">
						<span>{error.message}</span>
						<button type="button" className="underline" onClick={clearError}>
							Dismiss
						</button>
					</div>
				)}
			</div>
			<details className="border-t border-border px-3 py-1.5 text-xs" data-testid="subagent-message" open={expanded} onToggle={(e) => setExpanded((e.currentTarget as HTMLDetailsElement).open)}>
				<summary className="cursor-pointer text-muted-foreground">Message subagent</summary>
				<div className="mt-1 flex flex-col gap-1">
					<div data-testid="subagent-hint" data-mode={hint.mode} className="text-muted-foreground">
						{hint.text}
					</div>
					{sendError && (
						<div data-testid="subagent-send-error" className="text-destructive">
							{sendError}
						</div>
					)}
					<textarea
						data-testid="subagent-input"
						className="min-h-14 w-full resize-none rounded border border-border bg-background p-1.5"
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void submit();
							}
						}}
					/>
					<button type="button" data-testid="subagent-send" disabled={!text.trim()} className="self-end rounded border border-border px-2 py-0.5 hover:bg-accent disabled:opacity-50" onClick={() => void submit()}>
						{hint.mode === "steer" ? "Steer" : "Resume"}
					</button>
				</div>
			</details>
		</>
	);
}

/** A clock that ticks each second while `active`. */
function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		setNow(Date.now());
		if (!active) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [active]);
	return now;
}

/**
 * The Subagent panel: one child thread beside its parent — header (agent, state, elapsed, tokens, task, Stop), the
 * ledger of hand-offs, the child's transcript (read-only, live via the thread stream) and a message field that
 * steers a running child or resumes a finished one.
 */
export function SubagentPanel({ wolf, childThreadId }: { wolf: string; childThreadId: string }) {
	const slug = threadSlug(wolf, childThreadId);
	const base = threadBase(wolf, slug);
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [entries, setEntries] = useState<LedgerEntry[] | null>([]);
	const [note, setNote] = useState<string | null>(null);
	const [stopNote, setStopNote] = useState<string | null>(null);
	const loadedRef = useRef(false);
	const [failed, setFailed] = useState<string | null>(null);
	const seq = useRef(0);
	const refresh = useCallback(async () => {
		const mine = ++seq.current;
		try {
			const [detail, ledger] = await Promise.all([fetch(base), fetch(`${base}/ledger`)]);
			if (mine !== seq.current) return;
			if (!detail.ok) {
				const msg = detail.status === 404 ? "This subagent no longer exists." : `Could not load the subagent (${detail.status}).`;
				// After the first load a transient error keeps the view; only a vanished child replaces it.
				return void (loadedRef.current && detail.status !== 404 ? setNote(msg) : setFailed(msg));
			}
			const json = (await detail.json()) as ThreadSummary & { busy?: boolean; messages?: unknown };
			const messages = threadTransport(wolf, slug).parseRecord?.(json) ?? [];
			const led = ledger.ok ? ((await ledger.json()) as { entries?: LedgerEntry[] }).entries ?? [] : ledger.status === 501 ? null : undefined;
			if (mine !== seq.current) return;
			loadedRef.current = true;
			setFailed(null);
			setNote(null);
			// The transcript is owned by the live session once mounted; only the summary is replaced.
			setLoaded((prev) => ({ summary: json, messages: prev?.messages ?? messages }));
			if (led !== undefined) setEntries(led);
		} catch {
			if (loadedRef.current) setNote("Could not refresh the subagent; showing the last view.");
		}
	}, [base, wolf, slug]);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	// thread-updated reaches the console as a needs-you-changed poke for the wolf (no thread id = anything changed).
	useOptionalServerEvent("needs-you-changed", (p) => {
		if (p.wolf !== wolf || (p.threadId !== undefined && p.threadId !== childThreadId)) return;
		void refresh();
	});
	const stop = useCallback(() => {
		fetch(`${base}/abort`, { method: "POST" })
			.then(async (res) => {
				if (res.ok) return setStopNote(null);
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setStopNote(body?.error ?? `Could not stop the subagent (${res.status}).`);
			})
			.catch((err) => setStopNote(err instanceof Error ? err.message : "Could not stop the subagent."))
			.finally(() => void refresh());
	}, [base, refresh]);

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="subagent-panel" data-child={childThreadId}>
			{(note ?? stopNote) && (
				<div className="border-b border-border px-3 py-1 text-xs text-destructive" data-testid="subagent-note">
					{note ?? stopNote}
				</div>
			)}
			{failed ? (
				<div className="p-3 text-xs text-muted-foreground" data-testid="subagent-failed">
					{failed}
				</div>
			) : !loaded ? (
				<Header summary={null} now={0} onStop={stop} />
			) : (
				<Body key={childThreadId} wolf={wolf} slug={slug} childThreadId={childThreadId} loaded={loaded} entries={entries} onSettled={refresh} onStop={stop} />
			)}
		</div>
	);
}
