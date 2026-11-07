import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import { createSlots } from "./runtime-preview-slots.mjs";

let home: string, clock: number, alive: Set<number>, nextPid: number, spawned: { port: number; worktree: string; env: Record<string, string> }[], killed: number[], leftovers: number[];
const mk = (over: Record<string, unknown> = {}) =>
	createSlots({
		home,
		env: { WOLFPACK_HUB_TOKEN: "tok-1" },
		now: () => clock,
		spawn: (o: { port: number; worktree: string; env: Record<string, string> }) => {
			spawned.push(o);
			const pid = nextPid++;
			alive.add(pid);
			return pid;
		},
		isAlive: (pid: number) => alive.has(pid),
		pidExists: (pid: number) => alive.has(pid),
		kill: (pid: number) => {
			killed.push(pid);
			alive.delete(pid);
		},
		portFree: async () => true,
		waitListening: async () => true,
		prepare: () => {},
		reapLeftovers: (slot: { port: number }) => leftovers.push(slot.port),
		lockWaitMs: 50,
		...over,
	});

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "slots-"));
	clock = 1_000_000;
	alive = new Set();
	nextPid = 500;
	spawned = [];
	killed = [];
	leftovers = [];
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("agent slots", () => {
	it("gives each worktree its own port from 3231 and reuses it on a second ask", async () => {
		const s = mk();
		expect(await s.get("/wt/a")).toMatchObject({ port: 3231, url: "http://127.0.0.1:3231", reused: false });
		expect((await s.get("/wt/b")).port).toBe(3232);
		clock += 5000;
		expect(await s.get("/wt/a")).toMatchObject({ port: 3231, reused: true });
	});

	it("starts the slot with the hub token and its own port in the environment", async () => {
		await mk().get("/wt/a");
		expect(spawned[0].env).toMatchObject({ WOLFPACK_HUB_TOKEN: "tok-1", PORT: "3231" });
	});

	it("refuses a third worktree, naming the busy slots and how to release one", async () => {
		const s = mk();
		await s.get("/wt/a");
		await s.get("/wt/b");
		await expect(s.get("/wt/c")).rejects.toThrow(/2 slots.*3231.*\/wt\/a.*3232.*\/wt\/b.*slot release/s);
	});

	it("reaps a slot whose pid is dead and frees its port", async () => {
		const s = mk();
		await s.get("/wt/a");
		await s.get("/wt/b");
		alive.delete(500);
		expect((await s.list()).map((x: { port: number }) => x.port)).toEqual([3232]);
		expect((await s.get("/wt/c")).port).toBe(3231);
	});

	it("stops a slot idle past the timeout, and get keeps one alive", async () => {
		const s = mk({ idleMs: 20 * 60_000 });
		await s.get("/wt/a");
		await s.get("/wt/b");
		clock += 15 * 60_000;
		await s.get("/wt/b");
		clock += 10 * 60_000;
		expect(await s.reap()).toEqual([3231]);
		expect(killed).toEqual([500]);
		expect((await s.list()).map((x: { worktree: string }) => x.worktree)).toEqual(["/wt/b"]);
	});

	it("releases by worktree or by port and leaves the other slot running", async () => {
		const s = mk();
		await s.get("/wt/a");
		await s.get("/wt/b");
		expect(await s.release("/wt/a")).toBe(3231);
		expect(await s.release("3232")).toBe(3232);
		expect(killed).toEqual([500, 501]);
		expect(await s.list()).toEqual([]);
		await expect(s.release("/wt/zzz")).rejects.toThrow(/no slot/);
	});

	it("lists port, worktree, pid, start and last use", async () => {
		const s = mk();
		await s.get("/wt/a");
		clock += 1000;
		await s.get("/wt/a");
		expect(await s.list()).toEqual([{ port: 3231, worktree: "/wt/a", pid: 500, startedAt: 1_000_000, lastUsed: 1_001_000 }]);
	});

	it("makes a concurrent get wait for the lock, so two gets never share a port", async () => {
		let inner: Promise<{ port: number }> | undefined;
		const s = mk({
			spawn: () => {
				// another agent's get arrives while this claim is in flight
				alive.add(500);
				inner ??= mk({ lockWaitMs: 2000, spawn: () => (alive.add(501), 501) }).get("/wt/b");
				return 500;
			},
		});
		expect((await s.get("/wt/a")).port).toBe(3231);
		expect((await inner)?.port).toBe(3232);
	});

	it("breaks a lock whose holder process is gone", async () => {
		const lock = path.join(home, ".wolfpack", "preview", "slots.lock");
		fs.mkdirSync(path.dirname(lock), { recursive: true });
		fs.writeFileSync(lock, "2147483646:deadbeef"); // no such pid: a crashed command's lock
		expect((await mk().get("/wt/a")).port).toBe(3231);
	});

	it("waits for a fresh lock whose holder is alive", async () => {
		const lock = path.join(home, ".wolfpack", "preview", "slots.lock");
		fs.mkdirSync(path.dirname(lock), { recursive: true });
		fs.writeFileSync(lock, `${process.pid}:live`);
		await expect(mk({ lockWaitMs: 100 }).get("/wt/a")).rejects.toThrow(/locked/);
		expect(fs.readFileSync(lock, "utf8")).toBe(`${process.pid}:live`);
	});

	it("breaks a lock older than 60 s whatever its holder (a pid reused after a reboot must not wedge slots)", async () => {
		const lock = path.join(home, ".wolfpack", "preview", "slots.lock");
		fs.mkdirSync(path.dirname(lock), { recursive: true });
		fs.writeFileSync(lock, `${process.pid}:reused-pid`); // a live process holds this pid, but not this lock
		const old = (Date.now() - 61_000) / 1000; // file mtimes are real time; the injected clock is only for slot records
		fs.utimesSync(lock, old, old);
		expect((await mk().get("/wt/a")).port).toBe(3231);
	});

	it("does not hold the lock, or return, until the dead runner's leftovers are fully stopped", async () => {
		let finish!: () => void;
		const s = mk({ reapLeftovers: () => new Promise<void>((r) => (finish = r)) });
		await s.get("/wt/a");
		alive.delete(500);
		let done = false;
		const p = s.list().then(() => (done = true));
		await new Promise((r) => setTimeout(r, 30));
		expect(fs.existsSync(path.join(home, ".wolfpack", "preview", "slots.lock"))).toBe(false); // other commands are not kept waiting
		expect(done).toBe(false); // but this one has not claimed it is clean yet
		finish();
		await p;
		expect(done).toBe(true);
	});

	it("still waits for the leftovers to be stopped when the third slot is refused", async () => {
		let finish!: () => void;
		const s = mk({ reapLeftovers: () => new Promise<void>((r) => (finish = r)) });
		const preview = path.join(home, ".wolfpack", "preview");
		fs.mkdirSync(preview, { recursive: true });
		const rec = (port: number, wt: string, pid: number) => ({ port, worktree: wt, pid, startedAt: clock, lastUsed: clock });
		fs.writeFileSync(path.join(preview, "slots.json"), JSON.stringify({ slots: [rec(3231, "/wt/a", 500), rec(3232, "/wt/b", 501), rec(3233, "/wt/c", 502)] }));
		alive.add(501).add(502); // 500 is a dead runner; two live slots fill the cap
		let settled = false;
		const p = s.get("/wt/d").then(() => (settled = true), (e: Error) => ((settled = true), e.message));
		await new Promise((r) => setTimeout(r, 30));
		expect(settled).toBe(false);
		finish();
		expect(await p).toMatch(/2 slots/);
	});

	it("only forgets a record whose pid is held by some other process, and does not touch its group", async () => {
		const s = mk({ isAlive: () => false, pidExists: () => true });
		await s.get("/wt/a");
		expect(await s.list()).toEqual([]);
		expect(leftovers).toEqual([]);
	});
});

describe("agent slots: safety and readiness", () => {
	it("stops what survives a dead runner (its next and workers)", async () => {
		const s = mk();
		await s.get("/wt/a");
		alive.delete(500);
		await s.list();
		expect(leftovers).toEqual([3231]);
	});

	it("skips a port something else is already listening on", async () => {
		const s = mk({ portFree: async (p: number) => p !== 3231 });
		expect((await s.get("/wt/a")).port).toBe(3232);
	});

	it("returns the URL only once next is listening", async () => {
		let up!: (v: boolean) => void;
		const s = mk({ waitListening: () => new Promise<boolean>((r) => (up = r)) });
		let done = false;
		const p = s.get("/wt/a").then((r: unknown) => ((done = true), r));
		await new Promise((r) => setTimeout(r, 30));
		expect(done).toBe(false);
		up(true);
		expect(await p).toMatchObject({ port: 3231 });
	});

	it("says where the log is when next never starts listening", async () => {
		const s = mk({ waitListening: async () => false });
		await expect(s.get("/wt/a")).rejects.toThrow(/3231.*not listening.*slots\/3231\.log/s);
	});

	it("does not remove a lock that another command now holds", async () => {
		const lock = path.join(home, ".wolfpack", "preview", "slots.lock");
		const s = mk({ spawn: () => (fs.writeFileSync(lock, "other:token"), 500) });
		await s.get("/wt/a");
		expect(fs.readFileSync(lock, "utf8")).toBe("other:token");
	});

	it("refuses a worktree whose workspace packages are not built", async () => {
		const wt = path.join(home, "wt");
		fs.mkdirSync(path.join(wt, "apps", "console", "node_modules", "next", "dist", "bin"), { recursive: true });
		fs.writeFileSync(path.join(wt, "apps", "console", "node_modules", "next", "dist", "bin", "next"), "");
		fs.writeFileSync(path.join(wt, "apps", "console", "package.json"), JSON.stringify({ dependencies: { "@wolfpack/client": "*", react: "1" } }));
		fs.mkdirSync(path.join(wt, "packages", "client"), { recursive: true });
		fs.writeFileSync(path.join(wt, "packages", "client", "package.json"), JSON.stringify({ name: "@wolfpack/client", main: "dist/index.js" }));
		const s = mk({ prepare: undefined });
		await expect(s.get(wt)).rejects.toThrow(/@wolfpack\/client.*pnpm build/s);
		fs.mkdirSync(path.join(wt, "packages", "client", "dist"));
		expect((await s.get(wt)).port).toBe(3231);
	});

	it("keeps the hub token out of slots.json and says when there is none", async () => {
		const r = await mk().get("/wt/a");
		expect(fs.readFileSync(path.join(home, ".wolfpack", "preview", "slots.json"), "utf8")).not.toContain("tok-1");
		expect(r.noToken).toBe(false);
		expect((await mk({ env: {} }).get("/wt/b")).noToken).toBe(true);
	});

	it("caps the configurable limit at 4 slots", async () => {
		const s = mk({ env: { PREVIEW_SLOT_MAX: "9" } });
		for (const w of ["a", "b", "c", "d"]) await s.get(`/wt/${w}`);
		await expect(s.get("/wt/e")).rejects.toThrow(/4 slots/);
	});

	it("releases by the worktree's folder name, even after the folder is gone", async () => {
		const s = mk();
		await s.get("/gone/feat-a");
		expect(await s.release("feat-a")).toBe(3231);
	});
});
