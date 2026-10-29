/**
 * The Work view's data seam. `WorkClient` is what the overlay asks for; `createWorkClient` is the real one:
 * console route → wolfd → the wolf's Work API (GET /work?domain=). The wolves are tried the way the graph pane
 * tries them for one item (the librarian, then every other online wolf; only "unavailable" moves on). Tests inject a fake.
 */
import { findKbSource, findLibrarian, workWolfCandidates, type WorkListResponse } from "@/src/core";
import { fetchKbGraph, fetchWolves, fetchWorkList, type KbResult } from "./kb-client";

export interface WorkDomain {
	name: string;
	label: string;
}

export interface WorkClient {
	/** The domains to offer in the dropdown (empty when the KB is not reachable). */
	domains(): Promise<WorkDomain[]>;
	/** The domain's work items; graduated and archived ones only with `graduated`. */
	list(domain: string, graduated: boolean): Promise<KbResult<WorkListResponse>>;
}

export function createWorkClient(): WorkClient {
	const wolves = async () => {
		const res = await fetchWolves();
		return res.ok ? res.data.wolves : [];
	};
	return {
		async domains() {
			const all = await wolves();
			const source = findKbSource(all);
			if (!source) return [];
			const res = await fetchKbGraph(source.name);
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
