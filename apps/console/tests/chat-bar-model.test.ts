import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HOME_WOLF_KEY, loadHomeWolf, saveHomeWolf, resolveHomeWolf, SWITCHER_RECENT, ATTACHED_KEY, buildSwitcher, loadAttached, resolveAttached, saveAttached, pickOwnerWolf, type BarThread, type KeyValueStore } from "../src/core/chat-bar.ts";
import { KEYBOARD_ACTIONS, actionForBinding, bindingForAction, loadOverrides, saveOverrides } from "../src/core/keyboard.ts";
import { nextOverrides } from "../components/settings/keyboard-section.tsx";

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
	it("owner wolf is the first online non-librarian", () => {
		assert.equal(pickOwnerWolf(wolves), "1uk4");
		assert.equal(pickOwnerWolf([{ name: "lib", librarian: true }, { name: "x", status: "offline" }]), "lib");
	});
	it("keeps a live target; falls back to home when gone or archived", () => {
		const live = { wolf: "1uk4", slug: "f1", threadId: "1uk4/f1" };
		assert.deepEqual(resolveAttached(live, wolves, threads), { attached: live, note: null });
		for (const id of ["1uk4/gone", "1uk4/old"]) {
			const r = resolveAttached({ wolf: "1uk4", slug: "x", threadId: id }, wolves, threads);
			assert.equal(r.attached?.threadId, "1uk4/home");
			assert.ok(r.note);
		}
		const first = resolveAttached(null, wolves, threads);
		assert.equal(first.attached?.threadId, "1uk4/home");
		assert.equal(first.note, null);
	});
	it("an unreachable wolf's target stands (not gone)", () => {
		const live = { wolf: "lib", slug: "f", threadId: "lib/f" };
		assert.equal(resolveAttached(live, wolves, { "1uk4": threads["1uk4"], lib: undefined }).attached, live);
	});
});

describe("switcher", () => {
	it("groups by wolf, home first, needs-you next, no subagents or archived", () => {
		const g = buildSwitcher(wolves, threads);
		assert.deepEqual(g.map((x) => x.wolf), ["1uk4", "lib"]);
		assert.deepEqual(g[0]!.entries.map((e) => e.threadId), ["1uk4/home", "1uk4/f2", "1uk4/f1"]);
	});
});

describe("chat bar shortcuts", () => {
	it("defaults, override, reset, no clash", () => {
		assert.equal(bindingForAction("focus-chat-bar"), "mod+j");
		assert.equal(bindingForAction("chat-bar-switcher"), "mod+shift+j");
		const live = KEYBOARD_ACTIONS.filter((a) => !a.displayOnly);
		assert.equal(new Set(live.map((a) => a.binding)).size, live.length);
		assert.equal(actionForBinding("mod+j"), "focus-chat-bar");
	});
	it("override and reset go through the shared overrides map", () => {
		const m = new Map<string, string>();
		(globalThis as any).window = { localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } };
		try {
			saveOverrides(nextOverrides(loadOverrides(), "focus-chat-bar", "mod+u"));
			assert.equal(bindingForAction("focus-chat-bar"), "mod+u");
			assert.equal(actionForBinding("mod+j"), undefined);
			saveOverrides(nextOverrides(loadOverrides(), "focus-chat-bar", null));
			assert.equal(bindingForAction("focus-chat-bar"), "mod+j");
		} finally {
			delete (globalThis as any).window;
		}
	});
});

describe("home wolf setting", () => {
	it("defaults to the guess; the setting overrides; reset restores", () => {
		const { s, m } = mem();
		assert.equal(loadHomeWolf(s), null);
		assert.equal(resolveHomeWolf(loadHomeWolf(s), wolves), "1uk4");
		saveHomeWolf(s, "lib");
		assert.equal(m.get(HOME_WOLF_KEY), "lib");
		assert.equal(resolveHomeWolf(loadHomeWolf(s), wolves), "lib");
		const r = resolveAttached({ wolf: "1uk4", slug: "gone", threadId: "1uk4/gone" }, wolves, threads, "lib");
		assert.equal(r.attached?.threadId, "lib/home", "falls back to the SET wolf's home");
		saveHomeWolf(s, null);
		assert.equal(m.has(HOME_WOLF_KEY), false);
		assert.equal(resolveHomeWolf(loadHomeWolf(s), wolves), "1uk4");
	});
	it("an offline or unknown home wolf keeps the stored target (no jump)", () => {
		const stored = { wolf: "1uk4", slug: "gone", threadId: "1uk4/gone" };
		for (const home of ["ghost", "lib"]) {
			const r = resolveAttached(stored, wolves, { "1uk4": threads["1uk4"], lib: undefined }, home);
			assert.equal(r.attached, stored);
			assert.equal(r.note, null);
		}
		assert.equal(resolveAttached(null, wolves, threads, "ghost").attached, null);
	});
	it("the switcher cut-off is the named constant", () => {
		const many = Array.from({ length: SWITCHER_RECENT + 4 }, (_, i) => t(`1uk4/n${i}`));
		const g = buildSwitcher(wolves, { "1uk4": [t("1uk4/home", { kind: "home" }), ...many] });
		assert.equal(g[0]!.entries.length, 1 + SWITCHER_RECENT);
	});
});
