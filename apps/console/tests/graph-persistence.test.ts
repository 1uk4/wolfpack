/**
 * Graph persistence: the pure rules (src/core/graph-persistence.ts) and the
 * console-store round trip (positions.json under an isolated LH_DATA_DIR).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	MAX_COORD,
	mergePositions,
	parseCamera,
	resolvePositions,
	sanitizePositions,
} from "../src/core/graph-persistence.ts";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-graph-pos-"));
process.env.LH_DATA_DIR = TMP;
const { commitGraphPositions, graphPositions } = await import("../src/server/graph-positions.ts");
const { POSITIONS_FILE } = await import("../config.ts");

describe("sanitizePositions", () => {
	it("keeps finite coordinates for KB node ids, clamps absurd ones", () => {
		const out = sanitizePositions({
			"ent:a": { x: 1.5, y: -2 },
			"work:b": { x: 1e12, y: -1e12 },
			"dom:c": { x: 0, y: 0 },
		});
		assert.deepEqual(out["ent:a"], { x: 1.5, y: -2 });
		assert.deepEqual(out["work:b"], { x: MAX_COORD, y: -MAX_COORD });
		assert.ok("dom:c" in out);
	});

	it("drops garbage: non-finite, wrong types, ids outside the KB namespace, prototype keys", () => {
		const out = sanitizePositions({
			"ent:nan": { x: Number.NaN, y: 0 },
			"ent:inf": { x: Infinity, y: 0 },
			"ent:str": { x: "1", y: 2 },
			"ent:null": null,
			"ent:arr": [1, 2],
			plain: { x: 1, y: 1 },
			__proto__: { x: 1, y: 1 },
			"": { x: 1, y: 1 },
			["x:".padEnd(600, "y")]: { x: 1, y: 1 },
		});
		assert.deepEqual(out, {});
	});

	it("non-objects become an empty map", () => {
		for (const bad of [null, undefined, 3, "x", [], true]) assert.deepEqual(sanitizePositions(bad), {});
	});

	it("tolerates the { positions } envelope", () => {
		assert.deepEqual(sanitizePositions({ positions: { "ent:a": { x: 1, y: 2 } } }), { "ent:a": { x: 1, y: 2 } });
	});
});

describe("mergePositions", () => {
	it("incoming wins per id; ids it doesn't mention are kept (hidden layers)", () => {
		const merged = mergePositions(
			{ "ent:a": { x: 1, y: 1 }, "den:hal:t": { x: 9, y: 9 } },
			{ "ent:a": { x: 2, y: 2 }, "ent:b": { x: 3, y: 3 } },
		);
		assert.deepEqual(merged, { "ent:a": { x: 2, y: 2 }, "den:hal:t": { x: 9, y: 9 }, "ent:b": { x: 3, y: 3 } });
	});

	it("over the cap, the oldest-stored ids go first and fresh commits survive", () => {
		const stored = { "ent:1": { x: 1, y: 1 }, "ent:2": { x: 2, y: 2 }, "ent:3": { x: 3, y: 3 } };
		const merged = mergePositions(stored, { "ent:2": { x: 20, y: 20 }, "ent:4": { x: 4, y: 4 } }, 3);
		assert.deepEqual(Object.keys(merged), ["ent:3", "ent:2", "ent:4"]);
		assert.deepEqual(merged["ent:2"], { x: 20, y: 20 });
	});

	it("does not mutate its inputs", () => {
		const stored = { "ent:1": { x: 1, y: 1 } };
		mergePositions(stored, { "ent:2": { x: 2, y: 2 } });
		assert.deepEqual(Object.keys(stored), ["ent:1"]);
	});
});

describe("resolvePositions", () => {
	const nodes = ["a", "b", "c", "d"].map((id) => ({ id }));
	const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d" }];

	it("known positions are kept exactly; only the missing nodes are placed", () => {
		const known = new Map([["a", { x: 100, y: 100 }], ["b", { x: 140, y: 100 }], ["c", { x: 180, y: 100 }]]);
		const { positions, added } = resolvePositions(nodes, edges, known);
		assert.deepEqual(added, ["d"]);
		for (const id of ["a", "b", "c"]) assert.deepEqual(positions.get(id), known.get(id));
		const d = positions.get("d")!;
		assert.ok(Number.isFinite(d.x) && Number.isFinite(d.y));
		assert.ok(Math.hypot(d.x - 180, d.y - 100) < 400, "the new node lands near its neighbour");
	});

	it("nothing missing → nothing added; extra known ids are ignored", () => {
		const known = new Map(nodes.map((n, i) => [n.id, { x: i, y: i }] as const));
		known.set("elsewhere", { x: 9, y: 9 });
		const { positions, added } = resolvePositions(nodes, edges, known);
		assert.deepEqual(added, []);
		assert.equal(positions.size, 4);
	});

	it("from scratch it lays everything out, deterministically", () => {
		const first = resolvePositions(nodes, edges, new Map());
		const second = resolvePositions(nodes, edges, new Map());
		assert.deepEqual(first.added, ["a", "b", "c", "d"]);
		assert.deepEqual([...first.positions], [...second.positions]);
	});
});

describe("parseCamera", () => {
	it("round-trips a stored camera", () => {
		assert.deepEqual(parseCamera(JSON.stringify({ k: 2, x: -10, y: 5 })), { k: 2, x: -10, y: 5 });
		assert.deepEqual(parseCamera({ k: 0.5, x: 0, y: 0 }), { k: 0.5, x: 0, y: 0 });
	});
	it("rejects corrupt or invalid cameras", () => {
		for (const bad of [null, undefined, "", "not json", "{}", { k: 0, x: 0, y: 0 }, { k: -1, x: 0, y: 0 }, { k: 1, x: Number.NaN, y: 0 }, { k: "1", x: 0, y: 0 }, 5]) {
			assert.equal(parseCamera(bad), null, JSON.stringify(bad));
		}
	});
});

describe("the positions store (console data dir)", () => {
	it("starts empty and writes nothing on read", () => {
		assert.deepEqual(graphPositions(), {});
		assert.ok(!fs.existsSync(POSITIONS_FILE));
	});

	it("commit sanitizes, merges over what is stored, and persists a plain id → {x,y} map", () => {
		assert.deepEqual(commitGraphPositions({ "ent:a": { x: 1, y: 2 }, bad: { x: 1, y: 1 }, "ent:n": { x: Number.NaN, y: 0 } }), { "ent:a": { x: 1, y: 2 } });
		commitGraphPositions({ "den:hal:t": { x: 5, y: 6 } });
		commitGraphPositions({ "ent:a": { x: 10, y: 20 } });
		assert.deepEqual(graphPositions(), { "ent:a": { x: 10, y: 20 }, "den:hal:t": { x: 5, y: 6 } });
		assert.deepEqual(JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8")), { "den:hal:t": { x: 5, y: 6 }, "ent:a": { x: 10, y: 20 } });
	});

	it("an empty or invalid commit writes nothing", () => {
		const before = fs.readFileSync(POSITIONS_FILE, "utf8");
		assert.deepEqual(commitGraphPositions({}), {});
		assert.deepEqual(commitGraphPositions("junk"), {});
		assert.equal(fs.readFileSync(POSITIONS_FILE, "utf8"), before);
	});

	it("a corrupt file reads as empty; the next commit repairs it; no temp files linger", () => {
		fs.writeFileSync(POSITIONS_FILE, "{not json");
		assert.deepEqual(graphPositions(), {});
		commitGraphPositions({ "ent:z": { x: 1, y: 1 } });
		assert.deepEqual(graphPositions(), { "ent:z": { x: 1, y: 1 } });
		assert.deepEqual(fs.readdirSync(path.dirname(POSITIONS_FILE)).filter((f) => f.includes(".tmp-")), []);
	});
});

process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));
