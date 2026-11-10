/**
 * Pack health BY HOST (work-wolfpack-w7RPvtd): which machine each link runs on, and the modal's one card per host.
 * Pure; the server (src/server/pack-health.ts) uses hostId/hostLabel to resolve a link's host, the modal uses groupByHost.
 *
 * Host ids: lowercase, a trailing `.local` and any domain suffix dropped ("Luka-Air.local" → "luka-air",
 * "sfo-01.tail9c2.ts.net" → "sfo-01"). An IP stays as is: a raw tailnet IP shows until a newer build reports its name
 * (no IPs are hard-coded anywhere; WOLFPACK_HEALTH_HOST_LABELS can name one). Dropping the domain assumes short names are unique
 * within the one tailnet (MagicDNS names hosts by their short name).
 * Map facts (pack-map.ts), by EXACT match only ("sfo-010" is not sfo-01):
 *   - a host whose id or label is a map host's name (normalised) gets that map host's facts; this console's host on darwin (or a
 *     host labelled "Mac") gets the Mac's.
 *   - THE HUB RULE: the card carrying the hubd link, when it matches no map host by name (an older hubd seen by tailnet IP, with
 *     no `host` yet), is the map host that runs hubd: its links move to that host's card (label and facts with them).
 * A map host no live link runs on still gets a card with its facts, marked not checked from here.
 */
import type { HealthLink, HealthSnapshotView } from "./pack-health-view.ts";
import { PACK_MAP, type PackMapHost } from "./pack-map.ts";

export interface HostInfo {
	id: string;
	label: string;
	isThisConsole: boolean;
	/** process.platform, on this console's own entry only. */
	platform?: string;
	/** The hub's id for this host, when the hub's /healthz lists it. */
	hubId?: string;
}

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** The normalised host id of a hostname or address. */
export function hostId(name: string): string {
	const s = name.trim().toLowerCase().replace(/\.$/, "").replace(/\.local$/, "");
	if (IP_RE.test(s) || s.includes(":")) return s; // IPv4 / IPv6: no domain to strip
	return s.split(".")[0] || s;
}

/** `WOLFPACK_HEALTH_HOST_LABELS="<host>=<label>,..."` as host id → label (bad entries skipped). */
export function parseHostLabels(raw: string | undefined): Map<string, string> {
	const out = new Map<string, string>();
	for (const part of (raw ?? "").split(",")) {
		const i = part.indexOf("=");
		if (i <= 0) continue;
		const id = hostId(part.slice(0, i));
		const label = part.slice(i + 1).trim().slice(0, 40);
		if (id && label) out.set(id, label);
	}
	return out;
}

/** The map host named exactly `name` (normalised as a host id), or null. */
const mapByName = (name: string): PackMapHost | null => PACK_MAP.find((h) => hostId(h.host) === hostId(name)) ?? null;
const mapHost = (name: string): PackMapHost | null => PACK_MAP.find((h) => h.host === name) ?? null;
/** The map host that runs hubd (pack-map.ts services). */
const hubMapHost = (): PackMapHost | null => PACK_MAP.find((h) => h.services.some((s) => s.name === "hubd")) ?? null;

/** The friendly name of a host: an override, else a map host's name when the id is exactly it, else "Mac" for this console on darwin, else the id. */
export function hostLabel(id: string, o: { isThisConsole: boolean; platform?: string }, overrides: Map<string, string> = new Map()): string {
	const set = overrides.get(id);
	if (set) return set;
	const m = mapByName(id);
	if (m && m.host !== "Mac") return m.host;
	if (o.isThisConsole && o.platform === "darwin") return "Mac";
	return id;
}

/** The pack-map facts for a host card, or null (exact names only, see the header). */
function factsFor(h: HostInfo): PackMapHost | null {
	if ((h.isThisConsole && h.platform === "darwin") || h.label.toLowerCase() === "mac") return mapHost("Mac");
	return mapByName(h.id) ?? mapByName(h.label);
}

export interface HostCard {
	id: string;
	label: string;
	/** Some link on this host is probed from here (or this console runs here). False: map facts only. */
	checked: boolean;
	/** This console runs on this host. */
	console: boolean;
	facts: PackMapHost | null;
	hub: HealthLink | null;
	/** Each workerd unit with the wolves it runs, in snapshot order. */
	workerds: { link: HealthLink; wolves: HealthLink[] }[];
	/** Wolves on this host not under a workerd shown here (probed directly). */
	wolves: HealthLink[];
}

const CONSOLE_FALLBACK: HostInfo = { id: "this-console", label: "This console", isThisConsole: true };

/**
 * One card per host, ordered: this console's host, then the hub's host, then the others by label; map-only cards last by label.
 * A link without `host` (an older console server) goes to this console's card.
 */
export function groupByHost(snapshot: HealthSnapshotView): HostCard[] {
	const hosts = new Map<string, HostInfo>((snapshot.hosts ?? []).map((h) => [h.id, h]));
	const self = [...hosts.values()].find((h) => h.isThisConsole) ?? CONSOLE_FALLBACK;
	hosts.set(self.id, self);
	const cards = new Map<string, HostCard>();
	const card = (id: string): HostCard => {
		let c = cards.get(id);
		if (!c) {
			const h = hosts.get(id) ?? { id, label: id, isThisConsole: false };
			c = { id, label: h.label, checked: true, console: h.isThisConsole, facts: factsFor(h), hub: null, workerds: [], wolves: [] };
			cards.set(id, c);
		}
		return c;
	};
	card(self.id);
	const links = snapshot.links.filter((l) => l.kind === "hubd" || l.kind === "workerd" || l.kind === "wolfd" || l.kind === "hublink");
	// THE HUB RULE (header): the hub's host with no map name is the map host that runs hubd.
	const alias = new Map<string, string>();
	const hubLink = links.find((l) => l.kind === "hubd");
	const runsHub = hubMapHost();
	if (hubLink && runsHub) {
		const at = hubLink.host ?? self.id;
		const info = hosts.get(at) ?? { id: at, label: at, isThisConsole: false };
		if (!factsFor(info) && !info.isThisConsole) {
			const target = [...hosts.values()].find((h) => factsFor(h) === runsHub)?.id ?? hostId(runsHub.host);
			if (!hosts.has(target)) hosts.set(target, { id: target, label: runsHub.host, isThisConsole: false });
			alias.set(at, target);
		}
	}
	const hostOf = (l: HealthLink) => {
		const h = l.host ?? self.id;
		return alias.get(h) ?? h;
	};
	for (const l of links) {
		if (l.kind === "hubd") card(hostOf(l)).hub = l;
		else if (l.kind === "workerd" || l.kind === "hublink") card(hostOf(l)).workerds.push({ link: l, wolves: [] });
	}
	for (const l of links) {
		if (l.kind !== "wolfd") continue;
		const c = card(hostOf(l));
		const under = l.via ? c.workerds.find((w) => w.link.id === l.via) : undefined;
		(under ? under.wolves : c.wolves).push(l);
	}
	const hubHost = links.find((l) => l.kind === "hubd");
	const rank = (c: HostCard) => (c.console ? 0 : hubHost && c.id === hostOf(hubHost) ? 1 : 2);
	const live = [...cards.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
	const used = new Set(live.map((c) => c.facts?.host));
	const mapOnly: HostCard[] = PACK_MAP.filter((h) => !used.has(h.host))
		.map((h) => ({ id: h.host.toLowerCase(), label: h.host, checked: false, console: false, facts: h, hub: null, workerds: [], wolves: [] }))
		.sort((a, b) => a.label.localeCompare(b.label));
	return [...live, ...mapOnly];
}
