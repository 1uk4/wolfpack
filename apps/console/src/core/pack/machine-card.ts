/**
 * The Machines section's card rules (work-wolfpack-4qae7Hg). Pure.
 *   - one card per machine: online/offline, four services (Console, Hub, Wolf runtime, Background service) with version and status,
 *     the services that are down (with the log service to fetch), and the machine's update channel.
 *   - Restart is per DOWN service, and only when the machine advertised the command (HostCard.commands, from the hub's /healthz):
 *     Wolf runtime → `wolves.restart`, Background service → `workerd.restart`; never the hub, never a running service. A down service
 *     whose command is not advertised gets a hint instead: the Mac app (pack-map fact) is told to quit and reopen it. The hub's
 *     `not_sent_unsupported` answer stays as the fallback.
 *   - the channel lives in each machine's own subscription file: editable only on this console's own machine, read-only elsewhere.
 *   - log lines are shown exactly as the machine sent them.
 */
import type { CommandResult } from "./machine-commands.ts";
import { machineServices, toneOf, type HealthStatus, type Tone } from "./pack-health-view.ts";
import type { HostCard } from "./pack-hosts.ts";
import type { UpdateState } from "@wolfpack/protocol/update-state";

export const MAC_RESTART_HINT = "Restart isn't available on the Mac app; quit and reopen it";
export const NO_RESTART_HINT = "This machine can't restart it from here";
export type RestartKind = "wolves.restart" | "workerd.restart";
export const NO_LOG_NOTE = "This machine has no log for that service";
export const CHANNEL_READONLY_NOTE = "Change it from that machine's console";
export const SINGLE_MAC_CHANNEL_NOTE = "App updates are set in Settings → This device";
export const OWN_SETTINGS_UNREADABLE_NOTE = "Couldn't read this machine's update settings";
export const UPDATE_READONLY_NOTE = "Update it from that machine's console";

export interface MachineServiceView {
	kind: "console" | "hubd" | "wolfd" | "workerd";
	label: string;
	status: HealthStatus;
	tone: Tone;
	version: string | null;
	/** Why `version` is empty when the inventory could not be read; absent when it was read (then "version unknown" is honest). */
	versionNote?: string;
	down: boolean;
	/** `logs.fetch` service name for a down service (hubd, workerd, console, or the first down wolf's name). */
	logService?: string;
	/** Wolf runtime: how many wolves. */
	count?: number;
	/** Wolf runtime: one entry per wolf, sorted by name, with its own status and version (`versionNote`: why the version is empty when the inventory could not be read). */
	wolves?: { name: string; status: HealthStatus; tone: Tone; version: string | null; versionNote?: string }[];
	/** A down service the machine advertised a restart for. */
	restart?: RestartKind;
	/** A down service the machine cannot restart from here: why. */
	hint?: string;
}
export interface MachineCardView {
	id: string;
	label: string;
	online: boolean;
	services: MachineServiceView[];
	channel: { value: "stable" | "main" | null; editable: boolean; note?: string; /** The console machine's update mode; own card only. */ mode?: "manual" | "auto" | "off"; /** Shown instead of "unknown" when the inventory could not be read. */ missing?: string };
	/** The update block: the pack's (banner, channel, Check now) or, in single-Mac on this Mac's card, the app's own updater block; none on other cards in single-Mac. */
	update?: { kind: "pack"; /** Another machine only: it advertised update.run, so Update and Retry can be sent to it. */ canRun?: true; /** Another machine only: a component is behind the channel's release. */ behind?: true; /** Another machine only: what is available, worded like the sidebar notice ("hubd 0.1.25 is available", "2 updates available"). */ availableText?: string; /** Another machine only: its updater is failed or installing, as its workerd reported. */ hostState?: UpdateState } | { kind: "app"; version: string | null };
}

/** The button text once the app has downloaded an update, or null when none is staged. */
/** The one inline line after Check now: the app's note on success (else "up to date"), its plain error on failure. No native dialog: the block is the answer. */
export const appCheckNote = (r: { ok: boolean; error?: string; note?: string }): { text: string; tone: "ok" | "error" } =>
	r.ok ? { text: r.note ?? "You're up to date.", tone: "ok" } : { text: r.error ?? "Couldn't check for updates", tone: "error" };

export const appRestartLabel = (version: string | null | undefined): string | null => (version ? `Restart to update to v${version}` : null);

/** The text next to a service: "v1.2.3", the reason it could not be read, or nothing when the version is simply unknown. */
export const versionText = (version: string | null, note: string | undefined): string => (version ? `v${version}` : (note ?? ""));

const UNREAD = { unavailable: "reports unavailable", "signed-out": "sign in on this device first", loading: "loading…" } as const;
const LABEL = { console: "Console", hubd: "Hub", wolfd: "Wolf runtime", workerd: "Background service" } as const;
const ORDER = ["console", "hubd", "wolfd", "workerd"] as const;
const RANK: Record<Tone, number> = { green: 0, grey: 1, amber: 2, red: 3 };

const RESTART_OF: Partial<Record<MachineServiceView["kind"], RestartKind>> = { wolfd: "wolves.restart", workerd: "workerd.restart" };

/** `ownChannel`: this console's own machine channel (null when unknown or not asked). Only used on the console's own card. */
export const MODE_LABEL = { button: "manual", auto: "auto", off: "off" } as const;

/**
 * `opts.mode`: the console machine's update mode (null/"unknown": the default, manual). `opts.readFailed`: the own subscription read failed.
 * On the own card a missing channel is the default "stable", never "unknown".
 */
export function machineCard(card: HostCard, ownChannel: "stable" | "main" | null, opts: { singleMac?: boolean; mode?: "off" | "button" | "auto" | "unknown" | null; readFailed?: boolean } = {}): MachineCardView {
	const singleMac = opts.singleMac ?? false;
	const ownMode = opts.mode ?? null;
	const ownReadFailed = opts.readFailed ?? false;
	// The console's own entry (its version, uptime, lag) comes with the snapshot and needs no channel: the single-Mac app never asks for one.
	const own = card.console && (ownChannel || card.self) ? { channel: ownChannel ?? card.self?.channel ?? null, latest: {}, consoleVersion: null, self: card.self ?? null } : null;
	const rows = machineServices(card, card.inventory, own);
	const flat = rows.flatMap((r) => [r, ...r.children]);
	const services: MachineServiceView[] = [];
	for (const kind of ORDER) {
		const rs = flat.filter((r) => r.kind === kind && !r.noReport);
		if (rs.length === 0) continue;
		const worst = rs.reduce((a, r) => (RANK[toneOf(r.status)] > RANK[toneOf(a.status)] ? r : a));
		const downs = rs.filter((r) => toneOf(r.status) === "red");
		const v: MachineServiceView = { kind, label: LABEL[kind], status: worst.status, tone: toneOf(worst.status), version: rs.find((r) => r.version)?.version ?? null, down: downs.length > 0 };
		const unread = card.inventoryState && card.inventoryState !== "ok" ? UNREAD[card.inventoryState] : undefined;
		if (!v.version && unread) v.versionNote = unread;
		if (kind === "wolfd") {
			v.count = rs.length;
			v.wolves = [...rs]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((r) => ({ name: r.name, status: r.status, tone: toneOf(r.status), version: r.version, ...(!r.version && unread ? { versionNote: unread } : {}) }));
		}
		// workerd's logs.fetch reads wolf logs anywhere, but console / hubd / workerd only from systemd units (Linux): never ask the Mac for those.
		const canLog = !!card.hubId && !!card.commands?.includes("logs.fetch") && (kind === "wolfd" || card.facts?.host !== "Mac");
		if (downs.length > 0 && canLog) v.logService = kind === "wolfd" ? downs[0]!.name : kind;
		services.push(v);
	}
	const links = flat.map((r) => r.link).filter((l) => l !== null);
	const gone = (s: HealthStatus, e: string | null) => s === "down" || e === "host_asleep" || e === "host_offline";
	const online = card.checked && links.length > 0 && !links.every((l) => gone(l.status, l.error));
	if (online) {
		for (const s of services) {
			const kind = RESTART_OF[s.kind];
			if (!s.down || !kind || !card.hubId) continue;
			if (card.commands?.includes(kind)) s.restart = kind;
			else s.hint = s.kind === "workerd" && card.facts?.host === "Mac" ? MAC_RESTART_HINT : NO_RESTART_HINT;
		}
	}
	const fromInv = card.inventory.find((e) => e.channel)?.channel ?? null;
	const value = card.console ? (ownChannel ?? card.self?.channel ?? "stable") : fromInv;
	// The own card is never read-only: while the subscription is pending (or failed) the picker shows disabled, and a failed read says so.
	// In the Mac app the channel is a derived read-only badge (the app has no pack updater); its updates live in Settings.
	const editable = card.console && !singleMac;
	const note = singleMac && card.console ? SINGLE_MAC_CHANNEL_NOTE : card.console ? (ownReadFailed && ownChannel === null ? OWN_SETTINGS_UNREADABLE_NOTE : undefined) : CHANNEL_READONLY_NOTE;
	const missing = value === null && card.inventoryState && card.inventoryState !== "ok" ? UNREAD[card.inventoryState] : undefined;
	return {
		id: card.id,
		label: card.label,
		online,
		services,
		channel: { value, editable, ...(note ? { note } : {}), ...(missing ? { missing } : {}), ...(card.console ? { mode: MODE_LABEL[ownMode === "off" || ownMode === "auto" ? ownMode : "button"] } : {}) },
		...(singleMac ? (card.console ? { update: { kind: "app" as const, version: services.find((s) => s.version)?.version ?? null } } : {}) : { update: card.console ? { kind: "pack" as const } : remoteUpdate(card) }),
	};
}

/** The update block of another machine's card: what its workerd reported, whether a component is behind, and whether update.run can be sent. */
function remoteUpdate(card: HostCard): { kind: "pack"; canRun?: true; behind?: true; availableText?: string; hostState?: UpdateState } {
	const hostState = card.inventory.find((e) => e.kind === "workerd" && e.updateState)?.updateState;
	const behind = card.inventory.filter((e) => e.latest);
	const availableText = behind.length > 1 ? `${behind.length} updates available` : behind.length === 1 ? `${behind[0]!.kind}${behind[0]!.latest ? ` ${behind[0]!.latest}` : ""} is available` : hostState?.latest ? `${hostState.latest} is available` : undefined;
	return { kind: "pack", ...(availableText ? { availableText } : {}), ...(card.hubId && card.commands?.includes("update.run") ? { canRun: true as const } : {}), ...(card.inventory.some((e) => e.latest) ? { behind: true as const } : {}), ...(hostState ? { hostState } : {}) };
}

/** One line for the result of an update.run: started, or the reason it was not (a timeout means the outcome is unknown: the owner decides). */
export function updateRunSummary(r: CommandResult): string {
	if (r.ok) return "Update started";
	if (r.code === "timeout") return "Update sent; it may take a few minutes.";
	if (r.code === "update_busy") return "An update is already running on that machine";
	if (r.code === "not_sent_offline") return "The machine is offline; nothing was sent";
	if (r.code === "not_sent_unsupported") return "That machine cannot update from here yet";
	return r.message ?? "Update failed to start";
}

/** One line for the result of a restart: the hub's own words win; a machine that refuses gets `unsupportedHint`. */
export function restartSummary(r: CommandResult, unsupportedHint: string = NO_RESTART_HINT): string {
	if (!r.ok) {
		if (r.code === "not_sent_unsupported") return unsupportedHint;
		if (r.code === "not_sent_offline") return "The machine is offline; nothing was sent";
		if (r.code === "timeout") return "No answer in time; the outcome is unknown";
		return r.message ?? "Restart failed";
	}
	return r.message ?? "Restart sent";
}

/** The log lines of a `logs.fetch` result, untouched; a failure becomes its message. */
export function logLines(r: CommandResult): { lines: string[]; error: string | null } {
	if (!r.ok) {
		if (r.code === "not_sent_unsupported" || r.code === "unknown_service") return { lines: [], error: NO_LOG_NOTE };
		return { lines: [], error: r.message ?? "Could not fetch the log" };
	}
	const lines = (r.data as { lines?: unknown } | null | undefined)?.lines;
	return { lines: Array.isArray(lines) ? lines.filter((l): l is string => typeof l === "string") : [], error: null };
}
