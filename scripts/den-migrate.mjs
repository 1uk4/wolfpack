#!/usr/bin/env node
// den-migrate.mjs: migrate an old pi-durable wolf den (e.g. wolf-ETAy7b "Hal") into a wolfd wolf's den.
//
//   node scripts/den-migrate.mjs --source <old den> --target <new den> [--home <new wolf home>]
//                                [--apply] [--allow <rel/path>]... [--no-scan] [--json]
//
// Dry run is the default: it prints the plan and writes nothing. --apply performs it.
// Idempotent: a re-run copies only what changed in the source (final sync at cutover). Never overwrites a
// target file it did not write itself; a differing file is a collision: the incoming copy lands next to it as
// `legacy-hal-<name>` (memory), or is skipped and reported (skills). The source is never modified.
// No host is touched except the two paths given. No wolf.yaml is read or written (domains unchanged).
//
// Layout it assumes (see packages/harness/src/wolfd/context.ts, packages/memory/src/den.ts):
//   skills   -> <target den>/skills/<name>/SKILL.md (wolfd loads every <den>/skills/<dir>/SKILL.md)
//   memory   -> <target den>/memory/{topics,items,archive}; observation pool <den>/.memory/pool/observations.jsonl
//   persona  -> proposed only: <home>/migration/AGENTS.proposed.md (wolfd reads wolf.yaml identity, else
//               <home>/agent/AGENTS.md). Nothing in <home>/agent is touched.
//   archive  -> <home>/migration/archive/ (read-only, never loaded); state -> <home>/migration/state.json
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const PREFIX = "legacy-hal-";
const TEXT_EXT = /\.(md|csv|jsonl|json|txt|yml|yaml)$/i;
const NOISE = (n) => n === ".DS_Store" || n === ".stfolder" || n.startsWith("._");

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const exists = (p) => fs.existsSync(p);

function walk(root, rel = "") {
	const out = [];
	const abs = path.join(root, rel);
	for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
		if (NOISE(e.name)) continue;
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...walk(root, r));
		else if (e.isFile()) out.push(r);
	}
	return out;
}

function sizeOf(root, rel) {
	const p = path.join(root, rel);
	if (!exists(p)) return 0;
	const st = fs.statSync(p);
	return st.isDirectory() ? walk(root, rel).reduce((n, f) => n + fs.statSync(path.join(root, f)).size, 0) : st.size;
}

/** Classify a source-relative file -> {kind, dest?, note?, renameOnCollision?} */
function classify(rel) {
	const parts = rel.split("/");
	const top = parts[0];
	const name = parts[parts.length - 1];
	if (top === "fitness") {
		if (/\.bak/.test(name)) return { kind: "drop", note: "backup file" };
		return { kind: "copy", dest: rel, rename: true };
	}
	if (top === "vehicles") return { kind: "copy", dest: rel, rename: true };
	if (top === "memory") {
		if (rel === "memory/INDEX.md") return { kind: "skip", note: "generated index: regenerated from topics, not copied" };
		if (["topics", "items", "archive"].includes(parts[1])) return { kind: "copy", dest: rel, rename: true };
		return { kind: "skip", note: "unclassified memory file" };
	}
	if (top === ".memory") {
		if (rel === ".memory/pool/observations.jsonl")
			return {
				kind: "copy",
				dest: `.memory/archive/${PREFIX}pool-observations.jsonl`,
				note: "old live pool kept as archive, NOT merged into the live pool (would be re-consolidated)",
			};
		if (parts[1] === "archive") return { kind: "copy", dest: rel, rename: true };
		return { kind: "skip", note: "unclassified .memory file" };
	}
	if (top === "skills") {
		if (parts[1] === "day-planner") return { kind: "drop", note: "day-planner skill dropped (owner decision)" };
		if (["gym-log", "fuel-log"].includes(parts[1])) return { kind: "port", dest: rel, rename: false };
		return { kind: "skip", note: "unknown skill: not ported" };
	}
	if (rel === "NOTES.md") return { kind: "persona" };
	if (["kb", "usage", "telegram"].includes(top)) return { kind: "archive", dest: rel };
	if (rel === "session.sqlite") return { kind: "archive", dest: rel };
	if (/^session\.sqlite-(shm|wal)$/.test(rel) || /^session\.sync-conflict/.test(rel))
		return { kind: "drop", note: "sqlite sidecar / sync-conflict file" };
	if (["factory", "planner", "tasks"].includes(top) || rel === "status.json")
		return { kind: "drop", note: "obsolete (empty / null state)" };
	if (top === "extensions") return { kind: "drop", note: "legacy pi extensions, not loaded by wolfd" };
	return { kind: "skip", note: "unclassified" };
}

function personaText(notes, existing) {
	const kept = notes
		.split("\n")
		.filter((l) => !/day-planner/i.test(l))
		.join("\n")
		.trim();
	const section = [
		"## Legacy Hal persona (migrated from wolf-ETAy7b NOTES.md)",
		"",
		"<!-- PROPOSED for owner review. day-planner skill line removed; check remaining mentions of daily",
		"planning/scheduling and Telegram-specific wording (wolfd has no Telegram reply keyboards). -->",
		"",
		kept.replace(/^# .*\n+/, ""),
		"",
	].join("\n");
	if (existing && existing.includes("## Legacy Hal persona")) return existing;
	return existing ? `${existing.trimEnd()}\n\n${section}` : `# Hal\n\n${section}`;
}

/**
 * @param {{source:string,target:string,home?:string,apply?:boolean,allow?:string[],scan?:(t:string)=>{findings:{kind:string,count:number}[]}|null}} o
 */
export function migrate(o) {
	const source = path.resolve(o.source);
	const target = path.resolve(o.target);
	const home = path.resolve(o.home ?? path.dirname(target));
	const mig = path.join(home, "migration");
	const archiveRoot = path.join(mig, "archive");
	const statePath = path.join(mig, "state.json");
	const allow = new Set(o.allow ?? []);
	const state = exists(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { files: {} };
	const nextState = { files: { ...state.files } };
	const entries = [];
	const secrets = [];

	const files = walk(source).sort();
	const topLevelNoise = fs.readdirSync(source).filter(NOISE);
	for (const n of topLevelNoise) entries.push({ kind: "drop", src: n, size: sizeOf(source, n), status: "dropped", note: "OS/sync noise" });

	// A target path is "ours" when its current hash is what we last wrote there.
	const owned = (key, abs) => state.files[key] && exists(abs) && state.files[key].sha === sha(abs);
	const resolve = (rootDir, key, srcAbs) => {
		const abs = path.join(rootDir, key);
		if (!exists(abs)) return { key, abs, status: "new" };
		if (sha(abs) === sha(srcAbs)) return { key, abs, status: "same" };
		if (owned(rootKey(rootDir, key), abs)) return { key, abs, status: "update" };
		return null;
	};
	const rootKey = (rootDir, key) => (rootDir === target ? `den:${key}` : `arch:${key}`);

	for (const rel of files) {
		const c = classify(rel);
		const srcAbs = path.join(source, rel);
		const size = fs.statSync(srcAbs).size;
		const base = { kind: c.kind, src: rel, size, note: c.note };
		if (c.kind === "drop") {
			entries.push({ ...base, status: "dropped" });
			continue;
		}
		if (c.kind === "skip") {
			entries.push({ ...base, status: "skipped" });
			continue;
		}
		if (c.kind === "persona") {
			const existing = [path.join(home, "agent", "AGENTS.md")].find(exists);
			const proposed = personaText(fs.readFileSync(srcAbs, "utf8"), existing ? fs.readFileSync(existing, "utf8") : "");
			const dest = path.join(mig, "AGENTS.proposed.md");
			const same = exists(dest) && fs.readFileSync(dest, "utf8") === proposed;
			entries.push({ ...base, dest: path.relative(home, dest), status: same ? "same" : exists(dest) ? "update" : "new", note: "proposed merged AGENTS.md, not installed", _write: same ? null : { dest, proposed } });
			continue;
		}
		const isText = TEXT_EXT.test(rel);
		if (isText && o.scan && c.kind !== "archive") {
			const found = o.scan(fs.readFileSync(srcAbs, "utf8")).findings;
			if (found.length) {
				secrets.push({ src: rel, findings: found, allowed: allow.has(rel) });
				if (!allow.has(rel)) {
					entries.push({ ...base, status: "withheld", note: `secret-looking content: ${found.map((f) => `${f.kind}x${f.count}`).join(", ")}` });
					continue;
				}
			}
		} else if (isText && o.scan) {
			const found = o.scan(fs.readFileSync(srcAbs, "utf8")).findings;
			if (found.length) secrets.push({ src: rel, findings: found, allowed: true, archiveOnly: true });
		}
		const rootDir = c.kind === "archive" ? archiveRoot : target;
		let r = resolve(rootDir, c.dest, srcAbs);
		if (c.kind === "archive" && !r) r = { key: c.dest, abs: path.join(rootDir, c.dest), status: "update" };
		let status;
		if (r) status = r.status;
		else if (c.rename) {
			const alt = path.posix.join(path.posix.dirname(c.dest), PREFIX + path.posix.basename(c.dest));
			r = resolve(rootDir, alt, srcAbs);
			status = r ? `collision->${r.status === "same" ? "same" : "renamed"}` : "collision-skipped";
		} else status = "collision-skipped";
		if (!r) {
			entries.push({ ...base, dest: c.dest, status, note: "target differs and was not written by this tool; incoming copy not written" });
			continue;
		}
		entries.push({
			...base,
			dest: (c.kind === "archive" ? "migration/archive/" : "") + r.key,
			status,
			note: c.note,
			_op: r.status === "same" ? null : { src: srcAbs, abs: r.abs, stateKey: rootKey(rootDir, r.key), archive: c.kind === "archive" },
		});
	}

	const counts = {};
	for (const e of entries) counts[`${e.kind}:${e.status}`] = (counts[`${e.kind}:${e.status}`] ?? 0) + 1;

	if (o.apply) {
		if (exists(archiveRoot)) for (const d of [archiveRoot, ...walkDirs(archiveRoot)]) fs.chmodSync(d, 0o755);
		fs.mkdirSync(path.join(target, "memory", "items"), { recursive: true });
		fs.mkdirSync(path.join(target, "memory", "topics"), { recursive: true });
		for (const e of entries) {
			if (e._write) {
				fs.mkdirSync(path.dirname(e._write.dest), { recursive: true });
				fs.writeFileSync(e._write.dest, e._write.proposed);
			}
			const op = e._op;
			if (!op) continue;
			fs.mkdirSync(path.dirname(op.abs), { recursive: true });
			if (exists(op.abs)) fs.chmodSync(op.abs, 0o644);
			fs.copyFileSync(op.src, op.abs);
			const st = fs.statSync(op.src);
			fs.utimesSync(op.abs, st.atime, st.mtime);
			if (op.archive) fs.chmodSync(op.abs, 0o444);
			nextState.files[op.stateKey] = { sha: sha(op.abs), src: e.src };
		}
		// archive directories read-only too
		if (exists(archiveRoot)) {
			const dirs = [archiveRoot, ...walkDirs(archiveRoot)];
			for (const d of dirs.reverse()) fs.chmodSync(d, 0o555);
		}
		fs.mkdirSync(mig, { recursive: true });
		for (const d of [archiveRoot]) if (exists(d)) fs.chmodSync(d, 0o555);
		fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2) + "\n");
	}
	return { source, target, home, applied: !!o.apply, entries, counts, secrets };
}

function walkDirs(root) {
	const out = [];
	for (const e of fs.readdirSync(root, { withFileTypes: true }))
		if (e.isDirectory()) {
			const p = path.join(root, e.name);
			out.push(p, ...walkDirs(p));
		}
	return out;
}

const fmt = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}M` : n >= 1024 ? `${(n / 1024).toFixed(1)}K` : `${n}B`);

export function render(res) {
	const lines = [`den-migrate (${res.applied ? "APPLY" : "DRY RUN"})`, `  source: ${res.source}`, `  target: ${res.target}`, `  home:   ${res.home}`, ""];
	for (const kind of ["copy", "port", "archive", "persona", "drop", "skip"]) {
		const es = res.entries.filter((e) => e.kind === kind);
		if (!es.length) continue;
		lines.push(`${kind.toUpperCase()} (${es.length} files, ${fmt(es.reduce((n, e) => n + e.size, 0))})`);
		for (const e of es)
			lines.push(`  [${e.status}] ${e.src}${e.dest && e.dest !== e.src ? ` -> ${e.dest}` : ""} (${fmt(e.size)})${e.note ? `  # ${e.note}` : ""}`);
		lines.push("");
	}
	const bad = res.entries.filter((e) => e.status.startsWith("collision") || e.status === "withheld");
	lines.push(`COLLISIONS / WITHHELD: ${bad.length}`);
	for (const e of bad) lines.push(`  ${e.status}: ${e.src}${e.dest ? ` -> ${e.dest}` : ""}`);
	lines.push(`SECRET SCAN: ${res.secrets.length ? "" : "no findings"}`);
	for (const s of res.secrets) lines.push(`  ${s.src}: ${s.findings.map((f) => `${f.kind}x${f.count}`).join(", ")}${s.archiveOnly ? " (archive only)" : s.allowed ? " (allowed)" : " (withheld)"}`);
	lines.push("", "SUMMARY " + Object.entries(res.counts).map(([k, v]) => `${k}=${v}`).join(" "));
	return lines.join("\n");
}

async function loadScanner() {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const p = path.join(here, "..", "packages", "memory", "dist", "work", "secrets.js");
	if (!exists(p)) throw new Error(`secret scanner not built (${p}); run \`npm run build\` or pass --no-scan`);
	return (await import(pathToFileURL(p).href)).scanSecrets;
}

async function main(argv) {
	const a = { allow: [] };
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i];
		if (k === "--apply") a.apply = true;
		else if (k === "--no-scan") a.noScan = true;
		else if (k === "--json") a.json = true;
		else if (k === "--source") a.source = argv[++i];
		else if (k === "--target") a.target = argv[++i];
		else if (k === "--home") a.home = argv[++i];
		else if (k === "--allow") a.allow.push(argv[++i]);
		else throw new Error(`unknown argument ${k}`);
	}
	if (!a.source || !a.target) throw new Error("usage: den-migrate.mjs --source <old den> --target <new den> [--home <dir>] [--apply] [--allow <rel>] [--no-scan] [--json]");
	if (!exists(a.source)) throw new Error(`source not found: ${a.source}`);
	const scan = a.noScan ? null : await loadScanner();
	const res = migrate({ ...a, scan });
	console.log(a.json ? JSON.stringify(res, (k, v) => (k.startsWith("_") ? undefined : v), 2) : render(res));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	main(process.argv.slice(2)).catch((e) => {
		console.error(`den-migrate: ${e.message}`);
		process.exit(1);
	});
}
