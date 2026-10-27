import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildCommandItems,
	createSwrCache,
	currentWolfOf,
	focusHref,
	graphItems,
	PALETTE_CAPS,
	rankPalette,
	threadItems,
	wolfItems,
	type PaletteItem,
} from "../src/core/palette.ts";
import { actionForBinding, bindingForAction, KEYBOARD_ACTIONS } from "../src/core/keyboard.ts";
import type { KbGraphNode } from "../src/core/kb.ts";

const node = (n: Partial<KbGraphNode> & Pick<KbGraphNode, "id" | "kind" | "label">): KbGraphNode =>
	({ depth: 2, ...n }) as KbGraphNode;

describe("currentWolfOf", () => {
	it("derives the wolf from wolf routes", () => {
		assert.equal(currentWolfOf("/wolf/1uk4"), "1uk4");
		assert.equal(currentWolfOf("/wolf/1uk4/thread/home"), "1uk4");
		assert.equal(currentWolfOf("/wolf/a%20b/thread/x"), "a b");
	});
	it("is null off wolf routes", () => {
		assert.equal(currentWolfOf("/"), null);
		assert.equal(currentWolfOf("/pipeline"), null);
		assert.equal(currentWolfOf("/wolves"), null);
		assert.equal(currentWolfOf(null), null);
	});
});

describe("buildCommandItems", () => {
	it("hides memory commands without a current wolf", () => {
		const ids = buildCommandItems(null).map((i) => i.id);
		assert.deepEqual(ids, ["cmd:graph", "cmd:pipeline", "cmd:model"]);
	});
	it("adds consolidate/promote for the current wolf", () => {
		const items = buildCommandItems("1uk4");
		assert.deepEqual(items.filter((i) => i.command === "consolidate" || i.command === "promote").map((i) => i.hint), ["1uk4", "1uk4"]);
		assert.equal(items.find((i) => i.id === "cmd:pipeline")?.href, "/pipeline");
		assert.equal(items.find((i) => i.id === "cmd:graph")?.href, "/");
		assert.equal(items.find((i) => i.label === "Switch model")?.command, "switch-model");
	});
});

describe("item building", () => {
	it("wolves and threads link to their routes", () => {
		assert.equal(wolfItems([{ name: "1uk4" }])[0]!.href, "/wolf/1uk4");
		const t = threadItems("1uk4", [{ id: "1uk4/home", title: "Home" }])[0]!;
		assert.equal(t.href, "/wolf/1uk4/thread/home");
		assert.equal(t.hint, "1uk4");
	});
	it("graph nodes: only entries and work, linked by focus param", () => {
		const items = graphItems([
			node({ id: "dom:wolfpack", kind: "domain", label: "wolfpack" }),
			node({ id: "sec:s", kind: "section", label: "Sec" }),
			node({ id: "den:1uk4:t", kind: "den-topic", label: "Den" }),
			node({ id: "ent:a b", kind: "entry", label: "Arch", domain: "wolfpack" }),
			node({ id: "work:w1", kind: "work", label: "Do it", workKind: "task", stage: "in_build" }),
		]);
		assert.deepEqual(items.map((i) => [i.kind, i.href]), [
			["entry", "/?focus=ent%3Aa%20b"],
			["work", "/?focus=work%3Aw1"],
		]);
		assert.equal(items[1]!.hint, "task · in_build");
		assert.equal(focusHref("ent:x"), "/?focus=ent%3Ax");
	});
});

describe("rankPalette", () => {
	const items: PaletteItem[] = [
		{ id: "a", kind: "entry", label: "Memory architecture" },
		{ id: "b", kind: "command", label: "Consolidate memory" },
		{ id: "c", kind: "wolf", label: "memory-wolf" },
		{ id: "d", kind: "entry", label: "Buried memory note" },
		{ id: "e", kind: "work", label: "Unrelated" },
	];
	it("groups in fixed order and drops empty groups", () => {
		const g = rankPalette("memory", items);
		assert.deepEqual(g.map((x) => x.kind), ["command", "wolf", "entry"]);
	});
	it("ranks best-first within a group", () => {
		const entries = rankPalette("memory", items).find((x) => x.kind === "entry")!;
		assert.deepEqual(entries.items.map((i) => i.id), ["a", "d"]);
	});
	it("matches hint and keywords", () => {
		const g = rankPalette("fox", [{ id: "k", kind: "entry", label: "Zed", keywords: ["foxtrot"] }]);
		assert.equal(g[0]!.items[0]!.id, "k");
	});
	it("caps each group", () => {
		const many: PaletteItem[] = Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, kind: "entry", label: `note ${i}` }));
		assert.equal(rankPalette("note", many)[0]!.items.length, PALETTE_CAPS.entry);
	});
	it("empty query hides KB groups but shows commands", () => {
		const g = rankPalette("", items);
		assert.deepEqual(g.map((x) => x.kind), ["command", "wolf"]);
	});
});

describe("keyboard rebind", () => {
	it("⌘K is the palette, ⌘⇧M the model picker", () => {
		assert.equal(actionForBinding("mod+k"), "open-palette");
		assert.equal(actionForBinding("mod+shift+m"), "open-model-picker");
		assert.equal(bindingForAction("open-model-picker"), "mod+shift+m");
	});
	it("no two dispatchable actions share a binding", () => {
		const seen = new Set<string>();
		for (const a of KEYBOARD_ACTIONS.filter((x) => !x.displayOnly)) {
			assert.ok(!seen.has(a.binding), `duplicate ${a.binding}`);
			seen.add(a.binding);
		}
	});
});

describe("keyword weighting", () => {
	it("a title hit outranks a summary-only hit", () => {
		const g = rankPalette("fox", [
			{ id: "sum", kind: "entry", label: "Zed", keywords: ["fox"] },
			{ id: "title", kind: "entry", label: "Buried fox note" },
		]);
		assert.deepEqual(g[0]!.items.map((i) => i.id), ["title", "sum"]);
	});
});

describe("createSwrCache", () => {
	it("serves the stale value, refreshes, dedupes, and retries after rejection", async () => {
		let n = 0;
		let fail = false;
		const c = createSwrCache(async () => {
			n++;
			if (fail) throw new Error("boom");
			return n;
		});
		assert.equal(c.peek(), undefined);
		const [a, b] = await Promise.all([c.refresh(), c.refresh()]);
		assert.equal(a, 1);
		assert.equal(b, 1);
		assert.equal(c.peek(), 1);
		fail = true;
		await assert.rejects(c.refresh());
		assert.equal(c.peek(), 1);
		fail = false;
		assert.equal(await c.refresh(), 3);
	});
});
