import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDenTopics } from "../packages/memory/src/den.js";
import { scanSecrets } from "../packages/memory/src/work/secrets.js";
// @ts-expect-error plain .mjs script
import { guardPaths, holdTopic, loadScanner, migrate, render, resolveOwner } from "./den-migrate.mjs";

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), "den-migrate.mjs");
const TG = `${"1".repeat(9)}:${"A".repeat(35)}`;
const SK = `sk-${"a".repeat(30)}`;
const MT = 1_700_000_000;

let tmp: string, src: string, den: string, home: string;
const put = (root: string, rel: string, body: string | Buffer, mtime?: number, mode?: number) => {
	const p = path.join(root, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, body);
	if (mtime) fs.utimesSync(p, mtime, mtime);
	if (mode) fs.chmodSync(p, mode);
};
const run = (o: object = {}) => migrate({ source: src, target: den, home, scan: scanSecrets, sourceStopped: true, ...o });
const find = (r: any, rel: string) => r.entries.find((e: any) => e.src === rel);
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
const unlock = (d: string) => {
	const st = fs.lstatSync(d, { throwIfNoEntry: false });
	if (!st || !st.isDirectory()) return;
	fs.chmodSync(d, 0o755);
	for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) unlock(path.join(d, e.name));
};
function snapshot(root: string, rel = ""): Record<string, string> {
	const out: Record<string, string> = {};
	for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
		const r = rel ? `${rel}/${e.name}` : e.name;
		const p = path.join(root, r);
		const st = fs.lstatSync(p);
		if (e.isDirectory()) Object.assign(out, { [r + "/"]: `${st.mode}`, ...snapshot(root, r) });
		else if (e.isSymbolicLink()) out[r] = `link ${fs.readlinkSync(p)}`;
		else if (e.isFile()) out[r] = `${sha(fs.readFileSync(p))} ${st.mode} ${Math.floor(st.mtimeMs)}`;
		else out[r] = "special";
	}
	return out;
}

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "denmig-")));
	src = path.join(tmp, "old/den");
	home = path.join(tmp, "hal2");
	den = path.join(home, "den");
	put(src, "NOTES.md", "# Hal\n\n## Skills\n- **gym-log** — workouts\n- **day-planner** — schedule\n", MT);
	put(src, "fitness/lift-log.csv", "date,lift\n1,squat\n", MT, 0o640);
	put(src, "fitness/lift-log.csv.bak-1", "old");
	put(src, "fitness/Training Program.md", "# plan");
	put(src, "vehicles/f150/notes.md", "oil");
	put(src, "vehicles/f150/._x", "junk");
	put(src, "memory/INDEX.md", "# idx");
	put(src, "memory/topics/a.md", "---\nid: a\ntitle: A\nsummary: s\nupdated: x\nrelated: []\n---\nA from hal");
	put(src, "memory/topics/b.md", "B without frontmatter");
	put(src, "memory/archive/z.md", "---\nid: z\n---\nZ");
	fs.mkdirSync(path.join(src, "memory/items"), { recursive: true });
	put(src, ".memory/pool/observations.jsonl", '{"id":1}\n');
	put(src, ".memory/archive/observations-1.jsonl", '{"id":0}\n');
	for (const s of ["gym-log", "fuel-log", "day-planner"]) put(src, `skills/${s}/SKILL.md`, `---\nname: ${s}\n---\n`);
	put(src, "kb/emitted.json", "{}");
	put(src, "kb/distill/x.json", "{}");
	put(src, "usage/u.jsonl", "{}");
	put(src, "telegram/rules.pdf", "pdf");
	put(src, "session.sqlite", "SQLITE", MT);
	put(src, "session.sqlite-wal", "", MT);
	put(src, "session.sqlite-shm", "shm", MT);
	put(src, "status.json", "{}");
	put(src, "tasks/active.json", "null");
	put(src, "factory/.keep", "");
	put(src, "planner/p.md", "p");
	put(src, "extensions/e/index.ts", "x");
	put(den, "memory/topics/a.md", "hal2 own A");
	put(den, ".memory/pool/observations.jsonl", '{"id":"h2"}\n');
	put(home, "agent/AGENTS.md", "# hal2 persona\n");
});
afterEach(() => {
	unlock(tmp);
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("plan (dry run)", () => {
	it("writes nothing and classifies every path", () => {
		const before = snapshot(tmp);
		const r = run();
		expect(snapshot(tmp)).toEqual(before);
		expect(find(r, "fitness/lift-log.csv").kind).toBe("copy");
		expect(find(r, "fitness/lift-log.csv.bak-1").status).toBe("dropped");
		expect(find(r, "vehicles/f150/._x")).toBeUndefined();
		expect(find(r, "skills/gym-log/SKILL.md").kind).toBe("port");
		expect(find(r, "skills/day-planner/SKILL.md").status).toBe("dropped");
		for (const f of ["session.sqlite", "session.sqlite-wal", "session.sqlite-shm", "kb/emitted.json"]) expect(find(r, f).kind).toBe("archive");
		expect(find(r, "memory/topics/a.md").status).toBe("collision->renamed");
		expect(find(r, "memory/INDEX.md").status).toBe("skipped");
		expect(find(r, "status.json").status).toBe("dropped");
		expect(r.owner).toEqual({ uid: fs.statSync(den).uid, gid: fs.statSync(den).gid });
		expect(render(r)).toContain("DRY RUN");
	});

	it("reports symlinks, FIFOs in the source as skipped and never follows them", () => {
		fs.symlinkSync("/etc", path.join(src, "vehicles/etc-link"));
		fs.symlinkSync(path.join(src, "NOTES.md"), path.join(src, "fitness/notes-link.md"));
		execFileSync("mkfifo", [path.join(src, "vehicles/pipe")]);
		const r = run({ apply: true });
		for (const f of ["vehicles/etc-link", "fitness/notes-link.md", "vehicles/pipe"]) {
			expect(find(r, f).status).toBe("skipped");
			expect(find(r, f).note).toMatch(/symlink|fifo/);
		}
		expect(fs.existsSync(path.join(den, "vehicles/etc-link"))).toBe(false);
		expect(fs.existsSync(path.join(den, "vehicles/pipe"))).toBe(false);
	});
});

describe("apply", () => {
	it("produces the tree, never clobbers, keeps mtimes and source modes, holds topics", () => {
		run({ apply: true });
		const f = (...p: string[]) => path.join(den, ...p);
		expect(fs.readFileSync(f("memory/topics/a.md"), "utf8")).toBe("hal2 own A");
		expect(fs.readFileSync(f("memory/topics/legacy-hal-a.md"), "utf8")).toContain("A from hal");
		expect(fs.existsSync(f("memory/items"))).toBe(true);
		expect(fs.readFileSync(f(".memory/pool/observations.jsonl"), "utf8")).toBe('{"id":"h2"}\n');
		expect(fs.existsSync(f(".memory/archive/legacy-hal-pool-observations.jsonl"))).toBe(true);
		expect(fs.existsSync(f("skills/gym-log/SKILL.md"))).toBe(true);
		expect(fs.existsSync(f("skills/day-planner"))).toBe(false);
		expect(fs.existsSync(f("fitness/lift-log.csv.bak-1"))).toBe(false);
		expect(fs.existsSync(f("factory"))).toBe(false);
		expect(fs.statSync(f("fitness/lift-log.csv")).mtimeMs / 1000).toBeCloseTo(MT, 0);
		expect(fs.statSync(f("fitness/lift-log.csv")).mode & 0o777).toBe(0o640);
		// no temp files left behind
		const all = JSON.stringify(Object.keys(snapshot(tmp)));
		expect(all).not.toContain(".dm-");
		// migrated topics can never be resent to the KB
		const topics = readDenTopics(den).filter((t) => t.id !== "a" || t.body.includes("A from hal") || true);
		const legacy = topics.filter((t) => t.filePath.includes("legacy-hal-") || t.id === "b");
		expect(legacy.length).toBeGreaterThan(0);
		for (const t of legacy) expect(t.promotable).toBe(false);
		expect(fs.readFileSync(f("memory/archive/z.md"), "utf8")).toContain("promotable: false");
		// archive
		const arch = path.join(home, "migration/archive");
		expect(fs.existsSync(path.join(arch, "kb/emitted.json"))).toBe(true);
		for (const s of ["", "-wal", "-shm"]) expect(fs.existsSync(path.join(arch, `session.sqlite${s}`))).toBe(true);
		expect(fs.statSync(path.join(arch, "usage/u.jsonl")).mode & 0o777).toBe(0o400);
		expect(fs.statSync(path.join(arch, "usage")).mode & 0o777).toBe(0o500);
		expect(fs.statSync(arch).mode & 0o777).toBe(0o500);
		// persona proposed, installed persona untouched
		const persona = fs.readFileSync(path.join(home, "migration/AGENTS.proposed.md"), "utf8");
		expect(persona).toContain("# hal2 persona");
		expect(persona).toContain("gym-log");
		expect(persona).not.toMatch(/\*\*day-planner\*\*/);
		expect(fs.readFileSync(path.join(home, "agent/AGENTS.md"), "utf8")).toBe("# hal2 persona\n");
	});

	it("leaves the source byte-for-byte untouched (hashes, modes, mtimes)", () => {
		const before = snapshot(src);
		run({ apply: true });
		expect(snapshot(src)).toEqual(before);
		run({ apply: true });
		expect(snapshot(src)).toEqual(before);
	});

	it("is idempotent, picks up source changes, never overwrites hal2 edits", () => {
		run({ apply: true });
		const again = run({ apply: true });
		expect(again.entries.every((e: any) => !e._op)).toBe(true);
		put(src, "fitness/lift-log.csv", "date,lift\n1,squat\n2,bench\n", MT + 100);
		put(src, "kb/emitted.json", '{"n":2}');
		const r = run({ apply: true });
		expect(find(r, "fitness/lift-log.csv").status).toBe("update");
		expect(fs.readFileSync(path.join(den, "fitness/lift-log.csv"), "utf8")).toContain("bench");
		expect(fs.readFileSync(path.join(home, "migration/archive/kb/emitted.json"), "utf8")).toBe('{"n":2}');
		expect(fs.statSync(path.join(home, "migration/archive")).mode & 0o777).toBe(0o500);
		fs.writeFileSync(path.join(den, "fitness/lift-log.csv"), "hal2 edit");
		put(src, "fitness/lift-log.csv", "newer", MT + 200);
		const r2 = run({ apply: true });
		expect(find(r2, "fitness/lift-log.csv").status).toBe("collision->renamed");
		expect(fs.readFileSync(path.join(den, "fitness/lift-log.csv"), "utf8")).toBe("hal2 edit");
	});

	it("skips a colliding skill", () => {
		put(den, "skills/gym-log/SKILL.md", "hal2 gym");
		const r = run({ apply: true });
		expect(find(r, "skills/gym-log/SKILL.md").status).toBe("collision-skipped");
		expect(fs.readFileSync(path.join(den, "skills/gym-log/SKILL.md"), "utf8")).toBe("hal2 gym");
	});
});

describe("persona", () => {
	it("never overwrites an edited AGENTS.proposed.md, but refreshes an untouched one", () => {
		run({ apply: true });
		const p = path.join(home, "migration/AGENTS.proposed.md");
		put(src, "NOTES.md", "# Hal\n\nnew line one\n", MT + 5);
		const r1 = run({ apply: true });
		expect(find(r1, "NOTES.md").status).toBe("update");
		expect(fs.readFileSync(p, "utf8")).toContain("new line one");
		fs.writeFileSync(p, "owner edited this");
		put(src, "NOTES.md", "# Hal\n\nnew line two\n", MT + 9);
		const r2 = run({ apply: true });
		expect(find(r2, "NOTES.md").status).toBe("collision-skipped");
		expect(fs.readFileSync(p, "utf8")).toBe("owner edited this");
		expect(r2.problems.map((e: any) => e.src)).toContain("NOTES.md");
	});

	it("withholds the persona when NOTES.md contains a secret", () => {
		put(src, "NOTES.md", `# Hal\nbot token ${TG}\n`);
		const r = run({ apply: true });
		expect(find(r, "NOTES.md").status).toBe("withheld");
		expect(fs.existsSync(path.join(home, "migration/AGENTS.proposed.md"))).toBe(false);
	});
});

describe("secrets", () => {
	it("withholds secret filenames", () => {
		for (const n of [".env", ".env.local", "auth.json", "auth-profile.json", "telegram.json", "api_token.txt", "id_rsa", "x.pem", "y.key"]) put(src, `vehicles/${n}`, "harmless");
		const r = run({ apply: true });
		for (const n of [".env", ".env.local", "auth.json", "auth-profile.json", "telegram.json", "api_token.txt", "id_rsa", "x.pem", "y.key"]) {
			expect(find(r, `vehicles/${n}`).status).toBe("withheld");
			expect(fs.existsSync(path.join(den, "vehicles", n))).toBe(false);
		}
	});

	it("scans files with any extension, binary included", () => {
		put(src, "vehicles/notes.dat", `key ${SK}`);
		put(src, "vehicles/blob.bin", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(SK)]));
		put(src, "vehicles/pic.bin", Buffer.from([0, 1, 2, 3]));
		put(src, "vehicles/big.txt", "x".repeat(3 * 1024 * 1024));
		const r = run({ apply: true });
		expect(find(r, "vehicles/notes.dat").note).toMatch(/secret-looking content/);
		expect(find(r, "vehicles/blob.bin").note).toMatch(/binary file.*secret-looking content/);
		expect(find(r, "vehicles/pic.bin").note).toMatch(/binary file/);
		expect(find(r, "vehicles/big.txt").note).toMatch(/oversized/);
		for (const n of ["notes.dat", "blob.bin", "pic.bin", "big.txt"]) expect(fs.existsSync(path.join(den, "vehicles", n))).toBe(false);
		expect(r.secrets.map((s: any) => s.src).sort()).toEqual(["vehicles/blob.bin", "vehicles/notes.dat"]);
	});

	it("scans archive files too", () => {
		put(src, "usage/leak.jsonl", `{"bot":"${TG}"}`);
		put(src, "kb/bin.dat", Buffer.concat([Buffer.from([0]), Buffer.from(SK)]));
		const r = run({ apply: true });
		expect(find(r, "usage/leak.jsonl").status).toBe("withheld");
		expect(find(r, "kb/bin.dat").status).toBe("withheld");
		expect(fs.existsSync(path.join(home, "migration/archive/usage/leak.jsonl"))).toBe(false);
		expect(fs.existsSync(path.join(home, "migration/archive/usage/u.jsonl"))).toBe(true);
	});

	it("--allow is bound to a content hash: right hash passes loudly, stale hash does not", () => {
		const body = `key ${SK}`;
		put(src, "vehicles/notes.dat", body);
		const good = `vehicles/notes.dat@${sha(body).slice(0, 12)}`;
		const ok = run({ apply: true, allow: [good] });
		expect(find(ok, "vehicles/notes.dat").status).toBe("new");
		expect(ok.warnings.join("\n")).toMatch(/LOUD: --allow overrides withheld file vehicles\/notes.dat/);
		fs.rmSync(path.join(den, "vehicles/notes.dat"));
		put(src, "vehicles/notes.dat", `${body} changed`);
		const stale = run({ apply: true, allow: [good] });
		expect(find(stale, "vehicles/notes.dat").status).toBe("withheld");
		expect(find(stale, "vehicles/notes.dat").note).toMatch(/stale --allow hash/);
		expect(() => run({ allow: ["vehicles/notes.dat"] })).toThrow(/--allow must be/);
	});

	it("--no-scan with --apply needs --yes-skip-scan", () => {
		put(src, "vehicles/notes.dat", `key ${SK}`);
		expect(() => run({ apply: true, scan: null })).toThrow(/--yes-skip-scan/);
		expect(fs.existsSync(path.join(den, "vehicles"))).toBe(false);
		const dry = run({ scan: null });
		expect(dry.applied).toBe(false);
		const r = run({ apply: true, scan: null, noScanConfirmed: true });
		expect(r.warnings.join("\n")).toMatch(/secret scan SKIPPED/);
		expect(fs.existsSync(path.join(den, "vehicles/notes.dat"))).toBe(true);
	});

	it("fails loudly when the built scanner is stale or out of date", async () => {
		const root = path.join(tmp, "repo");
		put(root, "packages/memory/dist/work/secrets.js", "export const scanSecrets = () => ({ text: '', findings: [] });");
		await expect(loadScanner(root)).rejects.toThrow(/canary/);
		put(root, "packages/memory/src/work/secrets.ts", "// newer");
		fs.utimesSync(path.join(root, "packages/memory/dist/work/secrets.js"), 1, 1);
		await expect(loadScanner(root)).rejects.toThrow(/stale/);
		await expect(loadScanner(path.join(tmp, "nope"))).rejects.toThrow(/not built/);
	});

	it("the built scanner agrees with src on the Telegram token", async () => {
		const dist = path.join(path.dirname(SCRIPT), "..", "packages/memory/dist/work/secrets.js");
		if (!fs.existsSync(dist)) return; // not built in this checkout
		const scan = await loadScanner();
		expect(scan(TG).findings).toEqual(scanSecrets(TG).findings);
	});
});

describe("target-side safety", () => {
	it("does not follow a symlinked directory in the target", () => {
		const outside = path.join(tmp, "outside");
		fs.mkdirSync(outside);
		fs.mkdirSync(den, { recursive: true });
		fs.symlinkSync(outside, path.join(den, "fitness"));
		const r = run({ apply: true });
		expect(find(r, "fitness/lift-log.csv").status).toBe("unsafe-skipped");
		expect(find(r, "fitness/lift-log.csv").note).toMatch(/symlink/);
		expect(fs.readdirSync(outside)).toEqual([]);
		expect(fs.existsSync(path.join(den, "vehicles/f150/notes.md"))).toBe(true);
	});

	it("does not write through a symlinked destination file or dangling link", () => {
		const victim = path.join(tmp, "victim.txt");
		fs.writeFileSync(victim, "keep");
		fs.mkdirSync(path.join(den, "fitness"), { recursive: true });
		fs.symlinkSync(victim, path.join(den, "fitness/lift-log.csv"));
		fs.symlinkSync(path.join(tmp, "dangling"), path.join(den, "fitness/Training Program.md"));
		const r = run({ apply: true });
		expect(find(r, "fitness/lift-log.csv").status).toBe("unsafe-skipped");
		expect(find(r, "fitness/Training Program.md").status).toBe("unsafe-skipped");
		expect(fs.readFileSync(victim, "utf8")).toBe("keep");
		expect(fs.existsSync(path.join(tmp, "dangling"))).toBe(false);
	});

	it("does not follow a symlinked migration dir", () => {
		const outside = path.join(tmp, "outside");
		fs.mkdirSync(outside);
		fs.symlinkSync(outside, path.join(home, "migration"));
		expect(find(run(), "kb/emitted.json").status).toBe("unsafe-skipped");
		expect(() => run({ apply: true })).toThrow(/symlink in destination path: migration/);
		expect(fs.readdirSync(outside)).toEqual([]);
	});

	it("marks a directory where a file belongs, or a file where a directory belongs, as skipped (no EISDIR/ENOTDIR crash)", () => {
		fs.mkdirSync(path.join(den, "fitness/lift-log.csv"), { recursive: true });
		put(den, "vehicles", "i am a file");
		const r = run({ apply: true });
		expect(find(r, "fitness/lift-log.csv").status).toBe("collision-skipped");
		expect(find(r, "fitness/lift-log.csv").note).toMatch(/directory/);
		expect(find(r, "vehicles/f150/notes.md").status).toBe("unsafe-skipped");
		expect(find(r, "fitness/Training Program.md").status).toBe("new");
		expect(fs.readFileSync(path.join(den, "vehicles"), "utf8")).toBe("i am a file");
	});

	it("enforces path guards", () => {
		const g = (s: string, t: string, h: string) => () => guardPaths(s, t, h);
		expect(g(src, src, tmp)).toThrow(/same directory/);
		expect(g(src, path.join(src, "inner"), tmp)).toThrow(/nested/);
		expect(g(path.join(den, "x"), den, home)).toThrow(/not found|nested/);
		fs.mkdirSync(path.join(den, "x"), { recursive: true });
		expect(g(path.join(den, "x"), den, home)).toThrow(/nested/);
		expect(g(src, den, path.join(tmp, "elsewhere"))).toThrow(/ancestor/);
		expect(g(src, home, home)).toThrow(/ancestor/);
		const link = path.join(tmp, "srclink");
		fs.symlinkSync(src, link);
		expect(g(link, den, home)).toThrow(/source is a symlink/);
		const tlink = path.join(home, "denlink");
		fs.symlinkSync(den, tlink);
		expect(g(src, tlink, home)).toThrow(/target is a symlink/);
		const hlink = path.join(tmp, "homelink");
		fs.symlinkSync(home, hlink);
		expect(g(src, path.join(hlink, "den"), hlink)).toThrow(/home is a symlink/);
	});
});

describe("ownership", () => {
	it("lchowns every file and directory it creates, including migration/, state.json and AGENTS.proposed.md", () => {
		const pre = new Set<number>();
		const collect = (d: string, into: Set<number>) => {
			into.add(fs.lstatSync(d).ino);
			if (fs.lstatSync(d).isDirectory()) for (const e of fs.readdirSync(d)) collect(path.join(d, e), into);
		};
		collect(home, pre);
		const chowned = new Map<number, [number, number]>();
		const calls: string[] = [];
		const chown = (p: string, uid: number, gid: number) => {
			calls.push(p);
			chowned.set(fs.lstatSync(p).ino, [uid, gid]);
		};
		const fchown = (fd: number, uid: number, gid: number) => {
			calls.push(`fd:${fd}`);
			chowned.set(fs.fstatSync(fd).ino, [uid, gid]);
		};
		run({ apply: true, owner: { uid: 4242, gid: 2424 }, chown, fchown });
		expect(calls.some((c) => c.startsWith("fd:"))).toBe(true);
		expect(calls.length).toBeGreaterThan(10);
		const created: string[] = [];
		const walk = (d: string) => {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, e.name);
				if (!pre.has(fs.lstatSync(p).ino)) created.push(path.relative(home, p));
				if (e.isDirectory()) walk(p);
			}
		};
		walk(home);
		for (const need of ["migration", "migration/state.json", "migration/AGENTS.proposed.md", "migration/archive", "migration/archive/usage", "den/skills/gym-log", "den/skills/gym-log/SKILL.md", "den/vehicles/f150/notes.md"])
			expect(created).toContain(need);
		for (const c of created) expect(chowned.get(fs.lstatSync(path.join(home, c)).ino), c).toEqual([4242, 2424]);
	});

	it("defaults to the target den's owner and honours --chown", () => {
		const r = run();
		expect(r.ownerFrom).toBe("target den");
		const etc = path.join(tmp, "etc");
		put(etc, "passwd", "hal2:x:1234:2345::/home/hal2:/bin/sh\n");
		put(etc, "group", "wolves:x:3456:\n");
		expect(resolveOwner("hal2:wolves", etc)).toEqual({ uid: 1234, gid: 3456 });
		expect(resolveOwner("hal2", etc)).toEqual({ uid: 1234, gid: 2345 });
		expect(resolveOwner("7:8", etc)).toEqual({ uid: 7, gid: 8 });
		expect(() => resolveOwner("ghost:wolves", etc)).toThrow(/unknown user/);
	});

	it("refuses --apply as root when no owner resolves", () => {
		const calls: string[] = [];
		const o = { source: src, target: path.join(tmp, "nohome/den"), home: path.join(tmp, "nohome"), scan: scanSecrets, sourceStopped: true, apply: true, isRoot: true, chown: (p: string) => calls.push(p) };
		expect(() => migrate(o)).toThrow(/no owner could be resolved/);
		expect(calls).toEqual([]);
		expect(fs.existsSync(path.join(tmp, "nohome"))).toBe(false);
	});
});

describe("crash safety", () => {
	it("persists state per file, relocks the archive and cleans temp files when a write fails midway, then recovers", () => {
		let n = 0;
		const boom = () => {
			if (++n === 14) throw new Error("disk on fire");
		};
		expect(() => run({ apply: true, owner: { uid: 1, gid: 1 }, chown: () => {}, fchown: boom })).toThrow(/disk on fire/);
		const stPath = path.join(home, "migration/state.json");
		const state = JSON.parse(fs.readFileSync(stPath, "utf8"));
		expect(Object.keys(state.files).length).toBeGreaterThan(0);
		expect(Object.keys(snapshot(tmp)).join()).not.toContain(".dm-");
		if (fs.existsSync(path.join(home, "migration/archive"))) expect(fs.statSync(path.join(home, "migration/archive")).mode & 0o777).toBe(0o500);
		const r = run({ apply: true });
		expect(r.problems).toEqual([]);
		for (const e of r.entries.filter((e: any) => ["copy", "port", "archive"].includes(e.kind) && !e.status.startsWith("collision"))) expect(["new", "same", "update"]).toContain(e.status);
		expect(fs.existsSync(path.join(den, "vehicles/f150/notes.md"))).toBe(true);
		expect(fs.existsSync(path.join(home, "migration/archive/session.sqlite"))).toBe(true);
	});

	it("adopts a file whose state record was lost to a crash, and then updates it normally", () => {
		run({ apply: true });
		const stPath = path.join(home, "migration/state.json");
		const state = JSON.parse(fs.readFileSync(stPath, "utf8"));
		delete state.files["den:fitness/lift-log.csv"];
		fs.writeFileSync(stPath, JSON.stringify(state));
		const r = run({ apply: true });
		expect(find(r, "fitness/lift-log.csv").status).toBe("same");
		expect(JSON.parse(fs.readFileSync(stPath, "utf8")).files["den:fitness/lift-log.csv"]).toBeTruthy();
		put(src, "fitness/lift-log.csv", "v2", MT + 50);
		expect(find(run({ apply: true }), "fitness/lift-log.csv").status).toBe("update");
	});

	it("a corrupt state.json is an error that says restore, not delete", () => {
		fs.mkdirSync(path.join(home, "migration"), { recursive: true });
		fs.writeFileSync(path.join(home, "migration/state.json"), "{not json");
		expect(() => run()).toThrow(/corrupt[\s\S]*Restore it[\s\S]*do NOT delete/);
	});
});

describe("sqlite", () => {
	it("warns on a non-empty WAL; a live-looking source only adds a warning once --source-stopped is given", () => {
		const now = Date.now();
		put(src, "session.sqlite-wal", "walbytes", Math.floor(now / 1000));
		const dry = run({ now });
		expect(dry.looksLive).toBe(true);
		expect(dry.warnings.join()).toMatch(/looks LIVE/);
		const applied = run({ apply: true, now });
		expect(applied.warnings.join()).toMatch(/despite --source-stopped/);
		expect(fs.readFileSync(path.join(home, "migration/archive/session.sqlite-wal"), "utf8")).toBe("walbytes");
		// an old non-empty WAL only warns
		put(src, "session.sqlite-wal", "walbytes", MT);
		const old = run({ now });
		expect(old.looksLive).toBe(false);
		expect(old.warnings.join()).toMatch(/non-empty/);
	});
});

describe("holdTopic", () => {
	it("adds promotable: false to frontmatter, creates it when missing, leaves held topics alone", () => {
		expect(holdTopic(Buffer.from("---\nid: a\n---\nbody")).toString()).toMatch(/^---\npromotable: false\npromotable_reason: .*\nid: a\n---\nbody$/);
		expect(holdTopic(Buffer.from("plain")).toString()).toMatch(/^---\npromotable: false\n[\s\S]*---\n\nplain$/);
		const held = Buffer.from("---\nid: a\npromotable: false\npromotable_reason: log\n---\nx");
		expect(holdTopic(held)).toBe(held);
		expect(holdTopic(Buffer.from("---\nid: a\npromotable: true\n---\nx")).toString()).not.toContain("promotable: true");
	});
});

describe("CLI", () => {
	const cli = (...args: string[]) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
	it("--json dry run exits 0, prints parseable JSON and writes nothing", () => {
		const before = snapshot(tmp);
		const r = cli("--source", src, "--target", den, "--home", home, "--no-scan", "--json");
		expect(r.status).toBe(0);
		const j = JSON.parse(r.stdout);
		expect(j.applied).toBe(false);
		expect(j.entries.find((e: any) => e.src === "skills/gym-log/SKILL.md").status).toBe("new");
		expect(j.entries[0]).not.toHaveProperty("_op");
		expect(snapshot(tmp)).toEqual(before);
	});
	it("--strict exits 2 when something is withheld; default exits 0", () => {
		put(src, "vehicles/.env", "A=1");
		const args = ["--source", src, "--target", den, "--home", home, "--no-scan"];
		expect(cli(...args).status).toBe(0);
		const s = cli(...args, "--strict");
		expect(s.status).toBe(2);
		expect(s.stdout).toMatch(/withheld: vehicles\/\.env/);
	});
	it("errors exit 1: bad args, --no-scan --apply without confirmation, nested paths", () => {
		expect(cli("--bogus").status).toBe(1);
		expect(cli("--source", src).status).toBe(1);
		const na = cli("--source", src, "--target", den, "--home", home, "--no-scan", "--apply", "--source-stopped");
		expect(na.status).toBe(1);
		expect(na.stderr).toMatch(/--yes-skip-scan/);
		expect(fs.existsSync(path.join(home, "migration"))).toBe(false);
		expect(cli("--source", src, "--target", path.join(src, "x"), "--home", tmp, "--no-scan").status).toBe(1);
	});
	it("--apply --strict on a clean fixture exits 0 and applies", () => {
		const r = cli("--source", src, "--target", den, "--home", home, "--no-scan", "--yes-skip-scan", "--apply", "--strict", "--source-stopped");
		expect(r.status).toBe(0);
		expect(fs.existsSync(path.join(den, "skills/fuel-log/SKILL.md"))).toBe(true);
	});
});

describe("cutover guards", () => {
	it("--apply refuses without --source-stopped and writes nothing; dry run does not need it", () => {
		expect(() => run({ apply: true, sourceStopped: false })).toThrow(/--source-stopped/);
		expect(fs.existsSync(path.join(home, "migration"))).toBe(false);
		expect(run({ sourceStopped: false }).applied).toBe(false);
		const r = spawnSync("node", [SCRIPT, "--source", src, "--target", den, "--home", home, "--no-scan", "--yes-skip-scan", "--apply"], { encoding: "utf8" });
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/--source-stopped/);
	});

	it("as root, a resolved owner of uid 0 is refused unless --chown is explicit", () => {
		const base = { apply: true, isRoot: true, owner: { uid: 0, gid: 0 }, chown: () => {}, fchown: () => {} };
		expect(() => run(base)).toThrow(/uid 0/);
		expect(fs.existsSync(path.join(home, "migration"))).toBe(false);
		expect(() => run({ ...base, chownSpec: "0:0" })).not.toThrow();
		expect(() => run({ ...base, owner: { uid: 5, gid: 5 } })).not.toThrow();
	});

	it("chowns files by fd (fchown), never by path", () => {
		const pathCalls: string[] = [];
		const fdCalls: number[] = [];
		run({ apply: true, owner: { uid: 7, gid: 7 }, chown: (p: string) => pathCalls.push(p), fchown: (fd: number) => fdCalls.push(fd) });
		expect(fdCalls.length).toBeGreaterThan(30);
		for (const p of pathCalls) expect(fs.lstatSync(p).isDirectory()).toBe(true);
	});

	it("session.sqlite, -wal and -shm are all-or-none, and --allow on session.sqlite covers the set", () => {
		put(src, "session.sqlite-wal", `wal ${SK}`, MT);
		let r = run({ apply: true });
		for (const f of ["session.sqlite", "session.sqlite-wal", "session.sqlite-shm"]) expect(find(r, f).status).toBe("withheld");
		expect(find(r, "session.sqlite").note).toMatch(/all-or-none/);
		expect(fs.existsSync(path.join(home, "migration/archive/session.sqlite-shm"))).toBe(false);
		r = run({ apply: true, allow: [`session.sqlite@${sha("SQLITE").slice(0, 12)}`] });
		for (const f of ["session.sqlite", "session.sqlite-wal", "session.sqlite-shm"]) expect(find(r, f).status).toBe("new");
		expect(fs.existsSync(path.join(home, "migration/archive/session.sqlite-wal"))).toBe(true);
	});

	it("a flagged main db withholds its clean wal/shm", () => {
		put(src, "session.sqlite", `db ${SK}`, MT);
		const r = run({ apply: true });
		expect(find(r, "session.sqlite-shm").status).toBe("withheld");
		expect(find(r, "session.sqlite-wal").status).toBe("withheld");
		expect(r.problems.length).toBe(3);
	});

	it("keeps owner-write on copied files (mode | 0600) but 0400 in the archive", () => {
		put(src, "vehicles/ro.md", "x", MT, 0o444);
		run({ apply: true });
		expect(fs.statSync(path.join(den, "vehicles/ro.md")).mode & 0o777).toBe(0o644);
		expect(fs.statSync(path.join(home, "migration/archive/usage/u.jsonl")).mode & 0o777).toBe(0o400);
	});

	it("removes stale .dm-* temp files from earlier killed runs", () => {
		run({ apply: true });
		const a = path.join(den, "fitness/.lift-log.csv.dm-123-deadbeef");
		const b = path.join(home, "migration/archive/usage/.u.jsonl.dm-9-0123abcd");
		fs.writeFileSync(a, "x");
		fs.chmodSync(path.join(home, "migration/archive"), 0o700);
		fs.chmodSync(path.join(home, "migration/archive/usage"), 0o700);
		fs.writeFileSync(b, "x");
		fs.writeFileSync(path.join(den, "fitness/.keep-me"), "x");
		const r = run({ apply: true });
		expect(fs.existsSync(a)).toBe(false);
		expect(fs.existsSync(b)).toBe(false);
		expect(fs.existsSync(path.join(den, "fitness/.keep-me"))).toBe(true);
		expect(r.warnings.join("\n")).toMatch(/removed stale temp file/);
		expect(fs.statSync(path.join(home, "migration/archive/usage")).mode & 0o777).toBe(0o500);
	});

	it("--max-bytes sets the oversize limit", () => {
		put(src, "vehicles/mid.txt", "x".repeat(5000));
		expect(find(run({ maxBytes: 1000 }), "vehicles/mid.txt").note).toMatch(/oversized/);
		expect(find(run(), "vehicles/mid.txt").status).toBe("new");
		const cli = (...a: string[]) => spawnSync("node", [SCRIPT, "--source", src, "--target", den, "--home", home, "--no-scan", "--json", ...a], { encoding: "utf8" });
		expect(cli("--max-bytes", "abc").status).toBe(1);
		expect(JSON.parse(cli("--max-bytes", "1000").stdout).entries.find((e: any) => e.src === "vehicles/mid.txt").status).toBe("withheld");
		expect(JSON.parse(cli("--max-bytes", "10000").stdout).entries.find((e: any) => e.src === "vehicles/mid.txt").status).toBe("new");
	});
});
