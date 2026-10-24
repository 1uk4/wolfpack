/**
 * GraphStore — the fs JSONL adapter: the append-only ledgers at
 * config.LEDGER_FILES (contracts.ts "v1 emission").
 *   nodes.jsonl     GraphNode        — one line per node write: the FIRST
 *                                      line for an id defines it; a later
 *                                      line with a REPEATED id is a
 *                                      link-append (session phrasings join
 *                                      aliases, provenance unions); reads
 *                                      merge by id (core/graph.ts getGraph)
 *   chains.jsonl    GraphChain       — one line per chain ASSERTION (a second
 *                                      session asserting the same
 *                                      (premises, conclusion) appends
 *                                      another line; readers merge)
 *
 * CHAINS-PRIMARY (owner, 2026-09-30): there is NO edges ledger — the edge
 * view (implication nodes + untyped arrows) is derived in core/graph.ts on
 * every read and never persisted. A stale edges.jsonl left by a pre-chains
 * build is deleted once, here, at adapter load (same doctrine as the
 * events-ledger purge below).
 *
 * Implements core/ports.ts GraphStore. data/graph/* is exclusively this
 * adapter's. Reads are strict against the contracts.ts shapes (the 2026-09-02
 * graph redesign): corrupt lines are skipped, never guessed at — the ledgers
 * are the source of truth and everything else is derived (core/graph.ts,
 * which takes this port as a parameter). Same idioms as src/store/chats.ts:
 * sync fs, no framework.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LEDGER_FILES, POSITIONS_FILE } from "../../config.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import type { GraphChain, GraphNode, Position, ProvenancePoint } from "../core/contracts.ts";
import type { GraphStore } from "../core/ports.ts";

// ─── JSONL primitives ────────────────────────────────────────────────────────

function appendLine<T>(file: string, record: T): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	ensureGraphFormat(); // the lazy format stamp (graph-format.ts)
	fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");
}

function readRawLines(file: string): unknown[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return []; // no ledger yet — nothing has ever been emitted
	}
	const out: unknown[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// Corrupt line: skip rather than fail the whole read — a torn
			// append must never take the home graph down with it.
		}
	}
	return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const isString = (v: unknown): v is string => typeof v === "string";

/** Strict shape guards — anything not matching a W4 ledger shape is skipped. */
function readValid<T>(file: string, isValid: (v: unknown) => v is T): T[] {
	assertGraphFormat(); // honest refusal on a newer-stamped data dir
	return readRawLines(file).filter(isValid);
}

/** Provenance points are (chatId, messageId) pairs — message-granular. */
const isProvenancePoint = (v: unknown): v is ProvenancePoint =>
	isRecord(v) && isString(v.chatId) && isString(v.messageId);


const isGraphNode = (v: unknown): v is GraphNode =>
	isRecord(v) &&
	isString(v.id) &&
	isString(v.name) &&
	isString(v.statement) &&
	Array.isArray(v.aliases) &&
	v.aliases.every(isString) &&
	isString(v.createdAt) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint);

/** A chain line: premises ≥ 1 (a chain IS an argument — bare propositions
 *  ride the node ledger alone), every member a string, conclusion a string.
 *  Endpoint EXISTENCE is the derivation's concern (it drops dangling
 *  chains); the store only shapes. */
const isGraphChain = (v: unknown): v is GraphChain =>
	isRecord(v) &&
	isString(v.id) &&
	Array.isArray(v.premises) &&
	v.premises.length > 0 &&
	v.premises.every(isString) &&
	isString(v.conclusion) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint) &&
	isString(v.createdAt);

// ─── the port implementation ────────────────────────────────────────────────

export const graphStore: GraphStore = {
	appendNode(node: GraphNode): void {
		appendLine(LEDGER_FILES.nodes, node);
	},
	/** Raw node lines in append order. A node id may appear on more than
	 *  one line (a later session's LINK-append: phrasings + provenance); the
	 *  derivation (core/graph.ts getGraph) merges lines by id. */
	readNodes(): GraphNode[] {
		return readValid(LEDGER_FILES.nodes, isGraphNode);
	},

	/** Append one chain ASSERTION; readers merge lines by (premises,
	 *  conclusion). */
	appendChain(assertion: GraphChain): void {
		appendLine(LEDGER_FILES.chains, assertion);
	},
	readChains(): GraphChain[] {
		return readValid(LEDGER_FILES.chains, isGraphChain);
	},

	// ── the layout ledger (config.POSITIONS_FILE — a JSON map) ──
	readPositions(): Record<string, Position> {
		return readPositionMap();
	},
	writePositions(positions: Record<string, Position>): void {
		writePositionMap(positions);
	},

	/** THE DESTRUCTIVE SEAM (node deletion): atomic full-content
	 *  replacement per provided ledger — write a uniquely-named temp file
	 *  beside the ledger, then rename over it (POSIX-atomic: a crash mid-
	 *  write leaves the original ledger and an orphan .tmp-*, never a torn
	 *  ledger). Empty arrays write an empty file — a purged ledger reads
	 *  as "nothing yet", same as never-emitted. */
	rewriteLedgers(next: {
		nodes?: GraphNode[];
		chains?: GraphChain[];
	}): void {
		const files = {
			nodes: LEDGER_FILES.nodes,
			chains: LEDGER_FILES.chains,
		} as const;
		for (const [key, records] of Object.entries(next) as [keyof typeof files, unknown[]][]) {
			const file = files[key];
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
			try {
				// JSONL: one record per line, trailing newline — a reader
				// must see exactly what appendLine would have written.
				const body = records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
				fs.writeFileSync(tmp, body, "utf-8");
				fs.renameSync(tmp, file);
			} catch (err) {
				try {
					fs.unlinkSync(tmp);
				} catch {
					/* the rename either already happened or the tmp never existed */
				}
				throw err;
			}
		}
	},
};

/** positions.json — { positions, updatedAt }. Read-modify-write, NOT
 *  append-only: the settle is a full-graph computation, so it replaces the
 *  whole map. The updatedAt stamp exists for future live-physics conflict
 *  handling (a browser commit must be able to detect "the graph changed
 *  underneath me"); reads just return the map. */
function readPositionMap(): Record<string, Position> {
	let raw: string;
	try {
		raw = fs.readFileSync(POSITIONS_FILE, "utf-8");
	} catch {
		return {}; // no ledger yet — nothing has ever settled
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || !isRecord(parsed.positions)) return {};
		const out: Record<string, Position> = {};
		for (const [id, value] of Object.entries(parsed.positions)) {
			if (isPosition(value)) out[id] = { x: value.x, y: value.y };
		}
		return out;
	} catch {
		return {};
	}
}

function writePositionMap(positions: Record<string, Position>): void {
	fs.mkdirSync(path.dirname(POSITIONS_FILE), { recursive: true });
	// Tmp + rename — the same crash-safety rewriteLedgers uses two blocks
	// up (a9339b3 UI flag): a torn write must never replace the ledger
	// with a half-written file the reader parses as empty.
	const tmp = `${POSITIONS_FILE}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	try {
		fs.writeFileSync(tmp, JSON.stringify({ positions, updatedAt: new Date().toISOString() }, null, "\t"), "utf-8");
		fs.renameSync(tmp, POSITIONS_FILE);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* the rename either already happened or the tmp never existed */
		}
		throw err;
	}
}

const isPosition = (v: unknown): v is Position =>
	isRecord(v) && typeof v.x === "number" && Number.isFinite(v.x) && typeof v.y === "number" && Number.isFinite(v.y);

// ─── one-way purges at adapter load: dead ledgers are exactly the confusion
// the cleanup removes (owner doctrine — nothing reads them, nothing writes
// them, a stale file lying around is a lie). ────────────────────────────────
{
	const graphDir = path.dirname(LEDGER_FILES.nodes);
	for (const legacy of ["edges.jsonl", "events.jsonl"]) {
		const file = path.join(graphDir, legacy);
		try {
			if (fs.existsSync(file)) {
				fs.rmSync(file);
				console.info(`[graph-store] purged legacy ledger: ${file}`);
			}
		} catch (err) {
			console.warn(`[graph-store] could not purge legacy ledger ${file}:`, err);
		}
	}
}
