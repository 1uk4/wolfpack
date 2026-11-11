import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import { macChannel, macDeps, macPaths } from "./auto-update-mac.mjs";

let dir: string;
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-upd-"))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("auto-update-mac channel", () => {
	it("follows stable + env opt-in without ~/.wolfpack/release-channel.json; with it, the file's channel and mode decide and main's manifest sha is checked out", async () => {
		const env = { HOME: dir, WOLFPACK_HOME: path.join(dir, ".wolfpack") };
		const p = macPaths(env, dir);
		expect(macChannel(p)).toEqual({ channel: "stable", mode: undefined });
		fs.mkdirSync(path.dirname(p.channelFile), { recursive: true });
		fs.writeFileSync(p.channelFile, JSON.stringify({ schema: 1, channel: "main", mode: "auto" }));
		expect(macChannel(p)).toEqual({ channel: "main", mode: "auto" });
		const seen: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (u: string) => (seen.push(String(u)), Response.json({ schema: 1, components: { workerd: { version: "0.1.6-main.2" } }, sha: "abc1234" }))) as typeof fetch;
		try {
			const deps = macDeps(p, env, "main");
			expect((await deps.fetchManifest()).sha).toBe("abc1234");
			expect(seen).toEqual(["https://github.com/1uk4/wolfpack/releases/download/main-manifest/main.json"]);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
