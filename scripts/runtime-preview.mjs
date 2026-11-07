#!/usr/bin/env node
/**
 * wolfpack preview [<ref> | <worktree dir> [--build] | status | restart | off [--console|--all] | dev [dir]] [--dry-run] [--yes]
 * (no argument: a picker of the repo's worktrees; a worktree preview runs the wolves from it via the stack plist: see runtime-preview-worktree.mjs)
 *
 * Try a branch on the live Mac stack, and get back to stable, with one command each. The runtime is the stable worktree
 * (`git worktree list`, env RUNTIME_BRANCH, default stable) run by launchd `com.wolfpack.stack`. State lives in
 * ~/.wolfpack/preview/state.json: {previousRef, previousBranch, previewRef, previewSha, startedAt, phase, runtimeDir}.
 *
 * on <ref>: refuse a dirty runtime or an active preview of another ref; fetch; record state; while the wolves are still up,
 * check out the SHA (detached), install and build. A failed build checks the previous ref back out, rebuilds it and ends
 * "build-failed"; the stack is never stopped. After a good build a detached helper (runtime-preview-switch.mjs, copied to
 * ~/.wolfpack/preview/ so it survives the tree switch) restarts the stack and polls /healthz.
 * off: recovers from the state file alone (works after a crash at any phase): previous branch, fast-forward, build, same helper.
 * Never pushes or merges a branch: only fetch, rev-parse, checkout and `merge --ff-only` of the previous branch's origin.
 * Steps (git, build, spawnHelper) are injectable so tests can stub them. Env: HOME, RUNTIME_BRANCH, STACK_LABEL, STACK_PORT.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recoverApps, restoreApps, startConsole, startDevConsole, stopConsole, devConsoleApp } from "./runtime-preview-console.mjs";
import { probePortFree } from "./runtime-preview-switch.mjs";
import { collectWorktrees, listWorktrees, matchWorktrees, pickerModel, shortName, chooseCli, pointCli, pointPlist, recordCli, restoreCli, cliEntry, recordPlist, restorePlist, restartNeeded, startWatch, stopWatch, workerdEntry, writeStamp } from "./runtime-preview-worktree.mjs";
import { buildCommands, choosePm, isDirty, probePnpm, worktrees } from "./runtime-update.mjs";

const realGit = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Bump when the script changes behaviour: the CLI runs the highest version it finds, and a copy is never replaced by a lower one. */
export const PREVIEW_VERSION = 10;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const COPIED_SCRIPTS = ["runtime-preview.mjs", "runtime-preview-switch.mjs", "runtime-update.mjs", "dev-stack-extensions.mjs", "runtime-preview-console.mjs", "runtime-preview-worktree.mjs", "runtime-preview-watch.mjs"];

/** Copy this command and its imports out of the runtime tree, so `off` works after checking out a branch that lacks them. */
function copyScripts(binDir) {
	fs.mkdirSync(binDir, { recursive: true });
	if (path.resolve(binDir) === SCRIPT_DIR) return; // already running from the copy
	try {
		const have = Number(/export const PREVIEW_VERSION = (\d+)/.exec(fs.readFileSync(path.join(binDir, "runtime-preview.mjs"), "utf8"))?.[1] ?? 0);
		if (have > PREVIEW_VERSION) return; // a newer copy is there: never downgrade it
	} catch {} // no copy yet
	for (const f of COPIED_SCRIPTS) {
		const from = path.join(SCRIPT_DIR, f);
		if (f !== "runtime-preview.mjs" && !fs.existsSync(from)) continue; // optional; only this script itself is required
		fs.copyFileSync(from, path.join(binDir, f));
	}
	const prompts = path.join(SCRIPT_DIR, "..", "packages", "cli", "dist", "prompts.js"); // self-contained: lets the bin copy draw the arrow-key picker
	if (fs.existsSync(prompts)) fs.copyFileSync(prompts, path.join(binDir, "prompts.js"));
}

/** The CLI's prompts (select, confirm): from the checkout this script is in, the bin copy next to it, or ~/.wolfpack/preview/bin. Null when none is found. */
async function loadPrompts() {
	const home = process.env.HOME || os.homedir();
	for (const f of [path.join(SCRIPT_DIR, "..", "packages", "cli", "dist", "prompts.js"), path.join(SCRIPT_DIR, "prompts.js"), path.join(home, ".wolfpack", "preview", "bin", "prompts.js")]) {
		if (!fs.existsSync(f)) continue;
		try {
			const m = await import(pathToFileURL(f).href);
			if (typeof m.select === "function" && typeof m.confirm === "function") return m;
		} catch {}
	}
	return null;
}

const defaultSteps = {
	git: realGit,
	launchctl: (...args) => spawnSync("launchctl", args, { stdio: "inherit" }).status,
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
	portFree: probePortFree,
	health: async (port) => {
		try {
			return (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) })).ok;
		} catch {
			return false;
		}
	},
	fetchJson: async (url) => {
		const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
		if (!r.ok) throw new Error(`${url} answered ${r.status}`);
		return r.json();
	},
	/** y/N on the terminal (the CLI's own `confirm` when its prompts.js is found); null when there is no terminal to ask on. */
	confirm: async (question) => {
		if (!process.stdin.isTTY) return null;
		const prompts = await loadPrompts();
		if (prompts) return prompts.confirm(question, false);
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
		rl.close();
		return /^y(es)?$/i.test(String(answer).trim());
	},
	/** Pick one of `items` ([{label, hint?, value}]): the CLI's arrow-key `select`, else a numbered list; null when there is no terminal. */
	pick: async (title, items) => {
		if (!process.stdin.isTTY) return null;
		const prompts = await loadPrompts();
		if (prompts) return prompts.select(title, items);
		console.log(`\n${title}`);
		items.forEach((it, i) => console.log(`  ${i + 1}) ${it.label}`));
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		const answer = await new Promise((resolve) => rl.question("number: ", resolve));
		rl.close();
		return items[Number(String(answer).trim()) - 1]?.value ?? null;
	},
	/** Where the global `wolfpack` package is linked (npm's global root, else next to this node). */
	cliLink: () => {
		for (const root of [path.join(path.dirname(process.execPath), "..", "lib", "node_modules")]) {
			const l = path.join(root, "@wolfpack", "cli");
			try {
				fs.lstatSync(l);
				return l;
			} catch {}
		}
		return undefined;
	},
	/** The checkout this script runs from (null when it runs from the bin copy): the fallback source of the global cli. */
	cliFallbackDir: () => (path.basename(SCRIPT_DIR) === "scripts" ? path.dirname(SCRIPT_DIR) : null),
	build: (wt, { logFile } = {}) => {
		const { pm } = choosePm(wt, { pnpmFound: probePnpm });
		let fd;
		if (logFile) {
			fs.mkdirSync(path.dirname(logFile), { recursive: true });
			fd = fs.openSync(logFile, "w");
		}
		try {
			for (const { cmd, args } of buildCommands(pm)) execFileSync(cmd, args, { cwd: wt, stdio: fd === undefined ? "inherit" : ["ignore", fd, fd], shell: process.platform === "win32" });
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	},
	/** Open a url in the default browser. */
	open: (url) => {
		spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" });
	},
	/** `pnpm install --frozen-lockfile --prefer-offline` in a worktree, output to the log file. */
	install: (wt, { logFile } = {}) => {
		let fd;
		if (logFile) {
			fs.mkdirSync(path.dirname(logFile), { recursive: true });
			fd = fs.openSync(logFile, "w");
		}
		try {
			execFileSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: wt, stdio: fd === undefined ? "inherit" : ["ignore", fd, fd], shell: process.platform === "win32" });
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	},
	/** Run the helper from the stable copy under bin/ (the runtime tree is being switched under it), detached, output to the last-run log. */
	spawnHelper: ({ args, dir, logFile }) => {
		copyScripts(path.join(dir, "bin"));
		const copy = path.join(dir, "bin", "runtime-preview-switch.mjs");
		const fd = fs.openSync(logFile, "a");
		spawn(process.execPath, [copy, ...args], { detached: true, stdio: ["ignore", fd, fd] }).unref();
	},
};

export async function runPreview({ argv = [], env = {}, cwd = process.cwd(), steps = {}, log = console.log, warn = console.warn } = {}) {
	const st = { ...defaultSteps, ...steps };
	const git = (wt, ...a) => st.git(wt, ...a);
	const tryGit = (wt, ...a) => {
		try {
			return { ok: true, out: git(wt, ...a) };
		} catch (e) {
			return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || String(e.message) };
		}
	};
	const dryRun = argv.includes("--dry-run");
	const pos = argv.filter((a) => !a.startsWith("--") && a !== "-y");
	const sub = pos[0];
	const home = env.HOME || os.homedir();
	const dir = path.join(home, ".wolfpack", "preview");
	const stateFile = path.join(dir, "state.json");
	const logFile = path.join(dir, "last-run.log");
	const plist = path.join(home, "Library", "LaunchAgents", "com.wolfpack.stack.plist");
	const label = env.STACK_LABEL || "com.wolfpack.stack";
	const port = String(env.STACK_PORT || 7141);
	const runtimeBranch = env.RUNTIME_BRANCH || "stable";
	const tag = dryRun ? "[dry-run] " : "";
	if (!dryRun) copyScripts(path.join(dir, "bin")); // keep the copy `wolfpack preview` falls back to current, whatever command this is
	const fail = (msg) => {
		warn(`preview: ${msg}`);
		return { exitCode: 1 };
	};
	const readState = () => {
		try {
			return JSON.parse(fs.readFileSync(stateFile, "utf8"));
		} catch {
			return undefined;
		}
	};
	const writeState = (s) => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(stateFile, `${JSON.stringify(s, null, 2)}\n`);
	};
	let yes = argv.includes("--yes") || argv.includes("-y");
	/** Ask y/N before something restarts the wolves. Returns a result to hand back when the answer is no, else undefined. */
	const gate = async (question) => {
		if (yes) return undefined;
		const answer = await st.confirm(question);
		if (answer === null) return fail(`${question} There is no terminal to ask on: pass --yes to confirm. Nothing was changed.`);
		if (!answer) {
			log("cancelled; nothing was changed.");
			return { exitCode: 1 };
		}
		return undefined;
	};
	const helper = (okPhase, clear) => st.spawnHelper({ dir, logFile, args: [stateFile, plist, label, port, okPhase, clear ? "1" : "0"] });
	const state = readState();

	const uid = process.getuid?.() ?? 501;
	const userDataRoot = env.PREVIEW_USERDATA_ROOT || path.join(home, "Library", "Application Support");

	if (sub === "status") {
		const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-5) : [];
		const cons = state?.console ? { ...state.console, missing: !fs.existsSync(state.console.dir) } : undefined;
		const worktreeMissing = state?.mode === "worktree" && !fs.existsSync(state.worktree);
		const needsRestart = !!state && restartNeeded({ home, state });
		const consoleUrl = state?.console ? `http://127.0.0.1:${state.consolePort ?? 3230}` : null;
		if (argv.includes("--json")) {
			log(JSON.stringify({ state: state ?? null, consoleUrl, console: cons ?? null, worktreeMissing, restartNeeded: needsRestart, log: tail }, null, 2));
			return { exitCode: 0, state };
		}
		if (!state) {
			log("stable, no preview");
			return { exitCode: 0 };
		}
		const wtDir = state.console?.dir ?? state.worktree;
		if (wtDir) {
			const b = fs.existsSync(wtDir) ? tryGit(wtDir, "rev-parse", "--abbrev-ref", "HEAD") : { ok: false };
			log(`worktree: ${shortName(b.ok && b.out !== "HEAD" ? b.out : null, wtDir)} (${wtDir})`);
		}
		if (cons) {
			let up = false;
			try {
				const w = (await st.fetchJson(`${consoleUrl}/api/wolves`))?.wolves;
				up = Array.isArray(w);
			} catch {}
			log(`console: ${consoleUrl} (${up ? "up" : "down"})`);
		} else log("console: not running");
		log(state.previewRef ? `wolves: moved to ${state.previewRef}${state.mode === "worktree" ? ` (${state.worktree})` : ""}; \`wolfpack preview off --all\` puts them back on stable` : "wolves: on stable");
		if (needsRestart) log("restart needed: backend files were rebuilt after the wolves started. Run `wolfpack preview restart`.");
		if (worktreeMissing) log(`  the worktree ${state.worktree} no longer exists (a worker's copy is deleted when it finishes). The wolves cannot run from it: \`wolfpack preview off --all\` restores stable. If the \`wolfpack\` command fails, its cli link pointed into that worktree: run \`node ~/.wolfpack/preview/bin/runtime-preview.mjs off --all\` (the bin copy does not need the worktree).`);
		if (cons?.missing) log(`  ${cons.dir} no longer exists (a worker worktree is deleted when it finishes). Fix: pick another with \`wolfpack preview\`, or \`wolfpack preview off\``);
		if (state.reason) log(`reason: ${state.reason}`);
		return { exitCode: 0, state };
	}

	// off while the wolves run a preview (moved now, or by an older run): the console always stops; the wolves only on a yes.
	if (sub === "off" && state?.previewRef) {
		const flag = argv.includes("--console") ? "console" : argv.includes("--all") || argv.includes("--rollback") || dryRun ? "all" : undefined;
		if (flag === "console" || !flag) {
			stopConsole({ home, uid, launchctl: st.launchctl });
			restoreApps(state.apps ?? recoverApps({ root: userDataRoot, url: `http://127.0.0.1:${state.consolePort ?? 3230}` }));
			let putBack = false;
			if (!flag) {
				const answer = yes ? true : await st.confirm(`The wolves are on ${state.previewRef}. Put them back on stable? This restarts the wolves and ends the wolf session running this command.`);
				putBack = answer === true;
				if (answer === null) log("no terminal to ask on: the wolves stay on the preview. `wolfpack preview off --all` puts them back on stable.");
			}
			if (!putBack) {
				writeState({ ...state, console: undefined, apps: undefined, consolePort: undefined });
				log(flag ? "live console stopped; the wolves stay on the preview. `wolfpack preview off --all` returns everything to stable." : "console stopped; the wolves stay on the preview (`wolfpack preview off --all` puts them back on stable).");
				return { exitCode: 0 };
			}
			yes = true; // asked already: the restore below must not ask again
		}
	}

	// off with only a dev console: nothing about the wolves is touched.
	if (sub === "off" && state && !state.previewRef) {
		if (dryRun) {
			log(`${tag}would stop com.wolfpack.preview-console, undo any old console.json pointing and clear ${stateFile}; the wolves are not touched`);
			return { exitCode: 0 };
		}
		stopConsole({ home, uid, launchctl: st.launchctl });
		restoreApps(state.apps ?? recoverApps({ root: userDataRoot, url: `http://127.0.0.1:${state.consolePort ?? 3230}` }));
		fs.rmSync(stateFile, { force: true });
		log("dev console stopped.");
		return { exitCode: 0 };
	}

	/** Serve `next dev` from wtDir under the preview-console agent, wait for it to list a wolf, then record it in the state (the app's Preview window reads that). */
	const serveDev = async (wtDir, cur) => {
		const consolePort = String(cur?.consolePort ?? env.PREVIEW_CONSOLE_PORT ?? 3230);
		const url = `http://127.0.0.1:${consolePort}`;
		const lcx = { home, uid, launchctl: st.launchctl };
		stopConsole(lcx); // an earlier console (build or dev) or a restart of this one
		await st.sleep(1000);
		if (!(await st.portFree(consolePort))) return fail(`port ${consolePort} is already in use by something else (a hand-started \`next dev\`?). Stop it or set PREVIEW_CONSOLE_PORT. Nothing was changed.`);
		const tearDown = () => {
			stopConsole(lcx);
			restoreApps(readState()?.apps);
			const cur = readState();
			if (cur && !cur.previewRef) fs.rmSync(stateFile, { force: true });
		};
		try {
			startDevConsole({ home, dir: wtDir, port: consolePort, stackPort: port, node: process.execPath, uid, launchctl: st.launchctl });
		} catch (err) {
			tearDown();
			return fail(`cannot start the dev console: ${err.message}`);
		}
		log(`compiling the console from ${wtDir}/apps/console (the first request can take a minute)`);
		let up = false;
		for (let i = 0; i < 45 && !up; i++) {
			try {
				const w = (await st.fetchJson(`${url}/api/wolves`))?.wolves;
				up = Array.isArray(w) && w.length > 0;
			} catch {}
			if (!up) await st.sleep(2000);
		}
		if (!up) {
			tearDown();
			return fail(`${url}/api/wolves listed no wolf within 90 s; the dev console was stopped. See ${path.join(dir, "console.log")}`);
		}
		writeState({ ...(cur ?? { phase: "dev", startedAt: new Date().toISOString() }), consolePort: Number(consolePort), console: { mode: "dev", dir: wtDir } });
		log(`live console from ${wtDir} on ${url}. The app's main window is untouched. \`wolfpack preview off\` when done.`);
		return { exitCode: 0, url };
	};

	/** The default preview: serve the worktree's console as `next dev` and open it in the browser. No build, no wolf restart, no y/N. */
	const startConsolePreview = async (wtDir) => {
		try {
			wtDir = fs.realpathSync(wtDir);
		} catch (err) {
			return fail(`${err.message}. Nothing was changed.`);
		}
		const needsInstall = !fs.existsSync(path.join(wtDir, "apps", "console", "node_modules"));
		if (dryRun) {
			if (needsInstall) log(`${tag}would run pnpm install --frozen-lockfile --prefer-offline in ${wtDir}`);
			log(`${tag}would serve \`next dev\` from ${wtDir}/apps/console on :${state?.consolePort ?? env.PREVIEW_CONSOLE_PORT ?? 3230} under com.wolfpack.preview-console and open it in the browser; the wolves are not touched`);
			return { exitCode: 0 };
		}
		if (needsInstall) {
			log(`installing dependencies in ${wtDir} (pnpm install --frozen-lockfile --prefer-offline; output in ${logFile})`);
			try {
				st.install(wtDir, { logFile });
			} catch (err) {
				return fail(`pnpm install in ${wtDir} failed: ${err.message}. Nothing was changed.`);
			}
		}
		try {
			devConsoleApp(wtDir);
		} catch (err) {
			return fail(`${err.message}. Nothing was changed.`);
		}
		const r = await serveDev(wtDir, state);
		if (r.exitCode === 0) {
			try {
				st.open(r.url);
			} catch (err) {
				warn(`preview: could not open the browser (${err.message}); open ${r.url} yourself.`);
			}
			log(`opened ${r.url} in the browser`);
		}
		return r;
	};

	if (sub === "dev") {
		const given = pos[1];
		let wtDir;
		if (given) wtDir = path.resolve(cwd, given);
		else {
			try {
				wtDir = git(cwd, "rev-parse", "--show-toplevel");
			} catch {
				return fail("not inside a git worktree: pass the directory, `wolfpack preview dev <dir>`. Nothing was changed.");
			}
		}
		try {
			wtDir = fs.realpathSync(wtDir);
			devConsoleApp(wtDir);
		} catch (err) {
			return fail(`${err.message}. Nothing was changed.`);
		}
		const consolePort = String(state?.consolePort ?? env.PREVIEW_CONSOLE_PORT ?? 3230);
		const url = `http://127.0.0.1:${consolePort}`;
		if (dryRun) {
			log(`${tag}would serve \`next dev\` from ${wtDir}/apps/console on ${url} (WOLFPACK_API_URL=http://127.0.0.1:${port}) under com.wolfpack.preview-console`);
			log(`${tag}then record it in the state for the app's Preview window; the wolves are not touched`);
			return { exitCode: 0 };
		}
		return serveDev(wtDir, state);
	}

	/** The runtime checkout. A detached runtime has no worktree on RUNTIME_BRANCH: fall back to its known path. */
	const findRuntime = () => {
		const knownDirs = [path.join(env.WOLVES_DIR || path.join(home, "wolves", "local"), "runtime", "wolfpack"), path.join(home, "wolves", "local", "runtime", "wolfpack")];
		return state?.runtimeDir ?? worktrees(cwd).get(runtimeBranch) ?? knownDirs.find((d) => fs.existsSync(path.join(d, ".git")));
	};

	/** Plain `wolfpack preview`: list the worktrees and pick one. Default: its live console in the browser. `--wolves`: move the wolves onto it (building it first when needed). */
	const picker = async (wolves) => {
		let worktrees;
		try {
			worktrees = collectWorktrees({ home, cwd, git });
		} catch {
			return fail("usage: wolfpack preview <ref> | <worktree dir> | status | off [--dry-run]. (Not inside a wolfpack checkout, so there is no worktree list.)");
		}
		const here = (() => {
			try {
				return fs.realpathSync(git(cwd, "rev-parse", "--show-toplevel"));
			} catch {}
		})();
		const activeDir = wolves ? (state?.mode === "worktree" ? state.worktree : undefined) : state?.console?.dir;
		const runtimeDir = (() => {
			try {
				return findRuntime();
			} catch {}
		})();
		let showAll = false;
		for (;;) {
			const { rows, hiddenCount } = pickerModel({ worktrees, runtimeBranch, runtimeDir, here, activeDir, showAll, marks: wolves });
			const items = rows.map((r) => ({ label: r.label, hint: r.hint, value: { dir: r.dir, build: r.build } }));
			if (!showAll && hiddenCount > 0) items.push({ label: "Show all worktrees…", value: "all" });
			const choice = await st.pick("Preview which worktree?", items);
			if (choice === "all") {
				showAll = true;
				continue;
			}
			if (!choice) {
				for (const it of items) log(it.label);
				return fail(wolves ? "pick a worktree on a terminal, or pass its directory: `wolfpack preview --wolves <dir> [--build] --yes`." : "pick a worktree on a terminal, or name one: `wolfpack preview <name>`.");
			}
			return wolves ? startWorktree(choice.dir, { build: choice.build }) : startConsolePreview(choice.dir);
		}
	};

	/** Run the wolves (and the live console) straight from a built worktree: no copy, no rebuild. */
	const startWorktree = async (wtDir, { build = false } = {}) => {
		if (state?.previewRef && state.mode !== "worktree") return fail(`a ref preview of ${state.previewRef} is active; run \`wolfpack preview off --all\` first. Nothing was changed.`);
		if (!build && !fs.existsSync(workerdEntry(wtDir))) return fail(`${wtDir} is not built (no ${workerdEntry(wtDir)}); add --build or pick it from \`wolfpack preview\`. Nothing was changed.`);
		if (!build) {
			try {
				devConsoleApp(wtDir);
			} catch (err) {
				return fail(`${err.message}. Nothing was changed.`);
			}
		}
		if (!fs.existsSync(plist)) return fail(`${plist} does not exist. Nothing was changed.`);
		if (dryRun) {
			log(`${tag}would repoint the global wolfpack cli link at ${wtDir}/packages/cli (original target recorded)`);
			if (build) log(`${tag}would install and build ${wtDir} (output in ${logFile})`);
			log(`${tag}would point ${plist} at ${workerdEntry(wtDir)} (working directory ${wtDir}), keeping the original bytes in ${stateFile} and ${dir}`);
			log(`${tag}would serve \`next dev\` from ${wtDir}/apps/console, then restart ${label} and wait for /healthz on ${port}`);
			return { exitCode: 0 };
		}
		const refused = await gate(`${build ? `This builds ${wtDir}, then restarts` : "This restarts"} the wolves from ${wtDir}.`);
		if (refused) return refused;
		if (build) {
			log(`building ${wtDir} (output in ${logFile})`);
			try {
				st.build(wtDir, { logFile });
			} catch (err) {
				return fail(`build of ${wtDir} failed: ${err.message}. Nothing else was changed.`);
			}
			writeStamp({ home, dir: wtDir, head: git(wtDir, "rev-parse", "HEAD") });
			try {
				devConsoleApp(wtDir);
			} catch (err) {
				return fail(`${err.message}. Nothing else was changed.`);
			}
		}
		const priorText = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : undefined;
		const rec = recordPlist({ plist, dir, existing: state?.plist });
		const cliRec = recordCli({ link: st.cliLink(), existing: state?.cli });
		const cliPick = cliRec ? chooseCli(wtDir, st.cliFallbackDir()) : null;
		const branch = (() => {
			const b = tryGit(wtDir, "rev-parse", "--abbrev-ref", "HEAD");
			return b.ok && b.out !== "HEAD" ? b.out : null;
		})();
		writeState({
			...(state ?? {}),
			mode: "worktree",
			worktree: wtDir,
			plist: rec,
			...(cliRec && cliPick ? { cli: { ...cliRec, dir: cliPick.dir } } : state?.cli ? { cli: state.cli } : {}), // nothing recorded when the link is not touched
			previewRef: branch ?? wtDir,
			previewSha: git(wtDir, "rev-parse", "HEAD"),
			previousRef: "the original stack launch",
			previousBranch: null,
			startedAt: new Date().toISOString(),
			phase: "building",
			consolePort: state?.consolePort ?? Number(env.PREVIEW_CONSOLE_PORT || 3230),
		}); // record first, then touch the plist
		pointPlist(rec, wtDir);
		if (cliPick) {
			pointCli(cliRec, cliPick.dir);
			if (cliPick.fallback) log(`wolfpack CLI from ${cliPick.dir} (the previewed worktree's CLI predates preview)`);
		} else {
			warn(`preview: ${cliRec ? "no compatible wolfpack cli to link (the worktree's predates preview)" : "the global wolfpack cli is a real install, not a link"}, so it was left alone and stable's cli has no \`preview\` command. Use \`node ~/.wolfpack/preview/bin/runtime-preview.mjs status|restart|off\` while this preview runs.`);
		}
		const r = await serveDev(wtDir, readState());
		if (r.exitCode !== 0) {
			if (state?.plist) {
				fs.writeFileSync(stateFile, priorText);
				pointPlist(rec, state.worktree);
				if (cliRec && state.cli?.dir) pointCli(cliRec, state.cli.dir);
			} else {
				restorePlist(rec);
				restoreCli(cliRec);
				if (priorText === undefined) fs.rmSync(stateFile, { force: true });
				else fs.writeFileSync(stateFile, priorText);
			}
			// serveDev stopped the console that was running before; bring it back.
			const prev = state?.console;
			if (prev && fs.existsSync(prev.dir)) {
				const cp = String(state.consolePort ?? 3230);
				try {
					if (prev.mode === "dev") startDevConsole({ home, dir: prev.dir, port: cp, stackPort: port, node: process.execPath, uid, launchctl: st.launchctl });
					else startConsole({ home, runtimeDir: prev.dir, port: cp, stackPort: port, node: process.execPath, uid, launchctl: st.launchctl });
				} catch (err) {
					warn(`preview: could not restart the previous console (${err.message}); run \`wolfpack preview dev\` again.`);
				}
			}
			return r;
		}
		copyScripts(path.join(dir, "bin"));
		try {
			startWatch({ home, wt: wtDir, node: process.execPath, script: path.join(dir, "bin", "runtime-preview-watch.mjs"), uid, launchctl: st.launchctl });
		} catch (err) {
			warn(`preview: the background rebuild did not start (${err.message}); backend edits will not rebuild.`);
		}
		writeState({ ...readState(), phase: "switching", stackStartedAt: undefined });
		helper("running", false);
		log(`previewing ${branch ?? wtDir} from ${wtDir}: the stack is restarting, so the wolf session running this command will end.`);
		log("Run `wolfpack preview status` from Terminal; `wolfpack preview off` returns to stable. If the deep health check fails, the switch rolls back by itself.");
		return { exitCode: 0 };
	};

	if (sub === "off" && state?.mode === "worktree") {
		if (dryRun) {
			log(`${tag}would restore ${plist} to its original bytes, restart ${label}, wait for /healthz on ${port}, then clear ${stateFile}`);
			return { exitCode: 0 };
		}
		if (argv.includes("--rollback")) {
			restorePlist(state.plist); // the switch helper restarts the stack itself
			restoreCli(state.cli);
			stopWatch({ home, uid, launchctl: st.launchctl });
			return { exitCode: 0 };
		}
		const refused = await gate("This restarts the wolves back on stable.");
		if (refused) return refused;
		restorePlist(state.plist);
		restoreCli(state.cli);
		stopWatch({ home, uid, launchctl: st.launchctl });
		writeState({ ...state, phase: "restoring" });
		copyScripts(path.join(dir, "bin"));
		helper("stable", true);
		log("restoring stable: the wolf session running this command will end. Run `wolfpack preview status` from Terminal.");
		return { exitCode: 0 };
	}

	if (sub && (sub.includes("/") || sub === ".")) {
		try {
			const asDir = fs.realpathSync(path.resolve(cwd, sub));
			if (listWorktrees(cwd, git).some((w) => w.dir === asDir)) return argv.includes("--wolves") ? startWorktree(asDir, { build: argv.includes("--build") }) : startConsolePreview(asDir);
		} catch {} // not a directory, or not in a repo: treat it as a ref below
	}

	if (sub === "restart") {
		if (!state?.previewRef) return fail("no preview is running the wolves, so there is nothing to restart. Nothing was changed.");
		if (dryRun) {
			log(`${tag}would run launchctl kickstart -k gui/${uid}/${label} and wait for /healthz on ${port}`);
			return { exitCode: 0 };
		}
		const refused = await gate("This restarts the wolves (it ends the wolf session running this command).");
		if (refused) return refused;
		st.launchctl("kickstart", "-k", `gui/${uid}/${label}`);
		let up = false;
		for (let i = 0; i < 30 && !up; i++) {
			up = await st.health(port);
			if (!up) await st.sleep(2000);
		}
		if (!up) return fail(`healthz on ${port} did not answer within 60 s; check \`wolfpack preview status\`.`);
		writeState({ ...readState(), stackStartedAt: new Date().toISOString() });
		log("the wolves restarted and /healthz answers.");
		return { exitCode: 0 };
	}

	if (!sub) return picker(argv.includes("--wolves"));

	// A name: a worktree by folder or branch (a unique match), else a ref to preview the old way.
	if (sub !== "off" && !sub.startsWith("-")) {
		let worktrees = [];
		try {
			worktrees = collectWorktrees({ home, cwd, git });
		} catch {}
		const runtimeDir = (() => {
			try {
				return findRuntime();
			} catch {}
		})();
		const { matches } = matchWorktrees({ worktrees, name: sub, runtimeBranch, runtimeDir });
		if (matches.length > 1) {
			for (const m of matches) log(`  ${path.basename(m.dir)}  ${m.branch ?? "(detached)"}`);
			return fail(`"${sub}" matches more than one worktree (listed above); use a longer name or the directory. Nothing was changed.`);
		}
		if (matches.length === 1) return argv.includes("--wolves") ? startWorktree(matches[0].dir, { build: argv.includes("--build") }) : startConsolePreview(matches[0].dir);
		const asRef = runtimeDir && ["", "refs/remotes/origin/"].some((p) => tryGit(runtimeDir, "rev-parse", "--verify", "--quiet", `${p}${sub}^{commit}`).ok);
		if (!asRef) return fail(`no worktree or ref matches "${sub}". Run \`wolfpack preview\` to pick one. Nothing was changed.`);
	}

	const rtWt = findRuntime();
	if (!rtWt) return fail(`branch ${runtimeBranch} is not checked out in any worktree`);
	log(`${tag}runtime @ ${rtWt}`);

	if (sub === "off") {
		if (!state) {
			log("stable, no preview: nothing to do");
			return { exitCode: 0 };
		}
		if (isDirty(rtWt)) return fail(`runtime worktree ${rtWt} has uncommitted changes; commit or stash them first. Nothing was changed.`);
		const branch = state.previousBranch;
		if (!dryRun && !argv.includes("--rollback")) {
			const refused = await gate("This restarts the wolves back on stable.");
			if (refused) return refused;
		}
		if (dryRun) {
			log(`${tag}would check out ${branch ?? state.previousRef}, fast-forward it to origin, install and build`);
			log(`${tag}would restart ${label}, wait for /healthz on ${port}, then clear ${stateFile}`);
			return { exitCode: 0 };
		}
		const co = branch ? tryGit(rtWt, "checkout", branch) : tryGit(rtWt, "checkout", "--detach", state.previousRef);
		if (!co.ok) return fail(`cannot check out ${branch ?? state.previousRef}: ${co.out.split("\n")[0]}`);
		if (branch) {
			if (!tryGit(rtWt, "fetch", "origin", branch).ok) warn("preview: git fetch failed (offline?); using the local branch");
			const remote = tryGit(rtWt, "rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`);
			if (remote.ok && tryGit(rtWt, "merge-base", "--is-ancestor", remote.out, "HEAD").ok && remote.out !== git(rtWt, "rev-parse", "HEAD")) {
				warn(`preview: local ${branch} is ahead of origin/${branch}; staying at the local ${branch}`);
			} else if (remote.ok && remote.out !== git(rtWt, "rev-parse", "HEAD")) {
				const ff = tryGit(rtWt, "merge", "--ff-only", `origin/${branch}`);
				if (!ff.ok) warn(`preview: ${branch} cannot fast-forward to origin/${branch}; staying at the local ${branch}`);
			}
		}
		writeState({ ...state, phase: "restoring" });
		log(`building ${branch ?? state.previousRef} (output in ${logFile})`);
		try {
			st.build(rtWt, { logFile });
		} catch (err) {
			return fail(`build of ${branch ?? state.previousRef} failed: ${err.message}. The stack was not touched; state kept, run \`wolfpack preview off\` again.`);
		}
		if (argv.includes("--rollback")) return { exitCode: 0 }; // the switch helper restarts the stack itself
		helper(branch ?? "stable", true);
		log("restoring stable: the wolf session running this command will end. Run `wolfpack preview status` from Terminal.");
		return { exitCode: 0 };
	}

	// on <ref>
	const ref = sub;
	if (ref.startsWith("-")) return fail(`"${ref}" looks like an option, not a ref. Nothing was changed.`);
	if (isDirty(rtWt)) return fail(`runtime worktree ${rtWt} has uncommitted changes; commit or stash them first. Nothing was changed.`);
	if (state?.mode === "worktree") return fail(`a worktree preview of ${state.worktree} is active; run \`wolfpack preview off --all\` first. Nothing was changed.`);
	if (dryRun) log(`${tag}not fetching; using local refs`);
	else if (!tryGit(rtWt, "fetch", "origin").ok) return fail("git fetch failed. Nothing was changed.");
	const resolve = (r) => {
		const x = tryGit(rtWt, "rev-parse", "--verify", `${r}^{commit}`);
		return x.ok ? x.out : undefined;
	};
	const remoteSha = resolve(`refs/remotes/origin/${ref}`);
	const localSha = resolve(`refs/heads/${ref}`);
	let sha = remoteSha ?? resolve(ref);
	if (remoteSha && localSha && remoteSha !== localSha && !tryGit(rtWt, "merge-base", "--is-ancestor", localSha, remoteSha).ok) {
		// Local is ahead of (or diverged from) origin: the stale origin/<ref> must not silently replace it.
		sha = localSha;
		warn(`preview: local ${ref} is ahead of origin/${ref} (or diverged); using the local ${ref} at ${localSha.slice(0, 8)}. Push it first if the wolves should see origin's copy.`);
	}
	if (!sha) return fail(`cannot resolve "${ref}". Nothing was changed.`);

	const head = git(rtWt, "rev-parse", "HEAD");
	const abbrev = git(rtWt, "rev-parse", "--abbrev-ref", "HEAD");
	// A ref preview in any phase (even build-failed) wins over HEAD: a failed restore can leave HEAD on the preview SHA, and a switch
	// to a new ref keeps the first preview's previous ref. A dev-only state has no previousRef: take it from HEAD.
	const previousRef = state?.previousRef ?? head;
	const previousBranch = state?.previousRef ? state.previousBranch : abbrev === "HEAD" ? runtimeBranch : abbrev;
	if (dryRun) {
		log(`${tag}would record state in ${stateFile} (previous ${previousBranch ?? previousRef})`);
		log(`${tag}would check out ${sha.slice(0, 8)} (${ref}) detached, install and build while the wolves stay up`);
		log(`${tag}then restart ${label}, wait for /healthz on ${port}`);
		return { exitCode: 0 };
	}
	const refused = await gate(`This restarts the wolves on ${ref} (${sha.slice(0, 8)}).`);
	if (refused) return refused;
	const priorStateText = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : undefined;
	writeState({ previousRef, previousBranch, previewRef: ref, previewSha: sha, startedAt: new Date().toISOString(), phase: "building", runtimeDir: rtWt, consolePort: state?.consolePort ?? Number(env.PREVIEW_CONSOLE_PORT || 3230), console: state?.console ?? { mode: "build", dir: rtWt }, ...(state?.apps ? { apps: state.apps } : {}) });
	copyScripts(path.join(dir, "bin"));
	const co = tryGit(rtWt, "checkout", "--detach", sha);
	if (!co.ok) {
		if (priorStateText === undefined) fs.rmSync(stateFile, { force: true });
		else fs.writeFileSync(stateFile, priorStateText);
		return fail(`cannot check out ${sha}: ${co.out.split("\n")[0]}`);
	}
	log(`building ${ref} (output in ${logFile})`);
	try {
		st.build(rtWt, { logFile });
	} catch (err) {
		warn(`preview: build of ${ref} failed: ${err.message}. Restoring ${previousBranch ?? previousRef}; the stack was not stopped.`);
		if (previousBranch) tryGit(rtWt, "checkout", previousBranch);
		else tryGit(rtWt, "checkout", "--detach", previousRef);
		try {
			st.build(rtWt, { logFile });
		} catch (err2) {
			warn(`preview: rebuild of the previous ref failed too: ${err2.message}`);
		}
		writeState({ ...readState(), phase: "build-failed" });
		return { exitCode: 1 };
	}
	writeState({ ...readState(), phase: "switching" });
	helper("running", false);
	log(`previewing ${ref} (${sha.slice(0, 8)}): the stack is restarting, so the wolf session running this command will end.`);
	log(`Then a local console on http://127.0.0.1:${readState().consolePort} is started for the app's Preview window (the main window stays on its own console). If the deep health check fails, the switch rolls back by itself (phase rolled-back).`);
	log("Run `wolfpack preview status` from Terminal; `wolfpack preview off` returns to stable. If that command is missing: node ~/.wolfpack/preview/bin/runtime-preview.mjs off");
	return { exitCode: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const r = await runPreview({ argv: process.argv.slice(2), env: process.env });
	process.exit(r.exitCode);
}
