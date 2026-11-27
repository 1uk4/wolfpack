import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { progressBar, progressPanel, toneOfStatus } from "../../../src/core/work/task-progress.ts";

describe("stage tones", () => {
	it("colours ready and blocked as plan, building as build, shipped as shipped", () => {
		assert.deepEqual((["ready", "blocked", "building", "shipped", "archived"] as const).map(toneOfStatus), ["plan", "plan", "build", "shipped", "archived"]);
	});
});

describe("progressBar", () => {
	it("splits the bar by tone, skips archived, and always adds up to 100", () => {
		const s = (status: "ready" | "building" | "shipped" | "archived") => ({ status });
		const bar = progressBar([s("shipped"), s("shipped"), s("building"), s("ready"), s("archived")]);
		assert.deepEqual({ total: bar.total, plan: bar.plan, build: bar.build, shipped: bar.shipped }, { total: 4, plan: 1, build: 1, shipped: 2 });
		assert.deepEqual(bar.pct, { shipped: 50, build: 25, plan: 25 });
		assert.deepEqual(progressBar([]).pct, { shipped: 0, build: 0, plan: 0 });
		const third = progressBar([s("shipped"), s("building"), s("ready")]).pct;
		assert.equal(third.shipped + third.build + third.plan, 100);
	});
});

describe("progressPanel", () => {
	const item = {
		id: "work-wolfpack-T1",
		title: "Do it",
		kind: "task",
		stage: "in_build",
		record: "PR: https://github.com/acme/repo/pull/42 open",
		log: ["**t1** — started", "**t2** — committed abc1234def on the branch", "**t3** — note three", "**t4** — note four", "**t5** — note five", "**t6** — note six"],
	};
	it("picks the live thread bound to the item (needs-you over working over idle) and links to it", () => {
		const threads = [
			{ wolf: "w1", id: "t-idle", status: "idle" as const, boundItem: item.id },
			{ wolf: "w1", id: "t-ask", status: "needs-you" as const, boundWorkItem: item.id },
			{ wolf: "w1", id: "t-other", status: "busy" as const, boundItem: "other" },
			{ wolf: "w1", id: "t-closed", status: "busy" as const, closed: true, boundItem: item.id },
		];
		const p = progressPanel(item, "building", threads, "w2");
		assert.equal(p.thread?.id, "t-ask");
		assert.equal(p.thread?.live, "needs-you");
		assert.equal(p.wolf, "w2");
		assert.equal(p.tone, "build");
		assert.match(p.thread!.href, /t-ask/);
		assert.equal(progressPanel(item, "building", [{ wolf: "w1", id: "b", status: "busy", boundItem: item.id }]).thread?.live, "working");
		assert.equal(progressPanel(item, "ready", []).thread, null);
	});
	it("shows the latest three notes newest first, commits apart, and the PR written in the record", () => {
		const p = progressPanel(item, "building", []);
		assert.deepEqual(p.notes, ["**t6** — note six", "**t5** — note five", "**t4** — note four"]);
		assert.deepEqual(p.commits, ["**t2** — committed abc1234def on the branch"]);
		assert.equal(p.pr, "https://github.com/acme/repo/pull/42");
		assert.equal(progressPanel({ ...item, record: "" }, "building", []).pr, null);
	});
});
