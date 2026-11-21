// The release manifest is a pure function of the published releases, so the manifest job must be able to rebuild it on any
// successful run, including one where the tag job found nothing to tag (build skipped). Only a failed or cancelled build blocks it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Job = { if?: string };
const jobs = (file: string) => (parse(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8")) as { jobs: Record<string, Job> }).jobs;

describe.each(["release-main.yml", "release-stable.yml"])("%s", (file) => {
	const j = jobs(file);

	it("builds only when the tag job produced tags", () => {
		expect(j.build.if).toContain("tags != '[]'");
	});

	it("rebuilds the manifest even when nothing was tagged (build skipped), but not after a failed build", () => {
		const cond = j.manifest.if ?? "";
		expect(cond).not.toContain("tags != '[]'");
		expect(cond).toContain("needs.tag.result == 'success'");
		expect(cond).toContain("needs.build.result != 'failure'");
		expect(cond).toContain("needs.build.result != 'cancelled'");
	});
});
