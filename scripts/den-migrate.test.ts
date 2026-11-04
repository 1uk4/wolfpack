import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanSecrets } from "../packages/memory/src/work/secrets.js";
// @ts-expect-error plain .mjs script
import { migrate, render } from "./den-migrate.mjs";

let tmp: string, src: string, den: string, home: string;
const put = (root: string, rel: string, body: string, mtime?: number) => {
	const p = path.join(root, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, body);
	if (mtime) fs.utimesSync(p, mtime, mtime);
};
const run = (o: object = {}) => migrate({ source: src, target: den, home, scan: scanSecrets, ...o });
const MT = 1_700_000_000;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "denmig-")));
	src = path.join(tmp, "old/den");
	home = path.join(tmp, "hal2");
	den = path.join(home, "den");
	// sanitized fixture shaped like the old Hal den
	put(src, "NOTES.md", "# Hal\n\n## Skills\n- **gym-log** — workouts\n- **day-planner** — schedule\n", MT);
	put(src, "fitness/lift-log.csv", "date,lift\n1,squat\n", MT);
	put(src, "fitness/lift-log.csv.bak-1", "old");
	put(src, "fitness/Training Program.md", "# plan");
	put(src, "vehicles/f150/notes.md", "oil");
	put(src, "vehicles/f150/._x", "junk");
	put(src, "memory/INDEX.md", "# idx");
	put(src, "memory/topics/a.md", "---\nid: a\n---\nA from hal");
	put(src, "memory/topics/b.md", "B");
	put(src, "memory/archive/z.md", "Z");
	fs.mkdirSync(path.join(src, "memory/items"), { recursive: true });
	put(src, ".memory/pool/observations.jsonl", '{"id":1}\n');
	put(src, ".memory/archive/observations-1.jsonl", '{"id":0}\n');
	for (const s of ["gym-log", "fuel-log", "day-planner"]) put(src, `skills/${s}/SKILL.md`, `---\nname: ${s}\n---\n`);
	put(src, "kb/emitted.json", "{}");
	put(src, "kb/distill/x.json", "{}");
	put(src, "usage/u.jsonl", "{}");
	put(src, "telegram/rules.pdf", "pdf");
	put(src, "session.sqlite", "SQLITE");
	put(src, "session.sqlite-wal", "");
	put(src, "status.json", "{}");
	put(src, "tasks/active.json", "null");
	put(src, "factory/.keep", "");
	put(src, "planner/p.md", "p");
	put(src, "extensions/e/index.ts", "x");
	// hal2's own state
	put(den, "memory/topics/a.md", "hal2 own A");
	put(den, ".memory/pool/observations.jsonl", '{"id":"h2"}\n');
	put(home, "agent/AGENTS.md", "# hal2 persona\n");
});
afterEach(() => {
	const unlock = (d: string) => {
		if (!fs.existsSync(d)) return;
		fs.chmodSync(d, 0o755);
		for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) unlock(path.join(d, e.name));
	};
	unlock(tmp);
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("den-migrate", () => {
	it("dry run writes nothing and plans every class", () => {
		const before = fs.readdirSync(home).sort();
		const r = run();
		expect(fs.readdirSync(home).sort()).toEqual(before);
		expect(fs.existsSync(path.join(den, "fitness"))).toBe(false);
		const st = (rel: string) => r.entries.find((e: any) => e.src === rel);
		expect(st("fitness/lift-log.csv").kind).toBe("copy");
		expect(st("fitness/lift-log.csv.bak-1").status).toBe("dropped");
		expect(st("vehicles/f150/._x")).toBeUndefined();
		expect(st("skills/gym-log/SKILL.md").kind).toBe("port");
		expect(st("skills/day-planner/SKILL.md").status).toBe("dropped");
		expect(st("kb/emitted.json").kind).toBe("archive");
		expect(st("session.sqlite").kind).toBe("archive");
		expect(st("session.sqlite-wal").status).toBe("dropped");
		expect(st("memory/topics/a.md").status).toBe("collision->renamed");
		expect(st("memory/INDEX.md").status).toBe("skipped");
		expect(st("status.json").status).toBe("dropped");
		expect(render(r)).toContain("DRY RUN");
	});

	it("apply produces the tree, never clobbers, preserves mtimes", () => {
		run({ apply: true });
		const f = (...p: string[]) => path.join(den, ...p);
		expect(fs.readFileSync(f("memory/topics/a.md"), "utf8")).toBe("hal2 own A");
		expect(fs.readFileSync(f("memory/topics/legacy-hal-a.md"), "utf8")).toContain("A from hal");
		expect(fs.existsSync(f("memory/topics/b.md"))).toBe(true);
		expect(fs.existsSync(f("memory/items"))).toBe(true);
		expect(fs.readFileSync(f(".memory/pool/observations.jsonl"), "utf8")).toBe('{"id":"h2"}\n');
		expect(fs.existsSync(f(".memory/archive/legacy-hal-pool-observations.jsonl"))).toBe(true);
		expect(fs.existsSync(f(".memory/archive/observations-1.jsonl"))).toBe(true);
		expect(fs.existsSync(f("skills/gym-log/SKILL.md"))).toBe(true);
		expect(fs.existsSync(f("skills/fuel-log/SKILL.md"))).toBe(true);
		expect(fs.existsSync(f("skills/day-planner"))).toBe(false);
		expect(fs.existsSync(f("fitness/lift-log.csv.bak-1"))).toBe(false);
		expect(fs.statSync(f("fitness/lift-log.csv")).mtimeMs / 1000).toBeCloseTo(MT, 0);
		expect(fs.existsSync(f("factory"))).toBe(false);
		expect(fs.existsSync(f("kb"))).toBe(false);
		const arch = path.join(home, "migration/archive");
		expect(fs.existsSync(path.join(arch, "kb/emitted.json"))).toBe(true);
		expect(fs.existsSync(path.join(arch, "session.sqlite"))).toBe(true);
		expect(fs.statSync(path.join(arch, "usage/u.jsonl")).mode & 0o222).toBe(0);
		const persona = fs.readFileSync(path.join(home, "migration/AGENTS.proposed.md"), "utf8");
		expect(persona).toContain("# hal2 persona");
		expect(persona).toContain("gym-log");
		expect(persona).not.toContain("day-planner **");
		expect(persona).not.toMatch(/\*\*day-planner\*\*/);
		expect(fs.readFileSync(path.join(home, "agent/AGENTS.md"), "utf8")).toBe("# hal2 persona\n");
		// source untouched
		expect(fs.existsSync(path.join(src, "NOTES.md"))).toBe(true);
	});

	it("is idempotent and picks up later source changes without clobbering", () => {
		run({ apply: true });
		const again = run({ apply: true });
		expect(again.entries.every((e: any) => !e._op && !e._write)).toBe(true);
		put(src, "fitness/lift-log.csv", "date,lift\n1,squat\n2,bench\n", MT + 100);
		put(src, "kb/emitted.json", '{"n":2}');
		const r = run({ apply: true });
		expect(r.entries.find((e: any) => e.src === "fitness/lift-log.csv").status).toBe("update");
		expect(fs.readFileSync(path.join(den, "fitness/lift-log.csv"), "utf8")).toContain("bench");
		expect(fs.readFileSync(path.join(home, "migration/archive/kb/emitted.json"), "utf8")).toBe('{"n":2}');
		// owner edits the migrated file in hal2; a later sync must not overwrite it
		fs.writeFileSync(path.join(den, "fitness/lift-log.csv"), "hal2 edit");
		put(src, "fitness/lift-log.csv", "newer", MT + 200);
		const r2 = run({ apply: true });
		expect(r2.entries.find((e: any) => e.src === "fitness/lift-log.csv").status).toBe("collision->renamed");
		expect(fs.readFileSync(path.join(den, "fitness/lift-log.csv"), "utf8")).toBe("hal2 edit");
	});

	it("skill collisions are skipped, secret-looking files withheld", () => {
		put(den, "skills/gym-log/SKILL.md", "hal2 gym");
		put(src, "vehicles/leak.md", "api_key = sk-abcdefghijklmnopqrstuvwxyz0123456789");
		const r = run({ apply: true });
		expect(r.entries.find((e: any) => e.src === "skills/gym-log/SKILL.md").status).toBe("collision-skipped");
		expect(fs.readFileSync(path.join(den, "skills/gym-log/SKILL.md"), "utf8")).toBe("hal2 gym");
		expect(r.entries.find((e: any) => e.src === "vehicles/leak.md").status).toBe("withheld");
		expect(fs.existsSync(path.join(den, "vehicles/leak.md"))).toBe(false);
		expect(r.secrets).toHaveLength(1);
		const ok = run({ apply: true, allow: ["vehicles/leak.md"] });
		expect(ok.entries.find((e: any) => e.src === "vehicles/leak.md").status).toBe("new");
	});
});
