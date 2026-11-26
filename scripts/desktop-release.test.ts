import { describe, expect, it } from "vitest";
import { nextDesktopVersion, renderNotes } from "./desktop-release.mjs";

describe("nextDesktopVersion", () => {
	it("is +1 patch over the highest desktop release, ignoring -main.N pre-releases and other components", () => {
		const names = ["desktop/v0.4.0", "desktop/v0.4.1", "desktop/v0.5.0-main.9", "desktop/v0.4.10-main.2", "console/v0.9.9", "desktop-latest"];
		expect(nextDesktopVersion({ names, pkgVersion: "0.4.1" })).toBe("0.4.2");
		expect(nextDesktopVersion({ names: ["desktop/v0.4.9", "desktop/v0.4.10"], pkgVersion: "0.4.1" })).toBe("0.4.11");
	});

	it("counts a draft release that has no git tag (names come from releases as well)", () => {
		expect(nextDesktopVersion({ names: ["desktop/v0.4.0", "desktop/v0.4.1"], pkgVersion: "0.4.0" })).toBe("0.4.2");
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
