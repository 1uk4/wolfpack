/**
 * Seam: createReleaseNotes (src/server/pack/release-notes.ts), the GitHub release body for a tag (work-wolfpack-DKce6er).
 * Catches: refetching a tag it already has, the tag reaching GitHub unencoded or unvalidated, failures surfacing as errors,
 * the disk cache not surviving a restart. Misses: the real GitHub API (fetch is the stub boundary).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createReleaseNotes } from "../../../src/server/pack/release-notes.ts";

const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "relnotes-"));
	dirs.push(d);
	return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const release = (body: string) => new Response(JSON.stringify({ body, html_url: "https://github.com/1uk4/wolfpack/releases/tag/x" }), { status: 200 });
function stub(res: () => Response | Promise<Response>) {
	const urls: string[] = [];
	const fetch = (async (u: string) => (urls.push(u), res())) as unknown as typeof globalThis.fetch;
	return { urls, fetch };
}

describe("release notes", () => {
	it("fetches a tag once and serves the second get from the cache", async () => {
		const s = stub(() => release("## Fixes\n- one"));
		const notes = createReleaseNotes({ fetch: s.fetch, cacheDir: tmp() });
		const a = await notes.get("console/v0.1.27-main.5");
		const b = await notes.get("console/v0.1.27-main.5");
		assert.deepEqual(a, { tag: "console/v0.1.27-main.5", body: "## Fixes\n- one", url: "https://github.com/1uk4/wolfpack/releases/tag/x" });
		assert.deepEqual(b, a);
		assert.equal(s.urls.length, 1);
	});

	it("requests the slash tag URL-encoded", async () => {
		const s = stub(() => release("x"));
		await createReleaseNotes({ fetch: s.fetch, cacheDir: tmp() }).get("desktop/v0.2.0");
		assert.equal(s.urls[0], "https://api.github.com/repos/1uk4/wolfpack/releases/tags/desktop%2Fv0.2.0");
	});

	it("returns null for a 404, a rate limit, an empty body and a network error", async () => {
		for (const res of [() => new Response("{}", { status: 404 }), () => new Response("{}", { status: 403 }), () => release("  "), () => Promise.reject(new Error("down"))]) {
			assert.equal(await createReleaseNotes({ fetch: stub(res).fetch, cacheDir: tmp() }).get("hubd/v1.2.3"), null);
		}
	});

	it("never fetches a tag that is not component/vX.Y.Z[-main.N]", async () => {
		const s = stub(() => release("x"));
		const notes = createReleaseNotes({ fetch: s.fetch, cacheDir: tmp() });
		for (const t of ["../../etc", "console/v1.2", "console/v1.2.3?x=1", "other/v1.2.3", "v1.2.3", ""]) assert.equal(await notes.get(t), null);
		assert.equal(s.urls.length, 0);
	});

	it("fetches a missing tag once, not on every open, until the miss expires", async () => {
		const s = stub(() => new Response("{}", { status: 404 }));
		let t = 1_000_000;
		const notes = createReleaseNotes({ fetch: s.fetch, cacheDir: tmp(), now: () => t });
		await notes.get("hubd/v1.2.3");
		await notes.get("hubd/v1.2.3");
		assert.equal(s.urls.length, 1);
		t += 11 * 60_000;
		await notes.get("hubd/v1.2.3");
		assert.equal(s.urls.length, 2);
	});

	it("shares one request between concurrent gets of the same tag", async () => {
		const s = stub(() => release("one"));
		const notes = createReleaseNotes({ fetch: s.fetch, cacheDir: tmp() });
		const [a, b] = await Promise.all([notes.get("hubd/v1.2.3"), notes.get("hubd/v1.2.3")]);
		assert.equal(a?.body, "one");
		assert.equal(b?.body, "one");
		assert.equal(s.urls.length, 1);
	});

	it("stops calling GitHub for 15 minutes after a 403 rate limit", async () => {
		let status = 403;
		const s = stub(() => (status === 403 ? new Response("{}", { status: 403 }) : release("ok")));
		let t = 5_000_000;
		const notes = createReleaseNotes({ fetch: s.fetch, cacheDir: tmp(), now: () => t });
		await notes.get("hubd/v1.2.3");
		status = 200;
		assert.equal(await notes.get("hubd/v1.2.4"), null);
		assert.equal(s.urls.length, 1);
		t += 16 * 60_000;
		assert.equal((await notes.get("hubd/v1.2.4"))?.body, "ok");
	});

	it("ignores a cache file entry that is not {body, url} strings", async () => {
		const dir = tmp();
		const good = { tag: "hubd/v1.2.4", body: "good", url: "https://github.com/1uk4/wolfpack/releases/tag/y" };
		writeFileSync(join(dir, "release-notes.json"), JSON.stringify({ "hubd/v1.2.3": { tag: "hubd/v1.2.3", body: 5, url: "x" }, "hubd/v1.2.4": good }));
		const s = stub(() => release("fresh"));
		const notes = createReleaseNotes({ fetch: s.fetch, cacheDir: dir });
		assert.equal((await notes.get("hubd/v1.2.3"))?.body, "fresh");
		assert.equal((await notes.get("hubd/v1.2.4"))?.body, "good");
		assert.equal(s.urls.length, 1);
	});

	it("keeps notes on disk so a new instance does not refetch", async () => {
		const dir = tmp();
		const first = stub(() => release("kept"));
		await createReleaseNotes({ fetch: first.fetch, cacheDir: dir }).get("workerd/v0.1.16-main.3");
		const second = stub(() => new Response("{}", { status: 500 }));
		const got = await createReleaseNotes({ fetch: second.fetch, cacheDir: dir }).get("workerd/v0.1.16-main.3");
		assert.equal(got?.body, "kept");
		assert.equal(second.urls.length, 0);
	});
});
