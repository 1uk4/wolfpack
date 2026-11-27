import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	EMPTY_GROUPS,
	addDomainToGroup,
	createGroup,
	deleteGroup,
	groupMembers,
	removeDomainFromGroup,
	renameGroup,
	sanitizeGroups,
} from "../../../src/core/graph/groups.ts";
import { createGraphSimulation } from "../../../src/core/graph/layout.ts";
import { readGraphGroups, writeGraphGroups } from "../../../src/store/graph-groups.ts";

describe("group CRUD", () => {
	it("creates, renames, adds and removes domains, and deletes a group, leaving the others alone", () => {
		let s = createGroup(EMPTY_GROUPS, "g1", { name: "Threadstone", color: "#3366ff", domains: ["spot"] });
		s = createGroup(s, "g2", { name: "Other", domains: ["personal"] });
		s = renameGroup(s, "g1", "  Threadstone Co  ");
		s = addDomainToGroup(s, "g1", "wolfpack");
		assert.deepEqual(s.groups[0], { id: "g1", name: "Threadstone Co", color: "#3366ff", icon: null, domains: ["spot", "wolfpack"] });
		s = removeDomainFromGroup(s, "g1", "spot");
		assert.deepEqual(s.groups[0]!.domains, ["wolfpack"]);
		s = deleteGroup(s, "g1");
		assert.deepEqual(s.groups.map((g) => g.id), ["g2"]);
	});

	it("keeps a domain in at most one group: adding or creating moves it, bad saved data is repaired", () => {
		let s = createGroup(EMPTY_GROUPS, "a", { name: "A", domains: ["spot"] });
		s = createGroup(s, "b", { name: "B", domains: ["spot", "snapjack"] });
		assert.deepEqual(s.groups.map((g) => g.domains), [[], ["spot", "snapjack"]]);
		s = addDomainToGroup(s, "a", "snapjack");
		assert.deepEqual(s.groups.map((g) => g.domains), [["snapjack"], ["spot"]]);
		const bad = sanitizeGroups({ groups: [{ id: "x", name: "X", domains: ["d", "d"] }, { id: "y", name: "Y", domains: ["d", "e"] }, { id: "z", name: " " }] });
		assert.deepEqual(bad.groups.map((g) => g.domains), [["d"], ["e"]]);
	});

	it("maps a group to every node of its domains for the layout", () => {
		const s = createGroup(EMPTY_GROUPS, "g", { name: "G", domains: ["spot", "wolfpack"] });
		const nodes = [{ id: "1", domain: "spot" }, { id: "2", domain: "wolfpack" }, { id: "3", domain: "personal" }, { id: "4" }];
		assert.deepEqual(groupMembers(s, nodes), [{ id: "g", members: ["1", "2"] }]);
	});
});

describe("group storage", () => {
	it("saves the whole list in a local file and reads it back; a missing file is no groups", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "groups-"));
		const file = path.join(dir, "nested", "groups.json");
		assert.deepEqual(readGraphGroups(file), EMPTY_GROUPS);
		const stored = writeGraphGroups({ groups: [{ id: "g", name: "Threadstone", domains: ["spot", "spot"] }] }, file);
		assert.deepEqual(stored.groups[0]!.domains, ["spot"]);
		assert.deepEqual(readGraphGroups(file), stored);
		fs.rmSync(dir, { recursive: true });
	});
});

describe("group layout pull", () => {
	it("draws the domains of a group together; strength 0 leaves them apart", () => {
		// Two domains, no edges between them, starting far apart; the group pull is the only thing joining them.
		const mk = () => [
			...Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, x: -300 + i * 5, y: i * 5 })),
			...Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, x: 300 + i * 5, y: i * 5 })),
		];
		const groups = [{ members: mk().map((n) => n.id) }];
		const gap = (strength: number): number => {
			const sim = createGraphSimulation(mk(), [], { groupPull: { groups, strength } });
			for (let i = 0; i < 200; i++) sim.tick();
			const ns = sim.nodes() as unknown as { id: string; x: number }[];
			const mean = (p: string) => ns.filter((n) => n.id.startsWith(p)).reduce((s, n) => s + n.x, 0) / 4;
			return Math.abs(mean("a") - mean("b"));
		};
		assert.ok(gap(0.03) < gap(0) * 0.7, `pulled gap ${gap(0.03).toFixed(0)} vs ${gap(0).toFixed(0)}`);
	});
});
