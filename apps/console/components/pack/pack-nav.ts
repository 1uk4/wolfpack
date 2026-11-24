"use client";

/**
 * Opening the Pack page (work-wolfpack-oz3wvq3). The Pack is the page /pack/<section>; every opener (gear, shortcut, dictation's
 * "add a key", the health bar, a ?pack= link) calls openPackPage(section). The app shell registers the router here
 * (PackHealthHost), so plain functions like dictation's can navigate. The page you left is kept in sessionStorage
 * (`wp.pack.return`) and the page's close button goes back to it.
 */
import type { PackSectionId } from "@/src/core";

export const PACK_RETURN_KEY = "wp.pack.return";

let navigate: ((href: string) => void) | null = null;
export function setPackNavigator(fn: ((href: string) => void) | null): void {
	navigate = fn;
}

/**
 * A same-origin path (with query) or null: rejects protocol-relative ("//x"), backslashes, schemes and other origins. The only guard
 * for anything that becomes a navigation target (the stored return path, the `from` param, document.referrer).
 */
export function safeLocalPath(p: string | null | undefined): string | null {
	if (!p || !p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return null;
	try {
		const u = new URL(p, window.location.origin);
		return u.origin === window.location.origin ? u.pathname + u.search + u.hash : null;
	} catch {
		return null;
	}
}

/** Remember where to go on close, unless we are already inside the Pack (moving between sections keeps the first page). */
export function rememberPackReturn(path: string): void {
	try {
		const safe = safeLocalPath(path);
		if (!safe || safe === "/pack" || safe.startsWith("/pack/")) return;
		window.sessionStorage.setItem(PACK_RETURN_KEY, safe);
	} catch {
		// storage blocked: close falls back to "/"
	}
}

export function readPackReturn(): string {
	try {
		return safeLocalPath(window.sessionStorage.getItem(PACK_RETURN_KEY)) ?? "/";
	} catch {
		return "/";
	}
}

export function openPackPage(section: PackSectionId = "machines"): void {
	if (typeof window === "undefined") return;
	rememberPackReturn(window.location.pathname + window.location.search);
	const href = `/pack/${section}`;
	if (navigate) navigate(href);
	else window.location.assign(href);
}
