import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { loadPromptList, PROMPTS_LOAD_BOUND_MS } from "../lib/prompts-load.ts";
import { PromptsLoadNotice } from "../components/prompts-load-notice.tsx";

const rows = [{ id: "p", text: "t" }];

describe("Prompts list loading (work-wolfpack-FpEanzS)", () => {
	it("a non-OK answer becomes the server message, a network error and a stall become short errors, and a retry recovers", async () => {
		const answers: (() => Promise<Response>)[] = [
			async () => Response.json({ error: "wolf did not answer in time (20000 ms)" }, { status: 504 }),
			async () => { throw new TypeError("fetch failed"); },
			() => new Promise<Response>(() => {}),
			async () => Response.json({ prompts: rows }),
		];
		const f = (async () => answers.shift()!()) as unknown as typeof fetch;
		assert.deepEqual(await loadPromptList(f, "hal"), { error: "wolf did not answer in time (20000 ms)" });
		assert.deepEqual(await loadPromptList(f, "hal"), { error: "Could not reach the console server." });
		assert.deepEqual(await loadPromptList(f, "hal", 30), { error: "The wolf did not answer in time." });
		assert.deepEqual(await loadPromptList(f, "hal"), { prompts: rows });
		assert.equal(PROMPTS_LOAD_BOUND_MS, 20_000);
	});
	it("the notice shows a loading line while pending, and the error with a Retry button after a failure", () => {
		assert.match(renderToStaticMarkup(<PromptsLoadNotice loading error="" onRetry={() => {}} />), /Loading prompts/);
		const html = renderToStaticMarkup(<PromptsLoadNotice loading={false} error="The wolf did not answer in time." onRetry={() => {}} />);
		assert.match(html, /role="alert"[^>]*>The wolf did not answer in time\./);
		assert.match(html, /data-testid="prompts-retry"[^>]*>Retry</);
		assert.equal(renderToStaticMarkup(<PromptsLoadNotice loading={false} error="" onRetry={() => {}} />), "");
	});
});
