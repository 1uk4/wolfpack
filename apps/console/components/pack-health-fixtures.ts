/**
 * DEV ONLY (work-wolfpack-6imFEq7): canned pack-health snapshots so every state can be seen in a browser without breaking a real
 * service. `?healthFixture=<name>` replaces the live stream; `?healthRestart=<status>` makes the Restart button answer with that status
 * without calling the server. Both are ignored in a production build (see fixtureFromUrl).
 */
import type { HealthLink, HealthSnapshotView } from "@/src/core/pack-health-view";

export const HEALTH_FIXTURES = ["ok", "hub-down", "frozen", "recovering", "restarting", "unknown-wolf", "back", "issues", "unreachable"] as const;
export type HealthFixture = (typeof HEALTH_FIXTURES)[number];

const iso = (msAgo: number, now: number) => new Date(now - msAgo).toISOString();

function base(now: number): HealthLink[] {
	const ok = (id: string, kind: HealthLink["kind"], over: Partial<HealthLink> = {}): HealthLink => ({
		id,
		kind,
		status: "ok",
		responseMs: kind === "wolfd" ? null : 9,
		lagMs: kind === "wolfd" ? null : 4,
		lastOkAt: iso(2_000, now),
		lastCheckedAt: iso(2_000, now),
		error: null,
		version: kind === "wolfd" ? null : "0.1.14",
		uptimeS: kind === "wolfd" ? null : 86_400 * 2 + 3_600 * 5,
		history: [{ status: "ok", at: iso(3_600_000, now) }],
		lastRestart: null,
		restartable: true,
		...over,
	});
	return [ok("hubd", "hubd"), ok("workerd", "workerd"), ok("workerd-wolves", "workerd"), ok("wolfd@hal", "wolfd", { via: "workerd-wolves" })];
}

const patch = (links: HealthLink[], id: string, over: Partial<HealthLink>) => links.map((l) => (l.id === id ? { ...l, ...over } : l));

/** The snapshot for a fixture, or null for "unreachable" (the console server itself is not answering). */
export function fixtureSnapshot(name: HealthFixture, now: number): HealthSnapshotView | null {
	let links = base(now);
	const at = (msAgo: number) => iso(msAgo, now);
	switch (name) {
		case "ok":
			break;
		case "hub-down":
			links = patch(links, "hubd", { status: "down", error: "refused", responseMs: 2, lagMs: null, lastOkAt: at(4 * 60_000), version: null, uptimeS: null, history: [{ status: "ok", at: at(3_600_000) }, { status: "down", at: at(4 * 60_000) }] });
			break;
		case "frozen":
			links = patch(links, "hubd", { status: "frozen", error: "timeout", responseMs: 3000, lagMs: null, lastOkAt: at(90_000), history: [{ status: "ok", at: at(3_600_000) }, { status: "frozen", at: at(85_000) }] });
			break;
		case "recovering":
			links = patch(links, "hubd", { status: "recovering", error: "slow", responseMs: 11, lagMs: 1800, uptimeS: 25, history: [{ status: "ok", at: at(3_600_000) }, { status: "frozen", at: at(240_000) }, { status: "restarting", at: at(180_000) }, { status: "recovering", at: at(20_000) }], lastRestart: { at: at(180_000), ok: true } });
			break;
		case "restarting":
			links = patch(links, "workerd", { status: "restarting", error: "refused", responseMs: 1, lagMs: null, version: null, uptimeS: null, lastOkAt: at(15_000), history: [{ status: "ok", at: at(3_600_000) }, { status: "restarting", at: at(12_000) }], lastRestart: { at: at(12_000), ok: true } });
			break;
		case "unknown-wolf":
			links = patch(links, "workerd-wolves", { status: "down", error: "refused", responseMs: 1, lagMs: null, version: null, uptimeS: null, lastOkAt: at(60_000), history: [{ status: "ok", at: at(3_600_000) }, { status: "down", at: at(55_000) }] });
			links = patch(links, "wolfd@hal", { status: "unknown", error: "workerd_unavailable", history: [{ status: "ok", at: at(3_600_000) }, { status: "unknown", at: at(55_000) }] });
			break;
		case "back":
			links = patch(links, "hubd", { uptimeS: 40, history: [{ status: "down", at: at(120_000) }, { status: "restarting", at: at(90_000) }, { status: "recovering", at: at(30_000) }, { status: "ok", at: at(1_000) }], lastRestart: { at: at(90_000), ok: true } });
			break;
		case "issues":
			links = patch(links, "hubd", { status: "degraded", error: "slow", responseMs: 900, lagMs: 650, history: [{ status: "ok", at: at(3_600_000) }, { status: "degraded", at: at(30_000) }] });
			links = patch(links, "wolfd@hal", { status: "down", error: "wolf_failed", history: [{ status: "ok", at: at(3_600_000) }, { status: "down", at: at(20_000) }] });
			break;
		case "unreachable":
			return null;
	}
	return { checkedAt: at(2_000), intervalMs: 5000, links };
}

/** Read the dev fixture switches from the page URL; always off in production. */
export function fixtureFromUrl(search: string): { fixture: HealthFixture | null; restartStatus: number | null } {
	if (process.env.NODE_ENV === "production") return { fixture: null, restartStatus: null };
	const p = new URLSearchParams(search);
	const f = p.get("healthFixture");
	const r = Number(p.get("healthRestart"));
	return { fixture: (HEALTH_FIXTURES as readonly string[]).includes(f ?? "") ? (f as HealthFixture) : null, restartStatus: Number.isInteger(r) && r > 0 ? r : null };
}
