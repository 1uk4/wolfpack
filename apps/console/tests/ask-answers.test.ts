/** Multi defaults in the sheet's answers (work-wolfpack-6RTKdW4): seeded visible, never sent hidden, not brought back once cleared. Pure. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pageBody, reconcile, seedAll } from "../components/ask-answers.ts";

const OPTS = [{ label: "A", value: "a" }, { label: "B", value: "b" }];
const pc = (extra: object = {}, fields: object[] = [{ id: "m", kind: "multi", label: "m", options: OPTS, default: ["a", "b"] }]) =>
	({ callId: "c", threadId: "w/a", raisedAt: "", card: { tool: "task_done", paged: true, fields, steps: [{ fields: (fields as { id: string }[]).map((f) => f.id) }] }, ...extra }) as never;

describe("multi defaults", () => {
	it("a multi hidden by showIf is not in the submitted body even though its default was seeded", () => {
		const p = pc({}, [
			{ id: "gate", kind: "single", label: "g", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }] },
			{ id: "m", kind: "multi", label: "m", options: OPTS, default: ["a"], showIf: { field: "gate", equals: "yes" } },
		]) as { card: { fields: never[] } };
		const draft = { ...seedAll(p as never), gate: { value: "no" } } as never;
		assert.deepEqual(pageBody(p.card.fields, draft, (p as never as { card: never }).card), { gate: { value: "no" } });
	});

	it("a default the owner cleared stays cleared after a refetch", () => {
		const p = pc();
		assert.deepEqual(reconcile(p, {}), {});
	});

	it("a saved answer wins over the default", () => {
		const p = pc({ draft: { m: { value: ["b"] } } });
		assert.deepEqual(seedAll(p), { m: { value: ["b"] } });
	});

	it("a default naming an option that no longer exists is not seeded", () => {
		const p = pc({}, [{ id: "m", kind: "multi", label: "m", options: OPTS, default: ["gone"] }]);
		assert.deepEqual(seedAll(p), {});
	});
});
