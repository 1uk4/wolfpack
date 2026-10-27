import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PipelineBody, PipelineUnavailable } from "../components/pipeline-view.tsx";
import { initialState } from "../src/core/pipeline-model.ts";

describe("PipelineBody", () => {
	it("renders lanes, receipts with entry links and detail, parked", () => {
		const state = initialState({
			lanes: [{ wolf: "hal", pending: 2, oldestAgeMs: 120_000 }],
			receipts: [
				{ wolf: "hal", denTopicId: "t1", outcome: "created" as never, entryId: "ent-1", processed: "2026-10-26T10:00:00Z" },
				{ wolf: "hal", denTopicId: "t2", outcome: "rejected" as never, processed: "2026-10-26T10:00:00Z", detail: "too vague" },
			],
			parked: [{ wolf: "hal", file: "f.md", reason: "no domain" }],
			parkedTotal: 3,
			sweep: { last: { startedAt: "2026-10-26T09:59:00Z", finishedAt: "2026-10-26T10:00:00Z", processed: 2, created: 1, merged: 0, rejected: 1, parked: 0, remaining: 0, durationMs: 900, error: "boom" } },
		});
		const html = renderToStaticMarkup(<PipelineBody state={state} now={Date.parse("2026-10-26T10:05:00Z")} />);
		assert.match(html, /data-testid="pipeline-view"/);
		assert.match(html, /2 pending/);
		assert.match(html, /oldest 2m/);
		assert.match(html, /href="\/kb\/entry\/ent-1"/);
		assert.match(html, /too vague/);
		assert.match(html, /no domain/);
		assert.match(html, /3 total/);
		assert.match(html, /5m ago/);
		assert.match(html, /boom/);
	});
	it("unavailable state", () => {
		assert.match(renderToStaticMarkup(<PipelineUnavailable message="nope" />), /data-testid="pipeline-unavailable"/);
	});
});
