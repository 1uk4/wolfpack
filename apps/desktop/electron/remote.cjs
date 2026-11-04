/**
 * Remote-console mode (work-wolfpack-G85VZR0): point the shell at a console
 * served elsewhere (e.g. https://sfo-01.<tailnet>.ts.net) instead of the
 * bundled local server. Pure helpers, no Electron — unit-tested from
 * apps/console/tests/desktop-remote.test.ts.
 *
 * Config: env WOLFPACK_CONSOLE_URL wins over `consoleUrl` in <userData>/console.json
 * (macOS: ~/Library/Application Support/LearnHarness/console.json).
 * Accepted: https://host[:port][/path]; plain http only for loopback
 * (127.0.0.1, localhost, [::1]) and tailnet CGNAT 100.64.0.0/10 IPs.
 * Rejected: credentials, other schemes, query/hash (dropped, not rejected).
 */
const fs = require("node:fs");
const path = require("node:path");

const isLoopback = (h) => h === "127.0.0.1" || h === "localhost" || h === "[::1]";
function isTailnetIp(h) {
	const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
	return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

/** → { ok: true, url, origin } | { ok: false, reason } */
function parseConsoleUrl(raw) {
	if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "empty" };
	let u;
	try {
		u = new URL(raw.trim());
	} catch {
		return { ok: false, reason: "not a valid URL" };
	}
	if (u.username || u.password) return { ok: false, reason: "credentials in URL are not allowed" };
	if (u.protocol === "http:") {
		if (!isLoopback(u.hostname) && !isTailnetIp(u.hostname)) {
			return { ok: false, reason: "http is only allowed for loopback or 100.64/10 tailnet IPs; use https" };
		}
	} else if (u.protocol !== "https:") {
		return { ok: false, reason: "only https is allowed" };
	}
	const pathname = u.pathname.replace(/\/+$/, "");
	return { ok: true, origin: u.origin, url: `${u.origin}${pathname}/` };
}

/** Env beats file. → { mode: "local" } | { mode: "remote", url, origin, source } */
function resolveConsoleTarget({ env = process.env, userDataDir, log = () => {} }) {
	let raw;
	let source;
	if (env.WOLFPACK_CONSOLE_URL) {
		raw = env.WOLFPACK_CONSOLE_URL;
		source = "WOLFPACK_CONSOLE_URL";
	} else if (userDataDir) {
		const file = path.join(userDataDir, "console.json");
		try {
			const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
			if (cfg && cfg.consoleUrl) {
				raw = cfg.consoleUrl;
				source = file;
			}
		} catch (e) {
			if (e && e.code !== "ENOENT") log(`console.json unreadable (${e.message}); using local mode`);
		}
	}
	if (raw === undefined) return { mode: "local" };
	const parsed = parseConsoleUrl(raw);
	if (!parsed.ok) {
		log(`invalid console URL from ${source}: ${parsed.reason}; falling back to local mode`);
		return { mode: "local" };
	}
	return { mode: "remote", url: parsed.url, origin: parsed.origin, source };
}

const sameOrigin = (target, origin) => {
	try {
		return new URL(target).origin === origin;
	} catch {
		return false;
	}
};

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Static, script-free-of-remote-content page; Retry navigates to lh-retry:// (intercepted) via a link. */
function errorPageHtml(url) {
	return `<!doctype html><meta charset="utf-8"><title>Wolfpack Console</title>
<style>body{background:#141414;color:#e5e5e5;font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}
div{max-width:460px;text-align:center}a{display:inline-block;margin-top:16px;padding:8px 18px;border:1px solid #555;border-radius:8px;color:inherit;text-decoration:none}</style>
<div><p>Can't reach <b>${escapeHtml(url)}</b>.<br>Is Tailscale connected?</p><a href="lh-retry://now">Retry</a></div>`;
}

/** hubd's pairing page lives at <origin>/hub/pair (same origin as the console, never under the console's path prefix). */
const pairUrl = (origin) => `${origin}/hub/pair`;

module.exports = { pairUrl, parseConsoleUrl, resolveConsoleTarget, sameOrigin, errorPageHtml };
