import assert from "node:assert/strict";
import { describe, it } from "node:test";
import PipelinePage from "../app/pipeline/page.tsx";

describe("/pipeline", () => {
	it("redirects to /kb-activity", () => {
		assert.throws(
			() => PipelinePage(),
			(e: unknown) => {
				const err = e as { digest?: string };
				return typeof err.digest === "string" && err.digest.startsWith("NEXT_REDIRECT") && err.digest.includes("/kb-activity");
			},
		);
	});
});
