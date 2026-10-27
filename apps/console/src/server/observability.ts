/**
 * Server-side observability surface — the barrel-approved exports the
 * transport layer (app/api/*) reads for background-process status.
 *
 * THE ACTIVITY FEED: the bottom-right dock is visible in every view, so it
 * needs the complete running-process picture — jobs across ALL chats (not
 * just the open one) — in one poll. The dock is BACKGROUND PROCESSES ONLY:
 * in-flight turns are deliberately NOT in the feed. /api/jobs stays
 * chat-scoped: it is the transcript machinery's poll; the dock is a
 * different consumer with a different shape, served here. Single sources
 * of truth are unchanged: the job store — this file only composes it.
 */

import { chatStore } from "../store/chats.ts";
import { catalogContextLimits } from "./model-catalog.ts";
import { listJobs } from "./jobs.ts";
import type { JobRecord } from "../core/contracts.ts";

export { chatStore } from "../store/chats.ts";

/** A running sub-agent job, joined with its chat's title for the dock.
 *  contextLimit (context-meter amendment, owner 2026-09-23): the model's
 *  live catalog limit, resolved SERVER-SIDE from pi's catalog — the dock
 *  reads it off the feed instead of any client-side table. Null when the
 *  model is missing from the catalog (the blob then renders no context
 *  line — never a fake window). */
export interface ActivityJob extends JobRecord {
	title: string;
	contextLimit: number | null;
}

/** The dock's whole world in one payload: every running process, every view.
 *  Jobs are RUNNING-ONLY — finished jobs belong to their chat's transcript;
 *  the blob disappears when the process ends. Cost math is NOT done here:
 *  raw usage rides on the records and the client folds it with the pure
 *  helpers in core/prices.ts (transport stays thin). */
export function activityFeed(): {
	jobs: ActivityJob[];
} {
	const chats = chatStore.listChats();
	const limits = catalogContextLimits();
	const jobs: ActivityJob[] = [];
	for (const chat of chats) {
		for (const job of listJobs(chat.id)) {
			if (job.status === "running") {
				jobs.push({
					...job,
					title: chat.title ?? chat.id,
					contextLimit: job.usage ? (limits.get(job.usage.model) ?? null) : null,
				});
			}
		}
	}
	// oldest-first on last activity: the stable blob order (ISO strings sort chronologically)
	jobs.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
	return { jobs };
}
