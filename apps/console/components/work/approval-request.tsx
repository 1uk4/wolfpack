"use client";

/**
 * Owner-approval requests in the UI (work-wolfpack-WITFT19): one hook and one card body shared by the Work page block and the
 * requesting thread's transcript card. Truth is the hub (GET /api/work/requests); `work-request-changed` is only the poke to refetch,
 * so approving from any surface clears every other one. Decided requests are kept locally ("Approved by you at …") until reload.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalRequest } from "@wolfpack/protocol";
import { useOptionalServerEvent } from "@/components/shell/server-events";

export type Decision = { status: "approved" | "rejected"; at: string };

/** The pending requests (optionally only those for `workId` / filed from `thread`), refetched on every `work-request-changed`. */
export function useApprovals(filter: { workId?: string; wolf?: string; thread?: string } = {}) {
	const [all, setAll] = useState<ApprovalRequest[]>([]);
	const [decided, setDecided] = useState<Record<string, Decision>>({});
	const seq = useRef(0);
	const load = useCallback(async () => {
		const n = ++seq.current;
		try {
			const res = await fetch("/api/work/requests", { cache: "no-store" });
			if (!res.ok || n !== seq.current) return;
			const body = (await res.json()) as { requests?: ApprovalRequest[] };
			if (Array.isArray(body.requests)) setAll(body.requests);
		} catch {
			/* keep the last list; the next poke refetches */
		}
	}, []);
	useEffect(() => void load(), [load]);
	useOptionalServerEvent("work-request-changed", (ev) => {
		if (ev.status !== "pending") setDecided((d) => (d[ev.requestId] ? d : { ...d, [ev.requestId]: { status: ev.status as Decision["status"], at: new Date().toISOString() } }));
		void load();
	});
	const mine = (r: ApprovalRequest) => (!filter.workId || r.workId === filter.workId) && (!filter.thread || r.requestedBy.thread === filter.thread);
	return { pending: all.filter(mine), decided, markDecided: (id: string, d: Decision) => setDecided((x) => ({ ...x, [id]: d })), reload: load };
}

const time = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

/** What the request asks for: kind, who and when, the whole stored contribution set (graduate) or the target (reassign). */
export function ApprovalSummary({ request, compact = false }: { request: ApprovalRequest; compact?: boolean }) {
	const set = request.preview?.contributions ?? [];
	const summary = request.preview?.summary?.trim();
	// With a summary the contributions sit behind "Show details"; an older request without one shows them as before.
	const [open, setOpen] = useState(false);
	const showSet = !summary || open;
	return (
		<div className="space-y-1 text-sm" data-testid="approval-summary" data-kind={request.kind}>
			<p>
				<span className="font-medium capitalize">{request.kind}</span> requested by <span className="font-medium">{request.requestedBy.wolf}</span>{" "}
				<span className="text-muted-foreground">{time(request.requestedAt)}</span>
			</p>
			{request.kind === "reassign" && request.target && <p>Assign to <span className="font-medium">{request.target}</span></p>}
			{request.kind === "graduate" && summary && (
				<p className="font-medium" data-testid="approval-request-summary">
					{summary}
				</p>
			)}
			{request.kind === "graduate" && summary && (
				<button type="button" onClick={() => setOpen((o) => !o)} className="text-xs text-primary underline" aria-expanded={open}>
					{open ? "Hide details" : "Show details"}
				</button>
			)}
			{request.kind === "graduate" && showSet && (
				<div>
					<p className="text-muted-foreground">{set.length} {set.length === 1 ? "contribution" : "contributions"} will be sent:</p>
					<ul className={compact ? "max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5" : "list-disc space-y-0.5 pl-5"}>
						{set.map((c, i) => (
							<li key={i}>
								<span className="font-medium">{c.title || c.id}</span>
								{(firstLine(c.summary) || firstLine(c.body)) && <span className="text-muted-foreground"> {firstLine(c.summary) || firstLine(c.body)}</span>}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

/** Approve / Reject buttons for one request. The whole set is approved as stored; nothing is trimmed here. */
export function ApprovalButtons({ request, onDecided }: { request: ApprovalRequest; onDecided: (d: Decision) => void }) {
	const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const decide = async (verb: "approve" | "reject") => {
		setBusy(verb);
		setError(null);
		try {
			const rid = encodeURIComponent(request.id);
			// Two literal paths (not `/${verb}`) so the api-routes guard can match each to its route file.
			const path = verb === "approve" ? `/api/work/requests/${rid}/approve` : `/api/work/requests/${rid}/reject`;
			const res = await fetch(path, { method: "POST" });
			if (res.ok) onDecided({ status: verb === "approve" ? "approved" : "rejected", at: new Date().toISOString() });
			else setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The hub answered ${res.status}.`);
		} catch {
			setError("The console could not be reached.");
		} finally {
			setBusy(null);
		}
	};
	return (
		<div className="flex flex-wrap items-center gap-2" data-testid="approval-buttons">
			<button type="button" disabled={busy !== null} onClick={() => void decide("approve")} className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-60 max-md:min-h-11">
				{busy === "approve" ? "Approving…" : "Approve"}
			</button>
			<button type="button" disabled={busy !== null} onClick={() => void decide("reject")} className="rounded-md border border-border px-3 py-1 text-sm hover:bg-accent disabled:opacity-60 max-md:min-h-11">
				{busy === "reject" ? "Rejecting…" : "Reject"}
			</button>
			{error && (
				<span className="text-sm text-destructive" role="alert">
					{error}
				</span>
			)}
		</div>
	);
}

/** The Work page block: shown only while a request is pending for the item. */
export function PendingApprovalBlock({ workId, onChanged }: { workId: string; onChanged?: () => void }) {
	const { pending, markDecided, reload } = useApprovals({ workId });
	if (pending.length === 0) return null;
	return (
		<section className="mb-6 space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3" data-testid="pending-approval" data-section="approval">
			<h2 className="font-mono text-[11px] uppercase tracking-wide text-amber-400">Pending approval</h2>
			{pending.map((r) => (
				<div key={r.id} className="space-y-2">
					<ApprovalSummary request={r} />
					<ApprovalButtons
						request={r}
						onDecided={(d) => {
							markDecided(r.id, d);
							void reload();
							onChanged?.();
						}}
					/>
				</div>
			))}
		</section>
	);
}

/** True while the item has a pending request (the owner's direct controls hide in favour of the block). */
export function useHasPendingApproval(workId: string): boolean {
	return useApprovals({ workId }).pending.length > 0;
}

/** The thread transcript card: the same preview and buttons, then "Approved by you at …" / "Rejected" after the decision. */
export function ApprovalThreadCard({ wolf, threadId }: { wolf: string; threadId: string }) {
	const { pending, decided, markDecided, reload } = useApprovals({ thread: threadId });
	// Requests this window has seen pending for the thread: a decision (here or on another surface) leaves its mark in the transcript.
	const seen = useRef<Set<string>>(new Set());
	const shown = new Map<string, ApprovalRequest>();
	for (const r of pending) if (r.requestedBy.wolf === wolf) {
		shown.set(r.id, r);
		seen.current.add(r.id);
	}
	return (
		<>
			{[...shown.values()].map((r) => (
				<div key={r.id} className="my-3 space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 max-md:p-2" data-testid="approval-card" data-request={r.id}>
					<ApprovalSummary request={r} compact />
					<ApprovalButtons request={r} onDecided={(d) => { markDecided(r.id, d); void reload(); }} />
				</div>
			))}
			{Object.entries(decided)
				.filter(([id]) => !shown.has(id) && seen.current.has(id))
				.map(([id, d]) => (
					<p key={id} className="my-3 text-sm text-muted-foreground" data-testid="approval-card-decided">
						{d.status === "approved" ? `Approved by you at ${time(d.at)}` : `Rejected at ${time(d.at)}`}
					</p>
				))}
		</>
	);
}
