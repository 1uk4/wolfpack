/**
 * Wolf page paths (work-wolfpack-iafGCfG): /pack/wolves/<hostId>/<name>[/<tab>]. The tab defaults to models (no segment).
 * Old links (?wolf=<hostId>/<name>&wolfTab=<tab>, wolfTab=overview meaning models) and a ?view=prompt:<id> on a non-prompts path
 * are redirected by wolfRedirect to the honest path; every other query param is kept. Pure.
 */
export const WOLF_TABS = ["appearance", "models", "behaviour", "access", "yaml", "prompts"] as const;
export type WolfTabId = (typeof WOLF_TABS)[number];
export interface WolfPath { hostId: string; name: string; tab: WolfTabId }
export const DEFAULT_WOLF_TAB: WolfTabId = "models";

const asTab = (raw: string | null | undefined): WolfTabId => {
	if (raw === "overview") return DEFAULT_WOLF_TAB;
	return WOLF_TABS.find((t) => t === raw) ?? DEFAULT_WOLF_TAB;
};
const dec = (s: string): string => {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
};

export function parseWolfPath(pathname: string): WolfPath | null {
	const seg = pathname.split("/").filter(Boolean);
	if (seg[0] !== "pack" || seg[1] !== "wolves" || !seg[2] || !seg[3]) return null;
	return { hostId: dec(seg[2]), name: dec(seg[3]), tab: asTab(seg[4]) };
}

export function wolfPath(hostId: string, name: string, tab?: string): string {
	const t = asTab(tab);
	const base = `/pack/wolves/${encodeURIComponent(hostId)}/${encodeURIComponent(name)}`;
	return t === DEFAULT_WOLF_TAB ? base : `${base}/${t}`;
}

/** The new location for an old-style or view-forced URL, or null when the URL is already right. */
export function wolfRedirect(pathname: string, search: string): string | null {
	const q = new URLSearchParams(search);
	const withQuery = (path: string, drop: string[]) => {
		for (const k of drop) q.delete(k);
		const qs = q.toString();
		return qs ? `${path}?${qs}` : path;
	};
	const cur = parseWolfPath(pathname);
	if (cur) {
		if (!(q.get("view") ?? "").startsWith("prompt:") || cur.tab === "prompts") return null;
		return withQuery(wolfPath(cur.hostId, cur.name, "prompts"), []);
	}
	if (pathname !== "/pack/wolves") return null;
	const raw = q.get("wolf") ?? "";
	const cut = raw.indexOf("/");
	if (cut <= 0 || cut === raw.length - 1) return null;
	const tab = (q.get("view") ?? "").startsWith("prompt:") ? "prompts" : q.get("wolfTab");
	return withQuery(wolfPath(raw.slice(0, cut), raw.slice(cut + 1), tab ?? undefined), ["wolf", "wolfTab"]);
}
