import type { KbActivityResponse } from "@wolfpack/client";

/** A hub KB activity response: two wolves waiting, four decisions (one with routing), two domains of changes. */
export function kbActivityFixture(over: Partial<KbActivityResponse> = {}): KbActivityResponse {
	return {
		generatedAt: "2026-11-05T10:00:00Z",
		source: { lane: "hub", hasDecisions: true, curator: "on" },
		incoming: {
			total: 4,
			wolves: [
				{ wolf: "ada", pending: 1, oldestAgeMs: 60_000, items: [{ denTopicId: "t-ada-1", hash: "h1", ageMs: 60_000 }] },
				{ wolf: "hal", pending: 3, oldestAgeMs: 7_200_000, bad: 1, items: [{ denTopicId: "t-hal-1", ageMs: 7_200_000 }, { denTopicId: "t-hal-2", ageMs: 3_000_000 }, { denTopicId: "t-hal-3", ageMs: 10_000 }] },
				{ wolf: "idle", pending: 0, items: [] },
			],
		},
		decisions: {
			items: [
				{
					id: "d4",
					at: "2026-11-05T09:58:00Z",
					from: "hal",
					denTopicId: "t-old",
					hash: "hh4",
					outcome: "merge",
					entryId: "ent-merge",
					reason: "same subject",
					superseded: 1,
					routing: {
						route: "similarity",
						band: "high",
						candidates: [{ id: "c-low", score: 0.2 }, { id: "c-top", score: 0.93 }, { id: "c-mid", score: 0.6 }, { id: "c-4th", score: 0.5 }],
						subject: { match: "same", valid: true },
						confirm: { candidate: "c-top", score: 0.93, merge: true, valid: true },
						warning: "close call",
					},
				},
				{ id: "d3", at: "2026-11-05T09:50:00Z", from: "ada", denTopicId: "t3", hash: "hh3", outcome: "create", entryId: "ent-new", reason: "new subject" },
				{ id: "d2", at: "2026-11-05T09:40:00Z", from: "ada", denTopicId: "t2", hash: "hh2", outcome: "reject", reason: "too vague" },
				{ id: "d1", at: "2026-11-05T09:30:00Z", from: "hal", denTopicId: "t1", hash: "hh1", outcome: "parked", reason: "no domain" },
			],
			nextCursor: "cur-1",
			total: 9,
			counts: { create: 3, merge: 2, unchanged: 1, reject: 2, parked: 1, unclassified: 0 },
		},
		changes: {
			domains: [
				{ domain: "wolfpack", items: [{ at: "2026-11-05T09:58:00Z", entryId: "ent-merge", title: "Merged entry", action: "merge", from: "hal" }, { at: "2026-11-05T08:00:00Z", entryId: "ent-old", action: "retire" }] },
				{ domain: "personal", items: [{ at: "2026-11-05T09:50:00Z", entryId: "ent-new", title: "New entry", action: "create", from: "ada" }] },
			],
		},
		...over,
	};
}
