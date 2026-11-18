import assert from "node:assert/strict";
import { describe, it } from "node:test";
import SettingsPage from "../app/settings/page.tsx";
import PromptsPage from "../app/prompts/page.tsx";

const redirectsTo = (page: () => unknown, target: string) =>
	assert.throws(
		() => page(),
		(e: unknown) => {
			const err = e as { digest?: string };
			return typeof err.digest === "string" && err.digest.startsWith("NEXT_REDIRECT") && err.digest.includes(target);
		},
	);

describe("the old Settings URLs", () => {
	it("/settings and /prompts open the Pack at Wolves", () => {
		redirectsTo(SettingsPage, "/?pack=wolves");
		redirectsTo(PromptsPage, "/?pack=wolves");
	});
});
