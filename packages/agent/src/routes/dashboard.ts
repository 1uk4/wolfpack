/**
 * Dashboard routes — serves the live KB graph.
 *
 * GET /dashboard             → HTML dashboard (same as /kb graph)
 * GET /dashboard/api/kb-graph → graph data (nodes, edges, bodies) per domain
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const KB_BASE = "/var/wolfpack/kb/base";

function parseFrontmatter(text: string): { meta: Record<string, any>; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, any> = {};
  const lines = match[1].split("\n");
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      meta[key] = val;
    }
  }
  return { meta, body: match[2] };
}

function parseYamlFrontmatter(text: string): Record<string, any> {
  const { meta } = parseFrontmatter(text);
  return meta;
}

interface GraphNode {
  id: string;
  label: string;
  group: string;
  value: number;
  maturity?: string;
  meta: Record<string, any>;
}

interface GraphEdge {
  from: string;
  to: string;
  type?: string;
}

function buildDomainDataset(domain: string, label: string, domainDir: string) {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const bodies: Record<string, string> = {};
  const seenEntry = new Set<string>();

  const domNode = `dom:${domain}`;

  // Load entries
  const entries = new Map<string, Record<string, any>>();
  const entriesDir = join(domainDir, "entries");
  if (existsSync(entriesDir)) {
    for (const f of readdirSync(entriesDir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const raw = readFileSync(join(entriesDir, f), "utf-8");
        const { meta, body } = parseFrontmatter(raw);
        const id = meta.id ?? f.replace(/\.md$/, "");
        entries.set(id, { ...meta, id, body });
      } catch { continue; }
    }
  }

  // Domain node
  nodes.push({
    id: domNode,
    label,
    group: "domain",
    value: 40,
    meta: { type: "Domain", entries: entries.size },
  });

  // Load digest for section tree
  let sections: any[] = [];
  const digestPath = join(domainDir, "_digest.json");
  if (existsSync(digestPath)) {
    try {
      const digest = JSON.parse(readFileSync(digestPath, "utf-8"));
      sections = digest.sections ?? [];
    } catch { /* no digest */ }
  }

  // Walk section tree
  function walkSections(sectionList: any[], parentId: string) {
    for (const sec of sectionList) {
      const sid = sec.sectionId ?? "";
      const snode = `sec:${sid}`;
      nodes.push({
        id: snode,
        label: (sec.title ?? sid).slice(0, 48),
        group: "section",
        value: 20,
        meta: {
          type: "Section",
          sectionId: sid,
          title: sec.title ?? "",
          summary: sec.summary ?? "",
          currency: sec.currency ?? "",
        },
      });
      edges.push({ from: parentId, to: snode });

      for (const eid of sec.entryIds ?? []) {
        const enode = `ent:${eid}`;
        const e = entries.get(eid) ?? { id: eid, title: eid, kind: "", maturity: "", body: "" };
        if (!seenEntry.has(eid)) {
          seenEntry.add(eid);
          nodes.push({
            id: enode,
            label: (e.title ?? eid).slice(0, 40),
            group: "entry",
            maturity: e.maturity ?? "",
            value: 10,
            meta: {
              type: "Entry",
              id: eid,
              title: e.title ?? "",
              kind: e.kind ?? "",
              maturity: e.maturity ?? "",
              authority: e.authority ?? "",
              currency: e.currency ?? "",
              facets: e.facets ?? {},
            },
          });
          bodies[enode] = e.body ?? "";
        }
        edges.push({ from: snode, to: enode });
      }

      walkSections(sec.children ?? [], snode);
    }
  }

  walkSections(sections, domNode);

  // Orphan entries
  for (const [eid, e] of entries) {
    if (!seenEntry.has(eid)) {
      const enode = `ent:${eid}`;
      nodes.push({
        id: enode,
        label: (e.title ?? eid).slice(0, 40),
        group: "entry",
        maturity: e.maturity ?? "",
        value: 10,
        meta: {
          type: "Entry",
          id: eid,
          title: e.title ?? "",
          kind: e.kind ?? "",
          maturity: e.maturity ?? "",
          authority: e.authority ?? "",
          currency: e.currency ?? "",
          facets: {},
        },
      });
      bodies[enode] = e.body ?? "";
      edges.push({ from: domNode, to: enode });
    }
  }

  // Work items
  // Work items — same structure as build_graph.py
  const workDirPath = join(domainDir, "work");
  const workItems = new Map<string, Record<string, any>>();
  if (existsSync(workDirPath)) {
    for (const f of readdirSync(workDirPath)) {
      if (!f.endsWith(".md")) continue;
      try {
        const raw = readFileSync(join(workDirPath, f), "utf-8");
        const { meta, body } = parseFrontmatter(raw);
        if (meta.nodeType !== "work") continue;
        if (meta.stage === "archived") continue;
        const id = meta.id ?? f.replace(/\.md$/, "");
        // Parse dependsOn from YAML list
        let dependsOn: string[] = [];
        const depMatch = raw.match(/dependsOn:\n((?:\s+-\s+\S+\n?)*)/)
        if (depMatch) {
          dependsOn = depMatch[1].match(/- (\S+)/g)?.map((m: string) => m.slice(2)) ?? [];
        }
        workItems.set(id, { ...meta, id, body, dependsOn });
      } catch { continue; }
    }
  }

  if (workItems.size > 0) {
    const factoryNode = `fac:${domain}`;
    nodes.push({
      id: factoryNode,
      label: "Factory",
      group: "factory",
      value: 25,
      meta: { type: "Factory", workCount: workItems.size },
    });
    edges.push({ from: domNode, to: factoryNode });

    const workIds = new Set(workItems.keys());
    for (const [wid, w] of workItems) {
      const wnode = `work:${wid}`;
      nodes.push({
        id: wnode,
        label: (w.title ?? wid).slice(0, 40),
        group: "work",
        workKind: w.kind ?? "task",
        stage: w.stage ?? "plan",
        value: 12,
        meta: {
          type: "Work",
          id: wid,
          title: w.title ?? "",
          kind: w.kind ?? "",
          stage: w.stage ?? "",
          assignee: w.assignee ?? "",
          area: w.area ?? "",
          successCriteria: w.successCriteria ?? "",
          dependsOn: w.dependsOn ?? [],
        },
      } as any);
      bodies[wnode] = w.body ?? "";

      const parentId = w.partOf;
      if (parentId && workIds.has(parentId)) {
        edges.push({ from: `work:${parentId}`, to: wnode });
      } else {
        edges.push({ from: factoryNode, to: wnode });
      }
    }

    // Dependency edges (dashed in the graph)
    for (const [wid, w] of workItems) {
      for (const dep of w.dependsOn ?? []) {
        if (workIds.has(dep)) {
          edges.push({ from: `work:${dep}`, to: `work:${wid}`, type: "depends" });
        }
      }
    }
  }

  return {
    domain,
    label,
    nodes,
    edges,
    bodies,
    entryCount: entries.size,
    sectionCount: nodes.filter(n => n.group === "section").length,
    workCount: workItems.size,
  };
}

export function dashboardRouter(): Router {
  const router = Router();

  // Graph data API — same format as build_graph.py
  router.get("/api/kb-graph", (_req: Request, res: Response) => {
    try {
      const domainsDir = join(KB_BASE, "domains");
      if (!existsSync(domainsDir)) {
        res.json([]);
        return;
      }

      // Read domain labels
      const labels: Record<string, string> = {};
      const regPath = join(KB_BASE, "domains.yaml");
      if (existsSync(regPath)) {
        const raw = readFileSync(regPath, "utf-8");
        const domainBlock = raw.match(/domains:\n([\s\S]*?)(?:\n\S|\Z)/);
        if (domainBlock) {
          for (const m of domainBlock[1].matchAll(/^\s{2}(\w+):\n\s{4}label:\s*(.+)/gm)) {
            labels[m[1]] = m[2].trim();
          }
        }
      }

      const datasets = [];
      for (const d of readdirSync(domainsDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const label = labels[d.name] ?? d.name.charAt(0).toUpperCase() + d.name.slice(1);
        datasets.push(buildDomainDataset(d.name, label, join(domainsDir, d.name)));
      }
      res.json(datasets);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Serve dashboard HTML
  router.get("/", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html");
    res.send(DASHBOARD_HTML);
  });

  return router;
}

import { DASHBOARD_HTML } from "./dashboard-html.js";
