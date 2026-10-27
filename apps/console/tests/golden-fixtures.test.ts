/**
 * GOLDEN FIXTURES (owner ruling, 2026-10-10): real user data, verbatim,
 * read through the PRODUCTION read paths. tests/fixtures/golden-data/ is a
 * real data dir (see its README); this suite copies it to a temp dir, points
 * the stores at it via the LH_DATA_DIR seam (set BEFORE any config-loading
 * import — every app-module import is dynamic), and asserts:
 *
 *   1. every record parses and passes the contract folds the app itself
 *      runs (pending questions, summaries);
 *   2. the LLM wire flattening (toLlmMessages) turns each full record into
 *      a legal provider message list — the strongest property a record has;
 *   3. the stored graph render-settings sanitize;
 *   4. reads are READ-ONLY: after everything above, the copy is
 *      byte-identical to the fixture source.
 *
 * THE FIXTURE LAW: an intentional format change updates the fixtures in the
 * same commit; an unintentional one fails here.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, "fixtures", "golden-data");

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-golden-"));
fs.cpSync(GOLDEN, TMP, { recursive: true });
process.env.LH_DATA_DIR = TMP;

const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { readRenderSettings } = await import("../src/store/render-settings.ts");
const { sanitizeRenderSettings } = await import("../src/core/render-settings.ts");
const { toLlmMessages } = await import("../src/core/native-messages.ts");
const { danglingQuestionOf } = await import("../src/core/native-messages.ts");

const TEACH = "chat_mv27rrra_feff23b6";
const PRACTICE = "chat_mv293wv5_10656952";

function snapshotTree(dir: string): Map<string, Buffer> {
	const out = new Map<string, Buffer>();
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name);
		const st = fs.statSync(p);
		if (st.isDirectory()) for (const [k, v] of snapshotTree(p)) out.set(`${name}/${k}`, v);
		else out.set(name, fs.readFileSync(p));
	}
	return out;
}
const BEFORE = snapshotTree(TMP);

test.after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

// ── chats: records, folds, and the wire ─────────────────────────────────────

test("chats: both fixture records parse through the production read path", () => {
	const list = chatStore.listChats();
	const ids = new Set(list.map((c) => c.id));
	assert.ok(ids.has(TEACH), "the teach master record lists");
	assert.ok(ids.has(PRACTICE), "the practice lifecycle record lists");

	for (const id of [TEACH, PRACTICE]) {
		const r = chatStore.getChat(id);
		assert.ok(r, `${id} reads`);
		assert.ok(Array.isArray(r!.messages) && r!.messages.length > 0);
		// the folds the app itself runs per render/turn:
		assert.equal(danglingQuestionOf(r!.messages), null, "no dangling question tool call");
	}
});

test("chats: the LLM wire flattening turns each full record into a legal provider message list", () => {
	for (const id of [TEACH, PRACTICE]) {
		const r = chatStore.getChat(id)!;
		const wire = toLlmMessages(r.messages as never);
		assert.ok(wire.length > 0);
		for (const m of wire) {
			assert.ok(["system", "user", "assistant", "toolResult"].includes(m.role), `legal role ${m.role} in ${id}`);
			// every toolResult answers a call that appeared BEFORE it
			if (m.role === "toolResult") {
				const t = m as { toolCallId: string };
				assert.ok(
					wire.some((w) => w.role === "assistant" && JSON.stringify(w).includes(t.toolCallId)),
					`toolResult ${t.toolCallId} has its calling assistant message`,
				);
			}
		}
		// no assistant toolCall left unanswered (the dangling-call synthesis covers aborts)
		const answered = new Set(wire.filter((w) => w.role === "toolResult").map((w) => (w as { toolCallId: string }).toolCallId));
		for (const m of wire) {
			if (m.role !== "assistant") continue;
			for (const b of (m as { content: Array<{ type: string; id?: string }> }).content) {
				if (b.type === "toolCall" && b.id) assert.ok(answered.has(b.id), `call ${b.id} is answered on the wire`);
			}
		}
	}
});

// ── the graph: stored render settings ──────────────────────────────────────

test("graph: render-settings read and sanitize", () => {
	const raw = readRenderSettings();
	assert.ok(raw, "render-settings.json reads");
	const clean = sanitizeRenderSettings(raw);
	assert.ok(clean.nodeSize > 0 && typeof clean.labelZoom === "number", "sanitizes to concrete knobs");
	assert.equal(clean.groupBy, "domain", "the view fields added later default in");
});

// ── jobs + settings ─────────────────────────────────────────────────────────

test("jobs: the kind × status matrix parses through the job store", () => {
	const kinds = new Set<string>();
	const statuses = new Set<string>();
	for (const f of fs.readdirSync(path.join(GOLDEN, "jobs"))) {
		const id = f.replace(/\.json$/, "");
		const j = jobStore.getJob(id);
		assert.ok(j, `${id} reads through the job store`);
		assert.ok(["research", "demo", "visual", "pdf"].includes(j!.kind), `${id}: known kind`);
		assert.ok(["done", "error"].includes(j!.status), `${id}: terminal status`);
		kinds.add(j!.kind);
		statuses.add(j!.status);
	}
	assert.deepEqual([...kinds].sort(), ["demo", "pdf", "research", "visual"], "every job kind is fixture-d");
	assert.deepEqual([...statuses].sort(), ["done", "error"], "both terminal statuses are fixture-d");
});

test("settings: the stamped record parses", () => {
	const s = settingsStore.readSettings();
	assert.ok(s, "settings record reads");
	assert.equal(s!.version, 1, "settings carry their version stamp");
	assert.ok(s!.models && typeof s!.models === "object", "model slots present");
});

// ── read-only: readers never write ──────────────────────────────────────────

test("read-only: after every read above, the data dir is byte-identical to the fixture source", () => {
	const after = snapshotTree(TMP);
	assert.deepEqual([...after.keys()].sort(), [...BEFORE.keys()].sort(), "no files added or removed");
	for (const [name, buf] of after) {
		assert.ok(BEFORE.has(name), `${name} existed before`);
		assert.deepEqual(buf, BEFORE.get(name), `${name} unchanged by reads`);
	}
});
