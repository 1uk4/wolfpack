"use client";

import { DispatchCard } from "@/components/artifacts/dispatch-card";
import { MessageResponse } from "@/components/ai-elements/message";
import type { ArtifactPartProps, JobResult } from "@/src/core";

/**
 * The job tool-call box (contracts.ts "THE ASYNC PROTOCOL" §4).
 *
 * The part's output is the fire-and-forget dispatch ACK — the box itself is
 * the DispatchCard (live status via the chat view's jobs feed; quiet one-liner
 * once delivered). The result itself rides the steer message (the user-role
 * delivery injected after the wake turn) and renders there via JobBriefCard.
 * The job kind is the tool's name ("tool-<kind>"), so one component serves
 * every job tool a producer registers in the artifact registry.
 */
export function JobCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	const kind = part.type.startsWith("tool-") ? part.type.slice("tool-".length) : part.type;
	return <DispatchCard toolCallId={part.toolCallId} kind={kind} />;
}

/** The job's result brief — a markdown body. Exported: the steer card
 *  renders it under the job-complete badge. */
export function JobBriefCard({ output }: { output: unknown }) {
	const result = output as JobResult | undefined;
	if (!result || typeof result.brief !== "string") {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				The job completed, but the result could not be displayed.
			</div>
		);
	}
	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="job-brief-card">
			<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Job result
				{result.failed === true && <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>}
			</div>
			<div className="text-sm [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
				<MessageResponse>{result.brief}</MessageResponse>
			</div>
		</div>
	);
}
