"use client";

/**
 * GRADUATING A FEATURE FROM THE APP. The button sits on ready feature rows of the Work list and in the graph pane;
 * clicking it opens this modal: (1) which wolf runs it, asked only when the feature's assignee is not an online wolf;
 * (2) a PREVIEW of exactly what would be written to the KB (each entry's title, summary and body as markdown, the
 * pending observations folded into the Record, the warnings), fetched from the wolf, which sends nothing; (3) Confirm
 * sends it (all or nothing on the wolf's side) and the surfaces refresh through the graduation signal. Cancel does
 * nothing. A preview that went stale (expired, used, another item) offers a fresh one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { KbMarkdown } from "@/components/kb-markdown";
import { graduationWolf, type GraduateState, type GraduationPreview, type GraduationResult } from "@/src/core";
import type { GraduateClient, GraduateWolf } from "./graduate-client";
import { notifyGraduated } from "./graduation-signal";

export interface GraduateTarget {
	id: string;
	title: string;
	assignee?: string;
}

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

type Step =
	| { step: "wolves" }
	| { step: "pick"; online: string[] }
	| { step: "previewing"; wolf: string }
	| { step: "preview"; wolf: string; preview: GraduationPreview }
	| { step: "confirming"; wolf: string; preview: GraduationPreview }
	| { step: "error"; wolf: string | null; message: string; code?: string; retry: "preview" | "wolves" };

export function GraduateDialog({
	target,
	client,
	onClose,
	onGraduated,
}: {
	target: GraduateTarget;
	client: GraduateClient;
	onClose: () => void;
	onGraduated?: (result: GraduationResult) => void;
}) {
	const [state, setState] = useState<Step>({ step: "wolves" });
	const [picked, setPicked] = useState("");
	const busy = state.step === "previewing" || state.step === "confirming";
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});
	const closed = useRef(false);
	useEffect(() => {
		closed.current = false;
		return () => void (closed.current = true);
	}, []);

	const runPreview = useCallback(
		async (wolf: string) => {
			setState({ step: "previewing", wolf });
			const res = await client.preview(wolf, target.id);
			if (closed.current) return;
			if (res.ok) setState({ step: "preview", wolf, preview: res.data });
			else setState({ step: "error", wolf, message: res.message, code: res.code, retry: "preview" });
		},
		[client, target.id],
	);

	const start = useCallback(async () => {
		setState({ step: "wolves" });
		let wolves: GraduateWolf[] = [];
		try {
			wolves = await client.wolves();
		} catch {
			// no wolf list: the owner is told below
		}
		if (closed.current) return;
		const choice = graduationWolf(target.assignee, wolves);
		if (choice.kind === "assignee") void runPreview(choice.wolf);
		else {
			setPicked(choice.online[0] ?? "");
			setState({ step: "pick", online: choice.online });
		}
	}, [client, target.assignee, runPreview]);

	useEffect(() => {
		void start();
	}, [start]);

	const confirm = async (wolf: string, preview: GraduationPreview) => {
		setState({ step: "confirming", wolf, preview });
		const res = await client.confirm(wolf, target.id, preview.token);
		if (closed.current) return;
		if (res.ok) {
			notifyGraduated(target.id);
			onGraduated?.(res.data);
			onClose();
		} else setState({ step: "error", wolf, message: res.message, code: res.code, retry: "preview" });
	};

	// Esc closes unless the graduation is being sent (claimed at the document, the one-Esc law).
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || busy) return;
			e.preventDefault();
			e.stopPropagation();
			onCloseRef.current();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [busy]);

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Graduate feature"
				data-testid="graduate-dialog"
				data-step={state.step}
				onClick={(e) => e.stopPropagation()}
				className="flex max-h-[85vh] w-[44rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-card p-5 shadow-xl"
			>
				<h2 className="text-sm font-semibold">Graduate “{target.title}”?</h2>
				<div className="mt-3 min-h-0 flex-1 overflow-y-auto" data-testid="graduate-body">
					<Body state={state} picked={picked} setPicked={setPicked} onPick={(w) => void runPreview(w)} />
				</div>
				<Actions state={state} picked={picked} onClose={onClose} onPick={(w) => void runPreview(w)} onConfirm={(w, p) => void confirm(w, p)} onRetry={(s) => (s.retry === "wolves" || !s.wolf ? void start() : void runPreview(s.wolf))} />
			</div>
		</div>,
		document.body,
	);
}

function Body({ state, picked, setPicked }: { state: Step; picked: string; setPicked: (w: string) => void; onPick: (w: string) => void }) {
	switch (state.step) {
		case "wolves":
			return <p className="text-xs text-muted-foreground">Looking for a wolf to run it…</p>;
		case "pick":
			return state.online.length === 0 ? (
				<p data-testid="graduate-no-wolf" className="text-xs text-muted-foreground">
					No wolf is online to run the graduation. Start one and try again.
				</p>
			) : (
				<div className="flex flex-col gap-2 text-xs">
					<p className="text-muted-foreground">The assignee is not online. Which wolf should distill it and fold its pending observations?</p>
					<select data-testid="graduate-wolf" aria-label="Wolf" value={picked} onChange={(e) => setPicked(e.target.value)} className="h-8 w-48 rounded-lg border bg-background px-2 text-xs outline-none focus:border-ring">
						{state.online.map((w) => (
							<option key={w} value={w}>
								{w}
							</option>
						))}
					</select>
				</div>
			);
		case "previewing":
			return (
				<p data-testid="graduate-previewing" className="text-xs text-muted-foreground">
					{state.wolf} is folding the pending observations and distilling the entries… this can take a minute. Nothing is sent yet.
				</p>
			);
		case "preview":
		case "confirming":
			return <PreviewBody wolf={state.wolf} preview={state.preview} sending={state.step === "confirming"} />;
		case "error":
			return (
				<div role="alert" data-testid="graduate-error" data-code={state.code} className="rounded-sm border border-border/60 px-3 py-2 text-xs">
					{state.message}
				</div>
			);
	}
}

function PreviewBody({ wolf, preview, sending }: { wolf: string; preview: GraduationPreview; sending: boolean }) {
	const folded = preview.foldedObservations;
	return (
		<div className="flex flex-col gap-3 text-xs">
			<p className="text-muted-foreground">
				{wolf} will write {preview.contributions.length} {preview.contributions.length === 1 ? "entry" : "entries"} to the knowledge base and archive {preview.archive.length} work {preview.archive.length === 1 ? "item" : "items"}.
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
			{sending && (
				<p data-testid="graduate-sending" className="text-muted-foreground">
					Sending…
				</p>
			)}
		</div>
	);
}

function Actions({
	state,
	picked,
	onClose,
	onPick,
	onConfirm,
	onRetry,
}: {
	state: Step;
	picked: string;
	onClose: () => void;
	onPick: (wolf: string) => void;
	onConfirm: (wolf: string, preview: GraduationPreview) => void;
	onRetry: (s: Extract<Step, { step: "error" }>) => void;
}) {
	const quiet = "rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40";
	const primary = "rounded-sm border border-emerald-400/60 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-40";
	const busy = state.step === "previewing" || state.step === "confirming";
	return (
		<div className="mt-4 flex justify-end gap-2">
			<button type="button" data-testid="graduate-cancel" onClick={onClose} disabled={busy} className={quiet}>
				Cancel
			</button>
			{state.step === "pick" && state.online.length > 0 && (
				<button type="button" data-testid="graduate-pick-go" disabled={!picked} onClick={() => onPick(picked)} className={primary}>
					Preview
				</button>
			)}
			{state.step === "error" && (
				<button type="button" data-testid="graduate-retry" onClick={() => onRetry(state)} className={primary}>
					{state.code === "preview_stale" ? "Preview again" : "Try again"}
				</button>
			)}
			{(state.step === "preview" || state.step === "confirming") && (
				<button type="button" data-testid="graduate-confirm" disabled={busy || !!state.preview.blocked} onClick={() => onConfirm(state.wolf, state.preview)} className={primary}>
					{state.step === "confirming" ? "Graduating…" : "Confirm"}
				</button>
			)}
		</div>
	);
}
