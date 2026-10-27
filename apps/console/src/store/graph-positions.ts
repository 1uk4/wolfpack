/**
 * The graph's stored node positions: data/graph/positions.json, a plain
 * JSON map nodeId → {x, y} in the console's own data dir (the KB is never
 * written). Shape rules live in src/core/graph-persistence.ts; this module
 * only moves bytes. Whatever comes off disk is sanitized; writes go to a
 * temp file and rename over, so a crash never tears the file.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { POSITIONS_FILE } from "../../config.ts";
import { sanitizePositions, type PositionMap } from "../core/graph-persistence.ts";

/** The stored positions; empty when absent or unreadable. */
export function readGraphPositions(): PositionMap {
	try {
		return sanitizePositions(JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf-8")));
	} catch {
		return {};
	}
}

/** Replace the whole file with `positions` (already sanitized by the caller). */
export function writeGraphPositions(positions: PositionMap): void {
	fs.mkdirSync(path.dirname(POSITIONS_FILE), { recursive: true });
	const tmp = `${POSITIONS_FILE}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(positions), "utf-8");
		fs.renameSync(tmp, POSITIONS_FILE);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* already gone */
		}
		throw err;
	}
}
