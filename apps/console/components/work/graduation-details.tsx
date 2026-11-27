"use client";

/**
 * "More details" of a graduation (/work/<id>?view=graduation&wolf=<name>, work-wolfpack-F85qPOc): the summary on top, then every
 * contribution the graduation would write (title, target entry, body). With no prepared preview it says so and offers Prepare, which
 * runs the same preview job as the Graduate button.
 */
import { useCallback, useEffect, useState } from "react";
import type { GraduationPreview } from "@wolfpack/protocol";
import { KbMarkdown } from "@/components/kb/kb-markdown";
import { createGraduateClient } from "@/components/kb/graduate-client";
import { graduateStore, useGraduateJob } from "@/components/kb/graduate-store";
import { getPendingPreview } from "./graduate-direct-client";
import { HourglassIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { THREAD_RUNNING_LABEL, useThreadRunning } from "./thread-running";

type Load = { kind: "loading" } | { kind: "none" } | { kind: "error"; message: string } | { kind: "ready"; preview: GraduationPreview };

/** `wolf` is the one the link names (a request card links with its own wolf); `assignee`, `ready` and `reason` are the item's own state. */
export function GraduationDetails({ itemId, wolf, assignee, ready, reason }: { itemId: string; wolf: string; assignee?: string; ready: boolean; reason?: string }) {
	const job = useGraduateJob(itemId);
	const [load, setLoad] = useState<Load>({ kind: "loading" });
	const read = useCallback(async () => {
		const res = await getPendingPreview(wolf, itemId);
		setLoad(!res.ok ? { kind: "error", message: res.message } : "none" in res ? { kind: "none" } : { kind: "ready", preview: res.preview });
	}, [wolf, itemId]);
	useEffect(() => void read(), [read]);
	const threadRunning = useThreadRunning(assignee ?? wolf, itemId);
	// A Prepare that finished (or failed) in the store: read the wolf's preview again.
	const phase = job?.phase;
	useEffect(() => {
		if (phase === "ready") void read();
	}, [phase, read]);

	const note = assignee !== wolf && (
		<p className="mb-2 text-xs text-muted-foreground" data-testid="graduation-wolf-note">
			Preview prepared by {wolf}, not the assignee {assignee ?? "(none)"}
		</p>
	);
	if (load.kind === "loading") return <p className="mb-6 text-sm text-muted-foreground">Loading the graduation preview…</p>;
	if (load.kind === "error")
		return (
			<p className="mb-6 text-sm text-destructive" role="alert" data-testid="graduation-error">
				Could not read the graduation preview: {load.message}
			</p>
		);
	if (load.kind === "none") {
		const canPrepare = ready && !!assignee;
		const busy = phase === "previewing";
		return (
			<section className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border p-4" data-testid="graduation-none">
				<p className="min-w-0 text-sm text-muted-foreground">No graduation preview prepared.</p>
				{!ready && <p className="basis-full text-sm text-muted-foreground">Not ready to graduate: {reason || "the item is not eligible"}</p>}
				{ready && !assignee && <p className="basis-full text-sm text-muted-foreground">This item has no assignee wolf to prepare the graduation.</p>}
				{canPrepare && threadRunning && (
					<Hint label={THREAD_RUNNING_LABEL}>
						<span className="inline-flex">
							<button type="button" disabled aria-label={THREAD_RUNNING_LABEL} data-testid="graduation-prepare" data-phase="thread-running" className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1 text-sm text-muted-foreground disabled:cursor-not-allowed max-md:min-h-11">
								<HourglassIcon className="size-3.5" aria-hidden />
								Prepare
							</button>
						</span>
					</Hint>
				)}
				{canPrepare && !threadRunning && <button
					type="button"
					data-testid="graduation-prepare"
					disabled={busy}
					onClick={() => void graduateStore.startPreview(createGraduateClient(), { id: itemId, title: itemId, assignee: assignee as string }, assignee as string)}
					className="max-w-full whitespace-normal break-words rounded-md border border-border px-3 py-1 text-sm hover:bg-accent disabled:opacity-60"
				>
					{busy ? "Preparing…" : "Prepare"}
				</button>}
				{job?.phase === "error" && <p className="basis-full text-sm text-destructive" role="alert">{job.message}</p>}
			</section>
		);
	}
	const { preview } = load;
	return (
		<section className="mb-8 space-y-4" data-testid="graduation-details">
			{note}
			{preview.summary && (
				<p className="text-base font-medium" data-testid="graduation-summary">
					{preview.summary}
				</p>
			)}
			{preview.contributions.map((c) => (
				<article key={c.id} className="rounded-md border border-border p-4" data-testid="graduation-contribution">
					<h3 className="text-sm font-semibold">{c.title || c.id}</h3>
					<p className="mb-2 font-mono text-[11px] text-muted-foreground">{c.target ? `updates ${c.target}` : "new entry"}</p>
					<KbMarkdown density="normal">{c.body}</KbMarkdown>
				</article>
			))}
		</section>
	);
}
