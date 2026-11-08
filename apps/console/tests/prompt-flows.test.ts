import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildFlows, buildTree, hostOf, standardsOf, treeCardIds, type FlowRow } from "../src/core/prompt-flows.ts";

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
