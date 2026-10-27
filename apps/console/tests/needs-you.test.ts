/** Needs-you: the cross-wolf list from the client's status, answering from the list, the activity bridge, the notification trigger. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { MockConsoleClient, type Card, type PendingCard } from "@wolfpack/client";
import {
	INITIAL_NOTIFY_STATE,
	buildNeedsYou,
	cardHeadline,
	foldCardEvent,
	itemKey,
	mergeReport,
	NO_CARDS,
	planNotifications,
	subscribe,
	threadListItem,
	type NeedsYouItem,
	type ServerEvent,
} from "../src/core/index.ts";
import { abortableSleep, createActivityBridge, collectNeedsYou, createNeedsYouApi } from "../src/server/needs-you-api.ts";
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
		assert.deepEqual(await collectNeedsYou(client).then((c) => buildNeedsYou(c.reports)), []);
		const late = client.raiseCard(HOME, ask("Later?"), "c-late", "2026-10-26T11:00:00.000Z");
		client.raiseCard(HOME, ask("Which branch?", "Release"), "c-early", "2026-10-26T10:00:00.000Z");
		const [first, second] = buildNeedsYou((await collectNeedsYou(client)).reports);
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
		const it1 = buildNeedsYou((await collectNeedsYou(client)).reports)[0]!;
		const res = await createThreadApi(() => client).answerCard({ wolf: it1.wolf, slug: it1.slug }, it1.callId, answerReq({ answer: { value: "main" } }));
		assert.equal(res.status, 200);
		assert.deepEqual(client.cardAnswers, [{ threadId: HOME, callId: "c1", answers: { answer: { value: "main" } } }]);
		assert.deepEqual((await collectNeedsYou(client)).reports, [{ wolf: "1uk4", cards: [], threads: await client.listThreads("1uk4") }]);
		assert.equal((await client.listThreads("1uk4"))[0]?.status, "idle");
		// answered elsewhere / superseded: 404
		const again = await createThreadApi(() => client).answerCard({ wolf: it1.wolf, slug: it1.slug }, it1.callId, answerReq({ answer: { value: "x" } }));
		assert.equal(again.status, 404);
	});
});

describe("skipping a card", () => {
	it("clears the needs-you row dot and the list, and tells the bridge closed:skipped", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const events: unknown[] = [];
		const ac = new AbortController();
		void (async () => {
			for await (const ev of client.watchActivity!("1uk4", { signal: ac.signal })) events.push(ev);
		})();
		await new Promise((r) => setTimeout(r, 20));
		client.raiseCard(HOME, ask("Q"), "c1");
		assert.equal(threadListItem("1uk4", (await client.listThreads("1uk4"))[0]!).needsYou, true);
		assert.equal((await createThreadApi(() => client).skipCard({ wolf: "1uk4", slug: "home" }, "c1")).status, 200);
		assert.equal(threadListItem("1uk4", (await client.listThreads("1uk4"))[0]!).needsYou, false);
		assert.deepEqual(buildNeedsYou((await collectNeedsYou(client)).reports), []);
		await new Promise((r) => setTimeout(r, 20));
		ac.abort();
		assert.ok(events.some((e) => (e as { type?: string; closed?: string }).type === "card-settled" && (e as { closed?: string }).closed === "skipped"));
		assert.equal((await createThreadApi(() => client).skipCard({ wolf: "1uk4", slug: "home" }, "c1")).status, 404);
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
		assert.deepEqual(poked, ["1uk4", "1uk4"]); // card-pending + thread-status (no poke for the bare connect)
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
		assert.equal(r.state.primedAll, true);
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
		assert.equal(dismissed.calls.c1?.closed, "superseded", "a bare dismissal reads as superseded");
	});

	it("a skip settles the card as skipped; a held skip replaces a held answer", () => {
		let c = foldCardEvent(NO_CARDS, { type: "card-pending", card: { ...pending, heldAnswer: { answer: { value: "x" } } } });
		c = foldCardEvent(c, { type: "card-pending", card: { ...pending, heldSkip: true } });
		assert.equal(c.calls.c1?.heldSkip, true);
		assert.equal(c.calls.c1?.heldAnswer, undefined);
		const skipped = foldCardEvent(c, { type: "card-settled", callId: "c1", outcome: "dismissed", closed: "skipped" });
		assert.equal(skipped.pending.length, 0);
		assert.equal(skipped.calls.c1?.closed, "skipped");
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

describe("wolf outage", () => {
	const A = item({ callId: "a", card: ask("Which branch?") });
	const away = item({ callId: "z", wolf: "other", threadId: "other/home", href: "/wolf/other/thread/home" });

	it("collectNeedsYou reports which wolves responded; a failing wolf is absent from both", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		client.listWolves = async () => [{ id: "1uk4", name: "1uk4", host: "local", status: "online" }, { id: "gone", name: "gone", host: "x", status: "offline" }];
		const { reports, responded } = await collectNeedsYou(client);
		assert.deepEqual(responded, ["1uk4"]);
		assert.deepEqual(reports.map((r) => r.wolf), ["1uk4"]);
		assert.deepEqual((await collectNeedsYou(client, "1uk4")).responded, ["1uk4"]);
	});

	it("a wolf that drops out and returns does not re-notify; only responding wolves are pruned", () => {
		let s = planNotifications(INITIAL_NOTIFY_STATE, [], { focused: false }).state;
		s = planNotifications(s, [A, away], { focused: false, responded: ["1uk4", "other"] }).state;
		// "other" is down: its card vanishes from the fetch, but its key stays seen
		s = planNotifications(s, [A], { focused: false, responded: ["1uk4"] }).state;
		assert.ok(s.seen.has(itemKey(away)));
		const back = planNotifications(s, [A, away], { focused: false, responded: ["1uk4", "other"] });
		assert.deepEqual(back.notifications, []);
		// once it DID respond without the card, the key is forgotten (a new card of the same id would be new)
		const gone = planNotifications(back.state, [A], { focused: false, responded: ["1uk4", "other"] });
		assert.ok(!gone.state.seen.has(itemKey(away)));
	});

	it("mergeReport keeps a down wolf's items and replaces the responders'", () => {
		const a2 = item({ callId: "a2", raisedAt: "2026-10-26T09:00:00.000Z" });
		const merged = mergeReport([A, away], ["1uk4"], [a2]);
		assert.deepEqual(merged.map((i) => i.callId), ["a2", "z"]);
	});
});

describe("activity bridge recovery", () => {
	it("retries a dropped stream with backoff and pokes on every reconnect", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		let opens = 0;
		client.watchActivity = async function* () {
			opens++;
			if (opens < 3) throw new Error("connection lost");
			yield { type: "resync", id: 1, wolf: "1uk4", at: new Date().toISOString() } as never; // the baseline of the good connection
			await new Promise(() => {}); // stays open
		};
		const poked: string[] = [];
		const bridge = createActivityBridge((w) => poked.push(w), { backoffMs: [5, 5], wolvesTtlMs: 60_000 });
		bridge.ensure(client);
		await new Promise((r) => setTimeout(r, 120));
		bridge.stop();
		assert.equal(opens, 3);
		assert.equal(poked.length, 1, "one poke, after the connection that worked delivered its baseline");
	});

	it("caches the wolf list between ensure calls", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		let listed = 0;
		const real = client.listWolves.bind(client);
		client.listWolves = async () => (listed++, real());
		const bridge = createActivityBridge(() => {}, { wolvesTtlMs: 60_000 });
		bridge.ensure(client);
		await new Promise((r) => setTimeout(r, 20));
		bridge.ensure(client);
		bridge.ensure(client);
		await new Promise((r) => setTimeout(r, 20));
		bridge.stop();
		assert.equal(listed, 1);
	});
});

describe("bridge hygiene", () => {
	it("abortableSleep leaves no abort listeners behind over many retries", async () => {
		const ctl = new AbortController();
		let live = 0;
		const add = ctl.signal.addEventListener.bind(ctl.signal);
		const remove = ctl.signal.removeEventListener.bind(ctl.signal);
		ctl.signal.addEventListener = ((t: string, l: never, o?: never) => (live++, add(t, l, o))) as never;
		ctl.signal.removeEventListener = ((t: string, l: never, o?: never) => (live--, remove(t, l, o))) as never;
		for (let i = 0; i < 50; i++) await abortableSleep(1, ctl.signal);
		assert.equal(live, 0);
		const pending = abortableSleep(60_000, ctl.signal);
		ctl.abort();
		await pending; // abort ends the sleep at once
	});

	it("unfollows a wolf that is no longer listed", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const names = ["1uk4", "extra"];
		client.listWolves = async () => names.map((n) => ({ id: n, name: n, host: "x", status: "online" as const }));
		const opened: string[] = [];
		const closed: string[] = [];
		client.watchActivity = async function* (wolf, o) {
			opened.push(wolf);
			await new Promise<void>((r) => o?.signal?.addEventListener("abort", () => r()));
			closed.push(wolf);
		};
		const bridge = createActivityBridge(() => {}, { wolvesTtlMs: 0, backoffMs: [5] });
		bridge.ensure(client);
		await new Promise((r) => setTimeout(r, 20));
		assert.deepEqual([...bridge.following].sort(), ["1uk4", "extra"]);
		names.pop();
		bridge.ensure(client);
		await new Promise((r) => setTimeout(r, 40));
		assert.deepEqual(closed, ["extra"]);
		assert.deepEqual([...bridge.following], ["1uk4"]);
		bridge.stop();
	});

	it("a full fetch drops wolves that left the wolf list (no ghost cards)", () => {
		const A = item({ callId: "a" });
		const ghost = item({ callId: "g", wolf: "gone", threadId: "gone/home" });
		assert.deepEqual(mergeReport([A, ghost], ["1uk4"], [A], ["1uk4"]).map((i) => i.callId), ["a"]);
		assert.deepEqual(mergeReport([A, ghost], ["1uk4"], [A]).map((i) => i.callId).sort(), ["a", "g"], "a per-wolf fetch leaves others alone");
	});

	it("a wolf that was down at first load is primed by its first report, not notified for it", () => {
		const A = item({ callId: "a" });
		const late = item({ callId: "l", wolf: "late", threadId: "late/home", href: "/wolf/late/thread/home" });
		let s = planNotifications(INITIAL_NOTIFY_STATE, [A], { focused: false, responded: ["1uk4"] }).state;
		const first = planNotifications(s, [A, late], { focused: false, responded: ["1uk4", "late"] });
		assert.deepEqual(first.notifications, [], "its existing cards only prime");
		s = first.state;
		const next = item({ callId: "l2", wolf: "late", threadId: "late/home", href: "/wolf/late/thread/home" });
		assert.equal(planNotifications(s, [A, late, next], { focused: false, responded: ["1uk4", "late"] }).notifications.length, 1);
	});
});

describe("electron notify guards", () => {
	const { safeNotifyHref, isMainFrameSender, createNeedsYouNotifier } = createRequire(import.meta.url)("../../desktop/electron/notify.cjs") as {
		safeNotifyHref(h: unknown, o: string): string | null;
		isMainFrameSender(e: unknown, w: unknown): boolean;
		createNeedsYouNotifier(o: { Notification: unknown; appOrigin: string }): (e: unknown, w: unknown, n: unknown) => boolean;
	};
	const ORIGIN = "http://127.0.0.1:3000";

	it("accepts in-app paths and rejects anything that leaves the origin", () => {
		assert.equal(safeNotifyHref("/wolf/1uk4/thread/home", ORIGIN), "/wolf/1uk4/thread/home");
		assert.equal(safeNotifyHref("/wolf/a?x=1#h", ORIGIN), "/wolf/a?x=1#h");
		for (const bad of ["https://evil.com/x", "//evil.com", "/.//evil.com", "/\\evil.com", "\\\\evil.com", "javascript:alert(1)", "http://127.0.0.1:3001/", "", 5, null]) {
			assert.equal(safeNotifyHref(bad, ORIGIN), null, String(bad));
		}
	});

	function fakes(focused = false) {
		const shown: { title: string; body: string }[] = [];
		const sent: string[] = [];
		const clicks: (() => void)[] = [];
		class Notification {
			static isSupported = () => true;
			constructor(public opts: { title: string; body: string }) {}
			on(_e: string, cb: () => void) {
				clicks.push(cb);
			}
			show() {
				shown.push(this.opts);
			}
		}
		const mainFrame = {};
		const win = {
			isDestroyed: () => false,
			isFocused: () => focused,
			isMinimized: () => false,
			show() {},
			focus() {},
			restore() {},
			webContents: { mainFrame, send: (_c: string, href: string) => sent.push(href) },
		};
		return { Notification, shown, sent, clicks, win, mainFrame };
	}
	const note = { key: "k1", title: "1uk4 · Home", body: "Which branch?", href: "/wolf/1uk4/thread/home" };

	it("only the app window's main frame may notify", () => {
		const f = fakes();
		assert.equal(isMainFrameSender({ senderFrame: f.mainFrame }, f.win), true);
		assert.equal(isMainFrameSender({ senderFrame: {} }, f.win), false, "a subframe");
		assert.equal(isMainFrameSender({ senderFrame: null }, f.win), false);
		const notify = createNeedsYouNotifier({ Notification: f.Notification, appOrigin: ORIGIN });
		assert.equal(notify({ senderFrame: {} }, f.win, note), false);
		assert.equal(f.shown.length, 0);
	});

	it("shows once per key while unfocused, never while focused or for a foreign href; click navigates", () => {
		const f = fakes();
		const notify = createNeedsYouNotifier({ Notification: f.Notification, appOrigin: ORIGIN });
		const ev = { senderFrame: f.mainFrame };
		assert.equal(notify(ev, f.win, note), true);
		assert.equal(notify(ev, f.win, note), false, "deduped by key");
		assert.equal(notify(ev, f.win, { ...note, key: "k2", href: "/\\evil.com" }), false);
		assert.deepEqual(f.shown, [{ title: "1uk4 · Home", body: "Which branch?" }]);
		f.clicks[0]!();
		assert.deepEqual(f.sent, ["/wolf/1uk4/thread/home"]);
		const focused = fakes(true);
		assert.equal(createNeedsYouNotifier({ Notification: focused.Notification, appOrigin: ORIGIN })({ senderFrame: focused.mainFrame }, focused.win, note), false);
	});
});
