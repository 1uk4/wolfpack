import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveVersion } from "./release-version.mjs";

const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
let repo: string;
const commit = (msg: string) => {
	fs.writeFileSync(path.join(repo, "f.txt"), msg);
	g(repo, "add", "f.txt");
	g(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg);
	return g(repo, "rev-parse", "--short", "HEAD");
};
const tag = (t: string) => g(repo, "-c", "user.name=t", "-c", "user.email=t@t", "tag", "-a", t, "-m", t);

beforeEach(() => {
	repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relver-")));
	g(repo, "init", "-q", "-b", "stable");
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("resolveVersion", () => {
	it("is the bare tag version when HEAD is exactly at the component's tag, ignoring other components' tags", () => {
		commit("one");
		tag("hubd/v0.1.13");
		commit("two");
		tag("hubd/v0.1.14");
		tag("console/v0.1.18");
		expect(resolveVersion("hubd", repo)).toBe("0.1.14");
		expect(resolveVersion("console", repo)).toBe("0.1.18");
	});

	it("appends the short sha as build metadata when HEAD is ahead of the tag", () => {
		commit("one");
		tag("workerd/v0.1.5");
		const sha = commit("two");
		expect(resolveVersion("workerd", repo)).toBe(`0.1.5+${sha}`);
	});

	it("for a release build of X.Y.Z, is bare X.Y.Z at that tag and X.Y.Z+<sha> anywhere else (by-hand builds off the tag)", () => {
		commit("one");
		tag("hubd/v0.1.14");
		expect(resolveVersion("hubd", repo, { release: "0.1.14" })).toBe("0.1.14");
		const sha = commit("two");
		expect(resolveVersion("hubd", repo, { release: "0.1.14" })).toBe(`0.1.14+${sha}`);
		expect(resolveVersion("wolfd", repo, { release: "0.2.0" })).toBe(`0.2.0+${sha}`);
	});

	it("is null when the component has never been tagged", () => {
		commit("one");
		tag("hubd/v0.1.14");
		expect(resolveVersion("wolfd", repo)).toBeNull();
	});
});
