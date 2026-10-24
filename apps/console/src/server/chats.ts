import { titleFromPrompt } from "../core/contracts.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

/**
 * Server-side chat entries for the transport layer (app/api/chats*,
 * app/chat/[id]). Today these delegate straight to the ChatStore port; the
 * services stage carves the real orchestration behind this same surface.
 *
 * deleteChatSession is the one real orchestration here: gates → one
 * synchronous deletion block.
 */

export const { createChat, getChat, listChats } = stores.chatStore;
export { titleFromPrompt };

/** What deleteChatSession did — the route maps it straight to HTTP. */
export type ChatDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 409; code: "turn_in_flight" | "jobs_running"; error: string; jobIds: string[] }
	| { ok: true; jobsRemoved: number };

/**
 * Delete a session. GATES first — a turn in flight or a running background
 * job refuses with 409 (they write the chat record and steer into it;
 * deleting mid-flight would corrupt the write-ahead flow). The UI retries
 * once work drains. Then jobs, then the chat record LAST.
 */
export async function deleteChatSession(chatId: string): Promise<ChatDeleteOutcome> {
	if (!stores.chatStore.getChat(chatId)) {
		return { ok: false, status: 404, code: "not_found", error: "No such session" };
	}
	if (isTurnRunning(chatId)) {
		return {
			ok: false,
			status: 409,
			code: "turn_in_flight",
			error: "A turn is running in this session — try again when it finishes",
			jobIds: [],
		};
	}
	const runningJobs = stores.jobStore.listJobs(chatId).filter((job) => job.status === "running");
	if (runningJobs.length > 0) {
		return {
			ok: false,
			status: 409,
			code: "jobs_running",
			error: "Background jobs are still running in this session — try again when they finish",
			jobIds: runningJobs.map((job) => job.id),
		};
	}
	const jobsRemoved = stores.jobStore.deleteJobsForChat(chatId);
	stores.chatStore.deleteChat(chatId);
	return { ok: true, jobsRemoved };
}
