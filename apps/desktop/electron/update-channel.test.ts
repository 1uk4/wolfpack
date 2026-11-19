/**
 * Seam: createUpdateChannel (electron/update-channel.cjs) with a stand-in autoUpdater, a temp dir and a stand-in GitHub releases fetch.
 */
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const { createUpdateChannel, compareVersions } = createRequire(import.meta.url)("./update-channel.cjs");

let dir: string;
let updater: { channel?: string; allowPrerelease?: boolean; allowDowngrade?: boolean };
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "update-channel-"));
	updater = {};
});

const releases = (tags: string[]) => async () => ({
	ok: true,
	json: async () => tags.map((t) => ({ tag_name: t, prerelease: t.includes("-"), draft: false })),
});
const make = (o: Record<string, unknown> = {}) => createUpdateChannel({ stateDir: dir, updater, version: "0.4.0", ...o });

describe("update channel", () => {
	it("defaults to stable: the latest feed, no pre-releases, no downgrade", () => {
		const c = make();
		c.init();
		expect(c.state()).toEqual({ available: true, channel: "stable" });
		expect(updater).toEqual({ channel: "latest", allowPrerelease: false, allowDowngrade: false });
	});

	it("main reads the main feed with pre-releases allowed, and the choice survives a restart", () => {
		expect(make().setChannel("main").ok).toBe(true);
		const again = make();
		again.init();
		expect(again.state().channel).toBe("main");
		expect(updater).toEqual({ channel: "main", allowPrerelease: true, allowDowngrade: false });
	});

	it("returning to stable from a main build keeps downgrade off and says it waits for the next stable release", () => {
		const c = make({ version: "0.4.1-main.3" });
		c.setChannel("main");
		const r = c.setChannel("stable");
		expect(updater).toEqual({ channel: "latest", allowPrerelease: false, allowDowngrade: false });
		expect(r.returnNote).toBe("You'll return to stable at the next stable release.");
	});

	it("orders pre-releases by number, below their release", () => {
		expect(compareVersions("0.4.1-main.10", "0.4.1-main.9")).toBe(1);
		expect(compareVersions("0.4.1-main.2", "0.4.1")).toBe(-1);
		expect(compareVersions("0.4.1", "0.4.0-main.7")).toBe(1);
		expect(compareVersions("0.4.1-main.2", "0.4.1-main.2")).toBe(0);
	});

	it("reports the newest main pre-release as ahead when it is newer than the running version", async () => {
		const c = make({ version: "0.4.0", fetchImpl: releases(["v0.4.0", "v0.4.1-main.9", "v0.4.1-main.10"]) });
		expect(await c.checkMain()).toEqual({ ahead: "0.4.1-main.10", upToDate: false });
	});

	it("reports up to date when the running build is the newest main pre-release or newer", async () => {
		const c = make({ version: "0.4.1-main.10", fetchImpl: releases(["v0.4.1-main.10", "v0.4.1-main.9"]) });
		expect(await c.checkMain()).toEqual({ ahead: null, upToDate: true });
		const stable = make({ version: "0.4.1", fetchImpl: releases(["v0.4.1-main.10"]) });
		expect(await stable.checkMain()).toEqual({ ahead: null, upToDate: true });
	});

	it("in remote mode is unavailable with a note, changes nothing and never touches the updater", () => {
		const c = make({ remote: true });
		c.init();
		expect(c.state()).toMatchObject({ available: false, note: expect.stringContaining("another machine") });
		expect(c.setChannel("main").ok).toBe(false);
		expect(updater).toEqual({});
	});
});
