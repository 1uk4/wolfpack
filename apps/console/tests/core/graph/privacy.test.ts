import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REDACTED, redact, redactCard, redactLines } from "../../../src/core/graph/privacy.ts";
import { DEFAULT_RENDER_SETTINGS, sanitizeRenderSettings } from "../../../src/core/graph/render-settings.ts";
import { formatFeed } from "../../../src/core/graph/live/feed.ts";
import { LiveOverlay } from "../../../components/graph/live/live-overlay.ts";

describe("private view redaction", () => {
	it("redact replaces a title only when private, and keeps empty text empty", () => {
		assert.equal(redact("Trip to Lisbon", true), REDACTED);
		assert.equal(redact("Trip to Lisbon", false), "Trip to Lisbon");
		assert.equal(redact("", true), "");
		assert.equal(redact(undefined, true), undefined);
	});
	it("redactLines keeps the line count and width but not the characters", () => {
		assert.deepEqual(redactLines(["Pure Poker", "app"], true), ["••••••••••", "•••"]);
		assert.deepEqual(redactLines(["Pure Poker"], false), ["Pure Poker"]);
	});
	it("redactCard hides titles, summary, domain, section and link labels but keeps kind, stage and wolf", () => {
		const card = {
			id: "work:x",
			kind: "work" as const,
			title: "Fix Mom's invoice",
			summary: "secret",
			domain: { name: "personal", label: "Personal" },
			section: { id: "s", label: "Taxes" },
			stage: "doing",
			wolf: "hal",
			parent: { id: "p", label: "Parent title" },
			dependencies: [{ id: "d", label: "Dep title" }],
			openHref: "/work/x",
		};
		const r = redactCard(card as never, true) as typeof card;
		assert.equal(r.title, REDACTED);
		assert.equal(r.summary, REDACTED);
		assert.equal(r.domain.label, REDACTED);
		assert.equal(r.section.label, REDACTED);
		assert.equal(r.parent.label, REDACTED);
		assert.equal(r.dependencies[0]!.label, REDACTED);
		assert.equal(r.openHref, undefined);
		assert.deepEqual([r.kind, r.stage, r.wolf], ["work", "doing", "hal"]);
		assert.equal(redactCard(card as never, false), card);
	});
	it("the feed keeps the wolf and verb but drops the target title in private", () => {
		const e = { id: "1", at: 1, verb: "kb-read", actor: { wolf: "hal" }, target: { kind: "kb-entry", id: "kb-x", title: "Tax notes" } };
		assert.equal(formatFeed([e] as never, { private: true })[0]!.text.includes("Tax notes"), false);
		assert.equal(formatFeed([e] as never, { private: false })[0]!.text.includes("Tax notes"), true);
	});
	it("overlay cards show a wolf's name but replace thread titles with the redaction mark", () => {
		const o = new LiveOverlay(() => {});
		o.setPrivate(true);
		const item = { kind: "thread", key: "hal/t1", wolf: "hal", threadId: "t1", label: "Plan my divorce", x: 0, y: 0, r: 1, alpha: 1, needsYou: false, online: true, color: "#fff" };
		const card = o.cardFor({ item, sx: 0, sy: 0 } as never);
		assert.equal(card.title, REDACTED);
		assert.ok(card.lines.includes("Wolf: hal"));
		const wolf = o.cardFor({ item: { ...item, kind: "wolf", label: "hal" }, sx: 0, sy: 0 } as never);
		assert.equal(wolf.title, "hal");
	});
});

describe("privateView setting", () => {
	it("defaults to false for old files and keeps only a real true", () => {
		assert.equal(DEFAULT_RENDER_SETTINGS.privateView, false);
		assert.equal(sanitizeRenderSettings({}).privateView, false);
		assert.equal(sanitizeRenderSettings({ privateView: "yes" }).privateView, false);
		assert.equal(sanitizeRenderSettings({ privateView: true }).privateView, true);
	});
});
