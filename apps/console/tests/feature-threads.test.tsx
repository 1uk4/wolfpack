/** Feature threads in the console: open one from a feature, list it beside home, route to it. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MockConsoleClient } from "@wolfpack/client";
import { WorkItemView } from "../components/work-item-page.tsx";
import { featureThreadWolves, foldWolfThreads, resolveThreadId, threadHref } from "../src/core/index.ts";
import { createThreadApi } from "../src/server/thread-api.ts";

const feat = { id: "work-x-F", title: "Feat", kind: "feature", stage: "in_build", domain: "wolfpack", partOf: null, dependsOn: [], plan: "the plan", record: "", children: [] };
const post = (body: unknown) => new Request("http://t/api/wolves/1uk4/threads", { method: "POST", body: JSON.stringify(body) });

describe("opening a feature thread", () => {
	it("POST creates the feature thread, bound to the feature; the same feature returns the same thread", async () => {
		const api = createThreadApi(() => client);
		const client = new MockConsoleClient({ delayMs: 0 });
		const first = (await (await api.createThread("1uk4", post({ kind: "feature", workItemId: "work-x-F" }))).json()) as { id: string; kind: string; boundWorkItem: string };
		assert.equal(first.kind, "feature");
		assert.equal(first.boundWorkItem, "work-x-F");
		const again = (await (await api.createThread("1uk4", post({ kind: "feature", workItemId: "work-x-F" }))).json()) as { id: string };
		assert.equal(again.id, first.id);
		const list = ((await (await api.threads("1uk4")).json()) as { threads: { id: string; kind: string }[] }).threads;
		assert.deepEqual(list.map((t) => t.kind), ["home", "feature"]);
	});

	it("rejects anything but a feature with a work item id; an unknown wolf is 404", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const api = createThreadApi(() => client);
		assert.equal((await api.createThread("1uk4", post({ kind: "home" }))).status, 400);
		assert.equal((await api.createThread("1uk4", post({ kind: "feature" }))).status, 400);
		assert.equal((await api.createThread("1uk4", new Request("http://t", { method: "POST", body: "nope" }))).status, 400);
		assert.equal((await api.createThread("nobody", post({ kind: "feature", workItemId: "w" }))).status, 404);
	});

	it("a client that cannot create threads answers 501", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const bare = { ...client, listThreads: client.listThreads.bind(client) } as unknown as MockConsoleClient;
		(bare as { createThread?: unknown }).createThread = undefined;
		assert.equal((await createThreadApi(() => bare).createThread("1uk4", post({ kind: "feature", workItemId: "w" }))).status, 501);
	});

	it("the thread opens at its own route and is listed at the top level beside home", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const t = await client.createThread!("1uk4", { kind: "feature", workItemId: "work-x-F" });
		assert.equal(threadHref("1uk4", t.id), "/wolf/1uk4/thread/feature-work-x-F");
		assert.equal(resolveThreadId("1uk4", "feature-work-x-F", await client.listThreads("1uk4")), t.id);
		const rows = foldWolfThreads(null, [{ wolf: "1uk4", threads: await client.listThreads("1uk4") }]);
		assert.deepEqual(rows.map((r) => (r as { href: string }).href), ["/wolf/1uk4/thread/home", "/wolf/1uk4/thread/feature-work-x-F"]);
	});

	it("a feature thread takes turns like home", async () => {
		const api = createThreadApi(() => client);
		const client = new MockConsoleClient({ delayMs: 0 });
		const t = await client.createThread!("1uk4", { kind: "feature", workItemId: "work-x-F" });
		await client.submit(t.id, "hello");
		for await (const _ of client.watch(t.id));
		const detail = (await (await api.thread({ wolf: "1uk4", slug: "feature-work-x-F" })).json()) as { messages: { role: string }[] };
		assert.deepEqual(detail.messages.map((m) => m.role), ["user", "assistant"]);
	});
});

describe("the work page offers a thread for a feature", () => {
	it("a feature with wolves shows one button per wolf; a lone wolf says just 'Open thread'", () => {
		const one = renderToStaticMarkup(<WorkItemView id="work-x-F" state={{ kind: "ready", item: feat, parent: null, threadWolves: ["1uk4"] }} />);
		assert.match(one, /data-testid="open-feature-thread"/);
		assert.match(one, />Open thread</);
		const two = renderToStaticMarkup(<WorkItemView id="work-x-F" state={{ kind: "ready", item: feat, parent: null, threadWolves: ["1uk4", "hal"] }} />);
		assert.match(two, /Open thread on 1uk4/);
		assert.match(two, /Open thread on hal/);
	});

	it("a task, a container, or no wolf online offers none", () => {
		const task = renderToStaticMarkup(<WorkItemView id="t" state={{ kind: "ready", item: { ...feat, id: "t", kind: "task" }, parent: null, threadWolves: [] }} />);
		assert.doesNotMatch(task, /open-feature-thread/);
		const none = renderToStaticMarkup(<WorkItemView id="work-x-F" state={{ kind: "ready", item: feat, parent: null, threadWolves: [] }} />);
		assert.doesNotMatch(none, /open-feature-thread/);
		const inbox = renderToStaticMarkup(<WorkItemView id="i" state={{ kind: "ready", item: { ...feat, container: true }, parent: null, threadWolves: ["1uk4"] }} />);
		assert.doesNotMatch(inbox, /open-feature-thread/);
	});

	it("targets: online wolves, the librarian last", () => {
		const wolves = [
			{ name: "dewey", status: "online", librarian: true },
			{ name: "1uk4", status: "busy" },
			{ name: "gone", status: "offline" },
		];
		assert.deepEqual(featureThreadWolves(wolves), ["1uk4", "dewey"]);
		assert.deepEqual(featureThreadWolves([]), []);
	});
});
