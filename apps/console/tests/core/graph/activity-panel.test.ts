import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityPanelBox, activityRedirects, loadSeenUpTo, replayTargetIds, saveSeenUpTo, unseenCount } from "../../../src/core/graph/live/activity-panel.ts";

const mem = () => {
	const m = new Map<string, string>();
	return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("activity panel", () => {
	it("counts only events newer than the seen-up-to mark, and the mark survives a reload", () => {
		const s = mem();
		assert.equal(loadSeenUpTo(s), 0);
		saveSeenUpTo(s, 2000);
		assert.equal(loadSeenUpTo(s), 2000);
		assert.equal(unseenCount([{ at: 1500 }, { at: 2000 }, { at: 2500 }, { at: 3000 }], loadSeenUpTo(s)), 2);
		assert.equal(loadSeenUpTo(null), 0);
		assert.equal(loadSeenUpTo({ getItem: () => "junk", setItem: () => {} }), 0);
	});

	it("replay flies to the entry, else the deepest section on the map, else the domain, else nowhere", () => {
		const on = new Set(["ent:A", "sec:s1", "sec:s2", "dom:wolfpack"]);
		const t = { kind: "kb-entry", id: "A", domain: "wolfpack" };
		assert.deepEqual(replayTargetIds(on, t, ["s1", "s2", "s3"]), ["ent:A"]);
		assert.deepEqual(replayTargetIds(on, { ...t, id: "B" }, ["s1", "s2", "s3"]), ["sec:s2"]);
		assert.deepEqual(replayTargetIds(on, { ...t, id: "B" }, ["x"]), ["dom:wolfpack"]);
		assert.deepEqual(replayTargetIds(on, { ...t, id: "B", domain: "other" }), []);
		assert.deepEqual(replayTargetIds(on, { kind: "work-item", id: "work-x-1" }), []);
	});

	it("/kb-activity opens the graph on the KB tab, keeping the domain", () => {
		const r = activityRedirects();
		assert.deepEqual(r.find((x) => !x.has), { source: "/kb-activity", destination: "/graph?activity=kb", permanent: false });
		assert.deepEqual(r.find((x) => x.has), { source: "/kb-activity", has: [{ type: "query", key: "domain", value: "(?<domain>.+)" }], destination: "/graph?activity=kb&domain=:domain", permanent: false });
	});

	it("a phone gets a bottom sheet clear of the chat icon with 44px controls; desktop the 12px-above-bar panel", () => {
		assert.deepEqual(activityPanelBox(true), { kind: "sheet", bottom: "env(safe-area-inset-bottom) + 64px", minTarget: 44 });
		assert.deepEqual(activityPanelBox(false), { kind: "panel", bottom: "var(--chat-bar-top,0px) + 12px", minTarget: 28 });
	});
});
