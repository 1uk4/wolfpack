#!/usr/bin/env node
// topics-migrate.mjs: bring an existing wolf den's session topics under the buffer-drain rules.
//
//   node scripts/topics-migrate.mjs --den <den> [--apply] [--json]
//
// Dry run is the default and writes NOTHING to <den>: it copies the topics and state files to a temp dir and runs the
// same pass function (runPromotePass, trigger "migration") and enforceByteCap there, with a stand-in for the KB (every
// chosen topic counts as "would promote", no receipts). It prints a decision per topic and the expected buffer size.
//   promote : eligible on this pass (a `legacy` topic, or all its sources quiet 8 active hours); keep-local never
//   keep    : stays (keep-local, or still active)
//   split   : over 8,000 characters; needs the model, done by consolidation / the live pass (never lost)
//   retire/evict : moved aside by the 180 KB cap (retired/ or evicted/, never deleted)
// --apply additionally: backfills `sources` (work/feature tags; else `legacy`) and `last_note` on the real topics,
// seeds <den>/memory/active-hours.json from the archived observation times (<den>/.memory/archive/*.jsonl), and runs
// enforceByteCap. It never deletes and never calls the KB: promotion happens on the next daily/owner pass.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = path.dirname(new URL(import.meta.url).pathname);
const mem = await import(pathToFileURL(path.join(here, "..", "packages", "memory", "dist", "index.js")).href);

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const den = val("--den");
if (!den || !fs.existsSync(den)) {
	console.error("usage: topics-migrate.mjs --den <den> [--apply] [--json]");
	process.exit(2);
}
const apply = flag("--apply");
const root = path.join(den, ".memory", "sessions", "durable");

/** Observation times from the archive (recordedAt, else timestamp read as UTC). */
function archivedStamps() {
	const dir = path.join(den, ".memory", "archive");
	if (!fs.existsSync(dir)) return [];
	const out = [];
	for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
		for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const o = JSON.parse(line);
				const raw = o.recordedAt ?? (o.timestamp ? `${String(o.timestamp).replace(" ", "T")}${/Z|[+-]\d\d:?\d\d$/.test(o.timestamp) ? "" : "Z"}` : "");
				const d = new Date(raw);
				if (!Number.isNaN(d.getTime())) out.push(d);
			} catch { /* a bad line is skipped */ }
		}
	}
	return out;
}

/** Backfill sources and last_note on every topic under `r` (a copy in a dry run). */
function backfill(r) {
	for (const t of mem.readTopics(r)) {
		const tags = [t.work, t.feature].filter(Boolean);
		const sources = t.sources?.length ? t.sources : tags.length ? tags : ["legacy"];
		mem.writeTopic(r, { id: t.id, title: t.title, summary: t.summary, updated: t.updated, body: t.body, domain: t.domain, sources, lastNote: t.lastNote, keepLocal: t.keepLocal, state: t.state });
	}
}

const bytesOf = (r) => (fs.existsSync(r) ? fs.readdirSync(r).filter((f) => f.endsWith(".md") && f !== "INDEX.md").reduce((n, f) => n + fs.statSync(path.join(r, f)).size, 0) : 0);

// Work on a copy: the pass and the cap run for real, only on the copy.
const sim = fs.mkdtempSync(path.join(os.tmpdir(), "topics-migrate-"));
const simRoot = path.join(sim, ".memory", "sessions", "durable");
fs.mkdirSync(path.dirname(simRoot), { recursive: true });
if (fs.existsSync(root)) fs.cpSync(root, simRoot, { recursive: true });
if (fs.existsSync(path.join(den, "memory"))) fs.cpSync(path.join(den, "memory"), path.join(sim, "memory"), { recursive: true });
mem.seedActiveHours(sim, archivedStamps());
backfill(simRoot);

const before = mem.readTopics(simRoot);
const beforeBytes = bytesOf(simRoot);
const promoted = [];
const pass = await mem.runPromotePass({
	den: sim, root: simRoot, trigger: { kind: "migration" },
	promote: async (ts) => { promoted.push(...ts.map((t) => t.id)); },
	outcomeOf: () => ({ kind: "pending" }),
	resolveEntry: (id) => id,
	rewriteHeld: async () => false,
});
const cap = mem.enforceByteCap({ den: sim, root: simRoot });
const decisions = before.map((t) => ({
	id: t.id,
	chars: t.body.length,
	decision: cap.retired.includes(t.id) ? "retire" : cap.evicted.includes(t.id) ? "evict" : t.body.length > mem.TOPIC_CHAR_CAP ? "split" : t.keepLocal ? "keep" : promoted.includes(t.id) ? "promote" : "keep",
}));
const summary = {
	den, mode: apply ? "apply" : "dry-run", topics: before.length, bytesBefore: beforeBytes, bytesAfterCap: bytesOf(simRoot),
	capBytes: mem.TOPICS_BYTE_CAP, counts: decisions.reduce((c, d) => ((c[d.decision] = (c[d.decision] ?? 0) + 1), c), {}), passRetired: pass.retired,
};

if (apply) {
	mem.seedActiveHours(den, archivedStamps());
	backfill(root);
	mem.enforceByteCap({ den, root });
}
fs.rmSync(sim, { recursive: true, force: true });

if (flag("--json")) console.log(JSON.stringify({ summary, decisions }, null, 2));
else {
	for (const d of decisions) console.log(`${d.decision.padEnd(8)} ${String(d.chars).padStart(6)} chars  ${d.id}`);
	console.log(JSON.stringify(summary));
}
