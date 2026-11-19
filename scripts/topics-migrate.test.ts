import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), "topics-migrate.mjs");
let den: string;
const root = () => path.join(den, ".memory", "sessions", "durable");
const run = (...a: string[]) => spawnSync("node", [SCRIPT, "--den", den, "--json", ...a], { encoding: "utf8" });
const snapshot = () => fs.readdirSync(den, { recursive: true }).map(String).sort();

beforeEach(() => {
	den = fs.mkdtempSync(path.join(os.tmpdir(), "topics-migrate-test-"));
	fs.mkdirSync(root(), { recursive: true });
	fs.mkdirSync(path.join(den, ".memory", "archive"), { recursive: true });
	fs.writeFileSync(path.join(root(), "old.md"), "---\nid: old\ntitle: Old\nsummary: s\nupdated: 2026-10-01 10:00\n---\n\nbody\n");
	fs.writeFileSync(path.join(root(), "big.md"), `---\nid: big\ntitle: Big\nsummary: s\nupdated: 2026-10-01 10:00\n---\n\n${"x".repeat(9000)}\n`);
	fs.writeFileSync(path.join(den, ".memory", "archive", "observations-1.jsonl"), `${JSON.stringify({ timestamp: "2026-10-02 08:05", content: "c", recordedAt: "2026-10-02T08:05:00.000Z" })}\n`);
});
afterEach(() => fs.rmSync(den, { recursive: true, force: true }));

describe("topics-migrate", () => {
	it("a dry run writes nothing to the den and reports a decision per topic, splitting the oversized one", () => {
		const before = snapshot();
		const r = run();
		expect(r.status).toBe(0);
		const out = JSON.parse(r.stdout) as { summary: { mode: string }; decisions: Array<{ id: string; decision: string }> };
		expect(out.summary.mode).toBe("dry-run");
		expect(Object.fromEntries(out.decisions.map((d) => [d.id, d.decision]))).toEqual({ big: "split", old: "promote" });
		expect(snapshot()).toEqual(before);
	});

	it("--apply backfills legacy sources and seeds the active-hours clock, deleting nothing", () => {
		expect(run("--apply").status).toBe(0);
		expect(fs.readFileSync(path.join(root(), "old.md"), "utf8")).toContain("  - legacy");
		expect(JSON.parse(fs.readFileSync(path.join(den, "memory", "active-hours.json"), "utf8")).hours).toEqual(["2026-10-02T08"]);
		expect(fs.existsSync(path.join(root(), "big.md"))).toBe(true);
	});
});
