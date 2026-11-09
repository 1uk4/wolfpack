/** Pack health view model (work-wolfpack-6imFEq7): pure wording and colour for the sidebar bar and the health modal. */

export type HealthStatus = "ok" | "degraded" | "recovering" | "down" | "frozen" | "restarting" | "unknown";
export type Tone = "red" | "amber" | "grey" | "green";

/** One link as GET /api/health returns it (src/server/pack-health.ts LinkSnapshot). */
export interface HealthLink {
	id: string;
	kind: "hubd" | "workerd" | "wolfd";
	status: HealthStatus;
	responseMs: number | null;
	lagMs: number | null;
	lastOkAt: string | null;
	lastCheckedAt: string | null;
	error: string | null;
	version: string | null;
	uptimeS: number | null;
	via?: string;
	history: { status: HealthStatus; at: string }[];
	lastRestart: { at: string; ok: boolean } | null;
	restartable: boolean;
}

export interface HealthSnapshotView {
	checkedAt: string | null;
	intervalMs: number;
	links: HealthLink[];
}

export function toneOf(s: HealthStatus): Tone {
	return s === "down" || s === "frozen" ? "red" : s === "degraded" || s === "restarting" || s === "recovering" ? "amber" : s === "unknown" ? "grey" : "green";
}
const RANK: Record<Tone, number> = { green: 0, grey: 1, amber: 2, red: 3 };

/** "Hub", the workerd unit id as is, a wolf's bare name. */
export function linkName(l: Pick<HealthLink, "id" | "kind">): string {
	if (l.kind === "hubd") return "Hub";
	if (l.kind === "wolfd") return l.id.replace(/^wolfd@/, "");
	return l.id;
}

const STATUS_WORD: Record<HealthStatus, string> = { ok: "ok", degraded: "slow", recovering: "recovering…", down: "down", frozen: "frozen", restarting: "restarting…", unknown: "unknown" };
export const statusWord = (s: HealthStatus): string => STATUS_WORD[s];

const ERROR_TEXT: Record<string, string> = {
	timeout: "No answer in time (hung or overloaded)",
	refused: "Not running (connection refused)",
	wrong_service: "Something else is answering on its port",
	no_healthz: "Running an older build without a health check",
	unreachable: "Can't reach it on the network",
	slow: "Answering, but slowly",
	reports_not_ok: "Answering, but reports a problem",
	workerd_unavailable: "Its workerd isn't answering, so its state is unknown",
	not_reported: "Its workerd no longer lists it",
};

/** The monitor's short error code (pack-health.ts) in plain words; an unknown code is shown as is. */
export function errorText(code: string | null): string | null {
	if (code === null) return null;
	if (ERROR_TEXT[code]) return ERROR_TEXT[code];
	const http = /^http_(\d{3})$/.exec(code);
	if (http) return `Answered with HTTP ${http[1]}`;
	const wolf = /^wolf_([a-z]+)$/.exec(code);
	if (wolf) return `Its workerd reports it ${wolf[1]}`;
	return code;
}

const hhmm = (iso: string): string => {
	const d = new Date(iso);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/**
 * The last `max` transitions, oldest first: "down 14:02 → restarting 14:03 → recovering → ok 14:04". "recovering" is a passing
 * step (the lag window draining), so it carries no time. A link that has only ever had one state has no story: "".
 */
export function historySummary(history: HealthLink["history"], max = 6): string {
	if (history.length < 2) return "";
	return history
		.slice(-max)
		.map((h) => (h.status === "recovering" ? statusWord(h.status).replace(/…$/, "") : `${statusWord(h.status).replace(/…$/, "")} ${hhmm(h.at)}`))
		.join(" → ");
}

export type RestartOutcome = { kind: "issued" } | { kind: "wait"; retryS: number } | { kind: "error"; message: string };

/**
 * What a row shows after POST /api/health/restart (health-api.ts): `status` 0 = the request never reached the console.
 * 401 is the console's own (no X-Wolfpack-Hub-Auth), so it never signs the device out; it only asks for one hub-up sign-in.
 */
export function restartOutcome(status: number, retryAfter: string | null): RestartOutcome {
	if (status === 202) return { kind: "issued" };
	if (status === 429) {
		const n = Number(retryAfter);
		return { kind: "wait", retryS: Number.isFinite(n) && n > 0 ? Math.min(Math.ceil(n), 60) : 5 }; // capped: a long Retry-After must not park the row
	}
	if (status === 401) return { kind: "error", message: "Sign in with the console once while the hub is up" };
	if (status === 502) return { kind: "error", message: "systemctl refused the restart (is the console's polkit rule installed?)" };
	if (status === 400) return { kind: "error", message: "The console doesn't know this service" };
	if (status === 0) return { kind: "error", message: "Console unreachable; restart not sent" };
	return { kind: "error", message: `Restart failed (HTTP ${status})` };
}

/** How long "back" shows after a link returns to ok. */
export const BACK_MS = 10_000;

/** True when the link turned ok within BACK_MS after being anything else. */
export function isBack(l: Pick<HealthLink, "status" | "history">, now: number): boolean {
	if (l.status !== "ok" || l.history.length < 2) return false;
	const last = l.history[l.history.length - 1]!;
	return last.status === "ok" && now - Date.parse(last.at) < BACK_MS;
}

/** "just now", "42s ago", "3m ago", "2h ago", "4d ago". */
export function ageText(ms: number): string {
	if (ms < 5_000) return "just now";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

/** The sidebar bar: one dot colour and a short label. Never empty, whatever the console's own state. */
export function packSummary(o: { snapshot: HealthSnapshotView | null; reachable: boolean; lastSeenAt?: number | null; now: number }): { tone: Tone; label: string } {
	if (!o.reachable) return { tone: "red", label: o.lastSeenAt != null ? `Console unreachable · last seen ${ageText(o.now - o.lastSeenAt)}` : "Console unreachable" };
	if (!o.snapshot) return { tone: "grey", label: "Checking…" };
	const issues = o.snapshot.links.filter((l) => l.status !== "ok");
	if (issues.length === 0) {
		const back = o.snapshot.links.find((l) => isBack(l, o.now));
		return { tone: "green", label: back ? `${linkName(back)} back` : "All good" };
	}
	const tone = issues.map((l) => toneOf(l.status)).reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
	if (issues.every((l) => l.status === "recovering")) return { tone, label: issues.length === 1 ? `${linkName(issues[0]!)} recovering…` : "Recovering…" };
	if (issues.length === 1) return { tone, label: `${linkName(issues[0]!)} ${statusWord(issues[0]!.status)}` };
	return { tone, label: `${issues.length} issues` };
}
