import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (this file is at <root>/config.ts). */
export const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * THE data-location seam (the Electron contract, 2026-09-17): WOLFPACK_DATA_DIR
 * relocates every MUTABLE record — chat sessions, graph ledgers, the
 * embedding model cache — when set. The desktop shell points it at
 * userData so nothing is written inside the read-only .app bundle
 * (macOS translocation guarantees the bundle is read-only anyway).
 * Unset (plain web dev / repo work) it resolves to the repo's data/,
 * byte-for-byte as before. Read-only assets (prompts) stay ROOT-anchored
 * on purpose: they ship inside the app bundle by design.
 */
const DATA_DIR_ENV = process.env.WOLFPACK_DATA_DIR || undefined;
const DATA_ROOT = DATA_DIR_ENV ? path.resolve(DATA_DIR_ENV) : path.join(ROOT, "data");

export const PATHS = {
	root: ROOT,
	/** The assistant's system prompt (src/agent/). */
	systemPrompt: path.join(ROOT, "src", "agent", "system-prompt.md"),
	data: DATA_ROOT,
	/** Chat sessions (AI SDK UIMessage transcripts, one JSON file per chat). */
	chats: path.join(DATA_ROOT, "chats"),
	graph: path.join(DATA_ROOT, "graph"),
	/** Debug artifacts (env-gated): data/debug/provider-events/<chatId>.jsonl
	 * raw provider stream recordings (src/agent/provider-events.ts). */
	debug: path.join(DATA_ROOT, "debug"),
} as const;

// ─── Models ────────────────────────────────────────────────────────────────
// BYOK ALL THE WAY DOWN (owner, 2026-09-22): there are NO factory default
// models. Every engine resolves from the user's model slots (settings.json
// models section: strong/cheap/vision) over per-role/ChatSettings overrides,
// and a chain that ends empty REFUSES honestly (503 models_not_configured).
// .env stays for secrets (API keys) only. What remains here are ENGINE
// CONSTRUCTION FACTS: the thinking-level scale and the default order.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** The graph's stored node positions: a plain JSON map nodeId → {x,y}
 *  (src/core/graph/graph-persistence.ts). The console's own store; the KB is
 *  never written. */
export const POSITIONS_FILE = path.join(PATHS.graph, "positions.json");

/**
 * Graph render settings (the settings-panel controls): one small JSON blob,
 * read-modify-write. Shared shape/sanitizer: src/core/graph/render-settings.ts.
 */
export const RENDER_SETTINGS_FILE = path.join(PATHS.graph, "render-settings.json");

/**
 * THE USER SETTINGS RECORD (settings-storage wave, 2026-09-19): one
 * versioned, DELTA-shaped JSON blob at the data-dir seam holding every
 * non-secret product preference — general, agent (background
 * model/thinking overrides + tool toggles + prompt-override switches),
 * appearance, graph. Explicit user choices only: ABSENT keys resolve to the
 * factory defaults compiled into src/core/settings/settings.ts (FACTORY_SETTINGS), so
 * a software update that adds a knob (new tool, new role, new appearance
 * field) needs no migration — old records simply lack the new keys. The
 * version field is a PRIVATE schema counter for breaking shape changes
 * only (field renamed/meaning changed), unrelated to the app release
 * version. Secrets (API keys, login tokens) NEVER live here — the Pack key
 * file / .env.local keep that role. (The `chat` default-settings section died
 * with per-session models, owner 2026-09-28 — sessions own their model
 * from birth, stamped from the strong slot.)
 */
export const SETTINGS_FILE = path.join(DATA_ROOT, "settings.json");

// Keys: the console keeps no key store of its own (work-wolfpack-u6GH2kk). They live in the Pack key file (WOLFPACK_KEY_FILE),
// read by src/server/settings/keys.ts.
