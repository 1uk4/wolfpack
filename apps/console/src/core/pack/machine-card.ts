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

export const MAC_RESTART_HINT = "Restart isn't available on the Mac app; quit and reopen it";
export const NO_RESTART_HINT = "This machine can't restart it from here";
export type RestartKind = "wolves.restart" | "workerd.restart";
export const NO_LOG_NOTE = "This machine has no log for that service";
export const CHANNEL_READONLY_NOTE = "Change it from that machine's console";
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
	channel: { value: "stable" | "main" | null; editable: boolean; note?: string; /** Shown instead of "unknown" when the inventory could not be read. */ missing?: string };
}

const UNREAD = { unavailable: "reports unavailable", "signed-out": "sign in on this device first" } as const;
const LABEL = { console: "Console", hubd: "Hub", wolfd: "Wolf runtime", workerd: "Background service" } as const;
const ORDER = ["console", "hubd", "wolfd", "workerd"] as const;
const RANK: Record<Tone, number> = { green: 0, grey: 1, amber: 2, red: 3 };

const RESTART_OF: Partial<Record<MachineServiceView["kind"], RestartKind>> = { wolfd: "wolves.restart", workerd: "workerd.restart" };

/** `ownChannel`: this console's own machine channel (null when unknown or not asked). Only used on the console's own card. */
export function machineCard(card: HostCard, ownChannel: "stable" | "main" | null): MachineCardView {
	const own = card.console && ownChannel ? { channel: ownChannel, latest: {}, consoleVersion: null, self: card.self ?? null } : null;
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
		if (kind === "wolfd") v.count = rs.length;
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
	const value = card.console ? ownChannel : fromInv;
	const editable = card.console && ownChannel !== null;
	const missing = value === null && card.inventoryState && card.inventoryState !== "ok" ? UNREAD[card.inventoryState] : undefined;
	return {
		id: card.id,
		label: card.label,
		online,
		services,
		channel: { value, editable, ...(editable ? {} : { note: CHANNEL_READONLY_NOTE }), ...(missing ? { missing } : {}) },
	};
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
