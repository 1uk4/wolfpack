import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import ThreadPage from "../app/wolf/[name]/thread/[threadId]/page.tsx";
import { setConsoleClient } from "../src/server/index.ts";

let getThreadOpts: { limit?: number } | undefined;
let chatProps: { colorThreads?: { id: string; kind?: string }[] } | undefined;
const thread = { id: "1uk4/f1", wolf: "1uk4", kind: "feature", title: "F", messages: [], hasMore: false, busy: false };

function fake(opts: { listed: unknown[]; all?: unknown[]; onListThreads?: (all: boolean) => Promise<void>; events?: string[] }) {
	const events = opts.events ?? [];
	setConsoleClient({
		async listThreads(_wolf: string, o?: { all?: boolean }) {
			events.push(o?.all ? "listThreads:all" : "listThreads");
			await opts.onListThreads?.(!!o?.all);
			return o?.all ? (opts.all ?? opts.listed) : opts.listed;
		},
		async listWolves() {
			events.push("listWolves");
			return [{ name: "1uk4", color: "#fff" }];
		},
		async getThread(_id: string, o?: { limit?: number }) {
			events.push("getThread");
			getThreadOpts = o;
			return thread;
		},
	} as never);
	return events;
}

/** Drive the page to completion: the async body (if streamed) is awaited like React does. */
async function visit(slug: string): Promise<string> {
	try {
		const el = (await ThreadPage({ params: Promise.resolve({ name: "1uk4", threadId: slug }) })) as { type: unknown; props: unknown };
		const body = (el.props as { children?: { type: unknown; props: unknown } }).children;
		if (body && typeof body.type === "function") {
			const out = (await (body.type as (p: unknown) => Promise<unknown>)(body.props)) as { props: typeof chatProps };
			chatProps = out.props;
		}
		return "rendered";
	} catch (e) {
		if (((e as { digest?: string }).digest ?? "").endsWith(";404")) return "404";
		throw e;
	}
}

afterEach(() => setConsoleClient(undefined));

describe("/wolf/<name>/thread/<slug>", () => {
	it("starts listWolves before listThreads has resolved", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const events = fake({ listed: [thread], onListThreads: () => gate });
		const run = visit("f1");
		await new Promise((r) => setTimeout(r, 20));
		assert.deepEqual(events, ["listThreads", "listWolves"]);
		release();
		await run;
	});

	it("opens a settled subagent thread that only the full list contains", async () => {
		const events = fake({ listed: [], all: [thread] });
		assert.equal(await visit("f1"), "rendered");
		assert.deepEqual(events.filter((e) => e.startsWith("listThreads")), ["listThreads", "listThreads:all"]);
	});

	it("paints the skeleton frame synchronously while the transcript streams", () => {
		fake({ listed: [thread] });
		const el = ThreadPage({ params: new Promise(() => {}) }) as unknown as { props: { fallback: never } };
		assert.match(renderToStaticMarkup(el.props.fallback), /data-testid="thread-skeleton"/);
	});

	it("sends only parent threads as colour sources, never subagent rows", async () => {
		fake({ listed: [thread, { id: "1uk4/s1", kind: "subagent", parentThreadId: "1uk4/f1" }, { id: "1uk4/home", kind: "home" }] });
		await visit("f1");
		assert.deepEqual(chatProps?.colorThreads?.map((t) => t.id), ["1uk4/f1", "1uk4/home"]);
	});

	it("404s when the slug is in neither list", async () => {
		fake({ listed: [], all: [] });
		assert.equal(await visit("nope"), "404");
	});
});
