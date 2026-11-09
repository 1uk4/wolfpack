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

/** What the console offers besides restart (src/server/pack-health.ts HealthActions; absent from older servers). */
export interface HealthActionsView {
	systemd: boolean;
	rollback: { service: string; from: string | null; to: string | null; last?: { result: string; exitStatus: number | null; at: string | null } | null }[];
}

export interface HealthSnapshotView {
	checkedAt: string | null;
	intervalMs: number;
	links: HealthLink[];
	actions?: HealthActionsView;
}

/** The Mac live stack has no systemd: these are what the owner can run by hand (scripts/stack.mjs). */
export const MAC_STACK_COMMANDS = ["pnpm stack restart", "tail -n 100 ~/wolves/local/logs/stack.log"];

/** The rollback targets, by the link that represents them (hubd; the link-only workerd unit). The console row is the modal's own. */
const ROLLBACK_LINK: Record<string, string> = { hubd: "hubd", workerd: "workerd" };

/**
 * What a row offers besides restart (work-wolfpack-yM3uTlj). Under systemd: Logs for a unit the console may restart, Roll back for hubd and
 * the workerd link unit when a previous release is kept. Off systemd (the Mac stack, or an older server without `actions`): nothing that
 * would fail, just the stack commands to copy on the workerd and wolf rows (the hub runs elsewhere).
 */
export function rowActions(
	l: Pick<HealthLink, "id" | "kind" | "restartable">,
	actions: HealthActionsView | undefined,
): { logs: boolean; rollback: { service: string; to: string | null } | null; macCommands: string[] | null } {
	if (!actions?.systemd) return { logs: false, rollback: null, macCommands: l.kind === "hubd" ? null : [...MAC_STACK_COMMANDS] };
	const svc = ROLLBACK_LINK[l.id];
	const rb = svc ? actions.rollback.find((r) => r.service === svc) : undefined;
	return { logs: l.restartable, rollback: rb && rollbackOffered(rb) ? { service: rb.service, to: rb.to } : null, macCommands: null };
}

/** The X.Y.Z core of a version as numbers, or null when it has none. */
const coreOf = (v: string | null): [number, number, number] | null => {
	const m = v ? /^(\d+)\.(\d+)\.(\d+)/.exec(v) : null;
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmpCore = (a: [number, number, number], b: [number, number, number]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Whether Roll back is offered: never when `to` is newer than `from` on the X.Y.Z core (after a rollback, `previous` is the release just
 * left, so "rolling back" would go forward). Equal cores (another build) and unknown versions stay offered.
 */
export function rollbackOffered(r: { from: string | null; to: string | null }): boolean {
	const a = coreOf(r.from);
	const b = coreOf(r.to);
	return !(a && b && cmpCore(b, a) > 0);
}

/** The confirm text: the target's X.Y.Z, with the build only when both cores are equal; says when a version is unknown. */
export function rollbackQuestion(name: string, from: string | null, to: string | null): string {
	if (!to) return `Roll ${name} back to the previous release (its version is unknown)?`;
	const a = coreOf(from);
	const b = coreOf(to);
	const shown = a && b && cmpCore(a, b) === 0 ? to : (/^\d+\.\d+\.\d+/.exec(to)?.[0] ?? to);
	return from ? `Roll ${name} back to v${shown}?` : `Roll ${name} back to v${shown} (the running version is unknown)?`;
}

/** deploy-release.sh --rollback's documented exit codes. */
const ROLLBACK_EXIT: Record<number, string> = { 1: "refused, nothing changed", 2: "usage error", 4: "needs a person" };
const RESULT_TEXT: Record<string, string> = { assert: "rollback script or previous release missing on the host", timeout: "timed out", signal: "killed", "core-dump": "crashed", "start-limit-hit": "started too often" };

/**
 * Whether a rollback sent from this page has finished, read off the rollback unit's last run (`actions.rollback[svc].last`). `sentAfter`:
 * the `last.at` seen when it was sent (null: none), so an older run never counts. null: still running (or not reported yet).
 */
export function rollbackFinished(
	last: { result: string; exitStatus: number | null; at: string | null } | null | undefined,
	sentAfter: string | null,
): { ok: true } | { ok: false; message: string } | null {
	if (!last || last.result === "running" || !last.at) return null;
	if (sentAfter !== null && Date.parse(last.at) <= Date.parse(sentAfter)) return null;
	if (last.result === "success" && last.exitStatus === 0) return { ok: true };
	const why =
		last.result === "exit-code" && last.exitStatus !== null
			? `exit ${last.exitStatus}${ROLLBACK_EXIT[last.exitStatus] ? `: ${ROLLBACK_EXIT[last.exitStatus]}` : ""}`
			: (RESULT_TEXT[last.result] ?? last.result);
	return { ok: false, message: `Rollback failed (${why}) — see Logs` };
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

const SIGN_IN = "Sign in with the console once while the hub is up";
const waitOf = (retryAfter: string | null, cap: number) => {
	const n = Number(retryAfter);
	return Number.isFinite(n) && n > 0 ? Math.min(Math.ceil(n), cap) : 5;
};

export type LogsOutcome = { kind: "lines"; lines: string[]; truncated: boolean } | { kind: "wait"; retryS: number } | { kind: "error"; message: string };

/** What the logs panel shows after GET /api/health/logs (`body` its JSON, null when unreadable; `status` 0 = never reached the console). */
export function logsOutcome(status: number, body: unknown, retryAfter: string | null): LogsOutcome {
	const b = (body ?? {}) as { lines?: unknown; truncated?: unknown; code?: unknown };
	if (status === 200 && Array.isArray(b.lines)) return { kind: "lines", lines: b.lines.filter((x): x is string => typeof x === "string"), truncated: b.truncated === true };
	if (status === 429) return { kind: "wait", retryS: waitOf(retryAfter, 60) };
	if (status === 401) return { kind: "error", message: SIGN_IN };
	if (b.code === "journal_denied") return { kind: "error", message: "The console cannot read the system journal (add its user to systemd-journal)" };
	if (b.code === "unsupported") return { kind: "error", message: "No system journal on this host" };
	if (status === 400) return { kind: "error", message: "The console doesn't know this service" };
	if (status === 0) return { kind: "error", message: "Console unreachable; logs not loaded" };
	return { kind: "error", message: `Logs failed (HTTP ${status})` };
}

/**
 * What a row shows after POST /api/health/rollback (`body` its JSON when read). A 429 can ask for up to 10 min (one rollback per service per
 * 10 min). A 409 is no_previous, or previous_is_newer when the kept release is newer than the running one.
 */
export function rollbackOutcome(status: number, retryAfter: string | null, body?: unknown): RestartOutcome {
	if (status === 202) return { kind: "issued" };
	if (status === 429) return { kind: "wait", retryS: waitOf(retryAfter, 600) };
	if (status === 401) return { kind: "error", message: SIGN_IN };
	if (status === 409 && (body as { code?: unknown } | null | undefined)?.code === "previous_is_newer") return { kind: "error", message: "The kept release is newer; deploy instead of rolling back" };
	if (status === 409) return { kind: "error", message: "No previous release is kept on this host" };
	if (status === 502) return { kind: "error", message: "systemctl refused the rollback (is the rollback unit and polkit rule installed?)" };
	if (status === 400) return { kind: "error", message: "This service can't be rolled back from here" };
	if (status === 0) return { kind: "error", message: "Console unreachable; rollback not sent" };
	return { kind: "error", message: `Rollback failed (HTTP ${status})` };
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
