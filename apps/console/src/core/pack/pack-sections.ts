/**
 * The Pack panel's sections (work-wolfpack-bq9iYp3): the menu order, labels and badges. Pure.
 * HOW A SECTION PLUGS IN: its entry is here (id, label, `badge`), its body is in components/pack/pack-section-bodies.tsx
 * (a Record keyed by PackSectionId, so the typecheck names any section left without one). Problems show as badges only.
 */
import { groupByHost, type HostCard } from "./pack-hosts.ts";
import { packSummary, toneOf, type HealthLink, type HealthSnapshotView, type Tone } from "./pack-health-view.ts";

export type PackSectionId = "machines" | "devices" | "wolves" | "domains" | "keys" | "this-device";

/** What a section badge needs: the shared health snapshot, plus whatever later sections add (devices, keys). */
export interface PackBadgeContext {
	snapshot: HealthSnapshotView | null;
	reachable: boolean;
	now: number;
}
export interface PackBadge {
	count: number;
	tone: Tone;
}
export interface PackSectionDef {
	id: PackSectionId;
	label: string;
	/** null: nothing to flag. */
	badge: (ctx: PackBadgeContext) => PackBadge | null;
	/**
	 * Optional: a hook for badge data this section fetches itself (Devices, Keys counts). It runs on every render of the panel, in the
	 * registry's fixed order. When present it wins over `badge`; health-based sections just use `badge`.
	 */
	useBadge?: () => PackBadge | null;
}

const none = () => null;
const RANK: Record<Tone, number> = { grey: 0, green: 0, amber: 1, red: 2 };

/** A link that is a problem: not ok, except a sleeping host and rows the hub reported before it stopped answering (as packSummary). */
export const isProblem = (l: HealthLink): boolean => l.status !== "ok" && l.error !== "host_asleep" && l.error !== "hub_stale";
const worst = (ls: HealthLink[]): Tone => ls.map((l) => toneOf(l.status)).reduce<Tone>((a, t) => (RANK[t] > RANK[a] ? t : a), "grey");
const badgeOf = (ls: HealthLink[]): PackBadge | null => (ls.length ? { count: ls.length, tone: worst(ls) } : null);

export const cardLinks = (c: HostCard): HealthLink[] => [...(c.hub ? [c.hub] : []), ...c.workerds.flatMap((w) => [w.link, ...w.wolves]), ...c.wolves];

/** The machines with a problem: one badge unit per machine, however many of its links are down. */
function machinesBadge(ctx: PackBadgeContext): PackBadge | null {
	if (!ctx.snapshot) return null;
	const bad = groupByHost(ctx.snapshot).map((c) => cardLinks(c).filter(isProblem)).filter((ls) => ls.length);
	return bad.length ? { count: bad.length, tone: worst(bad.flat()) } : null;
}

export const PACK_SECTIONS: readonly PackSectionDef[] = [
	{ id: "machines", label: "Machines", badge: machinesBadge },
	{ id: "devices", label: "Devices", badge: none },
	// A wolfd problem counts under both Wolves and Machines on purpose: the wolf is the thing, its machine is where to look.
	{ id: "wolves", label: "Wolves", badge: (ctx) => badgeOf((ctx.snapshot?.links ?? []).filter((l) => l.kind === "wolfd" && isProblem(l))) },
	{ id: "domains", label: "Domains", badge: none },
	{ id: "keys", label: "Keys", badge: none },
	{ id: "this-device", label: "This device", badge: none },
];

export function sectionBadges(ctx: PackBadgeContext): Record<PackSectionId, PackBadge | null> {
	return Object.fromEntries(PACK_SECTIONS.map((s) => [s.id, s.badge(ctx)])) as Record<PackSectionId, PackBadge | null>;
}

/** A section id from a URL or a stray string; anything unknown opens on Machines. */
export function parsePackSection(raw: string | null | undefined): PackSectionId {
	return PACK_SECTIONS.find((s) => s.id === raw)?.id ?? "machines";
}

/** `?pack=<section>` from a page URL's query: null when absent (the Pack stays closed), else the parsed section (unknown means Machines). */
export function packSectionFromSearch(search: string): PackSectionId | null {
	const raw = new URLSearchParams(search).get("pack");
	return raw === null ? null : parsePackSection(raw);
}

/**
 * The sidebar Settings entry's line: "All good", "N need attention" (N counts machines, the Machines badge's unit), or
 * "<machine> offline" / "A and B offline" / "N machines offline" (every problem machine has all its links down, all real problems).
 * The unreachable and still-checking states are packSummary's. It needs health only; other sections' data (devices, keys) is
 * not in it yet, so the entry does not reflect their badges.
 */
export function packEntrySummary(o: PackBadgeContext & { lastSeenAt?: number | null }): { tone: Tone; label: string } {
	const base = packSummary(o);
	if (!o.reachable || !o.snapshot) return base;
	const bad = groupByHost(o.snapshot).map((c) => ({ c, ls: cardLinks(c) })).filter((m) => m.ls.some(isProblem));
	if (bad.length === 0) return { tone: base.tone, label: "All good" };
	const tone = worst(bad.flatMap((m) => m.ls.filter(isProblem)));
	if (bad.every((m) => m.ls.every((l) => l.status === "down" && isProblem(l)))) {
		const names = bad.map((m) => m.c.label);
		return { tone: "red", label: names.length === 1 ? `${names[0]} offline` : names.length === 2 ? `${names[0]} and ${names[1]} offline` : `${names.length} machines offline` };
	}
	return { tone, label: bad.length === 1 ? "1 needs attention" : `${bad.length} need attention` };
}
