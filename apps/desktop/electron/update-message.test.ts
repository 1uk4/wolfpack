import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { plainError } from "../../../packages/protocol/src/update-state.js";

const require = createRequire(import.meta.url);
const { updateCheckMessage } = require("./update-message.cjs") as { updateCheckMessage: (err: unknown, version: string) => string };

// Manual "Check now" from Pack → Machines (work-wolfpack-SzoWaBZ). electron-updater throws HttpErrors whose
// message carries the URL, a hint about auth tokens and every response header; a friend must see one plain line.
describe("updateCheckMessage", () => {
	it("a missing feed (404) says no update is published yet, without the raw HTTP dump", () => {
		const raw =
			'Cannot find channel "latest-mac.yml" update info: HttpError: 404 \n"method: GET url: https://github.com/x/y/releases/download/desktop-latest/latest-mac.yml?noCache=1\\n\\nPlease double check that your authentication token is correct. Due to security reasons, actual status maybe not reported, but 404.\\n"\nHeaders: {\n"cache-control": "no-cache"\n}';
		const m = updateCheckMessage(new Error(raw), "0.4.0");
		expect(m).toBe("No update is published yet. Wolfpack 0.4.0 is the newest version.");
	});

	it("a network failure asks to check the connection", () => {
		for (const raw of ["net::ERR_INTERNET_DISCONNECTED", "getaddrinfo ENOTFOUND github.com", "connect ETIMEDOUT 1.2.3.4:443"]) {
			expect(updateCheckMessage(new Error(raw), "0.4.0")).toBe("Couldn't reach the update server. Check your internet connection and try again.");
		}
	});

	it("any other error keeps only its first line, trimmed", () => {
		expect(updateCheckMessage(new Error("Signature check failed\nHeaders: {...}"), "0.4.0")).toBe("Signature check failed");
		expect(updateCheckMessage("plain string", "0.4.0")).toBe("plain string");
		expect(updateCheckMessage(undefined, "0.4.0")).toBe("Couldn't check for updates.");
	});

	// The CJS shell cannot import @wolfpack/protocol, so it keeps its own copy of these two sentences (work-wolfpack-nPeLT7s).
	it("says the same plain sentences as the shared plainError for a missing feed and for offline", () => {
		for (const raw of ["HttpError: 404 Headers: {}", "getaddrinfo ENOTFOUND github.com"]) {
			expect(updateCheckMessage(new Error(raw), "0.4.0")).toBe(plainError("app", { message: raw }, { version: "0.4.0" }).message);
		}
	});
});
