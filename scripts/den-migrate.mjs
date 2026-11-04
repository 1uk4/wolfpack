#!/usr/bin/env node
// den-migrate.mjs: migrate an old pi-durable wolf den (e.g. wolf-ETAy7b "Hal") into a wolfd wolf's den.
//
//   node scripts/den-migrate.mjs --source <old den> --target <new den> [--home <new wolf home>]
//        [--apply] [--strict] [--chown user:group] [--allow <rel/path>@<sha256 prefix>]...
//        [--no-scan --yes-skip-scan] [--max-bytes N] [--json]
//   --apply additionally REQUIRES --source-stopped (you confirm the old Hal service is stopped; hal2 should be stopped too).
//
// Dry run is the default: it prints the plan and writes nothing. --apply performs it.
// Cutover: run `--apply --strict` (non-zero exit 2 when anything was withheld, collided or unsafe).
//
// Safety properties (reviewed; each has a test in den-migrate.test.ts):
//  - The source is only read. Source symlinks / sockets / FIFOs are reported as skipped, never followed.
//  - Writes (target den, <home>/migration) go temp file + rename (new files: link, so nothing is clobbered).
//    Every path component from <home> down is lstat-checked at plan time and again at write time; a symlink or
//    non-directory anywhere aborts that file. Temp files use O_EXCL|O_NOFOLLOW.
//  - Ownership: everything created (files and directories) is lchown'ed to the owner of the target den
//    (or --chown). As root with no resolvable owner, --apply refuses.
//  - Never overwrites a file this tool did not write (state.json records what it wrote). A differing file is a
//    collision: memory/fitness/vehicles get the incoming copy as `legacy-hal-<name>`; skills are skipped.
//  - Nothing secret-looking is carried: secret filenames, binary or oversized copies, and any file (archive
//    included) with scanSecrets findings are WITHHELD unless `--allow path@sha256prefix` names that exact content.
//  - state.json is persisted after every file and in a finally block; the archive is re-locked in a finally block.
//  - memory/topics and memory/archive topics are copied with `promotable: false` so resend-all / rebuild
//    (readResendTopics, which sends archived + pending den topics with force) can never re-submit them to the KB.
//
// The scanner is packages/memory/dist/work/secrets.js (build first: `npm run build`). The script refuses to run when
// dist is older than src or fails a canary self-test, so it cannot drift from the tested src/work/secrets.ts.
//
// Layout (packages/harness/src/wolfd/context.ts, packages/memory/src/den.ts):
//   skills   -> <target den>/skills/<name>/SKILL.md
//   memory   -> <target den>/memory/{topics,items,archive}; old observation pool kept as .memory/archive/legacy-hal-*
//   persona  -> proposed only: <home>/migration/AGENTS.proposed.md (nothing in <home>/agent is touched)
//   archive  -> <home>/migration/archive/ (0400 files / 0500 dirs, never loaded); state -> <home>/migration/state.json
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const C = fs.constants;
const PREFIX = "legacy-hal-";
const MAX_COPY_BYTES = 2 * 1024 * 1024;
const LIVE_WINDOW_MS = 5 * 60 * 1000;
const NOISE = (n) => n === ".DS_Store" || n === ".stfolder" || n.startsWith("._");
const DENY_NAME = [
	/^\.?env(\..*)?$/i,
	/^auth.*\.json$/i,
	/^telegram\.json$/i,
	/token/i,
	/^id_/i,
	/\.(pem|key|p12|pfx|crt|jks|kdbx)$/i,
	/^credentials?(\.|$)/i,
	/secret/i,
	/^\.(netrc|npmrc|pgpass|htpasswd)$/i,
];
const DENY_DIR = /^\.(ssh|gnupg|aws|kube)$/i;
const HOLD_REASON = "migrated from legacy Hal: already emitted to the KB, do not resend";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const lst = (p) => {
	try {
		return fs.lstatSync(p);
	} catch (e) {
		if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
		throw e;
	}
};
const readNoFollow = (p) => {
	const fd = fs.openSync(p, C.O_RDONLY | C.O_NOFOLLOW);
	try {
		return fs.readFileSync(fd);
	} finally {
		fs.closeSync(fd);
	}
};
const within = (parent, child) => child.startsWith(parent + path.sep);
const typeOf = (st) =>
	st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "directory" : st.isFile() ? "file" : st.isSocket() ? "socket" : st.isFIFO() ? "fifo" : "special file";

class Unsafe extends Error {}

/** realpath of the deepest existing ancestor + the not-yet-existing rest. */
function realish(p) {
	let cur = path.resolve(p);
	const rest = [];
	while (!fs.existsSync(cur) && !lst(cur)) {
		rest.unshift(path.basename(cur));
		cur = path.dirname(cur);
	}
	return path.join(fs.realpathSync(cur), ...rest);
}

export function guardPaths(source, target, home) {
	const ss = lst(source);
	if (!ss) throw new Error(`source not found: ${source}`);
	if (ss.isSymbolicLink()) throw new Error(`source is a symlink: ${source}`);
	if (!ss.isDirectory()) throw new Error(`source is not a directory: ${source}`);
	for (const [n, p] of [["target", target], ["home", home]]) {
		const st = lst(p);
		if (st?.isSymbolicLink()) throw new Error(`${n} is a symlink: ${p}`);
		if (st && !st.isDirectory()) throw new Error(`${n} is not a directory: ${p}`);
	}
	const s = fs.realpathSync(source);
	const t = realish(target);
	const h = realish(home);
	if (s === t) throw new Error("source and target are the same directory");
	if (within(s, t) || within(t, s)) throw new Error("source and target must not be nested in each other");
	if (!within(h, t)) throw new Error(`home (${h}) must be a strict ancestor of target (${t})`);
	if (s === h || within(path.join(h, "migration"), s) || within(s, path.join(h, "migration")))
		throw new Error("source must not be, or contain, the migration directory");
	return { source: s, target: t, home: h };
}

/** lstat every component from `home` down to `abs`. {ok, st|null} or {ok:false, reason}. */
function checkPath(home, abs) {
	const rel = path.relative(home, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, reason: "path escapes home" };
	let cur = home;
	const hs = lst(cur);
	if (hs && (hs.isSymbolicLink() || !hs.isDirectory())) return { ok: false, reason: `home is a ${typeOf(hs)}` };
	if (!hs) return { ok: true, st: null };
	const parts = rel.split(path.sep).filter(Boolean);
	let st = hs;
	for (let i = 0; i < parts.length; i++) {
		cur = path.join(cur, parts[i]);
		st = lst(cur);
		if (!st) return { ok: true, st: null };
		if (st.isSymbolicLink()) return { ok: false, reason: `symlink in destination path: ${path.relative(home, cur)}` };
		if (i < parts.length - 1 && !st.isDirectory()) return { ok: false, reason: `${typeOf(st)} where a directory is needed: ${path.relative(home, cur)}` };
	}
	return { ok: true, st };
}

/** Parse /etc/passwd + /etc/group names (node has no getpwnam). */
export function resolveOwner(spec, etc = "/etc") {
	const [u, g] = String(spec).split(":");
	const table = (file, nameIdx, idIdx) => {
		try {
			return fs.readFileSync(path.join(etc, file), "utf8").split("\n").map((l) => l.split(":")).filter((f) => f.length > idIdx).map((f) => [f[nameIdx], Number(f[idIdx]), Number(f[3])]);
		} catch {
			return [];
		}
	};
	const pw = table("passwd", 0, 2);
	const gr = table("group", 0, 2);
	let uid, gid;
	if (/^\d+$/.test(u)) uid = Number(u);
	else {
		const r = pw.find((x) => x[0] === u);
		if (!r) throw new Error(`unknown user: ${u}`);
		uid = r[1];
		gid = r[2];
	}
	if (g) {
		if (/^\d+$/.test(g)) gid = Number(g);
		else {
			const r = gr.find((x) => x[0] === g);
			if (!r) throw new Error(`unknown group: ${g}`);
			gid = r[1];
		}
	}
	if (gid === undefined) throw new Error(`cannot determine a group for ${spec}; use user:group`);
	return { uid, gid };
}

function walkSrc(root, rel = "") {
	const out = [];
	for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (NOISE(e.name)) {
			if (!rel) out.push({ rel: r, noise: true });
			continue;
		}
		if (e.isSymbolicLink()) out.push({ rel: r, special: "symlink" });
		else if (e.isDirectory()) out.push(...walkSrc(root, r));
		else if (e.isFile()) out.push({ rel: r });
		else out.push({ rel: r, special: e.isSocket() ? "socket" : e.isFIFO() ? "fifo" : "special file" });
	}
	return out;
}

const denied = (rel) => rel.split("/").some((c, i, a) => (i < a.length - 1 ? DENY_DIR.test(c) : DENY_NAME.some((re) => re.test(c))));

/** Classify a source-relative file -> {kind, dest?, note?, rename?, hold?} */
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
		if (["topics", "items", "archive"].includes(parts[1]))
			return { kind: "copy", dest: rel, rename: true, hold: /^memory\/(topics|archive)\/[^/]+\.md$/.test(rel) };
		return { kind: "skip", note: "unclassified memory file" };
	}
	if (top === ".memory") {
		if (rel === ".memory/pool/observations.jsonl")
			return { kind: "copy", dest: `.memory/archive/${PREFIX}pool-observations.jsonl`, note: "old live pool kept as archive, NOT merged into the live pool (would be re-consolidated)" };
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
	if (/^session\.sqlite(-wal|-shm)?$/.test(rel)) return { kind: "archive", dest: rel, note: rel === "session.sqlite" ? "archived with its -wal/-shm" : undefined };
	if (/^session\.sync-conflict/.test(rel)) return { kind: "drop", note: "sync-conflict file" };
	if (["factory", "planner", "tasks"].includes(top) || rel === "status.json") return { kind: "drop", note: "obsolete (empty / null state)" };
	if (top === "extensions") return { kind: "drop", note: "legacy pi extensions, not loaded by wolfd" };
	return { kind: "skip", note: "unclassified" };
}

/** Make a den topic non-promotable so resend-all / rebuild can never re-submit it to the KB. */
export function holdTopic(buf) {
	const text = buf.toString("utf8");
	const reason = `promotable_reason: ${HOLD_REASON}`;
	const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
	if (!m) return Buffer.from(`---\npromotable: false\n${reason}\n---\n\n${text}`);
	if (/^promotable:\s*false\s*$/m.test(m[1])) return buf;
	const lines = m[1].split(/\r?\n/).filter((l) => !/^promotable(_reason)?:/.test(l));
	lines.unshift("promotable: false", reason);
	return Buffer.from(`---\n${lines.join("\n")}\n---${m[2]}${text.slice(m[0].length)}`);
}

function personaText(notes, existing) {
	const kept = notes.split("\n").filter((l) => !/day-planner/i.test(l)).join("\n").trim();
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

const isBinary = (b) => b.subarray(0, 8192).includes(0);

function parseAllow(list) {
	const m = new Map();
	for (const a of list ?? []) {
		const x = /^(.+)@([0-9a-f]{8,64})$/i.exec(a);
		if (!x) throw new Error(`--allow must be <rel/path>@<sha256 prefix, 8+ hex chars>, got: ${a}`);
		m.set(x[1], x[2].toLowerCase());
	}
	return m;
}

const PROBLEM = new Set(["withheld", "collision-skipped", "unsafe-skipped"]);

/**
 * @param {object} o source, target, home?, apply?, allow?: string[], scan?: fn|null, owner?: {uid,gid}, chownSpec?: string,
 *   chown?: (path,uid,gid)=>void, isRoot?: boolean, noScanConfirmed?: boolean, sourceStopped?: boolean, maxBytes?: number, fchown?: (fd,uid,gid)=>void, now?: number, strict?: boolean
 */
export function migrate(o) {
	const { source, target, home } = guardPaths(path.resolve(o.source), path.resolve(o.target), path.resolve(o.home ?? path.dirname(path.resolve(o.target))));
	const mig = path.join(home, "migration");
	const archiveRoot = path.join(mig, "archive");
	const statePath = path.join(mig, "state.json");
	const allow = parseAllow(o.allow);
	const usedAllow = new Set();
	const warnings = [];
	const isRoot = o.isRoot ?? (typeof process.getuid === "function" && process.getuid() === 0);
	const chown = o.chown ?? ((p, u, g) => fs.lchownSync(p, u, g));
	const now = o.now ?? Date.now();
	const maxBytes = o.maxBytes ?? MAX_COPY_BYTES;
	const fchown = o.fchown ?? ((fd, u, g) => fs.fchownSync(fd, u, g));

	if (o.apply && !o.sourceStopped) throw new Error("--apply requires --source-stopped: stop the old Hal service (and hal2) first, then confirm with the flag");

	if (o.apply && !o.scan && !o.noScanConfirmed) throw new Error("--no-scan with --apply requires --yes-skip-scan (nothing would check the copied files for secrets)");
	if (!o.scan && o.apply) warnings.push("secret scan SKIPPED (--no-scan --yes-skip-scan): only filename/binary/size checks ran");

	let owner = o.owner ?? null;
	let ownerFrom = o.owner ? "given" : "";
	if (!owner && o.chownSpec) (owner = resolveOwner(o.chownSpec)), (ownerFrom = `--chown ${o.chownSpec}`);
	if (!owner) {
		const st = lst(target) ?? lst(home);
		if (st) (owner = { uid: st.uid, gid: st.gid }), (ownerFrom = lst(target) ? "target den" : "home");
	}
	if (o.apply && isRoot && !owner) throw new Error("running as root but no owner could be resolved from the target den or --chown; refusing --apply");
	if (o.apply && isRoot && owner && owner.uid === 0 && !o.chownSpec) throw new Error("running as root and the resolved owner is uid 0 (root:root); hal2 could not write these files. Pass --chown <user:group> explicitly");
	const doChown = (p) => owner && chown(p, owner.uid, owner.gid); // directories only; files use fchown on the temp fd

	// state
	let state = { version: 1, files: {} };
	const ss = lst(statePath);
	if (ss) {
		try {
			if (!ss.isFile()) throw new Error("not a regular file");
			const parsed = JSON.parse(readNoFollow(statePath).toString("utf8"));
			if (!parsed || typeof parsed.files !== "object" || parsed.files === null) throw new Error("missing files map");
			state = parsed;
		} catch (e) {
			throw new Error(`${statePath} is corrupt (${e.message}). Restore it from a backup; do NOT delete it: without it every file this tool already wrote would look hal2-owned and collide.`);
		}
	}
	const nextState = { version: 1, files: { ...state.files } };

	function judge(abs, key, data) {
		const chk = checkPath(home, abs);
		if (!chk.ok) return { status: "unsafe-skipped", note: chk.reason };
		if (!chk.st) return { status: "new" };
		if (!chk.st.isFile()) return { status: "collision-skipped", note: `destination is a ${typeOf(chk.st)}` };
		const cur = readNoFollow(abs);
		if (sha(cur) === sha(data)) return { status: "same", adopt: { key, sha: sha(cur) } };
		const rec = state.files[key];
		if (rec && rec.sha === sha(cur)) return { status: "update" };
		return { status: "differs" };
	}

	const entries = [];
	const secrets = [];
	/** reasons a file must not be carried; returns {withheld, note} after applying --allow */
	function gate(rel, buf, { archive, deny, allowRel = rel, allowBuf = buf }) {
		const reasons = [];
		let findings = [];
		if (deny && denied(rel)) reasons.push("secret-looking filename");
		if (!archive && isBinary(buf)) reasons.push("binary file");
		if (!archive && buf.length > maxBytes) reasons.push(`oversized (${buf.length} bytes)`);
		if (o.scan) {
			findings = o.scan(buf.toString(isBinary(buf) ? "latin1" : "utf8")).findings;
			if (findings.length) reasons.push(`secret-looking content: ${findings.map((f) => `${f.kind}x${f.count}`).join(", ")}`);
		}
		if (!reasons.length) return { withheld: false };
		const prefix = allow.get(allowRel);
		const digest = sha(allowBuf);
		if (prefix) usedAllow.add(allowRel);
		if (findings.length) secrets.push({ src: rel, findings, allowed: !!prefix && digest.startsWith(prefix) });
		if (prefix && digest.startsWith(prefix)) {
			warnings.push(`LOUD: --allow overrides withheld file ${rel} (${reasons.join("; ")}) @${prefix}`);
			return { withheld: false };
		}
		const note = prefix ? `stale --allow hash ${prefix} (file is now sha256 ${digest.slice(0, 12)}): ${reasons.join("; ")}` : reasons.join("; ");
		return { withheld: true, note };
	}

	const listing = walkSrc(source).sort((a, b) => (a.rel < b.rel ? -1 : 1));
	for (const f of listing) {
		const rel = f.rel;
		if (f.noise) {
			const st = lst(path.join(source, rel));
			entries.push({ kind: "drop", src: rel, size: st?.isFile() ? st.size : 0, status: "dropped", note: "OS/sync noise" });
			continue;
		}
		if (f.special) {
			entries.push({ kind: "skip", src: rel, size: 0, status: "skipped", note: `${f.special}: not followed or migrated` });
			continue;
		}
		const c = classify(rel);
		const srcAbs = path.join(source, rel);
		const st = fs.lstatSync(srcAbs);
		const base = { kind: c.kind, src: rel, size: st.size, note: c.note };
		if (c.kind === "drop") {
			entries.push({ ...base, status: "dropped" });
			continue;
		}
		if (c.kind === "skip") {
			entries.push({ ...base, status: "skipped" });
			continue;
		}
		const buf = readNoFollow(srcAbs);
		const setMember = /^session\.sqlite-(wal|shm)$/.test(rel);
		const g = gate(rel, buf, { archive: c.kind === "archive", deny: c.kind !== "persona", ...(setMember ? { allowRel: "session.sqlite", allowBuf: lst(path.join(source, "session.sqlite"))?.isFile() ? readNoFollow(path.join(source, "session.sqlite")) : buf } : {}) });
		if (g.withheld) {
			entries.push({ ...base, status: "withheld", note: g.note });
			continue;
		}
		if (c.kind === "persona") {
			const ag = path.join(home, "agent", "AGENTS.md");
			const ast = lst(ag);
			const existing = ast?.isFile() ? readNoFollow(ag).toString("utf8") : "";
			const data = Buffer.from(personaText(buf.toString("utf8"), existing));
			const dest = path.join(mig, "AGENTS.proposed.md");
			const j = judge(dest, "mig:AGENTS.proposed.md", data);
			const status = j.status === "differs" ? "collision-skipped" : j.status;
			entries.push({
				...base,
				dest: path.relative(home, dest),
				status,
				note: j.status === "differs" ? "AGENTS.proposed.md was edited or is not ours; not overwritten (move it aside to regenerate)" : j.note ?? "proposed merged AGENTS.md, not installed",
				_adopt: j.adopt,
				_op: ["new", "update"].includes(j.status) ? { data, abs: dest, key: "mig:AGENTS.proposed.md", mode: 0o644, src: rel } : null,
			});
			continue;
		}
		const archive = c.kind === "archive";
		const data = c.hold ? holdTopic(buf) : buf;
		const rootDir = archive ? archiveRoot : target;
		const keyOf = (r) => `${archive ? "arch" : "den"}:${r}`;
		let destRel = c.dest;
		let j = judge(path.join(rootDir, destRel), keyOf(destRel), data);
		let status = j.status;
		if (j.status === "differs") {
			if (c.rename) {
				destRel = path.posix.join(path.posix.dirname(c.dest), PREFIX + path.posix.basename(c.dest));
				const j2 = judge(path.join(rootDir, destRel), keyOf(destRel), data);
				status = j2.status === "differs" || j2.status === "collision-skipped" || j2.status === "unsafe-skipped" ? (j2.status === "differs" ? "collision-skipped" : j2.status) : j2.status === "same" ? "collision->same" : "collision->renamed";
				j = j2.status === "differs" ? { ...j2, note: "target differs and was not written by this tool; incoming copy not written" } : j2;
			} else {
				status = "collision-skipped";
				j = { ...j, note: "target differs and was not written by this tool; incoming copy not written" };
			}
		}
		const abs = path.join(rootDir, destRel);
		const ok = ["new", "update", "collision->renamed"].includes(status) && !["differs"].includes(j.status);
		entries.push({
			...base,
			dest: (archive ? "migration/archive/" : "") + destRel,
			status,
			note: j.note ?? c.note,
			_adopt: j.adopt,
			_op: ok ? { data, abs, key: keyOf(destRel), mode: archive ? 0o400 : (st.mode & 0o777) | 0o600, mtime: st.mtime, src: rel, archive } : null,
		});
	}
	// session.sqlite + -wal + -shm are one unit: all archived or all withheld
	const SQL_SET = ["session.sqlite", "session.sqlite-wal", "session.sqlite-shm"];
	const sqlEntries = entries.filter((e) => SQL_SET.includes(e.src));
	if (sqlEntries.some((e) => e.status === "withheld")) {
		for (const e of sqlEntries) {
			if (e.status === "withheld") continue;
			e.status = "withheld";
			e.note = "withheld with the rest of the session.sqlite set (db, -wal, -shm are all-or-none)";
			e._op = null;
			e._adopt = null;
		}
	}
	for (const [p] of allow) if (!usedAllow.has(p)) warnings.push(`--allow ${p} matched no withheld file (unused or the file is not withheld)`);

	// sqlite WAL liveness
	const wal = lst(path.join(source, "session.sqlite-wal"));
	const shm = lst(path.join(source, "session.sqlite-shm"));
	let looksLive = false;
	if (wal && wal.isFile() && wal.size > 0) {
		looksLive = [wal, shm].some((s) => s?.isFile() && now - s.mtimeMs < LIVE_WINDOW_MS);
		warnings.push(`session.sqlite-wal is non-empty (${wal.size} bytes)${looksLive ? " and was touched in the last 5 min: the source service looks LIVE" : ""}; it is archived together with -shm so the copy stays consistent`);
	}

	const counts = {};
	for (const e of entries) counts[`${e.kind}:${e.status}`] = (counts[`${e.kind}:${e.status}`] ?? 0) + 1;
	const problems = entries.filter((e) => PROBLEM.has(e.status));
	const result = { source, target, home, applied: !!o.apply, owner, ownerFrom, entries, counts, secrets, warnings, problems, looksLive };

	if (o.apply) {
		if (looksLive) warnings.push("source still looks LIVE (wal/shm touched in the last 5 min) despite --source-stopped: verify the old service is really stopped");
		applyPlan();
	}
	return result;

	// ── writers ──
	function mkdirp(dir) {
		const rel = path.relative(home, dir);
		if (rel.startsWith("..")) throw new Unsafe("path escapes home");
		let cur = home;
		for (const part of rel.split(path.sep).filter(Boolean)) {
			cur = path.join(cur, part);
			const st = lst(cur);
			if (!st) {
				fs.mkdirSync(cur, { mode: 0o755 });
				doChown(cur);
			} else if (st.isSymbolicLink()) throw new Unsafe(`symlink in destination path: ${path.relative(home, cur)}`);
			else if (!st.isDirectory()) throw new Unsafe(`${typeOf(st)} where a directory is needed: ${path.relative(home, cur)}`);
		}
	}

	function placeFile(abs, data, mode, mtime) {
		const chk = checkPath(home, abs);
		if (!chk.ok) throw new Unsafe(chk.reason);
		if (chk.st && !chk.st.isFile()) throw new Unsafe(`destination is a ${typeOf(chk.st)}`);
		mkdirp(path.dirname(abs));
		// Residual race: the parent dir is checked above and then used by path; a process that can swap a directory for a
		// symlink in between could redirect the temp file. Mitigated operationally by stopping hal2 (and the old Hal)
		// for the duration of --apply. The file itself is opened O_EXCL|O_NOFOLLOW and chowned by fd, not by path.
		const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.dm-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
		const fd = fs.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
		try {
			try {
				fs.writeSync(fd, data);
				if (owner) fchown(fd, owner.uid, owner.gid);
				fs.fchmodSync(fd, mode);
				if (mtime) fs.futimesSync(fd, mtime, mtime);
			} finally {
				fs.closeSync(fd);
			}
			if (chk.st) fs.renameSync(tmp, abs);
			else {
				fs.linkSync(tmp, abs); // fails with EEXIST rather than clobbering a racing file
				fs.unlinkSync(tmp);
			}
		} catch (e) {
			try {
				fs.unlinkSync(tmp);
			} catch {}
			if (e.code === "EEXIST") throw new Unsafe("destination appeared during apply");
			throw e;
		}
	}

	/** Remove `.<name>.dm-<pid>-<hex>` temp files a killed earlier run left behind (regular files only, no symlink following). */
	function cleanStaleTemps() {
		const re = /^\..+\.dm-\d+-[0-9a-f]{8}$/;
		const rec = (d) => {
			let list;
			try {
				list = fs.readdirSync(d, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of list) {
				const p = path.join(d, e.name);
				if (e.isDirectory()) rec(p);
				else if (e.isFile() && re.test(e.name)) {
					fs.unlinkSync(p);
					warnings.push(`removed stale temp file ${path.relative(home, p)}`);
				}
			}
		};
		rec(target);
		rec(mig);
	}

	function archiveDirs() {
		const out = [];
		const rec = (d) => {
			const st = lst(d);
			if (!st || !st.isDirectory()) return;
			out.push(d);
			for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) rec(path.join(d, e.name));
		};
		rec(archiveRoot);
		return out;
	}
	function chmodDir(d, mode) {
		const fd = fs.openSync(d, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
		try {
			fs.fchmodSync(fd, mode);
		} finally {
			fs.closeSync(fd);
		}
	}

	function persist() {
		placeFile(statePath, Buffer.from(JSON.stringify(nextState, null, 2) + "\n"), 0o600);
	}

	function applyPlan() {
		const homeSt = lst(home);
		if (!homeSt || !homeSt.isDirectory()) throw new Error(`home does not exist: ${home}`);
		let failure = null;
		try {
			mkdirp(path.join(target, "memory", "topics"));
			mkdirp(path.join(target, "memory", "items"));
			mkdirp(mig);
			for (const d of archiveDirs()) chmodDir(d, 0o700);
			cleanStaleTemps();
			for (const e of entries) {
				const op = e._op;
				try {
					if (op) {
						placeFile(op.abs, op.data, op.mode, op.mtime);
						nextState.files[op.key] = { sha: sha(op.data), src: op.src };
					} else if (e._adopt) nextState.files[e._adopt.key] = { sha: e._adopt.sha, src: e.src };
					else continue;
				} catch (err) {
					if (!(err instanceof Unsafe)) throw err;
					e.status = "unsafe-skipped";
					e.note = err.message;
					if (!problems.includes(e)) problems.push(e);
					continue;
				}
				persist();
			}
		} catch (err) {
			failure = err;
		} finally {
			try {
				persist();
			} catch (err) {
				failure ??= err;
			}
			try {
				for (const d of archiveDirs().reverse()) chmodDir(d, 0o500);
			} catch (err) {
				failure ??= err;
			}
		}
		if (failure) throw failure;
		result.counts = {};
		for (const e of entries) result.counts[`${e.kind}:${e.status}`] = (result.counts[`${e.kind}:${e.status}`] ?? 0) + 1;
	}
}

const fmt = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}M` : n >= 1024 ? `${(n / 1024).toFixed(1)}K` : `${n}B`);

export function render(res) {
	const lines = [`den-migrate (${res.applied ? "APPLY" : "DRY RUN"})`, `  source: ${res.source}`, `  target: ${res.target}`, `  home:   ${res.home}`, `  owner:  ${res.owner ? `${res.owner.uid}:${res.owner.gid} (${res.ownerFrom})` : "unresolved (no chown)"}`, ""];
	for (const kind of ["copy", "port", "archive", "persona", "drop", "skip"]) {
		const es = res.entries.filter((e) => e.kind === kind);
		if (!es.length) continue;
		lines.push(`${kind.toUpperCase()} (${es.length} files, ${fmt(es.reduce((n, e) => n + e.size, 0))})`);
		for (const e of es) lines.push(`  [${e.status}] ${e.src}${e.dest && e.dest !== e.src ? ` -> ${e.dest}` : ""} (${fmt(e.size)})${e.note ? `  # ${e.note}` : ""}`);
		lines.push("");
	}
	const coll = res.entries.filter((e) => e.status.startsWith("collision"));
	lines.push(`PROBLEMS (withheld / collision-skipped / unsafe-skipped): ${res.problems.length}`);
	for (const e of res.problems) lines.push(`  ${e.status}: ${e.src}${e.dest ? ` -> ${e.dest}` : ""}  # ${e.note ?? ""}`);
	lines.push(`COLLISIONS (incl. renamed): ${coll.length}`);
	lines.push(`SECRET SCAN: ${res.secrets.length ? "" : "no findings"}`);
	for (const s of res.secrets) lines.push(`  ${s.src}: ${s.findings.map((f) => `${f.kind}x${f.count}`).join(", ")} (${s.allowed ? "allowed" : "withheld"})`);
	if (res.warnings.length) lines.push("", "WARNINGS");
	for (const w of res.warnings) lines.push(`  ! ${w}`);
	lines.push("", "SUMMARY " + Object.entries(res.counts).map(([k, v]) => `${k}=${v}`).join(" "));
	return lines.join("\n");
}

/** Load the built scanner; refuse a stale or drifted build. */
export async function loadScanner(root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")) {
	const dist = path.join(root, "packages", "memory", "dist", "work", "secrets.js");
	const src = path.join(root, "packages", "memory", "src", "work", "secrets.ts");
	if (!fs.existsSync(dist)) throw new Error(`secret scanner not built (${dist}); run \`npm run build\` or pass --no-scan`);
	if (fs.existsSync(src) && fs.statSync(src).mtimeMs > fs.statSync(dist).mtimeMs)
		throw new Error(`secret scanner is stale: ${src} is newer than ${dist}; run \`npm run build\``);
	const scan = (await import(pathToFileURL(dist).href + `?t=${Date.now()}`)).scanSecrets;
	const canaries = [`${"1".repeat(9)}:${"A".repeat(35)}`, `sk-${"a".repeat(24)}`, `-----BEGIN PRIVATE KEY-----\nabc`];
	for (const c of canaries) if (!scan(c).findings.length) throw new Error("secret scanner build failed its canary self-test (out of date); run `npm run build`");
	return scan;
}

export function parseArgs(argv) {
	const a = { allow: [] };
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i];
		const val = () => {
			if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
			return argv[++i];
		};
		if (k === "--apply") a.apply = true;
		else if (k === "--strict") a.strict = true;
		else if (k === "--no-scan") a.noScan = true;
		else if (k === "--yes-skip-scan") a.noScanConfirmed = true;
		else if (k === "--source-stopped") a.sourceStopped = true;
		else if (k === "--max-bytes") {
			a.maxBytes = Number(val());
			if (!Number.isInteger(a.maxBytes) || a.maxBytes <= 0) throw new Error("--max-bytes must be a positive integer");
		}
		else if (k === "--json") a.json = true;
		else if (k === "--source") a.source = val();
		else if (k === "--target") a.target = val();
		else if (k === "--home") a.home = val();
		else if (k === "--chown") a.chownSpec = val();
		else if (k === "--allow") a.allow.push(val());
		else throw new Error(`unknown argument ${k}`);
	}
	if (!a.source || !a.target) throw new Error("usage: den-migrate.mjs --source <old den> --target <new den> [--home <dir>] [--apply] [--strict] [--chown user:group] [--allow path@sha256prefix] [--no-scan --yes-skip-scan] [--max-bytes N] [--source-stopped] [--json]");
	return a;
}

export async function main(argv, out = console.log) {
	const a = parseArgs(argv);
	const scan = a.noScan ? null : await loadScanner();
	const res = migrate({ ...a, scan });
	out(a.json ? JSON.stringify(res, (k, v) => (k.startsWith("_") ? undefined : v), 2) : render(res));
	return a.strict && res.problems.length ? 2 : 0;
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((e) => {
			console.error(`den-migrate: ${e.message}`);
			process.exit(1);
		});
}
