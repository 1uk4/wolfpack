import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PIPELINE_HREF, entryHref, findLibrarian, nodeIdOfEvent, parseMemoryEventFrame, workHref } from "../src/core/kb.ts";

const base = { wolf: "1uk4", timestamp: "2026-10-26T00:00:00.000Z", domain: "d" };

describe("findLibrarian", () => {
	it("returns the flagged wolf, else null", () => {
		const a = { name: "a" };
		const lib = { name: "lib", librarian: true };
		assert.equal(findLibrarian([a, lib]), lib);
		assert.equal(findLibrarian([a, { name: "b", librarian: false }]), null);
		assert.equal(findLibrarian([]), null);
	});
});

describe("parseMemoryEventFrame", () => {
	it("parses a known event", () => {
		const raw = JSON.stringify({ ...base, type: "promote_started", target: { kind: "den" }, jobId: "j" });
		assert.equal(parseMemoryEventFrame(raw)?.type, "promote_started");
	});

	it("passes unknown event types through as a generic frame", () => {
		const f = parseMemoryEventFrame(JSON.stringify({ ...base, type: "sweep_started", sweepId: "s1" }));
		assert.equal(f?.type, "sweep_started");
		assert.equal((f as Record<string, unknown>).sweepId, "s1");
	});

	it("returns null (never throws) for garbage", () => {
		for (const raw of ["", "nope", "[]", "42", "null", '{"wolf":"w"}', '{"type":"x"}', '{"type":1,"wolf":"w"}']) {
			assert.equal(parseMemoryEventFrame(raw), null, raw);
		}
	});
});

describe("hrefs", () => {
	it("builds and encodes", () => {
		assert.equal(PIPELINE_HREF, "/pipeline");
		assert.equal(entryHref("wolfpack/a b"), "/kb/entry/wolfpack%2Fa%20b");
		assert.equal(workHref("work-1"), "/kb/work/work-1");
	});
});

describe("nodeIdOfEvent", () => {
	it("maps den, work, and loose entry/work ids; null otherwise", () => {
		assert.equal(nodeIdOfEvent({ ...base, type: "topic_consolidated", target: { kind: "den" }, topicId: "t1" }), "den:1uk4:t1");
		assert.equal(nodeIdOfEvent({ ...base, type: "observation_captured", target: { kind: "work", workId: "w9" } }), "work:w9");
		assert.equal(nodeIdOfEvent({ ...base, type: "record_written", target: { kind: "session" }, entryId: "e5" }), "ent:e5");
		assert.equal(nodeIdOfEvent({ ...base, type: "observation_captured", target: { kind: "den" } }), null);
		assert.equal(nodeIdOfEvent({ ...base, type: "sweep_started" }), null);
	});
});
