import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LINK_RELAY_MAX_BODY } from "@wolfpack/protocol";
import { ATTACHMENT_MAX_BYTES } from "@wolfpack/protocol/attachments";
import { attachmentLimit } from "../src/server/attachment-limit.ts";
import { chipFor, fetchAttachmentLimit, friendlyUploadError, precheckFile, tooLargeMessage } from "../components/attachments.ts";
import { fitImage, planSteps, scaledSize, type FitDeps } from "../components/image-fit.ts";

const MB = 1024 * 1024;
const big = (n: number, type = "image/jpeg", name = "IMG_1.HEIC.jpeg") => new File([new Uint8Array(n)], name, { type });

describe("limit by mode", () => {
	it("local = protocol cap, relay = 90% of the relay body cap", () => {
		assert.deepEqual(attachmentLimit({}), { mode: "local", maxBytes: ATTACHMENT_MAX_BYTES });
		const r = attachmentLimit({ WOLFPACK_HUB_URL: "http://hub:1/v1" });
		assert.equal(r.mode, "relay");
		assert.ok(r.maxBytes < LINK_RELAY_MAX_BODY && r.maxBytes >= 1.8 * MB - 1);
	});
	it("the client falls back to local on a bad answer", async () => {
		assert.equal((await fetchAttachmentLimit((async () => new Response("x")) as typeof fetch)).mode, "local");
		assert.deepEqual(await fetchAttachmentLimit((async () => Response.json({ mode: "relay", maxBytes: 5 })) as typeof fetch), { mode: "relay", maxBytes: 5 });
	});
});

describe("resize planning", () => {
	it("caps the longest side and keeps aspect", () => {
		assert.deepEqual(scaledSize(4000, 3000, 2048), { width: 2048, height: 1536 });
		assert.deepEqual(scaledSize(800, 600, 2048), { width: 800, height: 600 });
	});
	it("steps quality down, then size", () => {
		const s = planSteps(4000, 3000);
		assert.equal(s[0]!.quality, 0.82);
		assert.equal(s[0]!.width, 2048);
		assert.ok(s.at(-1)!.width < s[0]!.width && s.at(-1)!.quality < 0.5);
	});
});

describe("fitImage", () => {
	const deps = (sizeOf: (w: number, q: number) => number, log: number[] = []): FitDeps => ({
		decode: async () => ({ width: 4000, height: 3000 }),
		encode: async ({ width, quality }) => {
			log.push(quality);
			return new Blob([new Uint8Array(sizeOf(width, quality))]);
		},
	});
	it("returns files under budget untouched, no decode", async () => {
		const f = big(1000);
		assert.equal(await fitImage(f, 2000, { decode: async () => assert.fail("decoded"), encode: async () => null }), f);
	});
	it("re-encodes a 6 MB photo to a fitting JPEG", async () => {
		const log: number[] = [];
		const out = await fitImage(big(6 * MB), 1.8 * MB, deps((w, q) => w * w * q * 0.5, log));
		assert.ok(out && out.size <= 1.8 * MB && out.type === "image/jpeg" && out.name === "IMG_1.HEIC.jpg");
		assert.ok(log.length >= 1);
	});
	it("gives up (undefined) when nothing fits, and on undecodable or GIF input", async () => {
		assert.equal(await fitImage(big(6 * MB), 1000, deps(() => 5 * MB)), undefined);
		assert.equal(await fitImage(big(6 * MB), 1000, { decode: async () => { throw new Error("x"); }, encode: async () => null }), undefined);
		assert.equal(await fitImage(big(6 * MB, "image/gif"), 1000, deps(() => 1)), undefined);
	});
	it("multiple photos fit independently", async () => {
		const outs = await Promise.all([big(5 * MB), big(4 * MB), big(1000)].map((f) => fitImage(f, 1.8 * MB, deps(() => MB))));
		assert.ok(outs.every((o) => o && o.size <= 1.8 * MB));
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
	});
	it("maps relay/413 refusals to the friendly text, passes others", () => {
		const lim = 1.8 * MB;
		assert.equal(friendlyUploadError("request body too large for the relay (limit 2097152 bytes)", 400, lim, true), tooLargeMessage(lim, true));
		assert.equal(friendlyUploadError("whatever", 413, lim, true), tooLargeMessage(lim, true));
		assert.equal(friendlyUploadError("wolf offline", 502, lim, true), "wolf offline");
	});
});
