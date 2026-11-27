"use client";

/**
 * GraduateButton (work-wolfpack-F85qPOc): the one-click graduation of a finished feature or initiative. Click prepares a preview on the
 * assignee wolf (the shared graduation store runs and polls the job, so /work, the item page and the graph pane agree); when it is ready a
 * small popover shows the summary, a "More details" link, Confirm and Cancel. Confirm is the owner's approval: it goes straight to the hub
 * through graduateDirect, with no second request to approve. A failure shows inline; "already graduated" counts as done.
 */
import { useEffect, useRef, useState } from "react";
import { useBusyAction } from "@/components/ui/use-busy-action";
import { createGraduateClient, type GraduateClient } from "../kb/graduate-client";
import { openGraduationLink, useOpenView } from "../viewer/viewer-context";
import { graduateStore, useGraduateJob } from "../kb/graduate-store";
import { notifyGraduated } from "../kb/graduation-signal";
import { HourglassIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { THREAD_RUNNING_LABEL, useThreadRunning } from "./thread-running";
import { getPendingPreview, graduateDirect, type GraduateVia } from "./graduate-direct-client";
import { ZC } from "@/lib/z-layers";

const moreHref = (id: string, wolf: string) => `/work/${id}?view=graduation&wolf=${encodeURIComponent(wolf)}`;
const NO_ASSIGNEE = "This item has no assignee wolf to prepare the graduation.";

export function GraduateButton({ itemId, assignee, via, title, client, onDone, testid = "graduate-button" }: { testid?: string; itemId: string; assignee?: string; via: GraduateVia; title?: string; client?: GraduateClient; onDone?: () => void }) {
	const job = useGraduateJob(itemId);
	// The feature thread has a turn or a running sub-agent: Graduate waits (wolfd refuses too); live, no reload.
	const threadRunning = useThreadRunning(assignee, itemId);
	const openView = useOpenView();
	const [real] = useState(() => client ?? createGraduateClient());
	const c = client ?? real;
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState(false);
	// The popover opens by itself when a preview this click started turns ready.
	const wanted = useRef(false);
	useEffect(() => {
		if (job?.phase === "ready" && wanted.current) {
			wanted.current = false;
			setOpen(true);
		}
	}, [job?.phase]);

	const target = { id: itemId, title: title ?? itemId, ...(assignee ? { assignee } : {}) };
	const start = async () => {
		if (threadRunning) return;
		setError(null);
		if (!assignee) return void setError(NO_ASSIGNEE);
		wanted.current = true;
		if (graduateStore.get(itemId)?.phase !== "ready") await graduateStore.recover(c, target);
		const cur = graduateStore.get(itemId);
		if (cur?.phase === "ready") return void (wanted.current = false, setOpen(true));
		if (cur?.phase === "error") graduateStore.retry(itemId);
		if (!graduateStore.get(itemId)) await graduateStore.startPreview(c, target, assignee);
	};
	const confirm = async () => {
		if (job?.phase !== "ready" || threadRunning) return;
		setError(null);
		// Send exactly what the owner can read under More details: read the wolf's preview again right before sending.
		const fresh = await getPendingPreview(job.wolf, itemId);
		if (!fresh.ok) return void setError(fresh.message);
		if ("none" in fresh || fresh.preview.token !== job.preview.token) {
			// Expired, or prepared again since the popover opened: drop it and, when a newer one exists, show that instead.
			graduateStore.clear(itemId);
			if ("none" in fresh) setOpen(false);
			else await graduateStore.recover(c, target);
			return void setError("The preview changed, review it again");
		}
		const p = fresh.preview;
		const res = await graduateDirect(itemId, { contributions: p.contributions, ...(p.summary ? { summary: p.summary } : {}), via, wolf: job.wolf });
		if (res.ok || res.alreadyGraduated) {
			graduateStore.clear(itemId);
			setOpen(false);
			setDone(true);
			notifyGraduated(itemId);
			onDone?.();
		} else setError(res.message);
	};
	// A second click while a confirm is in flight (even in the same tick) sends nothing; `sending` disables the button.
	const { run: runConfirm, pending: sending } = useBusyAction(confirm);
	if (done) return <span data-testid={testid} data-phase="graduated" className="shrink-0 text-[11px] text-emerald-300">Graduated</span>;


	const busy = job?.phase === "previewing" || job?.phase === "graduating";
	const label = busy ? "Preparing…" : job?.phase === "ready" ? "Review" : job?.phase === "error" ? "Retry" : "Graduate";
	const shown = error ?? (job?.phase === "error" ? job.message : null);
	return (
		<span className="relative inline-flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
			{threadRunning ? (
				<Hint label={THREAD_RUNNING_LABEL}>
					<span className="inline-flex">
						<button
							type="button"
							data-testid={testid}
							data-phase="thread-running"
							disabled
							aria-label={THREAD_RUNNING_LABEL}
							className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground max-md:min-h-11 disabled:cursor-not-allowed"
						>
							<HourglassIcon className="size-3" aria-hidden />
							{label}
						</button>
					</span>
				</Hint>
			) : (
				<button
					type="button"
					data-testid={testid}
					data-phase={busy ? "busy" : (job?.phase ?? "idle")}
					disabled={busy || !assignee}
					title={assignee ? undefined : NO_ASSIGNEE}
					onClick={() => (job?.phase === "ready" ? setOpen((o) => !o) : void start())}
					className="rounded-md border border-emerald-400/60 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/25 max-md:min-h-11 disabled:opacity-60"
				>
					{label}
				</button>
			)}
			{shown && !open && (
				<span role="alert" data-testid="graduate-error" className="text-[11px] text-destructive">
					{shown}
				</span>
			)}
			{open && job?.phase === "ready" && (
				<div data-testid="graduate-popover" role="dialog" className={`absolute right-0 top-full ${ZC.menu} mt-1 w-72 rounded-md border border-border bg-popover p-3 text-xs shadow-lg`}>
					<p className="mb-2 text-foreground">{job.preview.summary ?? `${job.preview.contributions.length} KB ${job.preview.contributions.length === 1 ? "entry" : "entries"} will be written; ${job.preview.archive.length} item${job.preview.archive.length === 1 ? "" : "s"} archived.`}</p>
					{job.preview.blocked && <p className="mb-2 text-destructive">{job.preview.blocked}</p>}
					<a data-testid="graduate-more" href={moreHref(itemId, job.wolf)} onClick={(e) => openGraduationLink(e, openView, moreHref(itemId, job.wolf))} className="text-primary underline">
						More details
					</a>
					{error && (
						<p role="alert" data-testid="graduate-error" className="mt-2 text-destructive">
							{error}
						</p>
					)}
					<div className="mt-3 flex justify-end gap-2">
						<button type="button" data-testid="graduate-cancel" onClick={() => (setOpen(false), setError(null))} className="rounded-md border border-border px-2 py-0.5">
							Cancel
						</button>
						<button type="button" data-testid="graduate-confirm" disabled={sending || threadRunning || !!job.preview.blocked} onClick={() => void runConfirm()} className="rounded-md border border-emerald-400/60 bg-emerald-500/20 px-2 py-0.5 font-medium text-emerald-200 disabled:opacity-60">
							{sending ? "Graduating…" : "Confirm"}
						</button>
					</div>
				</div>
			)}
		</span>
	);
}
