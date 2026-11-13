/** Seam: the Wolves section model (src/core/pack/wolves-model.ts). Pure. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KeyMachine } from "../../../src/core/pack/keys-model.ts";
import { groupWolves, keysNeeded, mainProviderOf, memoryIgnoredOn, modelPickers, saveMessage, settingsAnswerFor, wolfAccess } from "../../../src/core/pack/wolves-model.ts";

const key = { slot: "anthropic", present: true, masked: "••••4f2a", source: "pack" as const };
const mac: KeyMachine = { hostId: "mac", machine: "Mac", online: true, canSetKeys: true, wolves: [{ name: "hal", transport: "subscription" }], slots: [] };
const sfo: KeyMachine = { hostId: "sfo", machine: "sfo-01", online: true, canSetKeys: true, wolves: [{ name: "dewey", transport: "api" }, { name: "scout", transport: "api" }], slots: [key] };
const bare: KeyMachine = { hostId: "box", machine: "box", online: true, canSetKeys: true, wolves: [{ name: "pip", transport: "api" }], slots: [] };
const catalog = [
	{ id: "claude-opus-5-5", name: "Opus 5.5", provider: "anthropic" },
	{ id: "gpt-x", name: "GPT X", provider: "openai" },
];

describe("Wolves section model", () => {
	it("groups wolves under their machine, in the machines' order, and skips machines with none", () => {
		const g = groupWolves([mac, { ...bare, wolves: [] }, sfo]);
		assert.deepEqual(g.map((x) => [x.machine, x.wolves.map((w) => w.name)]), [["Mac", ["hal"]], ["sfo-01", ["dewey", "scout"]]]);
		assert.equal(g[1]!.wolves[0]!.hostId, "sfo");
	});

	it("reaches every wolf through the hub in relay mode, and only this machine's wolves in local mode", () => {
		assert.deepEqual(wolfAccess({ relay: true, machine: "mac" }, sfo), { reachable: true });
		assert.deepEqual(wolfAccess({ relay: false, machine: "mac" }, mac), { reachable: true });
		const r = wolfAccess({ relay: false, machine: "mac" }, sfo, "dewey");
		assert.deepEqual(r, { reachable: false, note: "Open sfo-01's console to change dewey's models." });
	});

	it("treats a console that did not say where it runs as unable to reach the wolf", () => {
		assert.equal(wolfAccess(undefined, mac, "hal").reachable, false);
	});

	it("accepts a settings answer only when it is for the wolf shown", () => {
		assert.equal(settingsAnswerFor("dewey", { name: "dewey" }), true);
		assert.equal(settingsAnswerFor("dewey", { name: "hal" }), false);
		assert.equal(settingsAnswerFor("dewey", {}), false);
	});

	it("names the wolf's main provider from wolf.yaml, else from what it runs on, and only then assumes Anthropic", () => {
		assert.equal(mainProviderOf({ models: { main: { provider: "openai" } } }, { main: "anthropic" }), "openai");
		assert.equal(mainProviderOf({}, { main: "openai" }), "openai");
		assert.equal(mainProviderOf({}, { main: "claude-stateless" }), "anthropic");
		assert.equal(mainProviderOf({}, undefined), "anthropic");
	});

	it("memory.model has no effect when the wolf's smart tier runs on a non-Anthropic provider", () => {
		assert.equal(memoryIgnoredOn({ smart: "openai" }), "openai");
		assert.equal(memoryIgnoredOn({ smart: "anthropic" }), undefined);
		assert.equal(memoryIgnoredOn({ smart: "claude-stateless" }), undefined);
		assert.equal(memoryIgnoredOn(undefined), undefined);
	});

	it("offers a wolf's chat picker the models of its own main provider when that provider is keyed", () => {
		const cat = [...catalog, { id: "gpt-y", name: "GPT Y", provider: "openai" }];
		const p = modelPickers(sfo, { name: "dewey", transport: "api" }, cat, "anthropic");
		assert.deepEqual(p.chat.kind === "options" && p.chat.models.map((m) => m.id), ["claude-opus-5-5"]);
		assert.deepEqual(modelPickers(sfo, { name: "dewey", transport: "api" }, cat, "openai").chat, { kind: "nokey", provider: "openai" });
	});

	it("words each save outcome: saved, changed since loaded (409), refused with the server's reason (400), network failure", () => {
		assert.deepEqual(saveMessage(200, null, "dewey"), { ok: true, text: "Saved for dewey only. It takes effect when dewey restarts." });
		assert.match(saveMessage(409, null, "dewey").text, /changed since you loaded/);
		assert.deepEqual(saveMessage(400, { error: "Memory can only use an Anthropic model" }, "dewey"), { ok: false, text: "Memory can only use an Anthropic model" });
		assert.deepEqual(saveMessage("network", null, "dewey"), { ok: false, text: "Couldn't save; nothing changed." });
	});

	it("an offline machine's pickers say its keys are not known", () => {
		const p = modelPickers({ ...sfo, online: false }, { name: "dewey", transport: "api" }, catalog);
		assert.deepEqual([p.chat.kind, p.memory.kind], ["unknown", "unknown"]);
	});

	it("a subscription wolf's memory picker still needs the machine's Anthropic key", () => {
		assert.deepEqual(modelPickers(mac, { name: "hal", transport: "subscription" }, catalog).memory, { kind: "nokey", provider: "Anthropic" });
		const keyed = { ...mac, slots: [key] };
		const m = modelPickers(keyed, { name: "hal", transport: "subscription" }, catalog).memory;
		assert.deepEqual(m.kind === "options" && m.models.map((x) => x.id), ["claude-opus-5-5"]);
	});

	it("a subscription wolf's chat picker offers no Pack key and says it runs on the subscription", () => {
		const p = modelPickers(mac, { name: "hal", transport: "subscription" }, catalog);
		assert.equal(p.chat.kind, "subscription");
	});

	it("an API wolf's pickers offer only keyed providers' models; memory is Anthropic only", () => {
		const p = modelPickers(sfo, { name: "dewey", transport: "api" }, catalog);
		assert.deepEqual(p.chat.kind === "options" && p.chat.models.map((m) => m.id), ["claude-opus-5-5"]);
		assert.deepEqual(p.memory.kind === "options" && p.memory.models.map((m) => m.id), ["claude-opus-5-5"]);
	});

	it("a wolf whose machine has no key for its provider gets no options and is told which key is missing", () => {
		const p = modelPickers(bare, { name: "pip", transport: "api" }, catalog);
		assert.deepEqual(p.chat, { kind: "nokey", provider: "Anthropic" });
		assert.deepEqual(p.memory, { kind: "nokey", provider: "Anthropic" });
	});

	it("lists the keys a wolf needs: none for chat on a subscription wolf, a flagged gap for an API wolf without one", () => {
		const sub = keysNeeded(mac, { name: "hal", transport: "subscription" });
		assert.deepEqual(sub.map((r) => [r.capability, r.state, r.missing]), [["chat", "subscription", false], ["memory", "none", true]]);
		const api = keysNeeded(bare, { name: "pip", transport: "api" });
		assert.deepEqual(api.map((r) => [r.capability, r.state, r.missing]), [["chat", "none", true], ["memory", "none", true]]);
		assert.equal(keysNeeded(sfo, { name: "dewey", transport: "api" })[0]!.masked, "••••4f2a");
	});
});
