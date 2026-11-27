/**
 * Server-side persistence for the graph groups (work-wolfpack-FnzgC6g): data/graph/groups.json in the console's own data
 * directory. LOCAL ONLY on purpose: it works on a Mac-only install with the in-app hub, offline, and every device that opens this
 * console sees the same bubbles. Whatever is read or written goes through sanitizeGroups, so the file can never hold a domain in
 * two groups.
 */

import fs from "node:fs";
import path from "node:path";
import { GRAPH_GROUPS_FILE } from "../../config.ts";
import { EMPTY_GROUPS, sanitizeGroups, type GraphGroups } from "../core/graph/groups.ts";

/** The saved groups; none saved (or an unreadable file) = no groups. */
export function readGraphGroups(file: string = GRAPH_GROUPS_FILE): GraphGroups {
	try {
		return sanitizeGroups(JSON.parse(fs.readFileSync(file, "utf-8")));
	} catch {
		return EMPTY_GROUPS;
	}
}

/** Save the whole list (sanitized); returns what was stored. */
export function writeGraphGroups(raw: unknown, file: string = GRAPH_GROUPS_FILE): GraphGroups {
	const groups = sanitizeGroups(raw);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(groups, null, "\t"), "utf-8");
	return groups;
}
