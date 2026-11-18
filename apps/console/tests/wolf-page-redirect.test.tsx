import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import WolfPage from "../app/wolf/[name]/page.tsx";
import { setConsoleClient } from "../src/server/index.ts";

type T = { id: string; wolf: string; kind: string; title: string };

/** A wolf roster in memory: createThread({kind:"home"}) returns the existing home (the wolf contract's idempotence). */
function fake(wolves: Record<string, T[]>) {
	const calls = { create: 0 };
	const client = {
		async listThreads(wolf: string) {
			if (!wolves[wolf]) throw Object.assign(new Error("no such wolf"), { name: "NotFoundError" });
			return [...wolves[wolf]!];
		},
		async createThread(wolf: string, body: { kind: string }) {
			calls.create++;
			assert.equal(body.kind, "home");
			const existing = wolves[wolf]!.find((t) => t.kind === "home");
			if (existing) return existing;
			const made = { id: `${wolf}/home`, wolf, kind: "home", title: "Home" };
			wolves[wolf]!.push(made);
			return made;
		},
	};
	setConsoleClient(client as never);
	return calls;
}

async function visit(name: string): Promise<string> {
	try {
		await WolfPage({ params: Promise.resolve({ name }) });
	} catch (e) {
		const digest = (e as { digest?: string }).digest ?? "";
		if (digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2]!;
		if (digest.endsWith(";404")) return "404";
		throw e;
	}
	return "rendered";
}

afterEach(() => setConsoleClient(undefined));

describe("/wolf/<name>", () => {
	it("redirects to the wolf's Home thread", async () => {
		fake({ "1uk4": [{ id: "1uk4/f1", wolf: "1uk4", kind: "feature", title: "F" }, { id: "1uk4/home", wolf: "1uk4", kind: "home", title: "Home" }] });
		assert.equal(await visit("1uk4"), "/wolf/1uk4/thread/home");
	});

	it("404s for an unknown wolf", async () => {
		fake({});
		assert.equal(await visit("ghost"), "404");
	});

	it("creates the Home thread when there is none, then redirects, and a repeat visit creates no second one", async () => {
		const wolves = { fresh: [] as T[] };
		const calls = fake(wolves);
		assert.equal(await visit("fresh"), "/wolf/fresh/thread/home");
		assert.equal(await visit("fresh"), "/wolf/fresh/thread/home");
		assert.equal(calls.create, 1);
		assert.equal(wolves.fresh.filter((t) => t.kind === "home").length, 1);
	});
});
