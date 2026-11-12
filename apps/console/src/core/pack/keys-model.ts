/**
 * The Keys grid model (work-wolfpack-6EmU8pu). Pure, browser-safe: no network, no key values (masks only).
 * One row per provider, one column per machine, grouped under Chat, Dictation and Memory. A provider that does two things
 * appears in both groups. Only providers in use or holding a key are shown; the rest are offered by "+ Add a provider key".
 */
import { CAPABILITIES, PROVIDERS, providersByCapability, type Capability } from "@wolfpack/protocol/providers";

export interface SlotPresence {
	slot: string;
	present: boolean;
	masked?: string;
	source?: "pack" | "env";
	shadowsEnv?: boolean;
}
export interface KeyMachine {
	hostId: string;
	machine: string;
	online: boolean;
	/** The machine can run key.set (advertised) and the hub holds its public key. */
	canSetKeys: boolean;
	/** True when the machine serves a console (needs dictation). */
	servesConsole?: boolean;
	/** Wolves on this machine that are mid-reply right now (restarting would cut them off). Not reported by workerd yet; fixtures only. */
	midReply?: string[];
	/** The machine's wolves with the transport each reports (inventory). Absent or empty = unknown, treated as needing the key. */
	wolves?: { name: string; transport: "api" | "subscription" }[];
	pubkey?: string;
	fingerprint?: string;
	keyChanged?: boolean;
	slots: SlotPresence[];
}
/** "unknown": the machine can't take keys or is offline, so nothing is known (or asked) about its keys. */
export type CellState = "none" | "pack" | "env" | "shadowed" | "unknown" | "subscription";
export interface Cell {
	hostId: string;
	state: CellState;
	masked?: string;
	/** "Set here; the machine's environment also has one, and this one is used." */
	note?: string;
	/** A needed key that is absent. */
	missing: boolean;
}
export interface GridRow {
	providerId: string;
	name: string;
	slot: string;
	cells: Cell[];
}
export interface GridGroup {
	capability: Capability;
	label: string;
	rows: GridRow[];
}

export const CAPABILITY_LABEL: Record<Capability, string> = { chat: "Chat", dictation: "Dictation", memory: "Memory" };

/** Names of the machine's wolves that run on an API key: the only ones the Anthropic key reaches or restarts. */
export const apiWolves = (m: KeyMachine): string[] => (m.wolves ?? []).filter((w) => w.transport === "api").map((w) => w.name);

/** Every wolf on the machine is on the Claude subscription: its Chat row needs no Anthropic key. */
const allSubscription = (m: KeyMachine): boolean => !!m.wolves && m.wolves.length > 0 && m.wolves.every((w) => w.transport === "subscription");

export function cellOf(m: KeyMachine, slot: string, needed: boolean, capability?: Capability): Cell {
	if (!m.canSetKeys || !m.online) return { hostId: m.hostId, state: "unknown", missing: false };
	if (capability === "chat" && slot === "anthropic" && allSubscription(m)) return { hostId: m.hostId, state: "subscription", missing: false };
	const s = m.slots.find((x) => x.slot === slot);
	if (!s || !s.present) return { hostId: m.hostId, state: "none", missing: needed };
	if (s.source === "pack" && s.shadowsEnv) return { hostId: m.hostId, state: "shadowed", masked: s.masked, note: "The Pack's key is used; this machine's environment also sets one.", missing: false };
	return { hostId: m.hostId, state: s.source === "env" ? "env" : "pack", masked: s.masked, missing: false };
}

/** Dictation is needed on any machine that serves a console; chat and memory on every machine that runs wolves (all listed here). */
const neededOn = (cap: Capability, m: KeyMachine): boolean => (cap === "dictation" ? !!m.servesConsole : true);

export function buildGrid(machines: readonly KeyMachine[]): GridGroup[] {
	const hasAny = (slot: string) => machines.some((m) => m.slots.some((s) => s.slot === slot && s.present));
	return CAPABILITIES.map((cap) => ({
		capability: cap,
		label: CAPABILITY_LABEL[cap],
		rows: providersByCapability(cap)
			.flatMap((p) => p.slots.map((s) => ({ p, slot: s.id })))
			// In use = some machine has a key, or one that needs this capability has none (so the gap is visible).
			.filter(({ slot }) => hasAny(slot) || (cap !== "dictation" && machines.length > 0) || machines.some((m) => neededOn(cap, m)))
			.map(({ p, slot }) => ({ providerId: p.id, name: p.name, slot, cells: machines.map((m) => cellOf(m, slot, neededOn(cap, m), cap)) })),
	})).filter((g) => g.rows.length > 0);
}

/** Providers the picker offers for adding: those with no row in any group yet, grouped by capability. */
export function pickerOptions(grid: readonly GridGroup[]): { capability: Capability; label: string; providers: { id: string; name: string; slot: string }[] }[] {
	const shown = new Set(grid.flatMap((g) => g.rows.map((r) => r.slot)));
	return CAPABILITIES.map((cap) => ({
		capability: cap,
		label: CAPABILITY_LABEL[cap],
		providers: providersByCapability(cap).flatMap((p) => p.slots.filter((s) => !shown.has(s.id)).map((s) => ({ id: p.id, name: p.name, slot: s.id }))),
	})).filter((g) => g.providers.length > 0);
}

export const knownSlots = (): string[] => PROVIDERS.flatMap((p) => p.slots.map((s) => s.id));
