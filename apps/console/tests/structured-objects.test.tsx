/**
 * Structured objects (decision): object-upsert events and ThreadMessage.objects render a registry "object" card in
 * ThreadChat; a revision (same objectId) replaces it in place with an "updated N times" marker; live events and the
 * history seed fold to the same latest revision.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { ThreadEvent, ThreadMessage } from "@wolfpack/client";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
});

const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { ThreadChat } = await import("../components/thread-chat.tsx");
const { MemoryEventsProvider } = await import("../components/memory-events.tsx");
const { lookupCard } = await import("../components/card-registry.tsx");
const { DecisionCard } = await import("../components/decision-card.tsx");
const { SessionModel } = await import("../components/session-core.ts");
const { threadTransport } = await import("../components/thread-transport.ts");
const { renderItems, threadMessagesToNative } = await import("../src/core/index.ts");

const inertSource = () => ({ close() {}, onOpen() {}, onMessage() {}, onError() {} });
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const base = { threadId: "t", at: "2026-01-01T00:00:00.000Z", turnId: "a" };
let n = 0;
const ev = (e: Record<string, unknown>) => ({ ...base, id: ++n, ...e }) as unknown as ThreadEvent;

const options = [
	{ id: "pg", label: "Postgres", detail: "concurrent writers" },
	{ id: "sq", label: "SQLite" },
];
const d1 = { objectId: "db", title: "Datastore", options, chosen: "pg", rationale: "Concurrent writers." };
const d2 = { ...d1, chosen: "sq", rationale: "Single writer after all." };
const { objectId: _id, ...data1 } = d1;
const { objectId: _id2, ...data2 } = d2;

/** A live turn: text, show_decision, more text, the same decision revised. */
function liveEvents(): ThreadEvent[] {
	return [
		ev({ type: "turn-start" }),
		ev({ type: "text-delta", text: "Weighing it." }),
		ev({ type: "tool-start", callId: "c1", name: "show_decision", args: d1 }),
		ev({ type: "object-upsert", objectId: "db", objectType: "decision", rev: 1, data: data1, textOffset: 12 }),
		ev({ type: "tool-end", callId: "c1", result: 'Shown decision "db".', isError: false }),
		ev({ type: "text-delta", text: "Rethinking." }),
		ev({ type: "tool-start", callId: "c2", name: "show_decision", args: d2 }),
		ev({ type: "object-upsert", objectId: "db", objectType: "decision", rev: 2, data: data2, textOffset: 26 }),
		ev({ type: "tool-end", callId: "c2", result: 'Shown decision "db".', isError: false }),
		ev({ type: "text-delta", text: "Done." }),
		ev({ type: "turn-end", reason: "complete" }),
	];
}

/** The same turn as getThread returns it. */
const history: ThreadMessage[] = [
	{ id: "u", role: "user", text: "pick one", at: base.at },
	{
		id: "entry-2",
		role: "assistant",
		text: "Weighing it.\n\nRethinking.\n\nDone.",
		at: base.at,
		tools: [
			{ callId: "c1", name: "show_decision", args: d1, result: 'Shown decision "db".', isError: false, textOffset: 12 },
			{ callId: "c2", name: "show_decision", args: d2, result: 'Shown decision "db".', isError: false, textOffset: 26 },
		],
		objects: [{ objectId: "db", type: "decision", rev: 2, data: data2, textOffset: 12 }],
	},
];

let root: Root | null = null;
async function mount(initialMessages: unknown[]) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<AppRouterContext.Provider value={{ push() {} } as never}>
				<SettingsDialogProvider>
					<MemoryEventsProvider connect={inertSource}>
						<ThreadChat wolf="w" slug="s" threadId="t1" title="T" initialMessages={initialMessages as never} />
					</MemoryEventsProvider>
				</SettingsDialogProvider>
			</AppRouterContext.Provider>,
		);
	});
}

after(() => {
	globalThis.fetch = realFetch;
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

const cards = () => [...document.querySelectorAll('[data-testid="decision-card"]')];
const chosenLabels = (card: Element) =>
	[...card.querySelectorAll('[data-testid="decision-option"][data-chosen="true"]')].map((o) => o.querySelector("span")?.textContent);

describe("decision card", () => {
	it("is registered under kind object", () => {
		assert.equal(lookupCard("object", "decision")?.Renderer, DecisionCard);
		assert.equal(lookupCard("tool", "decision"), undefined);
	});

	it("shows the options with the chosen one highlighted, plus the rationale; no marker at rev 1", () => {
		const html = renderToStaticMarkup(<DecisionCard objectId="db" type="decision" rev={1} data={data1} />);
		assert.match(html, /Datastore/);
		assert.match(html, /concurrent writers/);
		assert.match(html, /Concurrent writers\./);
		assert.doesNotMatch(html, /updated/);
		assert.equal((html.match(/data-chosen="true"/g) ?? []).length, 1);
		assert.match(html, /data-chosen="true"[^>]*>.*?Postgres/);
	});

	it("shows the updated marker for a revision", () => {
		assert.match(renderToStaticMarkup(<DecisionCard objectId="db" type="decision" rev={2} data={data2} />), /updated 1 time</);
		assert.match(renderToStaticMarkup(<DecisionCard objectId="db" type="decision" rev={3} data={data2} />), /updated 2 times</);
	});

	it("renders nothing for data that is not a decision", () => {
		assert.equal(renderToStaticMarkup(<DecisionCard objectId="x" type="decision" rev={1} data={{ nope: 1 }} />), "");
	});
});

describe("ThreadChat objects", () => {
	it("history seed: one card at the latest rev, at the first call's position, with the marker", async () => {
		await mount(threadMessagesToNative(history));
		assert.equal(cards().length, 1);
		const card = cards()[0]!;
		assert.equal(card.getAttribute("data-rev"), "2");
		assert.deepEqual(chosenLabels(card), ["SQLite"]);
		assert.match(card.textContent ?? "", /Single writer after all\./);
		assert.doesNotMatch(card.textContent ?? "", /Concurrent writers\.$/);
		assert.match(card.querySelector('[data-testid="object-updated"]')?.textContent ?? "", /updated 1 time/);
		// First position: between "Weighing it." and "Rethinking.".
		const text = document.body.textContent ?? "";
		assert.ok(text.indexOf("Weighing it.") < text.indexOf("Datastore") && text.indexOf("Datastore") < text.indexOf("Rethinking."));
	});

	it("a single call renders the card without a marker", async () => {
		const one: ThreadMessage[] = [history[0]!, { ...history[1]!, tools: [history[1]!.tools![0]!], objects: [{ objectId: "db", type: "decision", rev: 1, data: data1, textOffset: 12 }] }];
		await mount(threadMessagesToNative(one));
		assert.equal(cards().length, 1);
		assert.deepEqual(chosenLabels(cards()[0]!), ["Postgres"]);
		assert.equal(document.querySelector('[data-testid="object-updated"]'), null);
	});
});

const view = (model: InstanceType<typeof SessionModel>) => model.getState().messages;
const objectParts = (ms: ReturnType<typeof view>) => ms.flatMap((m) => m.parts.filter((p) => p.type === "object"));
/** Render order of an assistant message: text / object / tool, as the thread draws it. */
const kinds = (ms: ReturnType<typeof view>) => ms.filter((m) => m.role === "assistant").flatMap((m) => renderItems(m.parts, false).map((i) => i.kind));

function liveModel(events: ThreadEvent[] = liveEvents()) {
	const model = new SessionModel({ chatId: "t", initialMessages: [], transport: threadTransport("w", "t") });
	const wire = threadTransport("w", "t").createWire();
	for (const e of events) for (const w of wire(e as never)) model.applyWireEvent(w);
	return model;
}
const seeded = (h: ThreadMessage[]) => new SessionModel({ chatId: "t", initialMessages: threadMessagesToNative(h), transport: threadTransport("w", "t") });
const sig = (ms: ReturnType<typeof view>) => objectParts(ms).map((p) => [p.objectId, p.objectType, p.rev, (p.data as { chosen: string }).chosen]);

describe("live events and reload agree", () => {
	it("live: one decision part at rev 2, the show_decision rows hidden, order text/object/text", () => {
		const ms = view(liveModel());
		assert.deepEqual(sig(ms), [["db", "decision", 2, "sq"]]);
		assert.ok(!kinds(ms).includes("tool"));
		assert.ok(!kinds(ms).includes("group"));
		assert.deepEqual(kinds(ms).filter((k) => k !== "separator"), ["text", "object", "text", "text"]);
	});

	it("reload: the history seed gives the same object and the same render order", () => {
		const live = view(liveModel());
		const re = view(seeded(history));
		assert.deepEqual(sig(re), sig(live));
		assert.deepEqual(kinds(re).filter((k) => k !== "separator"), kinds(live).filter((k) => k !== "separator"));
	});

	it("cross-turn revision: the card stays in the first turn at the latest rev", () => {
		const turn2 = [
			ev({ type: "turn-start", turnId: "b" }),
			ev({ type: "text-delta", turnId: "b", text: "Revisiting." }),
			ev({ type: "object-upsert", turnId: "b", objectId: "db", objectType: "decision", rev: 3, data: { ...data2, rationale: "Third thoughts." }, textOffset: 11 }),
			ev({ type: "tool-end", turnId: "b", callId: "c3", result: "ok", isError: false }),
			ev({ type: "turn-end", turnId: "b", reason: "complete" }),
		];
		const ms = view(liveModel([...liveEvents(), ...turn2]));
		assert.deepEqual(objectParts(ms).map((p) => [p.rev, (p.data as { rationale: string }).rationale]), [[3, "Third thoughts."]]);
		const firstAssistant = ms.findIndex((m) => m.role === "assistant");
		assert.ok(ms[firstAssistant]!.parts.some((p) => p.type === "object"));
	});

	it("invalid object data (unknown chosen, unknown type, malformed) yields no object", () => {
		const bad = [
			{ ...data1, chosen: "nope" },
			{ nope: true },
		].map((data, i) => ev({ type: "object-upsert", turnId: "a", objectId: `x${i}`, objectType: "decision", rev: 1, data }));
		const unknown = ev({ type: "object-upsert", turnId: "a", objectId: "g", objectType: "graph", rev: 1, data: { nodes: [] } });
		const ms = view(liveModel([ev({ type: "turn-start" }), ...bad, unknown, ev({ type: "turn-end", reason: "complete" })]));
		assert.equal(objectParts(ms).length, 0);
		const h: ThreadMessage[] = [history[0]!, { id: "a", role: "assistant", text: "", at: base.at, objects: [{ objectId: "x", type: "decision", rev: 1, data: { ...data1, chosen: "nope" } }] }];
		assert.equal(objectParts(view(seeded(h))).length, 0);
	});

	it("a long decision (> 4 KiB) reloads intact from history objects, though the call args are capped", () => {
		const longRationale = "why ".repeat(2000);
		const longDetail = "detail ".repeat(800);
		const big = { ...data2, rationale: longRationale, options: [{ id: "pg", label: "Postgres", detail: longDetail }, { id: "sq", label: "SQLite" }] };
		assert.ok(JSON.stringify(big).length > 4096 * 2);
		const h: ThreadMessage[] = [
			history[0]!,
			{
				id: "entry-2",
				role: "assistant",
				text: "",
				at: base.at,
				// What the server sends: capped args (truncated flag) on the tool call, the full data on the object.
				tools: [{ callId: "c1", name: "show_decision", args: { objectId: "db", rationale: `${longRationale.slice(0, 1024)}…`, _truncated: true }, result: "ok", textOffset: 0 }],
				objects: [{ objectId: "db", type: "decision", rev: 1, data: big, textOffset: 0 }],
			},
		];
		const parts = objectParts(view(seeded(h)));
		assert.equal(parts.length, 1);
		assert.equal((parts[0]!.data as { rationale: string }).rationale, longRationale);
		assert.equal((parts[0]!.data as { options: Array<{ detail?: string }> }).options[0]!.detail, longDetail);
	});
});
