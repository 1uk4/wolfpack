/**
 * The ?pack= redirect target (work-wolfpack-oz3wvq3). A page URL with `?pack=<section>` goes to /pack/<section>, keeping wolf, wolfTab and
 * view (wolf links become wolf paths) and carrying the page it came from, without the Pack params, in `from` so the Pack's close button can
 * return there. Only app pages are redirected: not the API, the Pack itself, /pair, framework paths or static assets. Pure; proxy.ts calls it.
 */
import { packSectionFromSearch } from "./pack-sections.ts";
import { wolfRedirect } from "./wolf-path.ts";

const PACK_PARAMS = ["pack", "wolf", "wolfTab", "view"];

/** A page that renders the app shell: not an API route, the Pack, the pairing page, a framework path, or a file with an extension. */
function isShellPath(path: string): boolean {
	if (path.startsWith("/api/") || path === "/pack" || path.startsWith("/pack/")) return false;
	if (path === "/pair" || path.startsWith("/pair/") || path.startsWith("/_next/")) return false;
	return !/\.[A-Za-z0-9]+$/.test(path);
}

export function packRedirectTarget(pathname: string, search: string): string | null {
	if (!isShellPath(pathname)) return null;
	const section = packSectionFromSearch(search);
	if (section === null) return null;
	const src = new URLSearchParams(search);
	const keep = new URLSearchParams();
	for (const k of ["wolf", "wolfTab", "view"]) {
		const v = src.get(k);
		if (v !== null) keep.set(k, v);
	}
	const rest = new URLSearchParams(src);
	for (const k of PACK_PARAMS) rest.delete(k);
	const restQs = rest.toString();
	const base = (section === "wolves" ? wolfRedirect("/pack/wolves", keep.toString()) : null) ?? `/pack/${section}${keep.size ? `?${keep.toString()}` : ""}`;
	const from = new URLSearchParams({ from: pathname + (restQs ? `?${restQs}` : "") });
	return `${base}${base.includes("?") ? "&" : "?"}${from.toString()}`;
}
