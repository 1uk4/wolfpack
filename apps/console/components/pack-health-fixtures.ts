/**
 * DEV ONLY (work-wolfpack-6imFEq7): canned pack-health snapshots so every state can be seen in a browser without breaking a real
 * service. `?healthFixture=<name>` replaces the live stream; `?healthRestart=<status>` makes the Restart button answer with that status
 * without calling the server. `?healthLogs=<status>` and `?healthRollback=<status>` do the same for Logs (200 shows canned, redacted-looking
 * lines; 502 = journal_denied, 501 = no journal) and Roll back (work-wolfpack-yM3uTlj). The fixtures advertise systemd and a kept previous
 * hubd (0.1.13) and console (0.1.17) release, all on sfo-01 (plus the Mac's map-only card). `?healthFixture=mac` is a Mac console (no systemd)
 * whose hub is an older build probed by tailnet IP (no `host` yet, so it shows as the IP); `two-hosts-mac-view` is the same with a newer hub
 * that reports sfo-01. The hub's view (work-wolfpack-w7RPvtd): `ok`, `issues` and `two-hosts-mac-view` carry the hosts the hub reports
 * (the Mac card fills in from the hub in the sfo-01 view; sfo-01's from the hub in the Mac view), `hub-view-host-offline` has a host the
 * hub sees offline, and `hub-unreachable-last-seen` keeps the hub's last list while the hub is down. All ignored in a production build.
 */
import type { HealthLink, HealthSnapshotView } from "@/src/core/pack-health-view";
import type { HostInfo } from "@/src/core/pack-hosts";

export const HEALTH_FIXTURES = ["ok", "hub-down", "frozen", "recovering", "restarting", "unknown-wolf", "back", "issues", "unreachable", "mac", "two-hosts-mac-view", "hub-view-host-offline", "hub-unreachable-last-seen"] as const;
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
		host: "sfo-01",
		...over,
	});
	return [ok("hubd", "hubd"), ok("workerd", "workerd"), ok("workerd-wolves", "workerd"), ok("wolfd@hal", "wolfd", { via: "workerd-wolves" })];
}

const patch = (links: HealthLink[], id: string, over: Partial<HealthLink>) => links.map((l) => (l.id === id ? { ...l, ...over } : l));

/** A row known only from the hub's /healthz (pack-health.ts THE HUB'S VIEW). */
function hubRow(id: string, host: string, now: number, over: Partial<HealthLink> = {}): HealthLink {
	return {
		id,
		kind: id.startsWith("hub-link@") ? "hublink" : "wolfd",
		status: "ok",
		responseMs: null,
		lagMs: null,
		lastOkAt: iso(2_000, now),
		lastCheckedAt: iso(2_000, now),
		error: null,
		version: null,
		uptimeS: null,
		history: [{ status: "ok", at: iso(3_600_000, now) }],
		lastRestart: null,
		restartable: false,
		host,
		source: "hub",
		since: iso(5 * 3_600_000, now),
		hubSeenAt: iso(2_000, now),
		...over,
	};
}

/** The Mac as the hub sees it from sfo-01: its link and its two wolves. */
const macFromHub = (now: number, over: Partial<HealthLink> = {}): HealthLink[] => [
	hubRow("hub-link@luka-air", "luka-air", now, over),
	hubRow("wolfd@1uk4", "luka-air", now, { via: "hub-link@luka-air", ...over }),
	hubRow("wolfd@ada", "luka-air", now, { via: "hub-link@luka-air", ...over }),
];
const SFO_HOSTS = (extra: HostInfo[] = []): HostInfo[] => [{ id: "sfo-01", label: "sfo-01", isThisConsole: true, platform: "linux", hubId: "sfo-01" }, { id: "luka-air", label: "Mac", isThisConsole: false, hubId: "luka-air" }, ...extra];

/** The snapshot for a fixture, or null for "unreachable" (the console server itself is not answering). */
export function fixtureSnapshot(name: HealthFixture, now: number): HealthSnapshotView | null {
	let links = base(now);
	const at = (msAgo: number) => iso(msAgo, now);
	let hosts: HostInfo[] = [{ id: "sfo-01", label: "sfo-01", isThisConsole: true, platform: "linux" }];
	switch (name) {
		case "ok":
			links = [...patch(links, "wolfd@hal", { hubStatus: "online" }), ...macFromHub(now)];
			hosts = SFO_HOSTS();
			break;
		case "hub-view-host-offline": {
			// The Mac asleep (expected: grey, not an issue) and a build box the hub has lost (red, counted).
			const asleep = { status: "unknown" as const, error: "host_asleep", since: at(40 * 60_000), history: [{ status: "ok" as const, at: at(3_600_000) }, { status: "unknown" as const, at: at(40 * 60_000) }] };
			const gone = { status: "down" as const, since: at(7 * 60_000), lastOkAt: at(7 * 60_000), history: [{ status: "ok" as const, at: at(3_600_000) }, { status: "down" as const, at: at(7 * 60_000) }] };
			links = [
				...links,
				...macFromHub(now, asleep),
				hubRow("hub-link@build-box", "build-box", now, { ...gone, error: "host_offline" }),
				hubRow("wolfd@ci", "build-box", now, { ...gone, error: "wolf_offline", via: "hub-link@build-box" }),
			];
			hosts = SFO_HOSTS([{ id: "build-box", label: "build-box", isThisConsole: false, hubId: "build-box" }]);
			break;
		}
		case "hub-unreachable-last-seen":
			// hubd refused for 4 min: the hub's last list stays, unknown and dated; the local workerd rows stay live.
			links = patch(links, "hubd", { status: "down", error: "refused", responseMs: 2, lagMs: null, lastOkAt: at(4 * 60_000), version: null, uptimeS: null, history: [{ status: "ok", at: at(3_600_000) }, { status: "down", at: at(4 * 60_000) }] });
			links = [...links, ...macFromHub(now, { status: "unknown", error: "hub_stale", hubSeenAt: at(4 * 60_000), lastCheckedAt: at(4 * 60_000), history: [{ status: "ok", at: at(3_600_000) }, { status: "unknown", at: at(4 * 60_000) }] })];
			hosts = SFO_HOSTS();
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
			links = patch(links, "wolfd@hal", { status: "down", error: "wolf_failed", hubStatus: "offline", history: [{ status: "ok", at: at(3_600_000) }, { status: "down", at: at(20_000) }] });
			links = [...links, ...macFromHub(now).map((l) => (l.id === "wolfd@ada" ? { ...l, status: "down" as const, error: "wolf_offline", history: [{ status: "ok" as const, at: at(3_600_000) }, { status: "down" as const, at: at(90_000) }] } : l))];
			hosts = SFO_HOSTS();
			break;
		case "unreachable":
			return null;
		case "mac":
		case "two-hosts-mac-view": {
			// A Mac console: its live-stack workerd and wolves on loopback, the hub on sfo-01 over the tailnet (restartable false: no systemd).
			const hubHost = name === "mac" ? "100.120.154.69" : "sfo-01";
			const mac = links
				.filter((l) => l.id !== "workerd-wolves")
				.map((l): HealthLink => (l.kind === "hubd" ? { ...l, host: hubHost, restartable: false } : { ...l, host: "luka-air", restartable: false, ...(l.kind === "wolfd" ? { via: "workerd" } : {}) }));
			mac.push({ ...mac.find((l) => l.kind === "wolfd")!, id: "wolfd@ada" });
			if (name === "mac") {
				// An older hub: no `host`, no `hosts`. The card it is on (the IP) is sfo-01's by the hub rule (pack-hosts.ts).
				const old: HostInfo[] = [{ id: "luka-air", label: "Mac", isThisConsole: true, platform: "darwin" }, { id: hubHost, label: hubHost, isThisConsole: false }];
				return { checkedAt: at(2_000), intervalMs: 5000, links: mac, hosts: old, actions: { systemd: false, rollback: [] } };
			}
			// A newer hub: the local workerd names its hub host (merged), sfo-01 and its wolves come from the hub.
			const merged = mac.map((l) => (l.kind === "workerd" ? { ...l, hubPresence: "online" as const } : l.kind === "wolfd" ? { ...l, hubStatus: "online" as const } : l));
			merged.push(hubRow("hub-link@sfo-01", "sfo-01", now), hubRow("wolfd@hal", "sfo-01", now, { via: "hub-link@sfo-01" }));
			const newer: HostInfo[] = [
				{ id: "luka-air", label: "Mac", isThisConsole: true, platform: "darwin", hubId: "luka-air" },
				{ id: "sfo-01", label: "sfo-01", isThisConsole: false, hubId: "sfo-01" },
			];
			return { checkedAt: at(2_000), intervalMs: 5000, links: merged.filter((l) => !(l.id === "wolfd@hal" && l.source !== "hub")), hosts: newer, actions: { systemd: false, rollback: [] } };
		}
	}
	return { checkedAt: at(2_000), intervalMs: 5000, links, hosts, actions: { systemd: true, rollback: [{ service: "hubd", from: "0.1.14", to: "0.1.13" }, { service: "console", from: "0.1.18", to: "0.1.17" }] } };
}

/** Canned journal lines for `?healthLogs=200`. */
export function fixtureLogs(service: string, now: number): { lines: string[]; truncated: boolean } {
	const t = (msAgo: number) => new Date(now - msAgo).toISOString().replace(/\.\d+Z$/, "+0000");
	const unit = service.replace(/@.*/, "");
	return {
		truncated: true,
		lines: Array.from({ length: 40 }, (_, i) => {
			const n = 40 - i;
			if (i === 37) return `${t(n * 15_000)} sfo-01 ${unit}[812]: link up; Authorization: Bearer [redacted]`;
			if (i === 38) return `${t(n * 15_000)} sfo-01 ${unit}[812]: slow request /v1/work took 912 ms (a very long line that has to wrap on a 390 px phone screen without pushing the panel sideways)`;
			return `${t(n * 15_000)} sfo-01 ${unit}[812]: tick ${i} ok`;
		}),
	};
}

export interface FixtureSwitches {
	fixture: HealthFixture | null;
	restartStatus: number | null;
	logsStatus: number | null;
	rollbackStatus: number | null;
}

/** Read the dev fixture switches from the page URL; always off in production. */
export function fixtureFromUrl(search: string): FixtureSwitches {
	if (process.env.NODE_ENV === "production") return { fixture: null, restartStatus: null, logsStatus: null, rollbackStatus: null };
	const p = new URLSearchParams(search);
	const f = p.get("healthFixture");
	const num = (k: string) => {
		const r = Number(p.get(k));
		return Number.isInteger(r) && r > 0 ? r : null;
	};
	return { fixture: (HEALTH_FIXTURES as readonly string[]).includes(f ?? "") ? (f as HealthFixture) : null, restartStatus: num("healthRestart"), logsStatus: num("healthLogs"), rollbackStatus: num("healthRollback") };
}
