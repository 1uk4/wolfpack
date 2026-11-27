/** The den strip's model (work-wolfpack-XR2Jmxf): one button per wolf, with the needs-you count, a working flag, the wolf's colour and the sheet's rows. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Card } from "@wolfpack/client";
import { buildDenStrip, denLabel } from "../../../src/core/thread/den-strip.ts";
import type { NeedsYouItem } from "../../../src/core/thread/needs-you.ts";

const card = (title: string): Card => ({ tool: "ask", title, fields: [] }) as unknown as Card;
const item = (wolf: string, threadId: string, threadTitle: string, headline: string, extra: Partial<NeedsYouItem> = {}): NeedsYouItem => ({
	wolf,
	threadId,
	threadTitle,
	slug: threadId.split("/")[1]!,
	href: `/wolf/${wolf}/thread/${threadId.split("/")[1]}`,
	callId: `c-${threadId}-${headline}`,
	card: card(headline),
	raisedAt: "2026-11-09T00:00:00Z",
	...extra,
});
const t = (id: string, status: "idle" | "busy" | "needs-you" = "idle", extra: object = {}) => ({ id, title: id, kind: "feature" as const, status, ...extra });

describe("buildDenStrip", () => {
	it("lists the online wolves in order, each with its needs-you count and the rows the sheet shows", () => {
		const strip = buildDenStrip(
			[{ name: "w" }, { name: "hal" }],
			{ w: [t("w/a")], hal: [t("hal/b")] },
			[item("w", "w/a", "Ship it", "Which branch?"), item("w", "w/a", "Ship it", "Delete worktrees?"), item("hal", "hal/b", "Sync", "Restart?")],
		);
		assert.deepEqual(strip.map((s) => [s.wolf, s.needsYou]), [["w", 2], ["hal", 1]]);
		assert.deepEqual(strip[0]!.rows.map((r) => [r.title, r.summary, r.href]), [["Ship it", "Which branch?", "/wolf/w/thread/a"], ["Ship it", "Delete worktrees?", "/wolf/w/thread/a"]]);
	});

	it("counts the threads the lists say are waiting before the cards are loaded", () => {
		const strip = buildDenStrip([{ name: "w" }], { w: [t("w/a", "needs-you"), t("w/b", "needs-you"), t("w/c")] }, []);
		assert.deepEqual([strip[0]!.needsYou, strip[0]!.rows.length], [2, 0]);
	});

	it("marks a wolf working when any of its threads is busy, and no other", () => {
		const strip = buildDenStrip([{ name: "w" }, { name: "hal" }], { w: [t("w/a"), t("w/b", "busy")], hal: [t("hal/a")] }, []);
		assert.deepEqual(strip.map((s) => [s.wolf, s.working]), [["w", true], ["hal", false]]);
	});

	it("leaves out an offline wolf and the librarian unless a card waits on it", () => {
		const wolves = [{ name: "w" }, { name: "off", status: "offline" }, { name: "lib", librarian: true }, { name: "off2", status: "offline" }];
		const none = buildDenStrip(wolves, {}, []);
		assert.deepEqual(none.map((s) => s.wolf), ["w"]);
		const some = buildDenStrip(wolves, {}, [item("off2", "off2/x", "X", "Q?")]);
		assert.deepEqual(some.map((s) => s.wolf), ["w", "off2"]);
	});

	it("takes the wolf's chosen colour, else the colour of its home thread", () => {
		const strip = buildDenStrip([{ name: "w", color: "red" }, { name: "v" }], { w: [t("w/home", "idle", { kind: "home" })], v: [t("v/home", "idle", { kind: "home" })] }, []);
		assert.equal(strip[0]!.color, "#f07178", "the wolf's own colour: red");
		assert.match(strip[1]!.color, /^#[0-9a-f]{6}$/i, "automatic: one of the palette's hex colours");
	});

	it("labels the button with the wolf, whether it is working and how many need you", () => {
		assert.equal(denLabel({ wolf: "w", working: true, needsYou: 2 }), "w, working, 2 need you");
		assert.equal(denLabel({ wolf: "w", working: false, needsYou: 1 }), "w, 1 needs you");
		assert.equal(denLabel({ wolf: "w", working: false, needsYou: 0 }), "w");
	});
});
