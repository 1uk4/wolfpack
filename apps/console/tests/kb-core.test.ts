import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KB_MIRROR_LABEL, PIPELINE_HREF, entryHref, findKbSource, findLibrarian, parseMemoryEventFrame, workHref } from "../src/core/kb.ts";

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

describe("findKbSource", () => {
	const lib = { name: "dewey", status: "online", librarian: true, kbReadable: true };
	const mirror = { name: "1uk4", status: "online", librarian: false, kbReadable: true };
	const blind = { name: "x", status: "online" };
	it("prefers the online librarian", () => {
		assert.deepEqual(findKbSource([mirror, lib]), { name: "dewey", mirror: false });
	});
	it("falls back to the first online wolf with kbReadable, as a mirror", () => {
		assert.deepEqual(findKbSource([blind, mirror, { ...mirror, name: "other" }]), { name: "1uk4", mirror: true });
		assert.deepEqual(findKbSource([{ ...lib, status: "offline" }, mirror]), { name: "1uk4", mirror: true });
	});
	it("is null only when no online wolf can read the KB", () => {
		assert.equal(findKbSource([]), null);
		assert.equal(findKbSource([blind, { ...mirror, status: "offline" }, { name: "y", status: "online", kbReadable: false }]), null);
	});
	it("labels the mirror", () => assert.equal(KB_MIRROR_LABEL, "read-only mirror (librarian offline)"));
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

