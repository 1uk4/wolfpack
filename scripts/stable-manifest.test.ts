import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest, writeManifest } from "./stable-manifest.mjs";

const REPO = "1uk4/wolfpack";
const at = "2026-11-09T12:00:00.000Z";
const t = (tag: string, sha: string, date: string) => ({ tag, sha, date });

describe("buildManifest", () => {
	it("takes each component's highest tag by semver, not by string or date order, and ignores tags that are not <component>/vX.Y.Z", () => {
		const m = buildManifest(
			[
				t("hubd/v0.1.9", "aaa", "2026-11-08T00:00:00Z"), // newest date, lowest version
				t("hubd/v0.1.14", "bbb", "2026-11-07T00:00:00Z"),
				t("hubd/v0.1.13", "ccc", "2026-11-06T00:00:00Z"),
				t("console/v0.1.18", "ddd", "2026-11-07T01:00:00Z"),
				t("stable-manifest", "eee", "2026-11-09T00:00:00Z"),
				t("v1.0.0", "fff", "2026-11-09T00:00:00Z"),
				t("legacy/main", "ggg", "2026-11-09T00:00:00Z"),
			],
			{ repo: REPO, components: ["console", "hubd", "wolfd", "workerd"], now: at },
		);
		expect(m).toEqual({
			schema: 1,
			generatedAt: at,
			components: {
				console: { version: "0.1.18", tag: "console/v0.1.18", sha: "ddd", publishedAt: "2026-11-07T01:00:00Z", notesUrl: "https://github.com/1uk4/wolfpack/releases/tag/console/v0.1.18" },
				hubd: { version: "0.1.14", tag: "hubd/v0.1.14", sha: "bbb", publishedAt: "2026-11-07T00:00:00Z", notesUrl: "https://github.com/1uk4/wolfpack/releases/tag/hubd/v0.1.14" },
			},
		});
	});

});

// The gh runner is the GitHub boundary: `(args) => { status, stdout, stderr }`, as `gh release view <tag> --json isDraft --jq .isDraft`.
type GhResult = { status: number | null; stdout: string; stderr: string };
const published: GhResult = { status: 0, stdout: "false\n", stderr: "" };
const draft: GhResult = { status: 0, stdout: "true\n", stderr: "" };
const notFound: GhResult = { status: 1, stdout: "", stderr: "release not found\n" };
const unavailable: GhResult = { status: 1, stdout: "", stderr: "HTTP 503: Service Unavailable (https://api.github.com/repos/1uk4/wolfpack/releases/tags/workerd/v0.1.7)\n" };
const workerdTags = [t("workerd/v0.1.4", "z", "2026-10-01T00:00:00Z"), t("workerd/v0.1.5", "a", "2026-11-01T00:00:00Z"), t("workerd/v0.1.6", "b", "2026-11-08T00:00:00Z"), t("workerd/v0.1.7", "c", "2026-11-09T00:00:00Z")];
/** Answers per tag, one per call in order; the last answer repeats. */
const ghStub = (answers: Record<string, GhResult[]>) => {
	const calls: Record<string, number> = {};
	return (args: string[]): GhResult => {
		const tag = args[2];
		const list = answers[tag] ?? [notFound];
		const i = calls[tag] ?? 0;
		calls[tag] = i + 1;
		return list[Math.min(i, list.length - 1)];
	};
};
const noWait = () => {};

describe("writeManifest with --check-releases", () => {
	it("walks down past tags gh reports as not found or as a draft to the newest published release", () => {
		const m = writeManifest({ repo: REPO, tags: workerdTags, components: ["workerd"], now: at, checkReleases: true, sleep: noWait, gh: ghStub({ "workerd/v0.1.7": [notFound], "workerd/v0.1.6": [draft], "workerd/v0.1.5": [published], "workerd/v0.1.4": [published] }) });
		expect(m.components.workerd?.tag).toBe("workerd/v0.1.5");
	});

	it("retries a transient gh failure and still picks the newest published tag", () => {
		const m = writeManifest({ repo: REPO, tags: workerdTags, components: ["workerd"], now: at, checkReleases: true, sleep: noWait, gh: ghStub({ "workerd/v0.1.7": [unavailable, published], "workerd/v0.1.6": [published] }) });
		expect(m.components.workerd?.tag).toBe("workerd/v0.1.7");
	});

	it("fails with the tag and gh's error, writing no file, when gh keeps failing", () => {
		const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stable-manifest-")), "stable.json");
		const run = () => writeManifest({ repo: REPO, tags: workerdTags, components: ["workerd"], now: at, checkReleases: true, out, sleep: noWait, gh: ghStub({ "workerd/v0.1.7": [unavailable], "workerd/v0.1.6": [published] }) });
		expect(run).toThrow(/workerd\/v0\.1\.7[\s\S]*HTTP 503: Service Unavailable/);
		expect(fs.existsSync(out)).toBe(false);
	});
});
