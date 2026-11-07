import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import { createSlots } from "./runtime-preview-slots.mjs";

// Real processes: the runner, a fake `next` that listens on --port and forks a worker in the same group.
const FAKE_NEXT = `const http = require("http"), fs = require("fs"), cp = require("child_process"), path = require("path");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
if (process.argv.includes("--worker")) setInterval(() => {}, 1000);
else {
const w = cp.spawn(process.execPath, [__filename, "--worker"], { stdio: "ignore" });
fs.writeFileSync(path.join(process.cwd(), "pids.json"), JSON.stringify({ next: process.pid, worker: w.pid }));
http.createServer((q, r) => r.end("ok")).listen(port, "127.0.0.1");
}
`;

let home: string;
const pidsOf = (wt: string) => JSON.parse(fs.readFileSync(path.join(wt, "apps", "console", "pids.json"), "utf8")) as { next: number; worker: number };
const up = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const listening = (port: number) => fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }).then((r) => r.status === 200, () => false);
const until = async (cond: () => boolean | Promise<boolean>, ms = 8000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await cond()) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
};
const worktree = (name: string) => {
	const wt = path.join(home, name);
	const bin = path.join(wt, "apps", "console", "node_modules", "next", "dist", "bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, "next"), FAKE_NEXT);
	return wt;
};
const slots = (env: Record<string, string> = {}) => createSlots({ home, env: { WOLFPACK_HUB_TOKEN: "t", PREVIEW_SLOT_TICK_MS: "200", PREVIEW_SLOT_IDLE_MS: "600000", ...env } });
const slotsFile = () => path.join(home, ".wolfpack", "preview", "slots.json");

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "slotrun-"));
});
/** Only ever signal a process that is still one of this test's fixtures: its command names this test's temp home (a recycled pid never does). */
const ours = (pid: number | undefined) => !!pid && String(spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout).includes(home);
const killIfOurs = (pid: number | undefined, group = false) => {
	if (!ours(pid)) return;
	try {
		process.kill(group ? -pid! : pid!, "SIGKILL");
	} catch {}
};
afterEach(() => {
	try {
		for (const s of JSON.parse(fs.readFileSync(slotsFile(), "utf8")).slots) killIfOurs(s.pid, true);
	} catch {}
	// the fake next and its worker too, wherever a test left them (each worktree's pids.json)
	for (const d of fs.existsSync(home) ? fs.readdirSync(home) : []) {
		try {
			const p = JSON.parse(fs.readFileSync(path.join(home, d, "apps", "console", "pids.json"), "utf8"));
			for (const pid of [p.next, p.worker]) killIfOurs(pid);
		} catch {}
	}
	fs.rmSync(home, { recursive: true, force: true });
});

describe("slot runner (real processes)", () => {
	it("release stops one slot's runner, next and workers and leaves the other slot serving", async () => {
		const s = slots();
		const a = await s.get(worktree("a"));
		const b = await s.get(worktree("b"));
		const pa = pidsOf(path.join(home, "a"));
		await s.release("a");
		expect(await until(() => !up(a.pid) && !up(pa.next) && !up(pa.worker))).toBe(true);
		expect(await listening(a.port)).toBe(false);
		expect(await listening(b.port)).toBe(true);
		expect(up(b.pid)).toBe(true);
	}, 30000);

	it("a runner whose slot vanished from slots.json exits and takes next and workers with it", async () => {
		const s = slots();
		const a = await s.get(worktree("a"));
		const pa = pidsOf(path.join(home, "a"));
		fs.writeFileSync(slotsFile(), JSON.stringify({ slots: [] }));
		expect(await until(() => !up(a.pid) && !up(pa.next) && !up(pa.worker))).toBe(true);
	}, 30000);

	it("a runner whose slots.json is deleted exits instead of running on forever", async () => {
		const s = slots();
		const a = await s.get(worktree("a"));
		const pa = pidsOf(path.join(home, "a"));
		fs.rmSync(slotsFile());
		expect(await until(() => !up(a.pid) && !up(pa.next) && !up(pa.worker))).toBe(true);
	}, 30000);

	it("a slot nobody asked for within the idle time stops by itself", async () => {
		const s = slots({ PREVIEW_SLOT_IDLE_MS: "4000" });
		const a = await s.get(worktree("a"));
		const pa = pidsOf(path.join(home, "a"));
		expect(await until(() => !up(a.pid) && !up(pa.next) && !up(pa.worker), 20000)).toBe(true);
	}, 30000);

	it("the next command clears what a crashed runner left behind", async () => {
		const s = slots();
		const a = await s.get(worktree("a"));
		const pa = pidsOf(path.join(home, "a"));
		process.kill(a.pid, "SIGKILL"); // the runner only: next and its worker keep running
		expect(up(pa.next)).toBe(true);
		expect(await s.list()).toEqual([]);
		expect(await until(() => !up(pa.next) && !up(pa.worker))).toBe(true);
	}, 30000);

	it("leaves an unrelated live process group alone when a stale record points at its pid", async () => {
		// A pid reused after a reboot: a non-runner group leader whose child looks like next (a copy of the fake next, inside node_modules/next/).
		const wt = worktree("other");
		const nextBin = path.join(wt, "apps", "console", "node_modules", "next", "dist", "bin", "next");
		const leader = spawn("sh", ["-c", `node ${nextBin} --worker & exec sleep 60`], { detached: true, stdio: "ignore", cwd: path.join(wt, "apps", "console") });
		try {
			await new Promise((r) => setTimeout(r, 500));
			fs.mkdirSync(path.dirname(slotsFile()), { recursive: true });
			fs.writeFileSync(slotsFile(), JSON.stringify({ slots: [{ port: 3231, worktree: "/wt/x", pid: leader.pid, startedAt: Date.now(), lastUsed: Date.now() }] }));
			const members = () => spawnSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" }).stdout.split("\n").map((l) => l.trim().split(/\s+/).map(Number)).filter(([, g]) => g === leader.pid).map(([p]) => p);
			const before = members();
			expect(before.length).toBeGreaterThan(1);
			expect(await slots().list()).toEqual([]);
			await new Promise((r) => setTimeout(r, 500));
			// a killed child of the sleep stays a zombie (state Z), which kill(pid, 0) still sees: read the state instead
			expect(before.map((p) => spawnSync("ps", ["-o", "stat=", "-p", String(p)], { encoding: "utf8" }).stdout.trim()).filter((st) => st && !st.startsWith("Z")).length).toBe(before.length);
		} finally {
			try {
				process.kill(-leader.pid!, "SIGKILL");
			} catch {}
		}
	}, 30000);

	it("a dead runner's cleanup stops next inside its worktree but not a next-server-named process outside it", async () => {
		const wt = worktree("a");
		const nextBin = path.join(wt, "apps", "console", "node_modules", "next", "dist", "bin", "next");
		const decoy = path.join(home, "decoy", "next-server");
		fs.mkdirSync(path.dirname(decoy), { recursive: true });
		fs.writeFileSync(decoy, "setInterval(() => {}, 1000);\n"); // like the owner's console worker: a next-server in the group, outside the worktree
		// A short-lived group leader that leaves two members in its group, then exits (its pid is free again: ESRCH).
		const leader = spawn("sh", ["-c", `${process.execPath} ${nextBin} --port 3298 & ${process.execPath} ${decoy} & sleep 0.3`], { detached: true, stdio: "ignore", cwd: path.join(wt, "apps", "console") });
		await new Promise((r) => leader.once("exit", r));
		const members = () =>
			spawnSync("ps", ["-axo", "pid=,pgid=,stat=,command="], { encoding: "utf8" })
				.stdout.split("\n")
				.map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l))
				.filter((m) => m && Number(m[2]) === leader.pid && !m[3].startsWith("Z"))
				.map((m) => ({ pid: Number(m![1]), cmd: m![4] }));
		try {
			expect(members().map((m) => m.cmd.includes("decoy"))).toContain(true);
			fs.mkdirSync(path.dirname(slotsFile()), { recursive: true });
			fs.writeFileSync(slotsFile(), JSON.stringify({ slots: [{ port: 3231, worktree: wt, pid: leader.pid, startedAt: Date.now(), lastUsed: Date.now() }] }));
			expect(await slots().list()).toEqual([]);
			await until(() => !members().some((m) => m.cmd.includes(nextBin)));
			expect(members().map((m) => m.cmd.includes("decoy"))).toEqual([true]);
		} finally {
			for (const m of members()) killIfOurs(m.pid);
		}
	}, 30000);

	it("treats only a node runner started for this home and port as ours, not any command that mentions the script", async () => {
		const fake = path.join(home, "runtime-preview-slot-run.mjs");
		fs.writeFileSync(fake, "setInterval(() => {}, 1000);\n");
		const start = (...args: string[]) => spawn(process.execPath, [fake, ...args], { detached: true, stdio: "ignore" });
		const mine = start(home, "3231", "n", "a", "1");
		const otherHome = start("/elsewhere", "3231", "n", "a", "1");
		const otherPort = start(home, "3299", "n", "a", "1");
		try {
			await new Promise((r) => setTimeout(r, 400));
			const now = Date.now();
			const rec = (pid: number | undefined, port: number) => ({ port, worktree: `/wt/${port}-${pid}`, pid, startedAt: now, lastUsed: now });
			fs.mkdirSync(path.dirname(slotsFile()), { recursive: true });
			fs.writeFileSync(slotsFile(), JSON.stringify({ slots: [rec(mine.pid, 3231), rec(otherHome.pid, 3232), rec(otherPort.pid, 3233)] }));
			expect((await slots().list()).map((x: { pid: number }) => x.pid)).toEqual([mine.pid]);
			expect([otherHome.pid!, otherPort.pid!].every(up)).toBe(true);
		} finally {
			for (const c of [mine, otherHome, otherPort]) {
				try {
					process.kill(-c.pid!, "SIGKILL");
				} catch {}
			}
		}
	}, 30000);

	it("never signals a pid that is not a slot runner", async () => {
		const other = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
		try {
			fs.mkdirSync(path.dirname(slotsFile()), { recursive: true });
			fs.writeFileSync(slotsFile(), JSON.stringify({ slots: [{ port: 3231, worktree: "/wt/x", pid: other.pid, startedAt: Date.now(), lastUsed: Date.now() }] }));
			await expect(slots().release("3231")).rejects.toThrow(/no slot/);
			expect(up(other.pid!)).toBe(true);
		} finally {
			process.kill(other.pid!, "SIGKILL");
		}
	}, 30000);
});
