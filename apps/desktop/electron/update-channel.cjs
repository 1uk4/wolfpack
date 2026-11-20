/**
 * The app's own update channel switch, Settings > This device (work-wolfpack-JIIInfm). Nothing here imports Electron: main.cjs passes
 * electron-updater's `autoUpdater` in, so a plain Node test drives it with a stand-in and a temp dir.
 *
 * Mechanism (electron-updater, github provider, no second publish config):
 *   stable  channel "latest", allowPrerelease false  -> latest-mac.yml of the newest full GitHub release (the existing feed, unchanged)
 *   main    channel "main",   allowPrerelease true   -> main-mac.yml of the newest pre-release (electron-builder names the feed after the
 *           `-main.N` part of the version, so an `X.Y.Z-main.N` build publishes main-mac.yml)
 * allowDowngrade stays false: going back to stable needs no downgrade, because X.Y.Z (stable) is newer than X.Y.Z-main.N in semver, so the
 * next check offers the stable release as soon as one newer than the running pre-release's base exists. Offering an older stable build
 * (allowDowngrade) would roll the owner back over a release he asked to keep.
 *
 * The choice lives in <stateDir>/update-channel.json (the app's own store; ~/.wolfpack/release-channel.json is the pack updater's). Default stable.
 *
 *   state()        { available, channel, note?, returnNote? }  available:false in remote mode (the console is served by another machine)
 *   setChannel(c)  persists, applies to the updater; { ok } or { ok:false, error }
 *   checkMain()    { ahead: version|null, upToDate }  reads the GitHub releases list (no download), compares with the running version
 */
const fs = require("node:fs");
const path = require("node:path");

const FILE = "update-channel.json";
const CHANNELS = ["stable", "main"];
const RELEASES_URL = "https://api.github.com/repos/1uk4/wolfpack/releases?per_page=30";
const REMOTE_NOTE = "This console is served by another machine, so its app updates are set there.";
const RETURN_NOTE = "You'll return to stable at the next stable release.";

function parse(v) {
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v ?? "").trim());
	if (!m) return null;
	return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Semver order: -1, 0, 1. A pre-release is below its release; numeric parts compare as numbers (main.9 < main.10). null if unparsable. */
function compareVersions(a, b) {
	const x = parse(a);
	const y = parse(b);
	if (!x || !y) return null;
	for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
	if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const p = x.pre[i];
		const q = y.pre[i];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		if (p === q) continue;
		const pn = /^\d+$/.test(p);
		const qn = /^\d+$/.test(q);
		if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
		if (pn !== qn) return pn ? -1 : 1;
		return p < q ? -1 : 1;
	}
	return 0;
}

/** opts: { stateDir, updater (autoUpdater, or null in dev), version, remote, fetchImpl, log } */
function createUpdateChannel(opts) {
	const file = path.join(opts.stateDir, FILE);
	const read = () => {
		try {
			const c = JSON.parse(fs.readFileSync(file, "utf8")).channel;
			return CHANNELS.includes(c) ? c : "stable";
		} catch {
			return "stable";
		}
	};

	function apply(channel) {
		const u = opts.updater;
		if (!u) return;
		u.channel = channel === "main" ? "main" : "latest";
		u.allowPrerelease = channel === "main";
		u.allowDowngrade = false;
	}

	/** Call once at startup, before the first update check. Remote mode never switches: it stays on stable. */
	function init() {
		if (!opts.remote) apply(read());
	}

	function state() {
		if (opts.remote) return { available: false, channel: "stable", note: REMOTE_NOTE };
		const channel = read();
		const out = { available: true, channel };
		if (channel === "stable" && parse(opts.version)?.pre.length) out.returnNote = RETURN_NOTE;
		return out;
	}

	function setChannel(c) {
		if (opts.remote) return { ok: false, error: REMOTE_NOTE };
		if (!CHANNELS.includes(c)) return { ok: false, error: "Unknown channel" };
		try {
			fs.mkdirSync(opts.stateDir, { recursive: true });
			const tmp = `${file}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify({ channel: c }));
			fs.renameSync(tmp, file);
		} catch (err) {
			opts.log?.(`update channel not saved: ${err?.message ?? err}`);
			return { ok: false, error: "Couldn't save the choice." };
		}
		apply(c);
		return { ok: true, ...state() };
	}

	async function checkMain() {
		if (opts.remote) return { ahead: null, upToDate: false, error: REMOTE_NOTE };
		try {
			const res = await (opts.fetchImpl ?? fetch)(RELEASES_URL, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000) });
			if (!res.ok) return { ahead: null, upToDate: false, error: `GitHub answered ${res.status}` };
			const releases = await res.json();
			let best = null;
			for (const r of Array.isArray(releases) ? releases : []) {
				if (!r?.prerelease || r.draft) continue;
				const v = String(r.tag_name ?? "").replace(/^v/, "");
				if (!/-main\.\d+$/.test(v)) continue;
				if (!best || compareVersions(v, best) === 1) best = v;
			}
			if (!best) return { ahead: null, upToDate: true };
			const ahead = compareVersions(best, opts.version) === 1;
			return ahead ? { ahead: best, upToDate: false } : { ahead: null, upToDate: true };
		} catch (err) {
			return { ahead: null, upToDate: false, error: String(err?.message ?? err) };
		}
	}

	return { init, state, setChannel, checkMain };
}

module.exports = { createUpdateChannel, compareVersions, REMOTE_NOTE, RETURN_NOTE };
