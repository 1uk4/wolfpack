import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyLiveState, reduceLive } from "../../../src/core/graph/live/live-state.ts";
import { ownerThreadKey, targetNodeId } from "../../../src/core/graph/live/live-targets.ts";

const ev = (verb: string, o: Record<string, unknown>) => ({ v: 1, id: verb, pack: "p", ts: 0, ttlMs: 60_000, verb, ...o }) as never;

describe("owner thread and target matching", () => {
	it("matches the owner's URL slug to a wolfd thread id", () => {
		let s = reduceLive(emptyLiveState(), { type: "event", now: 0, event: ev("thread-active", { actor: { kind: "thread", wolf: "1uk4", threadId: "1uk4/feature-x" } }) });
		s = reduceLive(s, { type: "event", now: 1, event: ev("owner-viewing", { actor: { kind: "owner" }, target: { kind: "thread", id: "feature-x" } }) });
		assert.equal(ownerThreadKey(s), "1uk4/feature-x");
	});

	it("tells two wolves' same-slug threads apart by the wolf in the owner's target", () => {
		let s = reduceLive(emptyLiveState(), { type: "event", now: 0, event: ev("thread-active", { actor: { kind: "thread", wolf: "hal", threadId: "hal/plan" } }) });
		s = reduceLive(s, { type: "event", now: 1, event: ev("thread-active", { actor: { kind: "thread", wolf: "1uk4", threadId: "1uk4/plan" } }) });
		s = reduceLive(s, { type: "event", now: 2, event: ev("owner-viewing", { actor: { kind: "owner" }, target: { kind: "thread", id: "1uk4/plan" } }) });
		assert.equal(ownerThreadKey(s), "1uk4/plan");
		s = reduceLive(s, { type: "event", now: 3, event: ev("owner-viewing", { actor: { kind: "owner" }, target: { kind: "thread", id: "hal/plan" } }) });
		assert.equal(ownerThreadKey(s), "hal/plan");
		// A bare slug (an older console) matching two wolves is ambiguous: no ring rather than the wrong one.
		s = reduceLive(s, { type: "event", now: 4, event: ev("owner-viewing", { actor: { kind: "owner" }, target: { kind: "thread", id: "plan" } }) });
		assert.equal(ownerThreadKey(s), null);
	});

	it("maps targets to graph node ids, falling back to the domain node", () => {
		const nodes = new Set(["work:Abc1234", "ent:kb-1", "dom:wolfpack"]);
		const has = (id: string) => nodes.has(id);
		assert.equal(targetNodeId({ kind: "work-item", id: "work-wolfpack-Abc1234" }, has), "work:Abc1234");
		assert.equal(targetNodeId({ kind: "kb-entry", id: "kb-1" }, has), "ent:kb-1");
		assert.equal(targetNodeId({ kind: "kb-entry", id: "nope", domain: "wolfpack" }, has), "dom:wolfpack");
		assert.equal(targetNodeId({ kind: "kb-entry", id: "nope" }, has), null);
		assert.equal(targetNodeId({ kind: "domain", id: "wolfpack" }, has), "dom:wolfpack");
	});
});
