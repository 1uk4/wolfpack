import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { buildGraphs, buildTree, hostOf, parsePromptsUrl, promptsUrlSearch, standardsOf, type FlowRow, type PromptGraph } from "../src/core/prompt-flows.ts";

/** The ids a real wolf returns from GET /prompts (a wolf with an identity file and project AGENTS.md/CLAUDE.md/skills would add system.agents-md, .claude-md, .skills). */
const IDS = [
	"orchestrator-rules", "new-work", "grilling", "to-spec", "to-tickets", "identity",
	"agent.investigator", "agent.planner", "agent.researcher", "agent.reviewer", "agent.scout", "agent.visualizer", "agent.worker",
	"standard.git", "standard.testing", "standard.verify-ui",
	"system.header", "system.identity", "system.orchestrator", "system.structured-output", "system.brief",
	"tool.read", "tool.bash", "tool.subagent",
	"pipeline.observer", "pipeline.observer-user", "pipeline.consolidate", "pipeline.consolidate-user", "pipeline.pack-digest",
	"pipeline.crawl-observer", "pipeline.crawl-observer-user", "pipeline.crawl-consolidate", "pipeline.crawl-consolidate-user", "pipeline.crawl-journey", "pipeline.crawl-journey-user",
	"pipeline.distill", "pipeline.distill-graduation", "pipeline.distill-graduation-standing", "pipeline.work-record", "pipeline.task-summary", "pipeline.breakdown-suggestion",
	"pipeline.active-work-header", "pipeline.success-criteria-line",
	...["idea", "plan", "feasibility", "approved", "in_build", "shipped", "live"].map((s) => `pipeline.stage-context.${s}`),
	"compaction.pi-durable-system", "compaction.pi-durable-instructions",
];
const profile = (name: string, standards?: string) => `---\nname: ${name}\ndescription: d\n${standards ? `standards: ${standards}\n` : ""}---\nbody`;
const TEXTS: Record<string, string> = {
	"agent.worker": profile("worker", "testing"),
	"agent.reviewer": profile("reviewer", "testing, git"),
	"agent.planner": profile("planner", "testing"),
	"agent.scout": profile("scout"),
};
const TOOL_FILES: Record<string, string> = { "tool.read": "extension coding-tools", "tool.bash": "extension coding-tools", "tool.subagent": "extension wolfd-subagents" };
const rows = (ids = IDS): FlowRow[] => ids.map((id) => ({ id, group: "g", label: id, editable: !/^(system|tool|pipeline|compaction)\./.test(id), text: TEXTS[id] ?? "t", ...(TOOL_FILES[id] ? { file: TOOL_FILES[id] } : {}) }));
const count = (xs: string[], id: string) => xs.filter((x) => x === id).length;

describe("prompt tree", () => {
	it("lists the system-prompt blocks in the order composeProjectContext builds them", async () => {
		// Loaded by path so the console typecheck does not compile the harness source.
		const ctxPath = "../../../packages/harness/src/wolfd/context.ts";
		const { composeProjectContext } = (await import(ctxPath)) as { composeProjectContext: (i: Record<string, unknown>) => { blocks: { id: string }[] } };
		const home = mkdtempSync(join(tmpdir(), "flows-"));
		mkdirSync(join(home, "agent"), { recursive: true });
		mkdirSync(join(home, "den", "skills", "s"), { recursive: true });
		writeFileSync(join(home, "agent", "AGENTS.md"), "I am w.");
		writeFileSync(join(home, "AGENTS.md"), "project agents");
		writeFileSync(join(home, "CLAUDE.md"), "project claude");
		writeFileSync(join(home, "den", "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nx");
		const real = composeProjectContext({ name: "w", cwd: home, den: join(home, "den"), home, wolfHome: home }).blocks.map((b) => `system.${b.id}`);
		assert.deepEqual(real, ["system.header", "system.identity", "system.orchestrator", "system.agents-md", "system.claude-md", "system.skills", "system.structured-output", "system.brief"]);
		const tree = buildTree(rows([...IDS, "system.agents-md", "system.claude-md", "system.skills"]));
		const system = tree.find((n) => n.key === "system")!;
		assert.deepEqual(system.items.map((i) => i.id).filter((id) => id.startsWith("system.")), real);
	});

	it("derives the standards under each subagent from its frontmatter, and links each block to its editable source", () => {
		assert.deepEqual(standardsOf(profile("reviewer", "testing, git")), ["testing", "git"]);
		assert.deepEqual(standardsOf(profile("scout")), []);
		const tree = buildTree(rows());
		const subs = tree.find((n) => n.key === "subagents")!.subagents!;
		const reads = (p: string) => subs.find((s) => s.id === p)!.reads;
		assert.deepEqual(reads("agent.reviewer"), ["standard.testing", "standard.git"]);
		assert.deepEqual(reads("agent.worker"), ["standard.testing"]);
		assert.deepEqual(reads("agent.scout"), []);
		assert.deepEqual(subs.find((s) => s.id === "agent.reviewer")!.cards, ["standard.git"]);
		const system = tree.find((n) => n.key === "system")!;
		assert.equal(system.items.find((i) => i.id === "system.identity")?.editedIn, "identity");
		assert.equal(system.items.find((i) => i.id === "system.orchestrator")?.editedIn, "orchestrator-rules");
	});

	it("names the host each prompt runs on: the hub for sweep rows, pi-durable for compaction, the wolf otherwise", () => {
		assert.equal(hostOf("hub:sweep.merge"), "hub");
		assert.equal(hostOf("compaction.pi-durable-system"), "wolfd-pi-durable");
		assert.equal(hostOf("pipeline.observer"), "wolf");
		assert.equal(hostOf("identity"), "wolf");
	});
});

/** The hub rows exactly as hubd GET /v1/settings returns them (ids unprefixed). Loaded by path so the console typecheck does not compile hubd. */
const hubdPath = "../../../packages/hubd/src/settings.ts";
let HUB_ROWS: FlowRow[] = [];
before(async () => {
	const { hubPrompts } = (await import(hubdPath)) as { hubPrompts: () => Array<{ id: string; group: string; label: string; text: string }> };
	HUB_ROWS = hubPrompts().map((p) => ({ ...p, editable: false }));
});
const graphs = (all = rows(), hub: FlowRow[] | null = HUB_ROWS) => buildGraphs(all, hub);
const graphOf = (gs: PromptGraph[], key: string) => gs.find((g) => g.key === key)!;
const edgeSet = (g: PromptGraph) => g.edges.map((e) => `${e.from}>${e.to}`);

describe("prompt graphs", () => {
	it("offers one graph per tab, in order, with no dangling edge and no cycle", () => {
		const gs = graphs();
		assert.deepEqual(gs.map((g) => g.key), ["system", "subagents", "tools", "work", "kb", "crawl", "sweep", "compaction"]);
		for (const g of gs) {
			const ids = new Set(g.nodes.map((n) => n.id));
			assert.equal(ids.size, g.nodes.length, `${g.key}: unique node ids`);
			for (const e of g.edges) assert.ok(ids.has(e.from) && ids.has(e.to), `${g.key}: ${e.from}>${e.to}`);
			// Kahn: every node can be removed, so there is no cycle.
			const indeg = new Map([...ids].map((i) => [i, 0]));
			for (const e of g.edges) indeg.set(e.to, indeg.get(e.to)! + 1);
			const queue = [...indeg].filter(([, d]) => d === 0).map(([i]) => i);
			let seen = 0;
			while (queue.length) {
				const n = queue.pop()!;
				seen++;
				for (const e of g.edges.filter((x) => x.from === n)) if (indeg.set(e.to, indeg.get(e.to)! - 1).get(e.to) === 0) queue.push(e.to);
			}
			assert.equal(seen, ids.size, `${g.key}: acyclic`);
		}
	});

	it("draws the System prompt graph: blocks in composition order, sources feeding blocks, one collapsed Tools node", () => {
		const sys = graphOf(graphs(), "system");
		const e = edgeSet(sys);
		for (const x of ["system.header>system.identity", "system.identity>system.orchestrator", "system.orchestrator>system.structured-output", "system.structured-output>system.brief", "identity>system.identity", "orchestrator-rules>system.orchestrator"]) assert.ok(e.includes(x), x);
		const tools = sys.nodes.find((n) => n.id === "tools")!;
		assert.equal(tools.title, "Tools (3)");
		assert.equal(tools.link, "tools", "the Tools node links to the Tools tab");
		assert.equal(sys.nodes.filter((n) => n.id.startsWith("tool.")).length, 0);
		assert.ok(!sys.nodes.some((n) => n.id.startsWith("agent.") || n.id.startsWith("standard.")));
		assert.equal(sys.nodes.find((n) => n.id === "identity")!.marker, "editable");
		assert.equal(sys.nodes.find((n) => n.id === "system.header")!.marker, "read-only");
	});

	it("draws the Subagents graph: the main wolf to each profile to the standards its frontmatter names, and an unread standard apart", () => {
		const sub = graphOf(graphs(), "subagents");
		const e = edgeSet(sub);
		assert.deepEqual(e.filter((x) => x.startsWith("agent.") && x.includes(">standard.")).sort(), ["agent.planner>standard.testing", "agent.reviewer>standard.git", "agent.reviewer>standard.testing", "agent.worker>standard.testing"]);
		assert.ok(e.includes("main-wolf>agent.scout"));
		assert.equal(e.filter((x) => x.startsWith("main-wolf>agent.")).length, 7);
		const lonely = sub.nodes.find((n) => n.id === "standard.verify-ui")!;
		assert.equal(lonely.sub, "not read by any profile");
		assert.equal(e.filter((x) => x.endsWith(">standard.verify-ui")).length, 0);
		assert.equal(sub.nodes.find((n) => n.id === "standard.git")!.sub, undefined, "read standards carry no subtitle");
		assert.equal(graphOf(graphs(), "system").nodes.find((n) => n.id === "identity")!.sub, undefined);
	});

	it("draws the flow graphs: steps in order, the wolf-to-hub hop, and the crawl joining at hub curation", () => {
		const gs = graphs();
		const kb = graphOf(gs, "kb");
		assert.deepEqual(edgeSet(kb), ["pipeline.observer>pipeline.consolidate", "pipeline.consolidate>pipeline.distill", "pipeline.distill>hub-curation"]);
		const hub = kb.nodes.find((n) => n.id === "hub-curation")!;
		assert.equal(hub.host, "hub");
		assert.equal(hub.link, "sweep");
		const crawl = graphOf(gs, "crawl");
		assert.deepEqual(edgeSet(crawl), ["pipeline.crawl-observer>pipeline.crawl-consolidate", "pipeline.crawl-consolidate>pipeline.crawl-journey", "pipeline.crawl-journey>step:crawl:4", "step:crawl:4>hub-curation"]);
		assert.equal(crawl.nodes.find((n) => n.id === "step:crawl:4")!.marker, "no prompt");
		assert.deepEqual(graphOf(gs, "compaction").nodes.map((n) => n.id).slice(-2), ["compaction.pi-durable-system", "compaction.pi-durable-instructions"]);
		assert.equal(graphOf(gs, "work").nodes[0]!.id, "new-work");
	});

	it("draws the Tools graph: the wolf to one node per extension to each tool", () => {
		const t = graphOf(graphs(), "tools");
		assert.deepEqual(edgeSet(t).sort(), ["main-wolf>tools:coding-tools", "main-wolf>tools:wolfd-subagents", "tools:coding-tools>tool.bash", "tools:coding-tools>tool.read", "tools:wolfd-subagents>tool.subagent"]);
		assert.deepEqual(t.nodes.find((n) => n.id === "tools:coding-tools")!.ids, ["tool.read", "tool.bash"]);
		assert.equal(t.nodes.find((n) => n.id === "tool.read")!.title, "tool.read");
		// the tool nodes follow their group's order, so the layout can keep each group's edges apart
		const order = t.nodes.map((n) => n.id).filter((id) => id.startsWith("tool") );
		assert.deepEqual(order, ["tools:coding-tools", "tool.read", "tool.bash", "tools:wolfd-subagents", "tool.subagent"]);
	});

	it("draws the KB sweep graph in the order the sweep runs it, with the new-vs-merge fork and the maintenance pass", () => {
		const sweep = graphOf(graphs(), "sweep");
		assert.deepEqual(edgeSet(sweep), [
			"inbox>hub:sweep.match-subject",
			"hub:sweep.match-subject>hub:sweep.confirm-subject",
			"hub:sweep.match-subject>hub:sweep.section-pick",
			"hub:sweep.confirm-subject>hub:sweep.section-pick",
			"hub:sweep.section-pick>hub:sweep.produce",
			"hub:sweep.produce>hub:sweep.contradict",
			"hub:sweep.produce>hub:sweep.split-section",
			"hub:sweep.split-section>hub:sweep.section-summary",
			"hub:sweep.section-summary>hub:sweep.label-section",
		]);
		const inbox = sweep.nodes.find((n) => n.id === "inbox")!;
		assert.equal(inbox.title, "Inbox (contributions from every wolf)");
		assert.ok(sweep.nodes.filter((n) => n.id !== "inbox").every((n) => n.host === "hub" && n.marker === "read-only"));
	});

	it("places every prompt hubd reports on the sweep graph, so a new sweep prompt that is not placed fails here", () => {
		const sweep = graphOf(graphs(), "sweep");
		assert.equal(sweep.nodes.find((n) => n.id === "other"), undefined, "no unplaced hub prompt");
		const placed = new Set(sweep.nodes.flatMap((n) => n.ids));
		for (const h of HUB_ROWS) assert.ok(placed.has(`hub:${h.id}`), h.id);
		const extra = graphOf(graphs(rows(), [...HUB_ROWS, { id: "sweep.brand-new", group: "KB sweep", label: "new", editable: false, text: "t" }]), "sweep");
		assert.deepEqual(extra.nodes.find((n) => n.id === "hub:sweep.brand-new")?.ids, ["hub:sweep.brand-new"]);
	});

	it("keeps the sweep graph's shape with no hub, and the hub curation nodes link to it", () => {
		const gs = graphs(rows(), null);
		assert.deepEqual(edgeSet(graphOf(gs, "sweep")), edgeSet(graphOf(graphs(), "sweep")));
		for (const key of ["kb", "crawl"]) {
			const hub = graphOf(gs, key).nodes.find((n) => n.id === "hub-curation")!;
			assert.equal(hub.link, "sweep");
			assert.equal(hub.hubMissing, true);
			assert.deepEqual(hub.ids, []);
		}
		assert.equal(graphOf(graphs(), "kb").nodes.find((n) => n.id === "hub-curation")!.hubMissing, undefined);
	});

	it("covers every wolf prompt id and every hub sweep id in some graph, and an unknown id gets its own node under Other", () => {
		const covered = new Set(graphs().flatMap((g) => g.nodes.flatMap((n) => n.ids)));
		for (const id of IDS.filter((i) => i !== "pipeline.breakdown-suggestion")) assert.ok(covered.has(id), id);
		for (const h of HUB_ROWS) assert.ok(covered.has(`hub:${h.id}`), h.id);
		assert.ok(!covered.has("pipeline.breakdown-suggestion"));
		const sys = graphOf(graphs(rows([...IDS, "pipeline.brand-new", "tool.mystery"])), "system");
		assert.deepEqual(sys.nodes.find((n) => n.id === "pipeline.brand-new")?.ids, ["pipeline.brand-new"]);
		assert.ok(edgeSet(sys).includes("other>pipeline.brand-new"));
		assert.deepEqual(graphOf(graphs(rows([...IDS, "tool.mystery"])), "tools").nodes.find((n) => n.id === "tool.mystery")?.ids, ["tool.mystery"]);
		assert.equal(graphOf(graphs(), "system").nodes.find((n) => n.id === "other"), undefined);
	});

	it("round-trips the selected graph and node through the URL", () => {
		assert.deepEqual(parsePromptsUrl("?graph=kb&node=pipeline.observer"), { graph: "kb", node: "pipeline.observer" });
		assert.equal(promptsUrlSearch({ graph: "kb", node: "pipeline.observer" }), "?graph=kb&node=pipeline.observer");
		assert.deepEqual(parsePromptsUrl(promptsUrlSearch({ graph: "sweep", node: "hub:sweep.produce" })), { graph: "sweep", node: "hub:sweep.produce" });
		assert.deepEqual(parsePromptsUrl("?graph=list"), { graph: "system" }, "an old ?graph=list link lands on the System prompt tab");
		assert.deepEqual(parsePromptsUrl("?graph=subagents&node=agent.worker"), { graph: "subagents", node: "agent.worker" });
		assert.deepEqual(parsePromptsUrl(""), { graph: "system" });
		assert.deepEqual(parsePromptsUrl("?graph=bogus&node="), { graph: "system" });
		assert.deepEqual(parsePromptsUrl("?graph=main&node=identity"), { graph: "system", node: "identity" }, "an old ?graph=main link lands on the System prompt tab");
		assert.equal(promptsUrlSearch({ graph: "system" }), "");
	});
});
