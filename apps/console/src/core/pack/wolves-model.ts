/**
 * The Wolves section model (work-wolfpack-eE5FKDy). Pure, browser-safe. Keys belong to machines, never to wolves: a wolf's pickers
 * offer only the providers that have a key on ITS machine and can do the job (memory is Anthropic only for now). A wolf on the
 * Claude subscription never gets the Pack's Anthropic key, so its chat picker offers and requires none. Transport is read only.
 */
import { PROVIDERS, providersByCapability, type Capability } from "@wolfpack/protocol/providers";
import { cellOf, type CellState, type KeyMachine } from "./keys-model.ts";

export type Transport = "api" | "subscription";
export interface MachineWolf {
	name: string;
	transport: Transport;
}
export interface WolfEntry extends MachineWolf {
	hostId: string;
	machine: string;
}
export interface MachineGroup {
	hostId: string;
	machine: string;
	online: boolean;
	wolves: WolfEntry[];
}
export interface PickerModel {
	id: string;
	name: string;
	provider: string;
}
export type Picker =
	| { kind: "options"; models: PickerModel[] }
	/** The wolf runs on the Claude subscription: no Pack key is offered or needed. */
	| { kind: "subscription" }
	/** The machine has no key for the provider the wolf needs. */
	| { kind: "nokey"; provider: string }
	/** The machine is offline or can't take keys, so its keys are not known. */
	| { kind: "unknown" };

export const transportLabel = (t: Transport): string => (t === "api" ? "API key" : "Claude subscription");

/** Wolves grouped by machine, in the machines' order; a machine with no wolves is left out. */
export function groupWolves(machines: readonly KeyMachine[]): MachineGroup[] {
	return machines
		.filter((m) => (m.wolves ?? []).length > 0)
		.map((m) => ({ hostId: m.hostId, machine: m.machine, online: m.online, wolves: (m.wolves ?? []).map((w) => ({ ...w, hostId: m.hostId, machine: m.machine })) }));
}

const providerFor = (cap: Capability) => providersByCapability(cap)[0]!;

/** What this console told us about itself (keys-api `console`): relay through the hub, and the machine it runs on. */
export interface ConsoleReach {
	relay: boolean;
	machine: string;
}
export type WolfAccess = { reachable: true } | { reachable: false; note: string };

const norm = (s: string): string => s.trim().toLowerCase().replace(/\.local$/, "").split(".")[0]!;

/**
 * Can this console address the wolf by name? Relay mode: yes, the hub routes /v1/wolves/:name to the host that has it (wolf names are
 * pack-unique). Local mode: only the wolves on the machine this console runs on. Unknown console: no (never guess).
 * A wolf it cannot reach is shown read only, with the note.
 */
export function wolfAccess(c: ConsoleReach | undefined, m: KeyMachine, wolfName = "this wolf"): WolfAccess {
	if (c?.relay) return { reachable: true };
	if (c && norm(c.machine) === norm(m.machine)) return { reachable: true };
	return { reachable: false, note: `Open ${m.machine}'s console to change ${wolfName}'s models.` };
}

/** A settings answer counts only when it names the wolf that was asked for. An answer that names none is refused: never save on a guess. */
export const settingsAnswerFor = (wolf: string, answer: { name?: unknown }): boolean => answer.name === wolf;

/**
 * The catalog provider of the wolf's main (chat) tier: wolf.yaml's `models.main.provider` if it names one, else the provider the wolf
 * runs on (the settings view's `tierProviders.main`), and Anthropic only when neither says (an older wolfd that sends no tierProviders).
 * The Claude subscription (claude-stateless / claude-bridge) serves Anthropic's models.
 */
export function mainProviderOf(config: Record<string, unknown>, tierProviders: Record<string, string> | undefined): string {
	const own = ((config.models as { main?: { provider?: unknown } } | undefined)?.main?.provider as string | undefined) ?? tierProviders?.main ?? "anthropic";
	return own === "claude-stateless" || own === "claude-bridge" ? "anthropic" : own;
}

/** The provider that makes `memory.model` a no-op (the smart tier is not Anthropic-served), else undefined. Mirrors the engine's applyWolfMemoryModel. */
export function memoryIgnoredOn(tierProviders: Record<string, string> | undefined): string | undefined {
	const p = tierProviders?.smart;
	return p && p !== "anthropic" && p !== "claude-stateless" ? p : undefined;
}

/** The words for a save's outcome: the HTTP status, or "network" when the call itself failed. `body` is the parsed error body, if any. */
export function saveMessage(status: number | "network", body: { error?: string } | null, wolf: string): { ok: boolean; text: string } {
	if (status === "network") return { ok: false, text: "Couldn't save; nothing changed." };
	if (status >= 200 && status < 300) return { ok: true, text: `Saved for ${wolf} only. It takes effect when ${wolf} restarts.` };
	if (status === 409) return { ok: false, text: "This wolf's config changed since you loaded it. Reload to see the current values." };
	return { ok: false, text: body?.error ?? `Not saved (${status}).` };
}

function pickerFor(m: KeyMachine, w: MachineWolf, cap: "chat" | "memory", catalog: readonly PickerModel[], chatProvider: string): Picker {
	if (cap === "chat" && w.transport === "subscription") return { kind: "subscription" };
	// Memory is Anthropic only. Chat follows the wolf's own main provider, provided a key for it can exist on the machine.
	const id = cap === "memory" ? providerFor(cap).id : chatProvider;
	const p = PROVIDERS.find((x) => x.id === id);
	if (!p) return { kind: "nokey", provider: id };
	const cell = cellOf(m, p.slots[0]!.id, true);
	if (cell.state === "unknown") return { kind: "unknown" };
	if (cell.state === "none") return { kind: "nokey", provider: p.name };
	return { kind: "options", models: catalog.filter((x) => x.provider === p.id) };
}

/** The wolf's two pickers: chat (its own main provider's models) and memory (Anthropic). */
export function modelPickers(m: KeyMachine, w: MachineWolf, catalog: readonly PickerModel[], chatProvider = "anthropic"): { chat: Picker; memory: Picker } {
	return { chat: pickerFor(m, w, "chat", catalog, chatProvider), memory: pickerFor(m, w, "memory", catalog, chatProvider) };
}

export interface NeededKey {
	capability: "chat" | "memory";
	provider: string;
	state: CellState;
	masked?: string;
	missing: boolean;
}

/** The keys this wolf needs on its machine, with the same states as the Keys grid. */
export function keysNeeded(m: KeyMachine, w: MachineWolf): NeededKey[] {
	return (["chat", "memory"] as const).map((capability) => {
		const p = providerFor(capability);
		if (capability === "chat" && w.transport === "subscription") return { capability, provider: p.name, state: "subscription" as const, missing: false };
		const c = cellOf(m, p.slots[0]!.id, true);
		return { capability, provider: p.name, state: c.state, ...(c.masked ? { masked: c.masked } : {}), missing: c.missing };
	});
}
