/** Seam: the Keys grid model (src/core/pack/keys-model.ts). Pure. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apiWolves, buildGrid, pickerOptions, type KeyMachine } from "../../../src/core/pack/keys-model.ts";

const m = (hostId: string, over: Partial<KeyMachine> = {}): KeyMachine => ({ hostId, machine: hostId, online: true, canSetKeys: true, slots: [], ...over });

describe("Keys grid model", () => {
	it("lists Anthropic under both Chat and Memory, with one cell per machine", () => {
		const g = buildGrid([m("mac"), m("sfo-01")]);
		assert.deepEqual(g.map((x) => x.capability), ["chat", "memory"]);
		for (const grp of g) {
			assert.equal(grp.rows.length, 1);
			assert.equal(grp.rows[0]!.providerId, "anthropic");
			assert.equal(grp.rows[0]!.cells.length, 2);
		}
	});

	it("shows Dictation only when a key exists or a machine serves a console, and flags the gap there", () => {
		assert.ok(!buildGrid([m("mac")]).some((x) => x.capability === "dictation"));
		const g = buildGrid([m("mac", { servesConsole: true }), m("sfo-01")]);
		const row = g.find((x) => x.capability === "dictation")!.rows[0]!;
		assert.deepEqual(row.cells.map((c) => [c.state, c.missing]), [["none", true], ["none", false]]);
	});

	it("a machine that can't take keys, or is offline, is unknown and never flagged as missing a key", () => {
		const g = buildGrid([m("mac", { servesConsole: true }), m("old", { canSetKeys: false, servesConsole: true }), m("away", { online: false, servesConsole: true })]);
		for (const grp of g) {
			const [, old, away] = grp.rows[0]!.cells;
			assert.deepEqual([old!.state, old!.missing], ["unknown", false]);
			assert.deepEqual([away!.state, away!.missing], ["unknown", false]);
		}
		assert.equal(g.find((x) => x.capability === "chat")!.rows[0]!.cells[0]!.missing, true);
	});

	it("marks a Pack key that shadows the environment, and an environment-only key, without carrying values", () => {
		const g = buildGrid([
			m("mac", { slots: [{ slot: "anthropic", present: true, masked: "••••abcd", source: "pack", shadowsEnv: true }] }),
			m("sfo-01", { slots: [{ slot: "anthropic", present: true, masked: "••••wxyz", source: "env", shadowsEnv: false }] }),
		]);
		const [a, b] = g[0]!.rows[0]!.cells;
		assert.equal(a!.state, "shadowed");
		assert.equal(b!.state, "env");
	});

	it("a machine whose wolves are all subscription shows 'subscription' in Chat, never 'Needs a key'; a mixed machine still needs the key; Memory still wants it", () => {
		const sub = (n: string) => ({ name: n, transport: "subscription" as const });
		const api = (n: string) => ({ name: n, transport: "api" as const });
		const g = buildGrid([m("bridge", { wolves: [sub("hal")] }), m("mixed", { wolves: [sub("hal"), api("dewey")] }), m("plain", { wolves: [api("x")] })]);
		const chat = g.find((x) => x.capability === "chat")!.rows[0]!.cells;
		assert.deepEqual(chat.map((c) => [c.state, c.missing]), [["subscription", false], ["none", true], ["none", true]]);
		const memory = g.find((x) => x.capability === "memory")!.rows[0]!.cells;
		assert.equal(memory[0]!.state, "none");
	});

	it("apiWolves lists only the API-key wolves of a machine", () => {
		assert.deepEqual(apiWolves(m("a", { wolves: [{ name: "hal", transport: "subscription" }, { name: "dewey", transport: "api" }] })), ["dewey"]);
		assert.deepEqual(apiWolves(m("b")), []);
	});

	it("offers in the picker only providers that have no row yet, grouped by capability", () => {
		const grid = buildGrid([m("mac")]);
		assert.deepEqual(pickerOptions(grid).map((p) => [p.capability, p.providers.map((x) => x.id)]), [["dictation", ["deepgram"]]]);
	});
});
