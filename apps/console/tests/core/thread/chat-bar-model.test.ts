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
});
