/** Needs-you: the cross-wolf list from the client's status, answering from the list, the activity bridge, the notification trigger. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockConsoleClient, type Card, type PendingCard } from "@wolfpack/client";
import {
	INITIAL_NOTIFY_STATE,
	buildNeedsYou,
	cardHeadline,
	foldCardEvent,
	itemKey,
	NO_CARDS,
	planNotifications,
	subscribe,
	threadListItem,
	type NeedsYouItem,
	type ServerEvent,
} from "../src/core/index.ts";
import { createActivityBridge, collectNeedsYou, createNeedsYouApi } from "../src/server/needs-you-api.ts";
import { createThreadApi } from "../src/server/thread-api.ts";

const ask = (question: string, title?: string): Card => ({ tool: "ask_user_question", ...(title ? { title } : {}), fields: [{ id: "answer", kind: "free-text", label: question }] });
const HOME = "1uk4/home";
const answerReq = (answers: unknown) => new Request("http://t/answer", { method: "POST", body: JSON.stringify({ answers }) });

const item = (over: Partial<NeedsYouItem> & { callId: string }): NeedsYouItem => ({
	wolf: "1uk4",
	threadId: HOME,
	threadTitle: "Home",
	slug: "home",
	href: "/wolf/1uk4/thread/home",
	card: ask("Which branch?"),
	raisedAt: "2026-10-26T10:00:00.000Z",
	...over,
});

describe("needs-you list", () => {
	it("is built from the client's status: wolf, thread title, headline, oldest first", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		assert.deepEqual(await collectNeedsYou(client).then(buildNeedsYou), []);
		const late = client.raiseCard(HOME, ask("Later?"), "c-late", "2026-10-26T11:00:00.000Z");
		client.raiseCard(HOME, ask("Which branch?", "Release"), "c-early", "2026-10-26T10:00:00.000Z");
		const [first, second] = buildNeedsYou(await collectNeedsYou(client));
		assert.deepEqual([first?.callId, second?.callId], ["c-early", late.callId]);
		assert.equal(first?.wolf, "1uk4");
		assert.equal(first?.threadTitle, "Home");
		assert.equal(first?.href, "/wolf/1uk4/thread/home");
		assert.equal(cardHeadline(first!.card), "Release");
		assert.equal(cardHeadline(second!.card), "Later?");
		// ThreadSummary.status drives the row dot
		const summary = (await client.listThreads("1uk4"))[0]!;
		assert.equal(summary.status, "needs-you");
		assert.equal(threadListItem("1uk4", summary).needsYou, true);
		assert.equal(threadListItem("1uk4", { id: HOME, title: "Home", status: "idle" }).needsYou, false);
	});

	it("merges wolves; a wolf that fails is skipped, not fatal", () => {
		const p = (callId: string, threadId: string, raisedAt: string): PendingCard => ({ callId, threadId, card: ask(callId), raisedAt });
		const items = buildNeedsYou([
			{ wolf: "a", cards: [p("c2", "a/home", "2026-10-26T12:00:00.000Z")], threads: [{ id: "a/home", title: "A home" }] },
			{ wolf: "b", cards: [p("c1", "b/feat", "2026-10-26T09:00:00.000Z")], threads: [] },
		]);
		assert.deepEqual(items.map((i) => [i.wolf, i.callId, i.threadTitle]), [["b", "c1", "feat"], ["a", "c2", "A home"]]);
	});

	it("the API returns the list; the count is its length", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		client.raiseCard(HOME, ask("Q1"), "c1");
		client.raiseCard(HOME, ask("Q2"), "c2");
		const res = await createNeedsYouApi(() => client).list();
		const body = (await res.json()) as { items: NeedsYouItem[] };
		assert.equal(body.items.length, 2);
	});

	it("answering from the list goes through the thread answer route and clears it", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		client.raiseCard(HOME, ask("Which branch?"), "c1");
		const it1 = buildNeedsYou(await collectNeedsYou(client))[0]!;
		const res = await createThreadApi(() => client).answerCard({ wolf: it1.wolf, slug: it1.slug }, it1.callId, answerReq({ answer: { value: "main" } }));
		assert.equal(res.status, 200);
		assert.deepEqual(client.cardAnswers, [{ threadId: HOME, callId: "c1", answers: { answer: { value: "main" } } }]);
		assert.deepEqual(await collectNeedsYou(client), [{ wolf: "1uk4", cards: [], threads: await client.listThreads("1uk4") }]);
		assert.equal((await client.listThreads("1uk4"))[0]?.status, "idle");
		// answered elsewhere / superseded: 404
		const again = await createThreadApi(() => client).answerCard({ wolf: it1.wolf, slug: it1.slug }, it1.callId, answerReq({ answer: { value: "x" } }));
		assert.equal(again.status, 404);
	});
});

describe("activity bridge", () => {
	it("pokes the bus for a wolf's card and status changes, once per wolf", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const poked: string[] = [];
		const bridge = createActivityBridge((w) => poked.push(w));
		bridge.ensure(client);
		bridge.ensure(client); // idempotent
		await new Promise((r) => setTimeout(r, 20));
		assert.deepEqual([...bridge.following], ["1uk4"]);
		client.raiseCard(HOME, ask("Q"), "c1"); // card-pending + thread-status
		await new Promise((r) => setTimeout(r, 20));
		assert.deepEqual(poked, ["1uk4", "1uk4"]);
		bridge.stop();
	});

	it("emits needs-you-changed on the event bus by default", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const seen: ServerEvent[] = [];
		const off = subscribe((e) => seen.push(e));
		const bridge = createActivityBridge();
		bridge.ensure(client);
		await new Promise((r) => setTimeout(r, 20));
		client.raiseCard(HOME, ask("Q"), "c1");
		await new Promise((r) => setTimeout(r, 20));
		off();
		bridge.stop();
		assert.ok(seen.some((e) => e.type === "needs-you-changed" && (e as { wolf?: string }).wolf === "1uk4"));
	});
});

describe("notification trigger (planNotifications)", () => {
	const A = item({ callId: "a", card: ask("Which branch?") });
	const B = item({ callId: "b", threadId: "1uk4/feat", threadTitle: "Feature", href: "/wolf/1uk4/thread/feat", card: ask("Ship it?") });

	it("never fires for the first snapshot (cards already pending at startup)", () => {
		const r = planNotifications(INITIAL_NOTIFY_STATE, [A], { focused: false });
		assert.deepEqual(r.notifications, []);
		assert.equal(r.state.primed, true);
	});

	it("fires for a card that newly appears while unfocused: wolf + thread in the title, the question in the body", () => {
		const s = planNotifications(INITIAL_NOTIFY_STATE, [], { focused: false }).state;
		const r = planNotifications(s, [A], { focused: false });
		assert.deepEqual(r.notifications, [{ key: itemKey(A), title: "1uk4 · Home", body: "Which branch?", href: "/wolf/1uk4/thread/home" }]);
	});

	it("dedupes per card: a refetch or a held-answer update does not fire again", () => {
		let s = planNotifications(INITIAL_NOTIFY_STATE, [], { focused: false }).state;
		s = planNotifications(s, [A], { focused: false }).state;
		assert.deepEqual(planNotifications(s, [A], { focused: false }).notifications, []);
		assert.deepEqual(planNotifications(s, [{ ...A, heldAnswer: { answer: { value: "x" } } }], { focused: false }).notifications, []);
	});

	it("one notification per thread, for its first new card; another thread fires its own", () => {
		const A2 = item({ callId: "a2", card: ask("Second?") });
		const s = planNotifications(INITIAL_NOTIFY_STATE, [], { focused: false }).state;
		const r = planNotifications(s, [A, A2, B], { focused: false });
		assert.deepEqual(r.notifications.map((n) => n.title), ["1uk4 · Home", "1uk4 · Feature"]);
		assert.equal(r.notifications[0]?.body, "Which branch?");
		// the sibling is seen too: it does not fire later
		assert.deepEqual(planNotifications(r.state, [A, A2, B], { focused: false }).notifications, []);
	});

	it("stays quiet while focused, and a card seen while focused never fires later", () => {
		let s = planNotifications(INITIAL_NOTIFY_STATE, [], { focused: true }).state;
		const focused = planNotifications(s, [A], { focused: true });
		assert.deepEqual(focused.notifications, []);
		s = focused.state;
		assert.deepEqual(planNotifications(s, [A], { focused: false }).notifications, []);
	});

	it("an answered card leaves the set; a new card for the same thread fires again", () => {
		let s = planNotifications(INITIAL_NOTIFY_STATE, [], { focused: false }).state;
		s = planNotifications(s, [A], { focused: false }).state;
		s = planNotifications(s, [], { focused: false }).state;
		assert.equal(s.seen.size, 0);
		const next = item({ callId: "a-next", card: ask("Another?") });
		assert.equal(planNotifications(s, [next], { focused: false }).notifications.length, 1);
	});
});

describe("live card events in a thread (foldCardEvent)", () => {
	const pending: PendingCard = { callId: "c1", threadId: HOME, card: ask("Q"), raisedAt: "2026-10-26T10:00:00.000Z" };
	it("card-pending shows the card without a settle; a held answer updates it; card-settled removes it", () => {
		let c = foldCardEvent(NO_CARDS, { type: "card-pending", card: pending });
		assert.deepEqual(c.pending.map((p) => p.callId), ["c1"]);
		assert.equal(c.calls.c1?.card.tool, "ask_user_question");
		c = foldCardEvent(c, { type: "card-pending", card: { ...pending, heldAnswer: { answer: { value: "x" } } } });
		assert.equal(c.pending.length, 1);
		assert.deepEqual(c.calls.c1?.heldAnswer, { answer: { value: "x" } });
		const dismissed = foldCardEvent(c, { type: "card-settled", callId: "c1", outcome: "dismissed" });
		assert.equal(dismissed.pending.length, 0);
		assert.equal(dismissed.calls.c1?.dismissed, true);
		assert.equal(foldCardEvent(c, { type: "card-settled", callId: "c1", outcome: "answered" }).pending.length, 0);
	});
});

describe("thread transport", () => {
	it("hands live card events to the chat and keeps them out of the message stream", async () => {
		const { threadTransport } = await import("../components/thread-transport.ts");
		const heard: string[] = [];
		const wire = threadTransport("1uk4", "home", (ev) => heard.push(ev.type)).createWire();
		const base = { id: 1, threadId: HOME, at: "2026-10-26T10:00:00.000Z", actor: { id: "1uk4", kind: "wolf" } };
		const pending: PendingCard = { callId: "c1", threadId: HOME, card: ask("Q"), raisedAt: base.at };
		assert.deepEqual(wire({ ...base, type: "card-pending", card: pending }), []);
		assert.deepEqual(wire({ ...base, id: 2, type: "card-settled", callId: "c1", outcome: "answered" }), []);
		assert.deepEqual(heard, ["card-pending", "card-settled"]);
	});
});
