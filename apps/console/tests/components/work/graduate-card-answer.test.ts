/**
 * The task_graduate card's answer hook (work-wolfpack-zoeLko9): picked items graduate with stubbed client calls; the note tells the wolf the outcome.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { graduatePicked, graduationNoteFor, pickedOf } = await import("../../../components/work/graduate-card-answer.ts");

const preview = (id: string) => ({ ok: true as const, preview: { itemId: id, summary: `S ${id}`, contributions: [{ id: `c-${id}` }] } as never });
const done = (id: string) => ({ ok: true as const, itemId: id, domain: "wolfpack", sent: 1, archived: 1, via: "card" as const, approvedBy: { actor: "o", device: "d", at: "t" } });

function stubs(over: { preview?: (id: string) => unknown; graduate?: (id: string) => unknown } = {}) {
	const calls: { id: string; body: any }[] = [];
	let running = 0;
	let peak = 0;
	return {
		calls,
		peak: () => peak,
		deps: {
			getPendingPreview: async (_wolf: string, id: string) => (over.preview ?? preview)(id) as never,
			graduateDirect: async (id: string, body: any) => {
				calls.push({ id, body });
				running++;
				peak = Math.max(peak, running);
				await new Promise((r) => setTimeout(r, 5));
				running--;
				return (over.graduate ?? done)(id) as never;
			},
		},
	};
}

const OFFERED = ["a", "b", "c"];

describe("graduatePicked", () => {
	it("graduates every picked item with its preview, via card and the thread's wolf, two at a time", async () => {
		const s = stubs();
		const note = await graduatePicked({ wolf: "1uk4", offered: OFFERED, picked: ["a", "b", "c"] }, s.deps);
		assert.equal(note, "Graduated: a, b, c.");
		assert.deepEqual(s.calls.find((c) => c.id === "a")?.body, { contributions: [{ id: "c-a" }], summary: "S a", via: "card", wolf: "1uk4" });
		assert.equal(s.peak(), 2);
	});

	it("reports a failed item and still graduates the others", async () => {
		const s = stubs({ graduate: (id) => (id === "b" ? { ok: false, status: 403, code: "forbidden", message: "owner only", alreadyGraduated: false } : done(id)) });
		assert.equal(await graduatePicked({ wolf: "1uk4", offered: OFFERED, picked: ["a", "b", "c"] }, s.deps), "Graduated: a, c. Failed: b: owner only.");
	});

	it("reports an expired preview and does not graduate it", async () => {
		const s = stubs({ preview: (id) => (id === "b" ? { ok: true, none: true } : preview(id)) });
		const note = await graduatePicked({ wolf: "1uk4", offered: OFFERED, picked: ["a", "b"] }, s.deps);
		assert.match(note, /Graduated: a\. Expired .*: b\./);
		assert.deepEqual(s.calls.map((c) => c.id), ["a"]);
	});

	it("counts an already graduated item as done", async () => {
		const s = stubs({ graduate: () => ({ ok: false, status: 400, code: "bad", message: "already graduated", alreadyGraduated: true }) });
		assert.equal(await graduatePicked({ wolf: "1uk4", offered: OFFERED, picked: ["a"] }, s.deps), "Graduated: a.");
	});

	it("does nothing when nothing is picked", async () => {
		const s = stubs();
		assert.equal(await graduatePicked({ wolf: "1uk4", offered: OFFERED, picked: pickedOf({ picked: { value: [] } }) }, s.deps), "");
		assert.deepEqual(s.calls, []);
	});

	it("drops a picked value the card never offered and says so", async () => {
		const s = stubs();
		const note = await graduatePicked({ wolf: "1uk4", offered: OFFERED, picked: ["a", "zzz"] }, s.deps);
		assert.equal(note, "Graduated: a. Not offered on this card, ignored: zzz.");
		assert.deepEqual(s.calls.map((c) => c.id), ["a"]);
	});

	it("refuses everything when the card names another wolf", async () => {
		const s = stubs();
		const note = await graduatePicked({ wolf: "1uk4", cardWolf: "jack", offered: OFFERED, picked: ["a"] }, s.deps);
		assert.match(note, /card wolf mismatch/);
		assert.deepEqual(s.calls, []);
	});
});

describe("graduationNoteFor", () => {
	const card = (meta?: unknown) => ({ tool: "task_graduate", ...(meta ? { meta } : {}), fields: [{ id: "picked", kind: "multi", options: [{ value: "a" }, { value: "b" }] }] });

	it("reads the offered ids from the card and uses the thread's wolf", async () => {
		const s = stubs();
		const note = await graduationNoteFor(card({ wolf: "1uk4", via: "card" }) as never, { picked: { value: ["a"] } }, "1uk4", s.deps);
		assert.equal(note, "Graduated: a.");
		assert.equal(s.calls[0]?.body.wolf, "1uk4");
	});

	it("never throws: a broken card becomes a 'graduation step failed' note", async () => {
		const s = stubs();
		const note = await graduationNoteFor({ tool: "task_graduate" } as never, { picked: { value: ["a"] } }, "1uk4", s.deps);
		assert.match(note, /^graduation step failed: /);
		assert.deepEqual(s.calls, []);
	});
});
