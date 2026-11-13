/**
 * DEV ONLY (work-wolfpack-eE5FKDy): a fake backend for the Wolves section, so it can be checked without a hub.
 *   ?packFixture=wolves   a Mac wolf on the Claude subscription (hal), an sfo-01 API wolf with a key (dewey),
 *                         and a wolf whose machine has no Anthropic key (scout on old-box). Saving works, in memory.
 *   ?packFixture=wolves-relay   the same machines, but the console reports relay mode, so every wolf (dewey, with a key) is editable.
 * Without -relay the console is local on the Mac, so only hal is editable. Ignored in production.
 */
export function wolvesFixtureFromUrl(search: string): "local" | "relay" | null {
	if (process.env.NODE_ENV === "production") return null;
	const f = new URLSearchParams(search).get("packFixture");
	return f === "wolves" ? "local" : f === "wolves-relay" ? "relay" : null;
}

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const MACHINES = [
	{ hostId: "luka-mac", machine: "Mac", online: true, canSetKeys: true, wolves: [{ name: "hal", transport: "subscription" }], slots: [] },
	{ hostId: "sfo-01-wolves", machine: "sfo-01", online: true, canSetKeys: true, wolves: [{ name: "dewey", transport: "api" }], slots: [{ slot: "anthropic", present: true, masked: "••••9c1e", source: "pack" }] },
	{ hostId: "old-box", machine: "old-box", online: true, canSetKeys: true, wolves: [{ name: "scout", transport: "api" }], slots: [] },
];
const MODELS = [
	{ id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic" },
	{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic" },
	{ id: "claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "anthropic" },
];
const PROMPTS = [
	{ id: "system.header", group: "System", label: "System header", editable: false, text: "You are a wolf in a pack.".repeat(8), source: "default", file: "packages/harness/src/wolfd/context.ts" },
	{ id: "identity", group: "Wolf", label: "Identity", editable: true, text: "I am a careful engineer.".repeat(20), source: "override", file: "agent/AGENTS.md" },
	{ id: "pipeline.observer", group: "Memory", label: "Observer", editable: false, text: "Write down what matters.".repeat(40), source: "default", file: "packages/engine/src/prompts.ts" },
	{ id: "pipeline.consolidate", group: "Memory", label: "Consolidate", editable: false, text: "Merge observations into topics.".repeat(60), source: "default", file: "packages/engine/src/prompts.ts" },
	{ id: "agent.worker", group: "Workspace", label: "worker", editable: false, text: "---\nstandards: testing\n---\nBuild it.", source: "default", file: ".pi/agents/worker.md" },
	{ id: "standard.testing", group: "Workspace", label: "testing", editable: false, text: "Test first.", source: "default", file: "packages/agents/standards/testing.md" },
];

/** Typed out here, mirroring harness EDITABLE_KEYS (packages/harness/src/wolfd/wolf-settings.ts); not imported from harness. */
const EDITABLE_KEYS = [
	...(["main", "smart", "fast"] as const).flatMap((t) => [`models.${t}.provider`, `models.${t}.model`, `models.${t}.thinking`, `tiers.${t}.model`, `tiers.${t}.thinking`]),
	"color",
	"prompts.structuredOutput",
	"subagents.maxRunning",
	"compaction.enabled",
	"compaction.startAt",
	"compaction.reserveTokens",
	"compaction.keepRecentTokens",
	"memory.defaultDomain",
	"memory.model",
	"memory.sweepInterval",
	"memory.consolidation.threshold",
	"memory.consolidation.poolTarget",
	"memory.consolidation.trigger",
	"memory.consolidation.interval",
];
const ENV = [
	{ name: "WORK_ENDPOINT", set: true, secret: false, purpose: "Work API base URL" },
	{ name: "WORK_TOKEN", set: true, secret: true, purpose: "Work API token" },
	{ name: "WOLFPACK_HUB_TOKEN", set: false, secret: true, purpose: "hub worker token" },
];

export function fixtureWolvesFetch(mode: "local" | "relay" = "local"): typeof fetch {
	const config: Record<string, Record<string, unknown>> = {
		hal: { name: "hal", domains: ["wolfpack", "personal"], models: { main: { model: "claude-opus-5-5" } } },
		dewey: { name: "dewey", domains: ["wolfpack"], models: { main: { model: "claude-sonnet-5-5" } }, memory: { model: "claude-haiku-5-5" } },
		scout: { name: "scout", domains: ["snapjack"], models: { main: { model: "claude-sonnet-5-5" } } },
	};
	// Values for the All settings form, so it is not empty in the browser. Spread under each wolf's own config below.
	const FORM_DEFAULTS = { color: "blue", tiers: { smart: { model: "claude-sonnet-5-5" } }, subagents: { maxRunning: 3 }, compaction: { enabled: true } };
	for (const w of Object.keys(config)) config[w] = { ...FORM_DEFAULTS, ...config[w] };
	let n = 1;
	const view = (w: string) => ({ etag: `e${n}`, config: config[w] ?? {}, editable: EDITABLE_KEYS, tierModels: { main: "claude-opus-5-5", smart: "claude-sonnet-5-5", fast: "claude-haiku-5-5" }, env: ENV, restartNeeded: n > 1, restartable: true, restartAvailableInSeconds: 0 });
	return (async (url: RequestInfo | URL, init?: RequestInit) => {
		await new Promise((r) => setTimeout(r, 200));
		const u = String(url);
		if (u.startsWith("/api/pack/machines/keys")) return reply(200, { machines: MACHINES, console: { relay: mode === "relay", machine: "mac" } });
		if (u.startsWith("/api/pack/model-options")) return reply(200, { models: MODELS });
		const m = /^\/api\/wolves\/([^/]+)\/(settings|prompts)/.exec(u);
		if (!m) return reply(404, { error: "not a fixture route" });
		const wolf = decodeURIComponent(m[1]!);
		if (m[2] === "prompts") return reply(200, { prompts: PROMPTS });
		if ((init?.method ?? "GET") === "PUT") {
			const set = (JSON.parse(String(init!.body)) as { set: Record<string, string | null> }).set;
			for (const [k, v] of Object.entries(set)) {
				const path = k.split(".");
				let cur = (config[wolf] ??= {});
				for (const p of path.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
				if (v === null) delete cur[path.at(-1)!];
				else cur[path.at(-1)!] = v;
			}
			n++;
		}
		return reply(200, view(wolf));
	}) as typeof fetch;
}
