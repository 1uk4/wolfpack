/**
 * The console's "Data and support" settings tab, main side (work-wolfpack-B97I0Gv). Nothing here imports Electron: main.cjs passes
 * `shell`, `clipboard` and `app` in, so a plain Node test drives it with stand-ins and temp dirs.
 *
 *   folders()               { state, wolves }: the two paths the tab shows
 *   showFolder(name)        "state" | "wolves" only (never a path from the page): opens it in Finder
 *   loginItem() / setLoginItem(on)   the tray's Open at login logic (tray.cjs), { openAtLogin, needsApproval }
 *   changeKey(key)          checkKey -> credentials.json (0600, atomic) -> restart wolfd only; the page gets { ok } or { ok:false, error }
 *   copyDiagnostics()       plain-text report on the clipboard, secrets removed first; { ok:true }
 *   reset()                 stop, move the pack state dir to the Trash, relaunch; ~/Wolves is never touched
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { checkKey, storedKey, writeAtomic } = require("./setup.cjs");
const { KEY_FILE } = require("./supervisor.cjs");
const { loginItemState, setLoginItem } = require("./tray.cjs");

const LOG_LINES = 200;
const MARK = "[removed]";
const MAX_LINE = 2000;

/** Remove secrets from text: exact values first (the API key, the hub token), then anything shaped like one. */
function redact(text, secrets = []) {
	let out = String(text);
	for (const s of secrets) if (typeof s === "string" && s.length >= 4) out = out.split(s).join(MARK);
	out = out.replace(/("(?:token|apiKey|api_key|authorization|password)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, `$1"${MARK}"`);
	out = out.replace(/("?(?:token|apiKey|api_key|password)"?\s*[:=]\s*)(?!["\s]|\[removed\])[^\s,;}&]+/gi, `$1${MARK}`);
	out = out.replace(/([?&]token=)[^&\s"']+/gi, `$1${MARK}`);
	out = out.replace(/("x-wolfpack-[a-z-]*token[a-z-]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, `$1"${MARK}"`);
	out = out.replace(/(x-wolfpack-[a-z-]*token[a-z-]*:\s*)(?!"|\[removed\])\S+/gi, `$1${MARK}`);
	out = out.replace(/\b((?:[A-Z][A-Z0-9_]*_)?(?:TOKEN|KEY|SECRET))=\S+/g, `$1=${MARK}`);
	out = out.replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}/g, MARK);
	out = out.replace(/\/bot\d+:[^/\s]+/g, `/bot${MARK}`);
	out = out.replace(/(pairing code:\s*)\S+/gi, `$1${MARK}`);
	out = out.replace(/x-api-key:\s*\S+/gi, `x-api-key: ${MARK}`);
	out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${MARK}`);
	out = out.replace(/sk-ant-[A-Za-z0-9_-]+/g, MARK);
	out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, MARK);
	return out;
}

function tailLines(file, n) {
	try {
		const lines = fs.readFileSync(file, "utf8").split("\n");
		if (lines.at(-1) === "") lines.pop();
		return lines.slice(-n).map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l));
	} catch {
		return [];
	}
}

function hubToken(stateDir) {
	try {
		const t = JSON.parse(fs.readFileSync(path.join(stateDir, "hub-token.json"), "utf8")).token;
		return typeof t === "string" ? t : "";
	} catch {
		return "";
	}
}

/**
 * opts: { stateDir, wolvesDir, getSup() -> supervisor|null, shell, clipboard, app, version, modelBaseUrl, log, fetchImpl, sysVersion }
 * `shell` needs openPath and trashItem; `clipboard` writeText; `app` the login-item calls plus relaunch and exit.
 */
function createAppSettings(opts) {
	const { stateDir, wolvesDir, shell, clipboard, app, log } = opts;
	/** Native yes/no from main.cjs ({ message, detail, button } -> boolean); no confirm given means no. */
	const confirm = opts.confirm ?? (async () => false);
	const inside = (a, b) => {
		const r = path.relative(path.resolve(a), path.resolve(b));
		return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
	};
	const dirs = { state: stateDir, wolves: wolvesDir };

	const secrets = () => [storedKey(stateDir), hubToken(stateDir)];

	async function showFolder(name) {
		const dir = typeof name === "string" && Object.hasOwn(dirs, name) ? dirs[name] : "";
		if (!dir) return { ok: false, error: "Unknown folder" };
		fs.mkdirSync(dir, { recursive: true });
		const err = await shell.openPath(dir); // Electron: "" on success, else the reason
		return err ? { ok: false, error: String(err) } : { ok: true };
	}

	/** One confirm, reset or key change at a time: a second call while one runs is refused at once (no second dialog). */
	let busy = false;
	async function exclusive(fn) {
		if (busy) return { ok: false, busy: true };
		busy = true;
		try {
			return await fn();
		} finally {
			busy = false;
		}
	}

	const changeKey = (raw) => exclusive(() => changeKeyNow(raw));
	async function changeKeyNow(raw) {
		const key = String(raw ?? "").trim();
		const sup = opts.getSup();
		if (!sup) return { ok: false, error: "The app is not running" };
		if (!key) return { ok: false, error: "Paste your API key first." };
		// Ask first: a page must not be able to test keys against Anthropic without a prompt.
		const go = await confirm({
			message: "Change the API key?",
			detail: "Your wolf restarts to use the new key. A reply it is writing right now will stop.",
			button: "Change key and restart",
		});
		if (!go) return { ok: false, cancelled: true };
		const checked = await checkKey(key, { baseUrl: opts.modelBaseUrl, fetchImpl: opts.fetchImpl });
		if (!checked.ok) return checked;
		const file = path.join(stateDir, KEY_FILE);
		let current = {};
		try {
			const v = JSON.parse(fs.readFileSync(file, "utf8"));
			if (v && typeof v === "object" && !Array.isArray(v)) current = v; // a damaged file is replaced, a good one keeps its other fields
		} catch {
			/* missing or damaged */
		}
		writeAtomic(file, JSON.stringify({ ...current, ANTHROPIC_API_KEY: key }), 0o600);
		try {
			await sup.restart("wolfd");
		} catch (err) {
			if (err?.code === "PORT_MOVED") return { ok: false, error: "The key was saved. Restart the app to finish." };
			log?.(`wolf restart after key change failed: ${redact(err?.message ?? err, [key])}`);
			return { ok: false, error: "The key was saved, but your wolf didn't restart. Quit and reopen Wolfpack." };
		}
		return { ok: true };
	}

	async function report() {
		const sup = opts.getSup();
		const lines = [
			"Wolfpack diagnostics",
			`App version: ${opts.version}`,
			`macOS: ${opts.sysVersion ?? os.release()} (${process.arch})`,
			`App data: ${stateDir}`,
			`Your wolves: ${wolvesDir}`,
			`Wolf: ${sup?.status().running ? "running" : "stopped"}`,
		];
		for (const name of ["hubd", "workerd"]) {
			const url = sup?.urls?.[name];
			let state = "down";
			if (url) {
				try {
					state = (await (opts.fetchImpl ?? fetch)(`${url}/healthz`, { signal: AbortSignal.timeout(2000) })).ok ? "up" : "down";
				} catch {
					/* down */
				}
			}
			lines.push(`${name}: ${state}`);
		}
		const logDir = path.join(stateDir, "logs");
		let files = [];
		try {
			files = fs.readdirSync(logDir).filter((f) => f.endsWith(".log")).sort();
		} catch {
			/* no logs yet */
		}
		for (const f of files) lines.push("", `--- ${f} (last ${LOG_LINES} lines) ---`, ...tailLines(path.join(logDir, f), LOG_LINES));
		return redact(lines.join("\n"), secrets());
	}

	async function copyDiagnostics() {
		clipboard.writeText(await report());
		return { ok: true };
	}

	/** Stop, move the pack state to the Trash, relaunch. A Trash failure restarts the runtime and keeps everything. */
	const reset = () => exclusive(resetNow);
	async function resetNow() {
		if (inside(stateDir, wolvesDir) || inside(wolvesDir, stateDir)) {
			return { ok: false, error: "Your wolves folder and the app data folder overlap, so reset won't touch them. Nothing was changed." };
		}
		const go = await confirm({
			message: "Reset Wolfpack?",
			detail:
				"Your settings, key and knowledge base move to the Trash, so you can still get them back from there. Your wolves in ~/Wolves stay where they are, with their memory. Setup starts again.",
			button: "Move to Trash and restart setup",
		});
		if (!go) return { ok: false, cancelled: true };
		const sup = opts.getSup();
		const restore = async () => {
			if (sup) await sup.start().catch((e) => log?.(`reset: restart failed: ${e?.message ?? e}`));
		};
		try {
			if (sup) await sup.stop();
		} catch (err) {
			log?.(`reset: could not stop the app: ${err?.message ?? err}`);
			await restore();
			return { ok: false, error: "Couldn't stop the app to reset it. Nothing was changed." };
		}
		try {
			await shell.trashItem(stateDir);
		} catch (err) {
			log?.(`reset: could not move app data to the Trash: ${err?.message ?? err}`);
			await restore();
			return { ok: false, error: "Couldn't move the app's data to the Trash. Nothing was changed." };
		}
		app.relaunch();
		app.exit(0);
		return { ok: true };
	}

	return {
		folders: () => ({ ...dirs }),
		showFolder,
		loginItem: () => loginItemState(app),
		setLoginItem: (on) => setLoginItem(app, on, log),
		changeKey,
		copyDiagnostics,
		reset,
		report,
	};
}

module.exports = { createAppSettings, redact };
