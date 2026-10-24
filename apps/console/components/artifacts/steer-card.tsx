"use client";

import { CheckIcon, CircleX } from "lucide-react";
import type { SubagentArtifactData } from "@/src/core";
import type { LhViewMessage } from "@/src/core";
import { isSubagentFailure } from "@/src/core";
import { JobBriefCard } from "@/components/artifacts/job-card";

/**
 * The job result delivery card (contracts.ts "THE ASYNC PROTOCOL" §4).
 *
 * When a background job completes, the wake pipeline injects a STEER message
 * into the transcript: a user-role message whose data part
 * ("data-subagent-artifact") carries the result. It renders as an artifact —
 * NEVER a user bubble, never wrapped in a message container: a quiet
 * "complete" one-liner that expands on demand (native <details>) to the
 * full persisted brief. Failures keep the failure card (the brief explains
 * what went wrong).
 */
export function SubagentSteerCard({ message }: { message: LhViewMessage }) {
	const artifactPart = message.parts.find((p) => p.type === "data-subagent-artifact");
	const data = artifactPart?.data as SubagentArtifactData | undefined;
	// The abort steer: its message-type part is data-subagent-aborted — a
	// quiet chip, mirroring the complete-badge.
	if (!data) {
		const aborted = message.parts.find((p) => p.type === "data-subagent-aborted") as
			| { data?: { kind?: string } }
			| undefined;
		if (aborted?.data) return <AbortedBadge kind={aborted.data.kind ?? "job"} />;
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				A job finished, but its result could not be displayed.
			</div>
		);
	}
	return isSubagentFailure(data.kind, data.result) ? (
		<JobBriefCard output={data.result} />
	) : (
		<JobCompleteBadge kind={data.kind} result={data.result} />
	);
}

/** The aborted-job chip: mirrors the complete-badge one-liner — the
 * agent's wake turn acknowledges the abort itself, this just marks what
 * happened. */
function AbortedBadge({ kind }: { kind: string }) {
	return (
		<div data-testid="job-aborted-badge" className="flex items-center gap-2 text-xs text-muted-foreground">
			<CircleX className="size-3.5" />
			<span className="font-medium uppercase tracking-wide">{kind}</span>
			<span>aborted by the user</span>
		</div>
	);
}

/** Quiet one-liner: the agent's wake turn weaves the result in; the badge
 * marks delivery, the collapsed details carries the full brief. */
function JobCompleteBadge({ kind, result }: { kind: string; result: SubagentArtifactData["result"] }) {
	return (
		<details data-testid="job-complete-badge" className="group w-full text-xs text-muted-foreground">
			<summary className="flex cursor-pointer select-none list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
				<CheckIcon className="size-3.5" />
				<span className="font-medium uppercase tracking-wide">{kind}</span>
				<span>complete</span>
				<span className="ml-1 text-xs text-muted-foreground/70 group-open:hidden">view brief</span>
				<span className="ml-1 hidden text-xs text-muted-foreground/70 group-open:inline">hide brief</span>
			</summary>
			<div className="mt-2">
				<JobBriefCard output={result} />
			</div>
		</details>
	);
}
