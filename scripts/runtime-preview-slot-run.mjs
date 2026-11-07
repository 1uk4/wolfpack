/**
 * The process behind one agent slot: node runtime-preview-slot-run.mjs <home> <port> <next> <appDir> <idleMs>. Runs `next dev` as its
 * child in the same process group, and exits when the slot is no longer in slots.json (released, reaped) or has been idle past idleMs:
 * that is what stops an idle slot when nobody runs a command. Stopping signals the whole group (next and its workers), then SIGKILLs it.
 * PREVIEW_SLOT_TICK_MS (default 30 s) sets how often it checks. Node builtins only.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [home, port, next, app, idle] = process.argv.slice(2);
const file = path.join(home, ".wolfpack", "preview", "slots.json");
const idleMs = Number(idle) || 20 * 60_000;
const child = spawn(process.execPath, [next, "dev", "--hostname", "127.0.0.1", "--port", port], { cwd: app, stdio: "inherit", env: process.env });
let stopping = false;
const signalGroup = (sig) => {
	try {
		process.kill(-process.pid, sig); // our group: next, its workers, and this process
	} catch {}
};
const stop = () => {
	if (stopping) return;
	stopping = true;
	signalGroup("SIGTERM");
	setTimeout(() => signalGroup("SIGKILL"), 3000).unref();
};
child.on("exit", () => {
	signalGroup("SIGTERM"); // workers next left behind
	setTimeout(() => signalGroup("SIGKILL"), 1000).unref();
	setTimeout(() => process.exit(0), 1500).unref();
});
process.on("SIGTERM", stop);
setInterval(() => {
	try {
		const mine = (JSON.parse(fs.readFileSync(file, "utf8")).slots ?? []).find((s) => String(s.port) === port && s.pid === process.pid);
		if (mine && Date.now() - mine.lastUsed <= idleMs) return;
	} catch (e) {
		if (e.code !== "ENOENT") return; // unreadable now (mid-write): look again next time
		// the file (or the whole home) is gone: nobody can release or touch this slot any more
	}
	stop();
}, Number(process.env.PREVIEW_SLOT_TICK_MS) || 30_000);
