import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LINK_RELAY_MAX_BODY } from "@wolfpack/protocol";
import { ATTACHMENT_MAX_BYTES } from "@wolfpack/protocol/attachments";
import { attachmentLimit, RELAY_ATTACHMENT_BYTES } from "../src/server/attachment-limit.ts";
import { isRelayMode } from "../src/server/relay-mode.ts";
import { chipFor, fetchAttachmentLimit, fitFailureMessage, FALLBACK_LIMIT, friendlyUploadError, precheckFile, tooLargeMessage } from "../components/attachments.ts";
import { fitImage, planSteps, scaledSize, type FitDeps, type FitResult } from "../components/image-fit.ts";

const MB = 1024 * 1024;
const big = (n: number, type = "image/jpeg", name = "IMG_1.HEIC.jpeg") => new File([new Uint8Array(n)], name, { type });
const okFile = (r: FitResult): File => {
	assert.ok(r.ok, "expected a fitted file");
	return r.file;
};

describe("relay mode decision (shared)", () => {
	const hub = { WOLFPACK_HUB_URL: "http://hub:1/v1" };
	it("needs a hub URL", () => assert.equal(isRelayMode({}, true), false));
	it("hub + token and no direct wolf URL = relay; without a token = not", () => {
		assert.equal(isRelayMode(hub, true), true);
		assert.equal(isRelayMode(hub, false), false);
	});
	it("WOLFPACK_HUB_RELAY=0 never relays, =1 always does", () => {
		assert.equal(isRelayMode({ ...hub, WOLFPACK_HUB_RELAY: "0" }, true), false);
		assert.equal(isRelayMode({ ...hub, WOLFPACK_HUB_RELAY: "off" }, true), false);
		assert.equal(isRelayMode({ ...hub, WOLFPACK_HUB_RELAY: "1" }, false), true);
	});
	it("a direct WOLFPACK_API_URL is not relay unless forced", () => {
		assert.equal(isRelayMode({ ...hub, WOLFPACK_API_URL: "http://wolf:1/v1" }, true), false);
		assert.equal(isRelayMode({ ...hub, WOLFPACK_API_URL: "http://wolf:1/v1", WOLFPACK_HUB_RELAY: "true" }, true), true);
	});
});

describe("limit by mode", () => {
	it("local = protocol cap, relay = 90% of the relay body cap", () => {
		assert.deepEqual(attachmentLimit({}), { mode: "local", maxBytes: ATTACHMENT_MAX_BYTES });
		const r = attachmentLimit({ WOLFPACK_HUB_URL: "http://hub:1/v1", WOLFPACK_HUB_TOKEN: "t" });
		assert.deepEqual(r, { mode: "relay", maxBytes: RELAY_ATTACHMENT_BYTES });
		assert.ok(r.maxBytes < LINK_RELAY_MAX_BODY && r.maxBytes >= 1.8 * MB - 1);
	});
	it("honours WOLFPACK_HUB_RELAY=0, WOLFPACK_API_URL and the request's token", () => {
		const hub = { WOLFPACK_HUB_URL: "http://hub:1/v1", WOLFPACK_HUB_TOKEN: "t" };
		assert.equal(attachmentLimit({ ...hub, WOLFPACK_HUB_RELAY: "0" }).mode, "local");
		assert.equal(attachmentLimit({ ...hub, WOLFPACK_API_URL: "http://wolf:1/v1" }).mode, "local");
		assert.equal(attachmentLimit({ WOLFPACK_HUB_URL: "http://hub:1/v1" }, true).mode, "relay");
		assert.equal(attachmentLimit({ WOLFPACK_HUB_URL: "http://hub:1/v1" }, false).mode, "local");
	});
	it("the client answers undefined on a failure (never cached) and the fallback is the relay budget", async () => {
		assert.equal(await fetchAttachmentLimit((async () => new Response("x")) as typeof fetch), undefined);
		assert.equal(await fetchAttachmentLimit((async () => new Response("{}", { status: 500 })) as typeof fetch), undefined);
		assert.equal(await fetchAttachmentLimit((async () => Response.json({ mode: "local", maxBytes: 5 * MB }, { status: 503 })) as typeof fetch), undefined);
		assert.equal(await fetchAttachmentLimit((async () => { throw new Error("net"); }) as typeof fetch), undefined);
		assert.deepEqual(await fetchAttachmentLimit((async () => Response.json({ mode: "relay", maxBytes: 5 })) as typeof fetch), { mode: "relay", maxBytes: 5 });
		assert.deepEqual(FALLBACK_LIMIT, { mode: "relay", maxBytes: RELAY_ATTACHMENT_BYTES });
	});
});

describe("resize planning", () => {
	it("caps the longest side and keeps aspect", () => {
		assert.deepEqual(scaledSize(4000, 3000, 2048), { width: 2048, height: 1536 });
		assert.deepEqual(scaledSize(800, 600, 2048), { width: 800, height: 600 });
	});
	it("steps quality down, then size; a PNG source tries PNG first", () => {
		const s = planSteps(4000, 3000);
		assert.equal(s[0]!.quality, 0.82);
		assert.equal(s[0]!.type, "image/jpeg");
		assert.equal(s[0]!.width, 2048);
		assert.ok(s.at(-1)!.width < s[0]!.width && s.at(-1)!.quality < 0.5);
		const p = planSteps(4000, 3000, { png: true });
		assert.equal(p[0]!.type, "image/png");
		assert.equal(p[1]!.type, "image/jpeg");
	});
});

describe("fitImage", () => {
	const deps = (sizeOf: (w: number, q: number) => number, log: string[] = [], disposed = { n: 0 }): FitDeps => ({
		decode: async () => ({ width: 4000, height: 3000 }),
		encode: async ({ width, quality, type }) => {
			log.push(`${type}:${quality}`);
			return new Blob([new Uint8Array(sizeOf(width, quality))]);
		},
		dispose: () => void disposed.n++,
	});
	it("returns files under budget untouched, no decode", async () => {
		const f = big(1000);
		const r = await fitImage(f, 2000, { decode: async () => assert.fail("decoded"), encode: async () => null });
		assert.equal(okFile(r), f);
	});
	it("re-encodes a 6 MB photo to a fitting JPEG and disposes", async () => {
		const log: string[] = [];
		const d = { n: 0 };
		const out = okFile(await fitImage(big(6 * MB), 1.8 * MB, deps((w, q) => w * w * q * 0.5, log, d)));
		assert.ok(out.size <= 1.8 * MB && out.type === "image/jpeg" && out.name === "IMG_1.HEIC.jpg");
		assert.equal(d.n, 1);
	});
	it("keeps a PNG as PNG when it fits, else falls back to JPEG", async () => {
		const png = okFile(await fitImage(big(6 * MB, "image/png", "shot.png"), 1.8 * MB, deps(() => MB)));
		assert.equal(png.type, "image/png");
		assert.equal(png.name, "shot.png");
		const jpg = okFile(await fitImage(big(6 * MB, "image/png", "shot.png"), 1.8 * MB, { ...deps(() => 0), encode: async ({ type }) => new Blob([new Uint8Array(type === "image/png" ? 3 * MB : MB)]) }));
		assert.equal(jpg.type, "image/jpeg");
		assert.equal(jpg.name, "shot.jpg");
	});
	it("reports why: too-large, gif-too-large, undecodable, unsupported", async () => {
		assert.deepEqual(await fitImage(big(6 * MB), 1000, deps(() => 5 * MB)), { ok: false, reason: "too-large" });
		const d = { n: 0 };
		assert.deepEqual(await fitImage(big(6 * MB), 1000, { decode: async () => { throw new Error("x"); }, encode: async () => null, dispose: () => void d.n++ }), { ok: false, reason: "undecodable" });
		assert.equal(d.n, 1);
		assert.deepEqual(await fitImage(big(6 * MB, "image/gif"), 1000, deps(() => 1)), { ok: false, reason: "gif-too-large" });
		assert.deepEqual(await fitImage(big(10, "image/heic"), 1000, deps(() => 1)), { ok: false, reason: "unsupported" });
	});
	it("multiple photos fit independently", async () => {
		const outs = await Promise.all([big(5 * MB), big(4 * MB), big(1000)].map((f) => fitImage(f, 1.8 * MB, deps(() => MB))));
		assert.ok(outs.every((o) => o.ok && o.file.size <= 1.8 * MB));
	});
});

describe("messages", () => {
	it("precheck uses the mode's limit with the friendly text", () => {
		const m = precheckFile({ type: "image/jpeg", size: 3 * MB }, 1.8 * MB, true)!;
		assert.match(m, /Photo too large to send over the hub/);
		assert.match(m, /max 1\.8 MB/);
		assert.equal(precheckFile({ type: "image/jpeg", size: 3 * MB }), undefined);
		assert.match(precheckFile({ type: "image/jpeg", size: 6 * MB })!, /limit 5 MB/);
		assert.equal(chipFor(big(3 * MB), "k", 1.8 * MB, true).upload, false);
		assert.equal(chipFor(big(30 * MB), "k", Infinity).upload, true);
	});
	it("maps only real size refusals to the friendly text", () => {
		const lim = 1.8 * MB;
		const friendly = tooLargeMessage(lim, true);
		assert.equal(friendlyUploadError("request body too large for the relay (limit 2097152 bytes)", 400, lim, true), friendly);
		assert.equal(friendlyUploadError("whatever", 413, lim, true), friendly);
		assert.equal(friendlyUploadError("attachment too large (limit 5242880 bytes)", 400, lim, true), friendly);
		assert.equal(friendlyUploadError("wolf offline", 502, lim, true), "wolf offline");
		assert.equal(friendlyUploadError("header too large", 431, lim, true), "header too large");
	});
	it("each fit failure has its own text; undecodable is not 'too large'", () => {
		assert.equal(fitFailureMessage("undecodable", 1, true), "Couldn't read this image.");
		assert.doesNotMatch(fitFailureMessage("undecodable", 1, true), /large/i);
		assert.match(fitFailureMessage("too-large", 1.8 * MB, true, 6 * MB), /Photo too large to send over the hub \(6 MB\), max 1\.8 MB/);
		assert.match(fitFailureMessage("gif-too-large", 1.8 * MB, true), /GIF/);
		assert.match(fitFailureMessage("unsupported", 1, true), /Unsupported/);
	});
});
