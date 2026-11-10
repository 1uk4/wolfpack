/** Reply notifications: when a finished wolf turn notifies, and that it does so once, for the right message. */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { INITIAL_REPLY_STATE, coalesced, dropReply, notifyOnce, planReply, replyBody, syncBusy, trackThreadStatus, type ReplyNotifyState } from "../src/core/index.ts";

type Msg = { id: string; role: "user" | "assistant"; text: string };
const T = (messages: Msg[]) => ({ wolf: "1uk4", id: "1uk4/home", title: "Home", messages });
const away = { focused: true, visible: true, pathname: "/wolf/1uk4/thread/other" };
const HOME = { wolf: "1uk4", threadId: "1uk4/home" };
const BUSY = { ...HOME, status: "busy" };
const ask: Msg = { id: "u1", role: "user", text: "do it" };
const as = (ids: string[]): Msg[] => ids.map((id) => ({ id, role: "assistant", text: `text ${id}` }));
const ev = (status: "idle" | "busy" | "needs-you", threadId = HOME.threadId) => ({ wolf: "1uk4", threadId, status });

/** busy then idle: a turn just ended. Nothing is fetched in between (the reply may land before anything could be). */
function ended(from: ReplyNotifyState = INITIAL_REPLY_STATE): { state: ReplyNotifyState; turn: number } {
	const done = trackThreadStatus(trackThreadStatus(from, ev("busy")).state, ev("idle"));
	return { state: done.state, turn: done.turn! };
}

describe("reply notifications", () => {
	it("a thread finishes only when it goes busy then idle; needs-you does not end it", () => {
		assert.equal(trackThreadStatus(INITIAL_REPLY_STATE, ev("idle")).finished, false);
		let s = trackThreadStatus(INITIAL_REPLY_STATE, ev("busy")).state;
		s = trackThreadStatus(s, ev("needs-you")).state;
		const done = trackThreadStatus(s, ev("idle"));
		assert.equal(done.finished, true);
		assert.equal(trackThreadStatus(done.state, ev("idle")).finished, false);
	});

	it("notifies once per reply, titled wolf · thread, body the first line, opening that thread", () => {
		const t = T([ask, { id: "m1", role: "assistant", text: "\n  Shipped it.  \nMore detail" }]);
		const first = ended();
		const plan = planReply(first.state, t, away, first.turn);
		assert.deepEqual(plan.notification, { key: "1uk4\n1uk4/home\nm1", title: "1uk4 · Home", body: "Shipped it.", href: "/wolf/1uk4/thread/home" });
		// another busy/idle with the same final message (a refetch): not announced twice
		const again = ended(plan.state);
		assert.equal(planReply(again.state, t, away, again.turn).notification, undefined);
	});

	it("a fast reply that lands before anything was fetched is announced", () => {
		const { state, turn } = ended();
		assert.equal(planReply(state, T([ask, ...as(["m1"])]), away, turn).notification?.body, "text m1");
	});

	it("a turn already running on load (primed mid-stream) is announced at its end, not taken as its baseline", () => {
		// the lists said busy; whatever partial message existed then is irrelevant: only the final page is judged
		const primed = syncBusy(INITIAL_REPLY_STATE, 0, ["1uk4"], [BUSY]);
		const done = trackThreadStatus(primed, ev("idle"));
		assert.equal(done.finished, true);
		assert.equal(planReply(done.state, T([ask, ...as(["m1", "m2"])]), away, done.turn!).notification?.body, "text m2");
	});

	it("stays quiet while the owner is looking at that thread, but notifies when the window is hidden or unfocused", () => {
		const t = T([ask, ...as(["m1"])]);
		const here = { focused: true, visible: true, pathname: "/wolf/1uk4/thread/home" };
		const { state, turn } = ended();
		assert.equal(planReply(state, t, here, turn).notification, undefined);
		assert.equal(planReply(state, t, { ...here, focused: false }, turn).notification?.body, "text m1");
		assert.equal(planReply(state, t, { ...here, visible: false }, turn).notification?.body, "text m1");
		// a trailing slash is still this thread
		assert.equal(planReply(state, t, { ...here, pathname: "/wolf/1uk4/thread/home/" }, turn).notification, undefined);
	});

	it("treats an encoded path as the same thread", () => {
		const id = "w/a b";
		const done = trackThreadStatus(trackThreadStatus(INITIAL_REPLY_STATE, { wolf: "w", threadId: id, status: "busy" }).state, { wolf: "w", threadId: id, status: "idle" });
		const t = { wolf: "w", id, title: "t", messages: [ask, ...as(["m1"])] };
		const here = { focused: true, visible: true };
		assert.equal(planReply(done.state, t, { ...here, pathname: "/wolf/w/thread/a%20b" }, done.turn!).notification, undefined);
		assert.equal(planReply(done.state, t, { ...here, pathname: "/wolf/w/thread/a b" }, done.turn!).notification, undefined);
	});

	it("announces nothing when the turn made no new assistant message (tool-only, aborted, errored)", () => {
		// first turn: the old reply m0 is judged and announced; a second turn that adds nothing must not announce it again
		const old = [ask, ...as(["m0"])];
		const first = ended();
		const afterFirst = planReply(first.state, T(old), away, first.turn);
		assert.equal(afterFirst.notification?.body, "text m0");
		const second = ended(afterFirst.state);
		assert.equal(planReply(second.state, T(old), away, second.turn).notification, undefined);
	});

	it("announces nothing when the turn's final message is tool-only, even after a text preamble", () => {
		const { state, turn } = ended();
		const msgs: Msg[] = [ask, ...as(["m1"]), { id: "m2", role: "assistant", text: "  " }];
		const plan = planReply(state, T(msgs), away, turn);
		assert.equal(plan.notification, undefined);
		assert.equal(plan.retry, undefined);
	});

	it("announces nothing when the page has no user message and nothing was seen before (the turn's start is off the page)", () => {
		const { state, turn } = ended();
		assert.equal(planReply(state, T(as(["m1", "m2", "m3"])), away, turn).notification, undefined);
	});

	it("a wolf-initiated turn (no user message on the page) is announced once the thread has been judged before", () => {
		const first = ended();
		const judged = planReply(first.state, T(as(["m0"])), away, first.turn).state;
		const next = ended(judged);
		assert.equal(planReply(next.state, T(as(["m0", "m1"])), away, next.turn).notification?.body, "text m1");
	});

	it("a user message last means the reply is not there yet: retry, then announce it exactly once", () => {
		const asked: Msg[] = [...as(["m0"]), ask];
		const { state, turn } = ended();
		const early = planReply(state, T(asked), away, turn);
		assert.equal(early.notification, undefined);
		assert.equal(early.retry, true);
		const withReply = T([...asked, { id: "m2", role: "assistant", text: "Done." }]);
		const later = planReply(early.state, withReply, away, turn);
		assert.equal(later.notification?.body, "Done.");
		assert.equal(planReply(later.state, withReply, away, turn).notification, undefined);
	});

	it("never announces a reply fetched after the next turn began", () => {
		const first = ended();
		const next = trackThreadStatus(first.state, ev("busy")).state;
		const plan = planReply(next, T([ask, ...as(["m1"])]), away, first.turn);
		assert.equal(plan.notification, undefined);
		assert.equal(plan.retry, undefined);
	});

	it("a superseded retry chain's dropReply does not drop the next turn's pending reply", () => {
		const first = ended();
		const second = ended(first.state);
		assert.notEqual(second.turn, first.turn);
		// turn 1's retries run out after turn 2 ended
		const dropped = dropReply(second.state, "1uk4", HOME.threadId, first.turn);
		assert.equal(planReply(dropped, T([ask, ...as(["m1"])]), away, second.turn).notification?.body, "text m1");
	});

	it("dropReply after the retries are exhausted ends the wait: a late reply is not announced", () => {
		const { state, turn } = ended();
		const dropped = dropReply(state, "1uk4", HOME.threadId, turn);
		assert.equal(planReply(dropped, T([ask, ...as(["m1"])]), away, turn).notification, undefined);
	});

	it("two interleaved threads: idle on A does not clear B", () => {
		let s = trackThreadStatus(INITIAL_REPLY_STATE, ev("busy", "1uk4/a")).state;
		s = trackThreadStatus(s, ev("busy", "1uk4/b")).state;
		const a = trackThreadStatus(s, ev("idle", "1uk4/a"));
		assert.equal(a.finished, true);
		const b = trackThreadStatus(a.state, ev("idle", "1uk4/b"));
		assert.equal(b.finished, true);
		const tb = { wolf: "1uk4", id: "1uk4/b", title: "B", messages: [ask, ...as(["b1"])] };
		assert.equal(planReply(b.state, tb, away, b.turn!).notification?.body, "text b1");
	});

	it("only owner-facing threads notify: subagent, process and closed threads do not", () => {
		for (const extra of [{ kind: "subagent" }, { kind: "process" }, { closed: true }]) {
			const { state, turn } = ended();
			assert.equal(planReply(state, { ...T([ask, ...as(["m1"])]), ...extra }, away, turn).notification, undefined, JSON.stringify(extra));
		}
		const { state, turn } = ended();
		assert.equal(planReply(state, { ...T([ask, ...as(["m1"])]), kind: "feature" }, away, turn).notification?.body, "text m1");
	});

	it("caps a long first line, keeping its start and ending with an ellipsis", () => {
		assert.equal(replyBody("x".repeat(200)), `${"x".repeat(139)}…`);
		assert.equal(replyBody("short"), "short");
	});
});

describe("syncBusy (priming from the thread lists)", () => {
	const finished = (s: ReplyNotifyState) => trackThreadStatus(s, ev("idle")).finished;

	it("marks a listed busy thread, so its end is seen", () => {
		assert.equal(finished(syncBusy(INITIAL_REPLY_STATE, 0, ["1uk4"], [BUSY])), true);
	});

	it("clears a mark the lists no longer show (an idle lost across a reconnect)", () => {
		const marked = syncBusy(INITIAL_REPLY_STATE, 0, ["1uk4"], [BUSY]);
		assert.equal(finished(syncBusy(marked, 0, ["1uk4"], [])), false);
	});

	it("leaves the marks of wolves the snapshot does not cover", () => {
		const marked = syncBusy(INITIAL_REPLY_STATE, 0, ["1uk4"], [BUSY]);
		assert.equal(finished(syncBusy(marked, 0, ["other"], [])), true);
	});

	it("keeps a mark a busy event set while the lists were being fetched", () => {
		const since = INITIAL_REPLY_STATE.seq;
		const evented = trackThreadStatus(INITIAL_REPLY_STATE, ev("busy")).state; // arrives mid-fetch
		assert.equal(finished(syncBusy(evented, since, ["1uk4"], [])), true); // the stale list says idle
	});

	it("does not re-add busy for a thread an idle event ended while the lists were being fetched", () => {
		const marked = syncBusy(INITIAL_REPLY_STATE, 0, ["1uk4"], [BUSY]);
		const since = marked.seq;
		const idled = trackThreadStatus(marked, ev("idle")).state; // arrives mid-fetch
		assert.equal(finished(syncBusy(idled, since, ["1uk4"], [BUSY])), false); // the stale list still says busy
	});

	it("keeps the mark of a thread the snapshot shows as needs-you (busy → needs-you → idle still ends a turn)", () => {
		const marked = syncBusy(INITIAL_REPLY_STATE, 0, ["1uk4"], [BUSY]);
		assert.equal(finished(syncBusy(marked, 0, ["1uk4"], [{ ...HOME, status: "needs-you" }])), true);
	});

	it("queues a thread whose lost-idle mark it clears for one judgment", () => {
		const marked = syncBusy(INITIAL_REPLY_STATE, 0, ["1uk4"], [BUSY]);
		assert.equal(syncBusy(marked, 0, ["1uk4"], [{ ...HOME, status: "idle" }]).pending.get("1uk4\n1uk4/home"), 1);
	});

	it("does not start a new turn for a thread already marked busy", () => {
		const marked = syncBusy(INITIAL_REPLY_STATE, 0, ["1uk4"], [BUSY]);
		assert.equal(syncBusy(marked, 0, ["1uk4"], [BUSY]).turn.get("1uk4\n1uk4/home"), 1);
	});
});

describe("coalesced (resync during a sync)", () => {
	it("a call during a run queues exactly one follow-up run", async () => {
		let runs = 0;
		let release: () => void = () => {};
		const sync = coalesced(async () => {
			runs++;
			if (runs === 1) await new Promise<void>((r) => (release = r));
		});
		const first = sync();
		void sync();
		void sync(); // two calls in flight: still one follow-up
		release();
		await first;
		assert.equal(runs, 2);
	});
});

describe("notifyOnce (cross-tab dedupe)", () => {
	/** An in-memory Web Locks: names held by any "tab" are unavailable to the others (ifAvailable answers null). */
	const makeLocks = () => {
		const held = new Set<string>();
		return {
			async request(name: string, _o: { ifAvailable: true }, cb: (lock: object | null) => Promise<void>): Promise<void> {
				if (held.has(name)) return cb(null);
				held.add(name);
				try {
					await cb({});
				} finally {
					held.delete(name); // released when the callback settles, like Web Locks
				}
			},
		};
	};
	const n = { key: "1uk4\nhome\nm1", title: "t", body: "b", href: "/x" };
	const never = () => new Promise<void>(() => {});

	it("two tabs given the same reply: exactly one delivers", async () => {
		const locks = makeLocks();
		const delivered: string[] = [];
		await Promise.all(["tab1", "tab2"].map((tab) => notifyOnce(locks, n, () => void delivered.push(tab), never)));
		assert.equal(delivered.length, 1);
	});

	it("a different reply is not blocked by the first", async () => {
		const locks = makeLocks();
		let count = 0;
		await notifyOnce(locks, n, () => void count++, never);
		await notifyOnce(locks, { ...n, key: "other" }, () => void count++, never);
		assert.equal(count, 2);
	});

	it("a tab that judges after the first returned, with the claim still held, stays quiet (also long after the old 60s)", async () => {
		const locks = makeLocks();
		const delivered: string[] = [];
		const t = mock.timers;
		t.enable({ apis: ["setTimeout"] });
		await notifyOnce(locks, n, () => void delivered.push("tab1")); // default hold: the page's life
		t.tick(10 * 60000);
		await new Promise<void>((r) => setImmediate(r)); // let a released hold settle
		await notifyOnce(locks, n, () => void delivered.push("tab2"));
		t.reset();
		assert.deepEqual(delivered, ["tab1"]);
	});

	it("a request that rejects delivers once and leaves no timer behind", async () => {
		const live = new Set<unknown>();
		const real = { st: globalThis.setTimeout, si: globalThis.setInterval, ct: globalThis.clearTimeout, ci: globalThis.clearInterval };
		const track = (set: typeof setTimeout) => ((...a: Parameters<typeof setTimeout>) => { const h = set(...a); live.add(h); return h; }) as typeof setTimeout;
		const untrack = (clear: typeof clearTimeout) => ((h: Parameters<typeof clearTimeout>[0]) => { live.delete(h); clear(h); }) as typeof clearTimeout;
		globalThis.setTimeout = track(real.st);
		globalThis.setInterval = track(real.si as never) as never;
		globalThis.clearTimeout = untrack(real.ct);
		globalThis.clearInterval = untrack(real.ci as never) as never;
		let count = 0;
		try {
			await notifyOnce({ request: () => Promise.reject(new Error("locks broke")) }, n, () => void count++);
			await new Promise<void>((r) => real.st(r, 5));
			for (const h of live) real.ct(h as never);
			assert.equal(count, 1);
			assert.equal(live.size, 0);
		} finally {
			Object.assign(globalThis, { setTimeout: real.st, setInterval: real.si, clearTimeout: real.ct, clearInterval: real.ci });
		}
	});

	it("a request that throws outright still delivers once", async () => {
		let count = 0;
		const throwing = {
			request: () => {
				throw new Error("locks broke");
			},
		};
		await notifyOnce(throwing, n, () => void count++);
		assert.equal(count, 1);
	});

	it("delivers as before where Web Locks is unavailable", async () => {
		let count = 0;
		await notifyOnce(undefined, n, () => void count++);
		await notifyOnce(undefined, n, () => void count++);
		assert.equal(count, 2);
	});
});
