import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextDesktopVersion, renderNotes } from "./desktop-release.mjs";

describe("nextDesktopVersion", () => {
	it("is +1 patch over the highest desktop release, ignoring -main.N pre-releases and other components", () => {
		const names = ["desktop/v0.4.0", "desktop/v0.4.1", "desktop/v0.5.0-main.9", "desktop/v0.4.10-main.2", "console/v0.9.9", "desktop-latest"];
		expect(nextDesktopVersion({ names, pkgVersion: "0.4.1" })).toBe("0.4.2");
		expect(nextDesktopVersion({ names: ["desktop/v0.4.9", "desktop/v0.4.10"], pkgVersion: "0.4.1" })).toBe("0.4.11");
	});

	it("lets a hand bump in package.json win, and starts at package.json when nothing was released", () => {
		expect(nextDesktopVersion({ names: ["desktop/v0.4.1"], pkgVersion: "0.5.0" })).toBe("0.5.0");
		expect(nextDesktopVersion({ names: [], pkgVersion: "0.4.1" })).toBe("0.4.1");
	});

	it("reuses the version already tagged at the commit, so a rerun does not skip a number", () => {
		expect(nextDesktopVersion({ names: ["desktop/v0.4.2"], pkgVersion: "0.4.1", headTags: ["desktop/v0.4.2"] })).toBe("0.4.2");
	});
});

describe("renderNotes", () => {
	it("lists the highest console, wolfd, hubd and workerd versions and the commit", () => {
		const tags = ["console/v0.1.9", "console/v0.1.22", "console/v0.2.0-main.3", "wolfd/v0.1.19", "hubd/v0.1.18", "workerd/v0.1.10"];
		expect(renderNotes({ version: "0.4.2", sha: "abc123", tags })).toBe(
			"Signed, notarised Mac app 0.4.2.\n\nBundled parts:\n- console 0.1.22\n- wolfd 0.1.19\n- hubd 0.1.18\n- workerd 0.1.10\n\nStable commit: abc123\n",
		);
	});
});

describe("desktop-release CLI in a temp git repo", () => {
	let repo: string;
	const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" }).trim();
	const run = (...a: string[]) => execFileSync("node", ["scripts/desktop-release.mjs", ...a], { cwd: repo, encoding: "utf8" });
	const commit = (m: string) => { fs.writeFileSync(path.join(repo, "f.txt"), m); g("add", "."); g("commit", "-q", "-m", m); return g("rev-parse", "HEAD"); };
	beforeEach(() => {
		repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deskrel-")));
		g("init", "-q", "-b", "stable");
		fs.mkdirSync(path.join(repo, "scripts"));
		fs.mkdirSync(path.join(repo, "apps/desktop"), { recursive: true });
		fs.copyFileSync(path.join(__dirname, "desktop-release.mjs"), path.join(repo, "scripts/desktop-release.mjs"));
		fs.writeFileSync(path.join(repo, "apps/desktop/package.json"), JSON.stringify({ version: "0.4.1" }));
	});
	afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

	it("notes reads only component tags reachable from the given sha", () => {
		const first = commit("one");
		g("tag", "-a", "console/v0.1.5", "-m", "x");
		g("tag", "-a", "wolfd/v0.1.2", "-m", "x");
		g("tag", "-a", "hubd/v0.1.3", "-m", "x");
		g("tag", "-a", "workerd/v0.1.4", "-m", "x");
		commit("two");
		g("tag", "-a", "console/v0.1.6", "-m", "x");
		expect(run("notes", "0.4.2", first)).toContain("- console 0.1.5\n- wolfd 0.1.2\n- hubd 0.1.3\n- workerd 0.1.4\n");
	});

	it("version reuses a draft release aimed at this commit (no git tag) and skips drafts aimed elsewhere", () => {
		commit("one");
		g("tag", "-a", "desktop/v0.4.1", "-m", "x");
		const head = commit("two");
		const file = path.join(repo, "releases.json");
		fs.writeFileSync(file, JSON.stringify([{ tagName: "desktop/v0.4.2", isDraft: true, targetCommitish: head }]));
		expect(run("version", "--releases", file).trim()).toBe("0.4.2");
		fs.writeFileSync(file, JSON.stringify([{ tagName: "desktop/v0.4.2", isDraft: true, targetCommitish: "deadbeef" }]));
		expect(run("version", "--releases", file).trim()).toBe("0.4.3");
	});
});
