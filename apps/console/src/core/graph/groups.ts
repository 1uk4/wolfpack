/**
 * Graph groups (work-wolfpack-FnzgC6g): a VISUAL bubble around several domains, e.g. "Threadstone" containing spot.
 * Pure state and rules: the domains themselves, their parents and permissions are never touched, and a domain is in at most one
 * group (adding it to a group moves it there). The server stores the list for the whole pack (see src/store/graph-groups.ts and
 * GET/PUT /api/graph/groups); the canvas draws them (components/graph/group-regions.ts) and the layout pulls them together.
 */

export interface GraphGroup {
	id: string;
	name: string;
	/** "#rrggbb" or null (the canvas picks one). */
	color: string | null;
	/** A lucide icon name or null. */
	icon: string | null;
	/** Domain names, at most one group each. */
	domains: string[];
}

export interface GraphGroups {
	groups: GraphGroup[];
	/** Epoch ms of the last save (hub value and file each carry one: the newer wins). Absent on lists saved before this existed. */
	updatedAt?: number;
}

export const EMPTY_GROUPS: GraphGroups = { groups: [] };
export const MAX_GROUP_NAME = 40;
export const MAX_GROUPS = 24;
export const MAX_GROUP_DOMAINS = 64;

const HEX = /^#[0-9a-f]{6}$/i;

function text(v: unknown, max: number): string {
	return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** Whatever came off disk or the wire → valid groups: names trimmed and non-empty, colours checked, a domain only in the first group
 *  that lists it, duplicate ids and empty names dropped. */
export function sanitizeGroups(raw: unknown): GraphGroups {
	const list = raw && typeof raw === "object" && Array.isArray((raw as GraphGroups).groups) ? (raw as GraphGroups).groups : [];
	const seenIds = new Set<string>();
	const seenDomains = new Set<string>();
	const groups: GraphGroup[] = [];
	for (const g of list) {
		if (!g || typeof g !== "object" || groups.length >= MAX_GROUPS) continue;
		const id = text(g.id, 40);
		const name = text(g.name, MAX_GROUP_NAME);
		if (!id || !name || seenIds.has(id)) continue;
		seenIds.add(id);
		const domains: string[] = [];
		for (const d of Array.isArray(g.domains) ? g.domains : []) {
			const dn = text(d, 80);
			if (!dn || seenDomains.has(dn) || domains.length >= MAX_GROUP_DOMAINS) continue;
			seenDomains.add(dn);
			domains.push(dn);
		}
		groups.push({
			id,
			name,
			color: typeof g.color === "string" && HEX.test(g.color) ? g.color.toLowerCase() : null,
			icon: text(g.icon, 32) || null,
			domains,
		});
	}
	const at = (raw as GraphGroups | null)?.updatedAt;
	return typeof at === "number" && Number.isFinite(at) && at > 0 ? { groups, updatedAt: at } : { groups };
}

export function groupOfDomain(state: GraphGroups, domain: string): GraphGroup | null {
	return state.groups.find((g) => g.domains.includes(domain)) ?? null;
}

export interface GroupDraft {
	name: string;
	color?: string | null;
	icon?: string | null;
	domains?: string[];
}

/** Create a group. Its domains are taken from whatever group held them. */
export function createGroup(state: GraphGroups, id: string, draft: GroupDraft): GraphGroups {
	const domains = draft.domains ?? [];
	const stripped = state.groups.map((g) => ({ ...g, domains: g.domains.filter((d) => !domains.includes(d)) }));
	return sanitizeGroups({ groups: [...stripped, { id, name: draft.name, color: draft.color ?? null, icon: draft.icon ?? null, domains }] });
}

export function renameGroup(state: GraphGroups, id: string, name: string): GraphGroups {
	return sanitizeGroups({ groups: state.groups.map((g) => (g.id === id ? { ...g, name } : g)) });
}

export function updateGroup(state: GraphGroups, id: string, patch: { color?: string | null; icon?: string | null }): GraphGroups {
	return sanitizeGroups({ groups: state.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) });
}

export function deleteGroup(state: GraphGroups, id: string): GraphGroups {
	return { groups: state.groups.filter((g) => g.id !== id) };
}

/** Put a domain in a group; it leaves any other group it was in. */
export function addDomainToGroup(state: GraphGroups, id: string, domain: string): GraphGroups {
	if (!state.groups.some((g) => g.id === id)) return state;
	return sanitizeGroups({
		groups: state.groups.map((g) => {
			const rest = g.domains.filter((d) => d !== domain);
			return g.id === id ? { ...g, domains: [...rest, domain] } : { ...g, domains: rest };
		}),
	});
}

export function removeDomainFromGroup(state: GraphGroups, id: string, domain: string): GraphGroups {
	return { groups: state.groups.map((g) => (g.id === id ? { ...g, domains: g.domains.filter((d) => d !== domain) } : g)) };
}

/** Layout input: per group the node ids of all its domains (groups with no members are dropped). */
export function groupMembers(
	state: GraphGroups,
	nodes: ReadonlyArray<{ id: string; domain?: string | null }>,
): { id: string; members: string[] }[] {
	const out: { id: string; members: string[] }[] = [];
	for (const g of state.groups) {
		const set = new Set(g.domains);
		const members = nodes.filter((n) => n.domain && set.has(n.domain)).map((n) => n.id);
		if (members.length > 0) out.push({ id: g.id, members });
	}
	return out;
}
