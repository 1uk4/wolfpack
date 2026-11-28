import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyLiveState, reduceLive } from "../../../src/core/graph/live/live-state.ts";
import { hubWorkNodeId, ownerThreadKey, subagentTaskNodeId, targetNodeId, youLinkTarget } from "../../../src/core/graph/live/live-targets.ts";

const ev = (verb: string, o: Record<string, unknown>) => ({ v: 1, id: verb, pack: "p", ts: 0, ttlMs: 60_000, verb, ...o }) as never;

describe("where a thread hub and a sub-agent attach", () => {
	const on = (...ids: string[]) => (n: string) => ids.includes(n);
	const bound = { kind: "work-item", id: "work-wolfpack-TASK" };
	it("a bound thread with no feature sits on its task node", () => {
		assert.equal(hubWorkNodeId({ bound }, on("work:TASK", "dom:wolfpack")), "work:TASK");
	});
	it("a feature thread bound to a child task sits on the feature node, not the task", () => {
		const t = { bound, feature: "work-wolfpack-FEAT" };
		assert.equal(hubWorkNodeId(t, on("work:FEAT", "work:TASK", "dom:wolfpack")), "work:FEAT");
		assert.equal(hubWorkNodeId({ feature: "work-wolfpack-FEAT" }, on("work:FEAT")), "work:FEAT");
	});
	it("a feature thread whose feature node is missing falls back to its task node, then to nothing", () => {
		const t = { bound, feature: "work-wolfpack-FEAT" };
		assert.equal(hubWorkNodeId(t, on("work:TASK", "dom:wolfpack")), "work:TASK");
		assert.equal(hubWorkNodeId(t, on("dom:wolfpack")), null);
	});
	it("rebinding a feature thread between child tasks never changes its hub node", () => {
		const has = on("work:FEAT", "work:A", "work:B");
		const at = (id: string) => hubWorkNodeId({ bound: { kind: "work-item", id }, feature: "work-wolfpack-FEAT" }, has);
		assert.equal(at("work-wolfpack-A"), "work:FEAT");
		assert.equal(at("work-wolfpack-B"), "work:FEAT");
	});
	it("a sub-agent with a work id in its brief sits on that task", () => {
		assert.equal(subagentTaskNodeId({ workItem: "work-wolfpack-SUB" }, { bound }, on("work:SUB", "work:TASK")), "work:SUB");
	});
	it("a sub-agent with no work id sits on its parent's bound item", () => {
		assert.equal(subagentTaskNodeId({}, { bound }, on("work:TASK")), "work:TASK");
		assert.equal(subagentTaskNodeId({}, { bound }, on("dom:wolfpack")), null);
	});
});

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

describe("the you node's one link", () => {
	const hubs = [
		{ wolf: "1uk4", threadId: "1uk4/feature-a", name: "hub-a" },
		{ wolf: "1uk4", threadId: "feature-b", name: "hub-b" },
	];
	const bodies: Record<string, { wolf: string; name: string }> = { "1uk4": { wolf: "1uk4", name: "body" } };
	const body = (w: string) => bodies[w];

	it("links only the attached thread's hub, and moves at once when the chat swaps", () => {
		assert.equal(youLinkTarget({ wolf: "1uk4", threadId: "feature-a" }, hubs, body)?.name, "hub-a");
		assert.equal(youLinkTarget({ wolf: "1uk4", threadId: "1uk4/feature-b" }, hubs, body)?.name, "hub-b");
	});

	it("falls back to the wolf's body for a thread that is no feature, and to nothing when no chat is attached", () => {
		assert.equal(youLinkTarget({ wolf: "1uk4", threadId: "home" }, hubs, body)?.name, "body");
		assert.equal(youLinkTarget(null, hubs, body), undefined);
	});
});
