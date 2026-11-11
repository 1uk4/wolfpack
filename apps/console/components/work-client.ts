/**
 * The Work view's data seam. `WorkClient` is what the overlay asks for; `createWorkClient` is the real one:
 * console route → wolfd → the wolf's Work API (GET /work?domain=). The wolves are tried the way the graph pane
 * tries them for one item (the librarian, then every other online wolf; only "unavailable" moves on). Tests inject a fake.
 */
import { findLibrarian, workWolfCandidates, type WorkListResponse } from "@/src/core";
import { fetchKbGraph, fetchWolves, fetchWorkList, patchWorkItem, type KbResult } from "./kb/kb-client";

export interface WorkDomain {
	name: string;
	label: string;
}

export interface WorkClient {
	/** The domains to offer in the dropdown (empty when the KB is not reachable). */
	domains(): Promise<WorkDomain[]>;
	/** The domain's work items; graduated and archived ones only with `graduated`. */
	list(domain: string, graduated: boolean): Promise<KbResult<WorkListResponse>>;
	// Owner controls (absent = no assignee dropdowns). Every console session is an owner session today (its hub bearer is the paired
	// console token; the hub still gates), so the real client always provides them.
	/** The wolves the dropdown offers: the hub's wolf list (registered, non-retired; online or not). A failure carries the message. */
	assignees?(): Promise<KbResult<string[]>>;
	/** Set the item's assignee through the hub; a failure carries the hub's message. */
	assign?(id: string, wolf: string): Promise<KbResult<unknown>>;
	/** Move the item under `to` (a work id; null = no parent) through the hub; `reassigned` is set when a task was handed to another wolf. A failure carries the hub's message. */
	move?(id: string, to: string | null): Promise<KbResult<{ reassigned?: WorkReassignment[] }>>;
}

export interface WorkReassignment {
	id: string;
	from: string | null;
	to: string;
}

export function createWorkClient(): WorkClient {
	const wolves = async () => {
		const res = await fetchWolves();
		return res.ok ? res.data.wolves : [];
	};
	return {
		async assignees() {
			const res = await fetchWolves();
			return res.ok ? { ok: true, data: res.data.wolves.map((w) => w.name) } : res;
		},
		assign: (id, wolf) => patchWorkItem(id, { assignee: wolf }),
		move: (id, to) => patchWorkItem(id, { moveTo: to }),
		async domains() {
			const res = await fetchKbGraph();
			return res.ok ? res.data.domains.map((d) => ({ name: d.name, label: d.label })) : [];
		},
		async list(domain, graduated) {
			const all = await wolves();
			const candidates = workWolfCandidates(findLibrarian(all)?.name ?? null, all);
			let last: KbResult<WorkListResponse> = { ok: false, reason: "unavailable", message: "No wolf is online to serve the Work API." };
			for (const wolf of candidates) {
				last = await fetchWorkList(wolf, domain, graduated);
				if (last.ok || last.reason !== "unavailable") return last;
			}
			return last;
		},
	};
}
