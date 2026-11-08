import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildFlows, buildGraphs, buildTree, hostOf, parsePromptsUrl, promptsUrlSearch, standardsOf, treeCardIds, type FlowRow, type PromptGraph } from "../src/core/prompt-flows.ts";

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
const rows = (ids = IDS): FlowRow[] => ids.map((id) => ({ id, group: "g", label: id, editable: !/^(system|tool|pipeline|compaction)\./.test(id), text: TEXTS[id] ?? "t" }));
const count = (xs: string[], id: string) => xs.filter((x) => x === id).length;

describe("prompt tree and flows", () => {
	it("places every prompt id exactly once in the tree and at least once in the flows, except the unused breakdown-suggestion", () => {
		const tree = treeCardIds(buildTree(rows()));
		const flows = buildFlows(rows(), null).flatMap((f) => f.steps.flatMap((s) => s.ids));
		for (const id of IDS.filter((i) => i !== "pipeline.breakdown-suggestion")) {
			assert.equal(count(tree, id), 1, `tree: ${id}`);
			assert.ok(flows.includes(id), `flows: ${id}`);
		}
		assert.ok(!tree.includes("pipeline.breakdown-suggestion") && !flows.includes("pipeline.breakdown-suggestion"));
	});

	it("puts an unknown or new prompt id into an Other node in both views", () => {
		const all = rows([...IDS, "pipeline.brand-new"]);
		const tree = buildTree(all);
		assert.deepEqual(tree.find((n) => n.key === "other")?.items.map((i) => i.id), ["pipeline.brand-new"]);
		const other = buildFlows(all, null).find((f) => f.key === "other");
		assert.deepEqual(other?.steps.flatMap((s) => s.ids), ["pipeline.brand-new"]);
		assert.equal(buildTree(rows()).find((n) => n.key === "other"), undefined);
	});

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

const HUB_ROWS: FlowRow[] = [{ id: "sweep.merge", group: "KB sweep", label: "merge", editable: false, text: "t" }];
const graphs = (all = rows(), hub: FlowRow[] | null = HUB_ROWS) => buildGraphs(all, hub);
const graphOf = (gs: PromptGraph[], key: string) => gs.find((g) => g.key === key)!;
const edgeSet = (g: PromptGraph) => g.edges.map((e) => `${e.from}>${e.to}`);

describe("prompt graphs", () => {
	it("offers one graph per tab, in order, with no dangling edge and no cycle", () => {
		const gs = graphs();
		assert.deepEqual(gs.map((g) => g.key), ["main", "work", "kb", "crawl", "compaction"]);
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

	it("draws the main wolf graph: blocks in composition order, sources feeding blocks, one collapsed Tools node, subagents to their frontmatter standards", () => {
		const main = graphOf(graphs(), "main");
		const e = edgeSet(main);
		for (const x of ["system.header>system.identity", "system.identity>system.orchestrator", "system.orchestrator>system.structured-output", "system.structured-output>system.brief", "system.brief>main-wolf", "identity>system.identity", "orchestrator-rules>system.orchestrator", "tools>main-wolf"]) assert.ok(e.includes(x), x);
		const tools = main.nodes.find((n) => n.id === "tools")!;
		assert.equal(tools.title, "Tools (3)");
		assert.deepEqual(tools.ids, ["tool.read", "tool.bash", "tool.subagent"]);
		assert.equal(main.nodes.filter((n) => n.id.startsWith("tool.")).length, 0);
		assert.deepEqual(e.filter((x) => x.startsWith("agent.") && x.includes(">standard.")).sort(), ["agent.planner>standard.testing", "agent.reviewer>standard.git", "agent.reviewer>standard.testing", "agent.worker>standard.testing"]);
		assert.ok(e.includes("main-wolf>agent.scout"));
		assert.equal(main.nodes.find((n) => n.id === "identity")!.marker, "editable");
		assert.equal(main.nodes.find((n) => n.id === "system.header")!.marker, "read-only");
	});

	it("draws the flow graphs: steps in order, the wolf-to-hub hop, and the crawl joining at hub curation", () => {
		const gs = graphs();
		const kb = graphOf(gs, "kb");
		assert.deepEqual(edgeSet(kb), ["pipeline.observer>pipeline.consolidate", "pipeline.consolidate>pipeline.distill", "pipeline.distill>hub-curation"]);
		const hub = kb.nodes.find((n) => n.id === "hub-curation")!;
		assert.equal(hub.host, "hub");
		assert.deepEqual(hub.ids, ["hub:sweep.merge"]);
		const crawl = graphOf(gs, "crawl");
		assert.deepEqual(edgeSet(crawl), ["pipeline.crawl-observer>pipeline.crawl-consolidate", "pipeline.crawl-consolidate>pipeline.crawl-journey", "pipeline.crawl-journey>step:crawl:4", "step:crawl:4>hub-curation"]);
		assert.equal(crawl.nodes.find((n) => n.id === "step:crawl:4")!.marker, "no prompt");
		assert.deepEqual(graphOf(gs, "compaction").nodes.map((n) => n.id).slice(-2), ["compaction.pi-durable-system", "compaction.pi-durable-instructions"]);
		assert.equal(graphOf(gs, "work").nodes[0]!.id, "new-work");
	});

	it("keeps the hub-not-connected state on the hub curation node", () => {
		const hub = graphOf(graphs(rows(), null), "kb").nodes.find((n) => n.id === "hub-curation")!;
		assert.equal(hub.hubMissing, true);
		assert.deepEqual(hub.ids, []);
	});

	it("covers every prompt id in some graph, and an unknown id lands in an Other node", () => {
		const covered = new Set(graphs().flatMap((g) => g.nodes.flatMap((n) => n.ids)));
		for (const id of IDS.filter((i) => i !== "pipeline.breakdown-suggestion")) assert.ok(covered.has(id), id);
		assert.ok(!covered.has("pipeline.breakdown-suggestion"));
		const other = graphOf(graphs(rows([...IDS, "pipeline.brand-new"])), "main").nodes.find((n) => n.id === "other");
		assert.deepEqual(other?.ids, ["pipeline.brand-new"]);
		assert.equal(graphOf(graphs(), "main").nodes.find((n) => n.id === "other"), undefined);
	});

	it("round-trips the selected graph and node through the URL", () => {
		assert.deepEqual(parsePromptsUrl("?graph=kb&node=pipeline.observer"), { graph: "kb", node: "pipeline.observer" });
		assert.equal(promptsUrlSearch({ graph: "kb", node: "pipeline.observer" }), "?graph=kb&node=pipeline.observer");
		assert.deepEqual(parsePromptsUrl(promptsUrlSearch({ graph: "list" })), { graph: "list" });
		assert.deepEqual(parsePromptsUrl(""), { graph: "main" });
		assert.deepEqual(parsePromptsUrl("?graph=bogus&node="), { graph: "main" });
		assert.equal(promptsUrlSearch({ graph: "main" }), "");
	});
});
