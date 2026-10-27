/**
 * Composer attachments end to end through the console's server layer, against
 * the @wolfpack/client mock: paste → upload route → chip state → submit with
 * refs. (The wolfd side is covered by the harness scripted /v1 test.)
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ATTACHMENT_MAX_BYTES, FIXTURE_THREAD, MockConsoleClient } from "@wolfpack/client";
import { createThreadApi } from "../src/server/thread-api.ts";
import { canSendWith, pastedImages, readyRefs, uploadFile, type PendingAttachment } from "../components/attachments.ts";
import { AttachmentChips } from "../components/composer.tsx";
import { threadTransport } from "../components/thread-transport.ts";
import { threadFetch } from "./helpers/thread-fetch.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const shot = () => new File([PNG], "Screenshot.png", { type: "image/png" });
const transport = threadTransport("1uk4", "home");

describe("pasted images", () => {
	it("pulls image files off a clipboard and ignores text and non-image files", () => {
		const f = shot();
		const items = [
			{ kind: "string", type: "text/plain", getAsFile: () => null },
			{ kind: "file", type: "application/pdf", getAsFile: () => new File(["x"], "a.pdf") },
			{ kind: "file", type: "image/png", getAsFile: () => f },
		];
		assert.deepEqual(pastedImages({ items }), [f]);
		assert.deepEqual(pastedImages(null), []);
	});
});

describe("upload + send through the console routes", () => {
	it("uploads the bytes to the wolf via the upload route, then submits with the ref", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const fetchFn = threadFetch(client);
		const { id, name } = await uploadFile(transport.uploadUrl!, shot(), fetchFn);
		assert.equal(name, "Screenshot.png");
		assert.deepEqual(client.uploads.map((u) => [u.id, u.threadId, u.mimeType, u.name, u.size]), [[id, FIXTURE_THREAD.id, "image/png", "Screenshot.png", PNG.length]]);

		const body = transport.submitBody({ type: "text", text: "what is this?", attachments: [{ id }] });
		assert.deepEqual(JSON.parse(body), { input: "what is this?", whenBusy: "reject", attachments: [{ id }] });
		const res = await fetchFn(transport.submitUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body });
		assert.equal(res.status, 200);
		assert.deepEqual(client.submits, [{ threadId: FIXTURE_THREAD.id, input: "what is this?", attachments: [{ id }] }]);
	});

	it("an image-only send (empty text) is accepted; plain sends carry no attachments key", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const fetchFn = threadFetch(client);
		const { id } = await uploadFile(transport.uploadUrl!, shot(), fetchFn);
		const body = transport.submitBody({ type: "text", text: "", attachments: [{ id }] });
		assert.equal((await fetchFn(transport.submitUrl, { method: "POST", body })).status, 200);
		assert.ok(!("attachments" in JSON.parse(transport.submitBody({ type: "text", text: "hi" }))));
	});

	it("surfaces the wolf's refusal (wrong type) as the upload error", async () => {
		const fetchFn = threadFetch(new MockConsoleClient({ delayMs: 0 }));
		await assert.rejects(uploadFile(transport.uploadUrl!, new File(["hi"], "a.txt", { type: "text/plain" }), fetchFn), /unsupported attachment type/);
	});

	it("rejects a submit that references an unknown attachment", async () => {
		const fetchFn = threadFetch(new MockConsoleClient({ delayMs: 0 }));
		const body = transport.submitBody({ type: "text", text: "x", attachments: [{ id: "nope" }] });
		const res = await fetchFn(transport.submitUrl, { method: "POST", body });
		assert.equal(res.status, 400);
		assert.match(((await res.json()) as { error: string }).error, /unknown attachment/);
	});
});

describe("chip state", () => {
	const chip = (status: PendingAttachment["status"], id?: string): PendingAttachment => ({ key: `k-${status}`, name: `${status}.png`, status, ...(id ? { id } : {}) });

	it("send needs text or a ready attachment, and waits for uploads in flight", () => {
		assert.equal(canSendWith("", []), false);
		assert.equal(canSendWith("hi", []), true);
		assert.equal(canSendWith("", [chip("ready", "a")]), true);
		assert.equal(canSendWith("hi", [chip("ready", "a"), chip("uploading")]), false);
		assert.equal(canSendWith("", [chip("error")]), false);
		assert.deepEqual(readyRefs([chip("ready", "a"), chip("error"), chip("uploading")]), [{ id: "a" }]);
	});

	it("renders a chip per attachment with its status", () => {
		const html = renderToStaticMarkup(<AttachmentChips items={[chip("uploading"), chip("ready", "a"), chip("error")]} onRemove={() => {}} />);
		assert.equal((html.match(/data-testid="attachment-chip"/g) ?? []).length, 3);
		assert.match(html, /data-status="uploading"/);
		assert.match(html, /error\.png — failed/);
		assert.equal(renderToStaticMarkup(<AttachmentChips items={[]} onRemove={() => {}} />), "");
	});
});

describe("upload relay size cap", () => {
	const api = (client: MockConsoleClient) => createThreadApi(() => client);
	const ref = { wolf: "1uk4", slug: "home" };

	it("rejects by Content-Length before reading, as 413", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const req = new Request("http://t/up", { method: "POST", headers: { "Content-Type": "image/png", "Content-Length": String(ATTACHMENT_MAX_BYTES + 1) }, body: PNG });
		const res = await api(client).upload(ref, req);
		assert.equal(res.status, 413);
		assert.match(((await res.json()) as { error: string }).error, /too large/);
		assert.equal(client.uploads.length, 0);
	});

	it("rejects an over-cap stream with no Content-Length, as 413, without buffering it all", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		let pulled = 0;
		const chunk = new Uint8Array(1024 * 1024);
		const body = new ReadableStream<Uint8Array>({
			pull(c) {
				if (pulled++ >= 100) return c.close();
				c.enqueue(chunk);
			},
		});
		const req = new Request("http://t/up", { method: "POST", headers: { "Content-Type": "image/png" }, body, duplex: "half" } as RequestInit);
		const res = await api(client).upload(ref, req);
		assert.equal(res.status, 413);
		assert.ok(pulled < 20, `stopped reading early (pulled ${pulled} MiB)`);
		assert.equal(client.uploads.length, 0);
	});

	it("400s malformed or excessive attachment refs on submit", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const fetchFn = threadFetch(client);
		for (const attachments of ["x", [{ id: 1 }], [{}], Array.from({ length: 9 }, (_, i) => ({ id: `a${i}` }))]) {
			const res = await fetchFn(transport.submitUrl, { method: "POST", body: JSON.stringify({ input: "x", attachments }) });
			assert.equal(res.status, 400, JSON.stringify(attachments));
		}
	});
});
