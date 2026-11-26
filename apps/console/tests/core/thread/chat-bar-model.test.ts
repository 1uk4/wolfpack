import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SWITCHER_RECENT, ATTACHED_KEY, buildSwitcher, loadAttached, saveAttached, pickOwnerWolf, type BarThread, type KeyValueStore } from "../../../src/core/thread/chat-bar.ts";
import { KEYBOARD_ACTIONS, actionForBinding, bindingForAction, loadOverrides, saveOverrides } from "../../../src/core/ui/keyboard.ts";
import { nextOverrides } from "../../../components/settings/keyboard-section.tsx";

const mem = () => {
	const m = new Map<string, string>();
	const s: KeyValueStore = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
	return { m, s };
};
const wolves = [{ name: "lib", librarian: true }, { name: "1uk4" }];
const t = (id: string, o: Partial<BarThread> = {}): BarThread => ({ id, title: id, kind: "feature", ...o });
const threads = { "1uk4": [t("1uk4/home", { kind: "home", title: "Home" }), t("1uk4/f1"), t("1uk4/f2", { status: "needs-you" }), t("1uk4/sub", { kind: "subagent", parentThreadId: "1uk4/f1" }), t("1uk4/old", { closed: true })], lib: [t("lib/home", { kind: "home" })] };

describe("attached thread store", () => {
	it("persists and restores", () => {
		const { s } = mem();
		saveAttached(s, { wolf: "1uk4", slug: "f1", threadId: "1uk4/f1" });
		assert.deepEqual(loadAttached(s), { wolf: "1uk4", slug: "f1", threadId: "1uk4/f1" });
		s.setItem(ATTACHED_KEY, "garbage");
		assert.equal(loadAttached(s), null);
	});
	it("a thread stored under the old popped-out key becomes the attached thread, once", () => {
		const { m, s } = mem();
		m.set("wolfpack:chatbar:popped-out", JSON.stringify({ wolf: "1uk4", slug: "f1", threadId: "1uk4/f1" }));
		assert.deepEqual(loadAttached(s), { wolf: "1uk4", slug: "f1", threadId: "1uk4/f1" });
		assert.equal(m.has("wolfpack:chatbar:popped-out"), false, "the old key is gone");
		assert.deepEqual(loadAttached(s), { wolf: "1uk4", slug: "f1", threadId: "1uk4/f1" }, "now read from the new key");
	});
	it("owner wolf is the first online non-librarian", () => {
		assert.equal(pickOwnerWolf(wolves), "1uk4");
		assert.equal(pickOwnerWolf([{ name: "lib", librarian: true }, { name: "x", status: "offline" }]), "lib");
	});
});

describe("switcher", () => {
	it("the switcher cut-off is the named constant", () => {
		const many = Array.from({ length: SWITCHER_RECENT + 4 }, (_, i) => t(`1uk4/n${i}`));
		const g = buildSwitcher(wolves, { "1uk4": [t("1uk4/home", { kind: "home" }), ...many] });
		assert.equal(g[0]!.entries.length, 1 + SWITCHER_RECENT);
	});
	it("wolves and threads waiting on the owner sort first with an amber count; the rest keep a stable order", () => {
		const ws = [{ name: "lib", librarian: true }, { name: "1uk4" }, { name: "hal" }, { name: "sfo", status: "online" }];
		const ts = {
			lib: [t("lib/home", { kind: "home" })],
			"1uk4": [t("1uk4/home", { kind: "home" }), t("1uk4/a"), t("1uk4/b"), t("1uk4/c", { status: "needs-you" })],
			hal: [t("hal/home", { kind: "home" }), t("hal/x"), t("hal/y"), t("hal/z", { status: "needs-you" })],
			sfo: [t("sfo/home", { kind: "home", status: "needs-you" })],
		};
		// hal/x has a paged ask pending on its open page (the page-pending store), though its list row still says idle.
		const g = buildSwitcher(ws, ts, (wolf, id) => wolf === "hal" && id === "hal/x");
		// Waiting wolves lead (most waiting first), then the owner wolf, then the roster order.
		assert.deepEqual(g.map((x) => [x.wolf, x.needsYou]), [["hal", 2], ["1uk4", 1], ["sfo", 1], ["lib", 0]]);
		// Inside a wolf: waiting threads first (newest first), then the home thread, then the rest newest first.
		assert.deepEqual(g[0]!.entries.map((e) => [e.threadId, e.needsYou]), [["hal/z", true], ["hal/x", true], ["hal/home", false], ["hal/y", false]]);
		assert.deepEqual(g[2]!.entries.map((e) => e.threadId), ["sfo/home"]);
		assert.equal(g[3]!.status, "online");
	});
});
