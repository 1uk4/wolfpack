"use client";

/**
 * GRADUATING A FEATURE FROM THE APP, as a background job. The control sits on ready feature rows of the Work list and
 * in the graph pane and walks one flow, whose state lives in the graduate store (per feature, shared by both places):
 *
 *   Graduate → confirmation step (which wolf, "N observations from M tasks will be folded") → loader over the button
 *   while the preview job runs → Review → modal with the proposed entries, the folded observations and the warnings
 *   → Confirm → loader again while the confirm job runs → the list and graph refresh, a toast says what was sent.
 *
 * Confirm does not write the KB: the wolf drops contributions into the librarian's inbox and the librarian's sweep
 * makes the entries later, so the copy says "contributions sent to the librarian", never "written to the KB".
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { KbMarkdown } from "@/components/kb-markdown";
import { graduationWolf, type GraduateState, type GraduationObservations, type GraduationPreview } from "@/src/core";
import type { GraduateClient } from "./graduate-client";
import { graduateStore, useGraduateDone, useGraduateJob, type GraduateTarget } from "./graduate-store";

export type { GraduateTarget } from "./graduate-store";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quiet = "rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40";
const primary = "rounded-sm border border-emerald-400/60 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-40";

/** The Graduate button: enabled on a ready feature, disabled with the reason (tooltip and `data-reason`) otherwise. */
export function GraduateButton({ state, onClick, showReason = false, testid = "graduate-btn" }: { state: GraduateState; onClick: () => void; showReason?: boolean; testid?: string }) {
	if (!state.show) return null;
	return (
		<span className="inline-flex shrink-0 items-center gap-2">
			<button
				type="button"
				data-testid={testid}
				data-ready={state.ready}
				data-reason={state.ready ? undefined : state.reason}
				disabled={!state.ready}
				title={state.ready ? "Graduate this feature into the knowledge base" : `Not ready to graduate: ${state.reason}`}
				onClick={(e) => {
					e.stopPropagation();
					onClick();
				}}
				className="rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors enabled:border-emerald-400/60 enabled:text-emerald-300 enabled:hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-40"
			>
				Graduate
			</button>
			{showReason && !state.ready && (
				<span data-testid={`${testid}-reason`} className="text-[11px] text-muted-foreground">
					{state.reason}
				</span>
			)}
		</span>
	);
}


/** The button while a job runs: disabled, with a spinner over the label (the UI around it stays usable). */
function BusyButton({ job, testid }: { job: { phase: "previewing" | "graduating"; wolf: string }; testid: string }) {
	const what = job.phase === "previewing" ? `${job.wolf} is folding the observations and distilling the entries` : `${job.wolf} is sending the contributions to the librarian`;
	return (
		<button
			type="button"
			data-testid={testid}
			data-phase={job.phase}
			aria-busy="true"
			disabled
			title={`${what}… you can close this view, it keeps going.`}
			onClick={(e) => e.stopPropagation()}
			className="relative inline-flex shrink-0 cursor-progress items-center justify-center rounded-md border border-emerald-400/40 px-2 py-0.5 text-[11px] font-medium text-emerald-300"
		>
			<span className="opacity-30">{job.phase === "previewing" ? "Graduate" : "Confirm"}</span>
			<span data-testid={`${testid}-loader`} className="absolute inset-0 flex items-center justify-center" role="status" aria-label={job.phase === "previewing" ? "Previewing" : "Graduating"}>
				<span className="size-3 animate-spin rounded-full border-2 border-emerald-300/30 border-t-emerald-300" />
			</span>
		</button>
	);
}

/**
 * The whole graduation control of one feature: its button in every phase plus the dialogs it opens. `state` is the
 * readiness (disabled with the reason when the feature is not ready); a job in flight or finished overrides it.
 */
export function GraduateControl({ target, state, client, testid, showReason = false }: { target: GraduateTarget; state: GraduateState; client: GraduateClient; testid: string; showReason?: boolean }) {
	const job = useGraduateJob(target.id);
	const [dialog, setDialog] = useState<"start" | "review" | null>(null);
	const ready = state.show && state.ready;
	// A job the wolf already holds (a reload, a view never opened): a finished preview shows as Review.
	useEffect(() => {
		if (ready) void graduateStore.recover(client, target);
	}, [ready, client, target.id, target.assignee]);

	if (!state.show && !job) return null;
	const close = () => setDialog(null);
	let button: React.ReactNode;
	if (!job) button = <GraduateButton state={state} testid={testid} showReason={showReason} onClick={() => setDialog("start")} />;
	else if (job.phase === "previewing" || job.phase === "graduating") button = <BusyButton job={job} testid={testid} />;
	else if (job.phase === "ready")
		button = (
			<button
				type="button"
				data-testid={testid}
				data-phase="ready"
				title="Review the proposed entries before they are sent to the librarian"
				onClick={(e) => {
					e.stopPropagation();
					setDialog("review");
				}}
				className="shrink-0 rounded-md border border-emerald-400/60 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/25"
			>
				Review
			</button>
		);
	else
		button = (
			<span className="inline-flex shrink-0 items-center gap-2">
				<button
					type="button"
					data-testid={testid}
					data-phase="error"
					data-code={job.code}
					title={job.message}
					onClick={(e) => {
						e.stopPropagation();
						setDialog(graduateStore.retry(target.id) === "review" ? "review" : "start");
					}}
					className="rounded-md border border-destructive/60 px-2 py-0.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/10"
				>
					Retry
				</button>
				{showReason && (
					<span role="alert" data-testid={`${testid}-error`} className="text-[11px] text-destructive">
						{job.message}
					</span>
				)}
			</span>
		);
	return (
		<>
			{button}
			{dialog === "start" && <GraduateStartDialog target={target} client={client} onClose={close} />}
			{dialog === "review" && job?.phase === "ready" && <GraduateReviewDialog target={target} wolf={job.wolf} preview={job.preview} onConfirm={() => void graduateStore.confirm(client, target.id)} onClose={close} />}
		</>
	);
}

/** Esc closes, claimed at the document (the one-Esc law). */
function useEscape(onClose: () => void): void {
	const ref = useRef(onClose);
	ref.current = onClose;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			ref.current();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, []);
}

type Count = { state: "loading" } | { state: "ok"; data: GraduationObservations } | { state: "error"; message: string };

/**
 * The confirmation step: which wolf runs the graduation (the assignee when online, else the owner picks) and what it will
 * fold. The count is read from THAT wolf's pool: work items have a single assignee, so its pool holds the observations.
 */
export function GraduateStartDialog({ target, client, onClose }: { target: GraduateTarget; client: GraduateClient; onClose: () => void }) {
	const [wolves, setWolves] = useState<{ kind: "loading" } | { kind: "assignee"; wolf: string } | { kind: "pick"; online: string[] }>({ kind: "loading" });
	const [picked, setPicked] = useState("");
	const [count, setCount] = useState<Count>({ state: "loading" });
	const backdropDismiss = useBackdropDismiss(onClose);
	useEscape(onClose);

	useEffect(() => {
		let live = true;
		void (async () => {
			let list: Awaited<ReturnType<GraduateClient["wolves"]>> = [];
			try {
				list = await client.wolves();
			} catch {
				// no wolf list: the owner is told below
			}
			if (!live) return;
			const choice = graduationWolf(target.assignee, list);
			if (choice.kind === "assignee") setWolves(choice);
			else {
				setPicked(choice.online[0] ?? "");
				setWolves(choice);
			}
		})();
		return () => void (live = false);
	}, [client, target.assignee]);

	const wolf = wolves.kind === "assignee" ? wolves.wolf : wolves.kind === "pick" ? picked : "";
	useEffect(() => {
		if (!wolf) return;
		let live = true;
		setCount({ state: "loading" });
		void client.observations(wolf, target.id).then((res) => {
			if (live) setCount(res.ok ? { state: "ok", data: res.data } : { state: "error", message: res.message });
		});
		return () => void (live = false);
	}, [client, wolf, target.id]);

	const go = () => {
		void graduateStore.startPreview(client, target, wolf);
		onClose();
	};
	const tasks = count.state === "ok" ? count.data.byWork.length : 0;
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<div role="dialog" aria-modal="true" aria-label="Graduate feature" data-testid="graduate-dialog" data-step={wolves.kind === "pick" ? "pick" : "confirm"} onClick={(e) => e.stopPropagation()} className="flex max-h-[85vh] w-[34rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-card p-5 shadow-xl">
				<h2 className="text-sm font-semibold">Graduate “{target.title}”?</h2>
				<div className="mt-3 min-h-0 flex-1 overflow-y-auto text-xs" data-testid="graduate-body">
					{wolves.kind === "loading" && <p className="text-muted-foreground">Looking for a wolf to run it…</p>}
					{wolves.kind === "pick" && wolves.online.length === 0 && (
						<p data-testid="graduate-no-wolf" className="text-muted-foreground">
							No wolf is online to run the graduation. Start one and try again.
						</p>
					)}
					{wolves.kind === "pick" && wolves.online.length > 0 && (
						<div className="mb-3 flex flex-col gap-2">
							<p className="text-muted-foreground">The assignee is not online. Which wolf should distill it and fold its pending observations?</p>
							<select data-testid="graduate-wolf" aria-label="Wolf" value={picked} onChange={(e) => setPicked(e.target.value)} className="h-8 w-48 rounded-lg border bg-background px-2 text-xs outline-none focus:border-ring">
								{wolves.online.map((w) => (
									<option key={w} value={w}>
										{w}
									</option>
								))}
							</select>
						</div>
					)}
					{wolf && (
						<div className="flex flex-col gap-2">
							<p data-testid="graduate-summary">
								Graduate “{target.title}” on <span className="font-medium">{wolf}</span>:{" "}
								{count.state === "loading" && <span className="text-muted-foreground">counting the pending observations…</span>}
								{count.state === "error" && <span className="text-muted-foreground">the pending observations could not be counted ({count.message}); they are folded all the same.</span>}
								{count.state === "ok" && count.data.total === 0 && <span data-testid="graduate-count">no pending observations to fold. {wolf} distills the Records into contributions for the librarian’s inbox.</span>}
								{count.state === "ok" && count.data.total > 0 && (
									<span data-testid="graduate-count">
										{plural(count.data.total, "observation")} from {plural(tasks, "task")} will be folded into the contributions sent to the librarian’s inbox.
									</span>
								)}
							</p>
							{count.state === "ok" && count.data.total > 0 && (
								<ul data-testid="graduate-breakdown" className="list-disc pl-5 text-muted-foreground">
									{count.data.byWork.map((b) => (
										<li key={b.id} data-work={b.id}>
											{b.title ?? b.id}: {plural(b.count, "observation")}
										</li>
									))}
								</ul>
							)}
							<p className="text-muted-foreground">Nothing is sent yet: you review the proposed entries first. The librarian’s sweep turns the contributions into KB entries later.</p>
						</div>
					)}
				</div>
				<div className="mt-4 flex justify-end gap-2">
					<button type="button" data-testid="graduate-cancel" onClick={onClose} className={quiet}>
						Cancel
					</button>
					<button type="button" data-testid="graduate-go" disabled={!wolf} onClick={go} className={primary}>
						Graduate
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}

/** The Review modal: the proposed entries, the folded observations and the warnings. Confirm starts the background send. */
export function GraduateReviewDialog({ target, wolf, preview, onConfirm, onClose }: { target: GraduateTarget; wolf: string; preview: GraduationPreview; onConfirm: () => void; onClose: () => void }) {
	const backdropDismiss = useBackdropDismiss(onClose);
	useEscape(onClose);
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<div role="dialog" aria-modal="true" aria-label="Review graduation" data-testid="graduate-dialog" data-step="review" onClick={(e) => e.stopPropagation()} className="flex max-h-[85vh] w-[44rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-card p-5 shadow-xl">
				<h2 className="text-sm font-semibold">Send “{target.title}” to the librarian?</h2>
				<div className="mt-3 min-h-0 flex-1 overflow-y-auto" data-testid="graduate-body">
					<PreviewBody wolf={wolf} preview={preview} />
				</div>
				<div className="mt-4 flex justify-end gap-2">
					<button type="button" data-testid="graduate-cancel" onClick={onClose} className={quiet}>
						Cancel
					</button>
					<button
						type="button"
						data-testid="graduate-confirm"
						disabled={!!preview.blocked}
						onClick={() => {
							onConfirm();
							onClose();
						}}
						className={primary}
					>
						Confirm and send to the librarian
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}


/** What a finished graduation did. Mounted once (next to the Work view provider); the KB itself follows the librarian's sweep. */
export function GraduateToasts() {
	const done = useGraduateDone();
	if (done.length === 0) return null;
	return (
		<div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2" data-testid="graduate-toasts">
			{done.map((d) => (
				<div key={d.id} role="status" data-testid="graduate-done" data-work={d.id} className="pointer-events-auto flex max-w-sm items-start gap-3 rounded-lg border border-emerald-400/40 bg-card px-3 py-2 text-xs shadow-lg">
					<div>
						<div className="font-medium">
							“{d.title}” graduated: {plural(d.result.entries.length, "contribution")} sent to the librarian
						</div>
						<div className="mt-0.5 text-muted-foreground">{plural(d.result.archived.length, "work item")} archived. New KB entries appear after the librarian’s next sweep.</div>
					</div>
					<button type="button" data-testid="graduate-done-dismiss" aria-label="Dismiss" onClick={() => graduateStore.dismissDone(d.id)} className="text-muted-foreground hover:text-foreground">
						×
					</button>
				</div>
			))}
		</div>
	);
}

function PreviewBody({ wolf, preview }: { wolf: string; preview: GraduationPreview }) {
	const folded = preview.foldedObservations;
	return (
		<div className="flex flex-col gap-3 text-xs">
			<p className="text-muted-foreground">
				{wolf} will send {plural(preview.contributions.length, "proposed entry", "proposed entries")} to the librarian’s inbox and archive {plural(preview.archive.length, "work item")}. The librarian’s sweep turns them into KB entries later.
			</p>
			<div data-testid="graduate-folded" className="text-muted-foreground">
				{folded === 0 ? "No pending observations to fold." : `${folded} pending observation${folded === 1 ? "" : "s"} folded into the Record.`}
			</div>
			{preview.blocked && (
				<div role="alert" data-testid="graduate-blocked" className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2 text-destructive">
					Cannot be sent: {preview.blocked}
				</div>
			)}
			{preview.warnings.length > 0 && (
				<ul data-testid="graduate-warnings" className="flex flex-col gap-1 rounded-sm border border-amber-400/40 bg-amber-400/5 px-3 py-2 text-amber-200">
					{preview.warnings.map((w, i) => (
						<li key={`${i}:${w}`} data-warning>
							⚠ {w}
						</li>
					))}
				</ul>
			)}
			{preview.contributions.map((c) => (
				<section key={c.id} data-testid="graduate-entry" data-entry={c.id} className="rounded-lg border p-3">
					<div className="text-sm font-medium" data-entry-title>
						{c.title}
					</div>
					<div className="mt-0.5 text-muted-foreground" data-entry-summary>
						{c.summary}
					</div>
					<div className="mt-2 text-sm" data-entry-body>
						<KbMarkdown>{c.body}</KbMarkdown>
					</div>
				</section>
			))}
			<details data-testid="graduate-archive" className="text-muted-foreground">
				<summary className="cursor-pointer">Archives {preview.archive.length} work {preview.archive.length === 1 ? "item" : "items"}</summary>
				<ul className="mt-1 list-disc pl-5">
					{preview.archive.map((a) => (
						<li key={a.id}>{a.title}</li>
					))}
				</ul>
			</details>
		</div>
	);
}

