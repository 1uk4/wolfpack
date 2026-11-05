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
				{ wolf: "hal", pending: 3, oldestAgeMs: 7_200_000, bad: 2, items: [{ denTopicId: "t-hal-1", ageMs: 7_200_000 }, { denTopicId: "t-hal-2", ageMs: 3_000_000 }, { denTopicId: "t-hal-3", ageMs: 10_000 }] },
				{ wolf: "idle", pending: 0, items: [] },
			],
			bad: [
				{ id: "sha-1", wolf: "hal", denTopicId: "t-bad-1", domainHint: "nope", reason: "domain_hint is not subscribed", at: "2026-11-05T08:00:00Z" },
				{ id: "sha-2", wolf: "hal", reason: "request body is not valid JSON", at: "2026-11-05T07:00:00Z" },
			],
		},
		domains: [
			{ domain: "empty", entries: 0, waiting: 0, contributors: [] },
			{ domain: "personal", entries: 20, waiting: 1, lastChangeAt: "2026-11-05T09:50:00Z", contributors: [{ wolf: "ada", count: 5 }], decided: 5 },
			{ domain: "wolfpack", entries: 167, waiting: 2, lastChangeAt: "2026-11-05T09:58:00Z", contributors: [{ wolf: "hal", count: 1 }], decided: 1 },
		],
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
					domain: "wolfpack",
					title: "Merged entry",
					routing: {
						route: "similarity",
						band: "high",
						candidates: [{ id: "c-low", score: 0.2 }, { id: "c-top", score: 0.93 }, { id: "c-mid", score: 0.6 }, { id: "c-4th", score: 0.5 }],
						subject: { match: "same", valid: true },
						confirm: { candidate: "c-top", score: 0.93, merge: true, valid: true },
						warning: "close call",
					},
				},
				{ id: "d3", at: "2026-11-05T09:50:00Z", from: "ada", denTopicId: "t3", hash: "hh3", outcome: "create", entryId: "ent-new", reason: "new subject", domain: "personal", title: "New entry" },
				{ id: "d2", at: "2026-11-05T09:40:00Z", from: "ada", denTopicId: "t2", hash: "hh2", outcome: "reject", reason: "too vague", domain: "personal" },
				{ id: "d1", at: "2026-11-05T09:30:00Z", from: "hal", denTopicId: "t1", hash: "hh1", outcome: "parked", reason: "no domain" },
			],
			nextCursor: "cur-1",
			total: 9,
			counts: { create: 3, merge: 2, unchanged: 1, reject: 2, parked: 1, unclassified: 0 },
		},
		changes: {
			domains: [
				{ domain: "wolfpack", items: [{ at: "2026-11-05T09:58:00Z", entryId: "ent-merge", title: "Merged entry", action: "merge", from: "hal", denTopicId: "t-old" }, { at: "2026-11-05T08:00:00Z", entryId: "ent-old", action: "retire" }] },
				{ domain: "personal", items: [{ at: "2026-11-05T09:50:00Z", entryId: "ent-new", title: "New entry", action: "create", from: "ada", denTopicId: "t3" }] },
			],
		},
		...over,
	};
}
